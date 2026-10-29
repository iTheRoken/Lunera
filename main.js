const { app, BrowserWindow, ipcMain, nativeImage, session, screen } = require('electron');
const { startAppUpdater } = require('./services/appUpdater');
const { createGameOverlay } = require('./services/gameOverlay');
const usetube = require('usetube');
const Store = require('electron-store');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const net = require('net');
const sqlite3 = require('sqlite3').verbose();
const lyricGet = require('lyric-get');
const {
  extractAudio,
  getPlaylist: extractPlaylist,
  getVideoId,
  normalizeExtractorMode,
  validateMediaUrl,
  configureLseEngine,
  configureTurboEngine
} = require('./services/audioExtractor');
const {
  LuneraStreamEngine,
  DEFAULT_LSE_SETTINGS,
  normalizeSettings: normalizeLseSettings
} = require('./services/lse');
const {
  LuneraTurboEngine,
  DEFAULT_TURBO_SETTINGS,
  normalizeTurboSettings,
  BenchmarkRunner
} = require('./services/lte');
const ytdlpService = require('./services/ytdlpService');
const { isBlockedHostname, isUnsafeIp } = require('./services/lse/core/NetworkManager');

const store = new Store();
const dbPath = path.join(app.getPath('userData'), 'music_database.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error al conectar con la base de datos:', err);
  } else {
    console.log('Conectado a la base de datos SQLite en:', dbPath);
  }
});

let mainWindow;
let appUpdaterController = null;
let miniPlayerWindow = null;
let miniPlayerBoundsTimer = null;
let gameOverlay = null;
let latestPlayerState = {
  isPlaying: false,
  playerUiState: 'empty',
  title: null,
  artist: null,
  thumbnail: null,
  volume: 1,
  muted: false,
  currentTime: 0,
  duration: 0,
  accentColor: '#1db954'
};
let currentStream = null;
let thumbarPlaying = false;
let networkAccessEnabled = store.get('networkAccessEnabled', true);
const storedAudioExtractor = store.get('audioExtractor');
const hasExplicitAudioExtractor = ['lte', 'lse', 'yt-dlp', 'ytdl-core'].includes(storedAudioExtractor);
let audioExtractorPreference = normalizeExtractorMode(
  hasExplicitAudioExtractor ? storedAudioExtractor : 'lte'
);
if (storedAudioExtractor !== audioExtractorPreference) {
  store.set('audioExtractor', audioExtractorPreference);
}
let lseEngine = null;
let turboEngine = null;
let audioProxyServer = null;
let audioProxyPort = null;
const audioProxyEntries = new Map();
const audioCacheJobs = new Map();
const memoryStreamCache = new Map();
const memoryStreamPreloadJobs = new Map();
let activePlaybackResolution = null;
let activeTurboBenchmark = null;
let lastTurboBenchmark = null;
const AUDIO_PROXY_HOST = '127.0.0.1';
const AUDIO_PROXY_TTL_MS = 2 * 60 * 60 * 1000;
const MEMORY_STREAM_TTL_MS = 10 * 60 * 1000;
const AUDIO_CACHE_DIRECTORY_NAME = 'audio_cache';
const AUDIO_CACHE_EXTENSIONS = Object.freeze(['m4a', 'mp4', 'mp3', 'webm', 'ogg', 'aac', 'wav', 'flac']);
const LEGACY_USER_DATA_MIGRATION_KEY = 'legacyUserDataMigrationComplete';
let audioCacheGeneration = 0;
let audioCacheClearPromise = null;
let applicationDataGeneration = 0;

function cancelActivePlaybackResolution(reason = 'Se seleccionó otra pista') {
  const active = activePlaybackResolution;
  if (!active) return false;
  activePlaybackResolution = null;
  try { active.controller.abort(reason); } catch (error) {}
  return true;
}

function createPlaybackAbortError(reason = 'La preparacion de audio fue cancelada') {
  const error = new Error(reason);
  error.name = 'AbortError';
  error.code = 'ABORTED';
  return error;
}

function throwIfPlaybackAborted(signal) {
  if (signal?.aborted) {
    const reason = typeof signal.reason === 'string' && signal.reason.trim()
      ? signal.reason
      : 'La preparacion de audio fue cancelada';
    throw createPlaybackAbortError(reason);
  }
}

function beginPlaybackResolution(requestId, videoUrl, quality, mode) {
  cancelActivePlaybackResolution();
  const controller = new AbortController();
  activePlaybackResolution = { requestId, videoUrl, quality, mode, controller };
  return controller;
}

function finishPlaybackResolution(requestId) {
  if (activePlaybackResolution?.requestId === requestId) {
    activePlaybackResolution = null;
  }
}
function ensureInternetAccess(featureName) {
  if (!networkAccessEnabled) {
    throw new Error(`${featureName} no está disponible porque el acceso a internet está desactivado`);
  }
}

function initializeLseEngine() {
  const persisted = normalizeLseSettings(store.get('lseSettings', {}), DEFAULT_LSE_SETTINGS);
  store.set('lseSettings', persisted);

  lseEngine = new LuneraStreamEngine({
    settings: persisted,
    metadataCachePath: path.join(app.getPath('userData'), 'lse_metadata_cache.json')
  });
  const extractorStates = store.get('lseExtractorStates', {});
  if (extractorStates && typeof extractorStates === 'object') {
    for (const [id, enabled] of Object.entries(extractorStates)) {
      try { lseEngine.setExtractorEnabled(id, enabled !== false); } catch (error) {}
    }
  }
  configureLseEngine(lseEngine);
  return lseEngine.initialize();
}

function initializeTurboEngine() {
  const persisted = normalizeTurboSettings(store.get('turboSettings', {}), DEFAULT_TURBO_SETTINGS);
  store.set('turboSettings', persisted);
  turboEngine = new LuneraTurboEngine({
    settings: persisted,
    metadataCachePath: path.join(app.getPath('userData'), 'lte_metadata_cache.json')
  });
  configureTurboEngine(turboEngine);
  return turboEngine.initialize();
}

function getTurboEngineInstance() {
  if (turboEngine) return turboEngine;
  initializeTurboEngine();
  return turboEngine;
}

function getTurboSettings() {
  return getTurboEngineInstance().getSettings();
}

function sanitizeTurboSettingsPatch(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('La configuración de LTE debe ser un objeto JSON');
  }
  const allowedKeys = new Set(Object.keys(DEFAULT_TURBO_SETTINGS));
  const sanitized = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (!allowedKeys.has(key) || key === 'configVersion') continue;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (['string', 'number', 'boolean'].includes(typeof value)) sanitized[key] = value;
  }
  return sanitized;
}

function updateTurboSettings(candidate) {
  const settings = getTurboEngineInstance().updateSettings(sanitizeTurboSettingsPatch(candidate));
  store.set('turboSettings', settings);
  return settings;
}

async function getTurboDiagnostics() {
  const diagnostics = getTurboEngineInstance().getDiagnostics();
  const cacheSettings = await getCacheSettings();
  return {
    ...diagnostics,
    benchmark: lastTurboBenchmark ? {
      measuredAt: lastTurboBenchmark.measuredAt,
      runs: lastTurboBenchmark.runs,
      quality: lastTurboBenchmark.quality,
      baseline: lastTurboBenchmark.baseline,
      elapsedMs: lastTurboBenchmark.elapsedMs,
      summary: lastTurboBenchmark.summary,
      comparison: lastTurboBenchmark.comparison
    } : null,
    cache: {
      enabled: !!cacheSettings?.enabled,
      maxSizeMB: Number(cacheSettings?.maxSizeMB || 0),
      policy: 'La caché multimedia global sólo conserva contenido autorizado; LTE guarda metadatos efímeros.'
    }
  };
}

function normalizeTurboBenchmarkOptions(candidate = {}) {
  const input = candidate && typeof candidate === 'object' ? candidate : {};
  const validQualities = new Set(['auto', 'best', 'balanced', 'low', 'manual', 'medium', 'high', 'lossless']);
  const turboSettings = getTurboSettings();
  const runs = Math.max(1, Math.min(3, Math.round(Number(input.runs) || 1)));
  const timeoutMs = Math.max(1_000, Math.min(120_000, Math.round(Number(input.timeoutMs) || turboSettings.extractionTimeoutMs)));
  const quality = validQualities.has(String(input.quality || '').toLowerCase())
    ? String(input.quality).toLowerCase()
    : turboSettings.qualityMode;
  const requestedFormatId = typeof input.manualFormatId === 'string' ? input.manualFormatId.trim() : '';
  const manualFormatId = quality === 'manual'
    ? (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(requestedFormatId) ? requestedFormatId : turboSettings.manualFormatId)
    : '';
  const validCodecs = new Set(['auto', 'aac', 'opus', 'mp3', 'vorbis', 'flac']);
  const preferredCodec = validCodecs.has(String(input.preferredCodec || '').toLowerCase())
    ? String(input.preferredCodec).toLowerCase()
    : turboSettings.preferredCodec;
  return {
    runs,
    timeoutMs,
    quality,
    manualFormatId,
    preferredCodec,
    includeReuseScenarios: input.includeReuseScenarios !== false
  };
}

async function runTurboBenchmark(videoUrl, candidateOptions = {}) {
  if (activeTurboBenchmark) {
    throw new Error('Ya hay un benchmark LTE en curso');
  }

  ensureInternetAccess('El benchmark de LTE');
  validateMediaUrl(videoUrl, 'lte');
  const options = normalizeTurboBenchmarkOptions(candidateOptions);
  const controller = new AbortController();
  activeTurboBenchmark = { controller, startedAt: Date.now() };
  try {
    const runner = new BenchmarkRunner({
      turboEngine: getTurboEngineInstance(),
      baselineName: 'yt-dlp tradicional',
      // The reference path deliberately bypasses LTE. Both paths run a fresh
      // yt-dlp resolution under equivalent quality/timeout conditions.
      baselineResolver: (url, resolverOptions) => ytdlpService.extract(url, resolverOptions)
    });
    const result = await runner.run(videoUrl, { ...options, signal: controller.signal });
    lastTurboBenchmark = result;
    return result;
  } finally {
    activeTurboBenchmark = null;
  }
}

function getLseEngineInstance() {
  if (lseEngine) return lseEngine;
  // La inicialización normal ocurre en app.whenReady(). Este fallback sólo
  // protege IPCs tempranos sin volver a depender de extractores heredados.
  initializeLseEngine();
  return lseEngine;
}

function getLseSettings() {
  return getLseEngineInstance().getSettings();
}

function sanitizeLseSettingsPatch(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('La configuración de LSE debe ser un objeto JSON');
  }

  const allowedKeys = new Set(Object.keys(DEFAULT_LSE_SETTINGS));
  const sanitized = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (!allowedKeys.has(key) || key === 'engine' || key === 'configVersion') continue;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (['string', 'number', 'boolean'].includes(typeof value)) sanitized[key] = value;
  }
  return sanitized;
}

async function updateLseSettings(candidate) {
  const patch = sanitizeLseSettingsPatch(candidate);
  const engine = getLseEngineInstance();
  const settings = engine.updateSettings(patch);
  store.set('lseSettings', settings);

  // La caché multimedia global es la autoridad. LSE sólo administra su
  // configuración de resolución; no puede sobrescribir la preferencia de
  // almacenamiento elegida por el usuario.
  return settings;
}

function applyLseExtractorStates(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return getLseEngineInstance().getExtractorStatus();
  }

  const engine = getLseEngineInstance();
  const available = new Set(engine.getExtractorStatus().map(extractor => extractor.id));
  // Un archivo importado describe el estado completo: antes de aplicar sus
  // excepciones se vuelve al valor predeterminado (todos disponibles).
  engine.getExtractorStatus().forEach((extractor) => {
    if (extractor.enabled === false) engine.setExtractorEnabled(extractor.id, true);
  });
  const persisted = {};
  for (const [id, enabled] of Object.entries(candidate)) {
    if (!available.has(id) || typeof enabled !== 'boolean') continue;
    const status = engine.setExtractorEnabled(id, enabled);
    persisted[status.id] = status.enabled;
  }
  store.set('lseExtractorStates', persisted);
  return engine.getExtractorStatus();
}

function requireMainWindowSender(event) {
  if (!isMainWindowSender(event)) {
    throw new Error('Solicitud del motor de streaming no autorizada');
  }
}

function configureNetworkInterception() {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (networkAccessEnabled) {
      callback({ cancel: false });
      return;
    }

    const url = details.url || '';
    const isRemote = url.startsWith('http://') || url.startsWith('https://');
    const isLocalProxy = url.startsWith(`http://${AUDIO_PROXY_HOST}:`) || url.startsWith('http://localhost:');
    let isTrustedInterfaceAsset = false;

    try {
      const parsedUrl = new URL(url);
      const host = parsedUrl.hostname.toLowerCase();
      isTrustedInterfaceAsset = [
        'cdnjs.cloudflare.com',
        'fonts.googleapis.com',
        'fonts.gstatic.com'
      ].includes(host);
    } catch (error) {}

    callback({ cancel: isRemote && !isLocalProxy && !isTrustedInterfaceAsset });
  });
}

function getStreamingQualityLabel(value) {
  const labels = {
    low: 'Baja (128kbps)',
    medium: 'Media (256kbps)',
    high: 'Alta (320kbps)',
    lossless: 'Sin pérdida'
  };
  return labels[value] || value || 'Desconocida';
}

console.log('Inicializando aplicación Electron...');

// Crear tablas al iniciar
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT UNIQUE,
      title TEXT,
      artist TEXT,
      thumbnail TEXT,
      url TEXT,
      duration INTEGER,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT UNIQUE,
      title TEXT,
      artist TEXT,
      thumbnail TEXT,
      url TEXT,
      duration INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS recently_played (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT UNIQUE,
      title TEXT,
      artist TEXT,
      thumbnail TEXT,
      url TEXT,
      duration INTEGER,
      played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS library (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT UNIQUE,
      title TEXT,
      artist TEXT,
      thumbnail TEXT,
      url TEXT,
      duration INTEGER,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS playlist_songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER,
      video_id TEXT,
      FOREIGN KEY (playlist_id) REFERENCES playlists(id),
      FOREIGN KEY (video_id) REFERENCES library(video_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE,
      value TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS local_music (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT UNIQUE,
      title TEXT,
      artist TEXT,
      album TEXT,
      thumbnail TEXT,
      url TEXT,
      local_path TEXT,
      file_size INTEGER,
      file_type TEXT,
      duration INTEGER,
      file_data BLOB,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Preserve cache metadata independently from listening history.
  db.run(`
    CREATE TABLE IF NOT EXISTS audio_cache_metadata (
      video_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT,
      thumbnail TEXT,
      url TEXT,
      duration INTEGER,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// Migrar datos de userData.json si existe
function migrateUserData() {
  if (store.get(LEGACY_USER_DATA_MIGRATION_KEY, false)) {
    return;
  }

  const jsonPath = path.join(__dirname, 'userData.json');
  if (fs.existsSync(jsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (data.recentlyPlayed && Array.isArray(data.recentlyPlayed)) {
        data.recentlyPlayed.forEach(track => {
          db.run(`
            INSERT OR IGNORE INTO recently_played (video_id, title, artist, thumbnail, url, duration)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [track.id, track.title, track.artist, track.thumbnail, track.url, track.duration], (err) => {
            if (err) console.error('Error al migrar recently_played:', err);
          });
        });
      }
      if (data.recommendations && Array.isArray(data.recommendations)) {
        data.recommendations.forEach(track => {
          db.run(`
            INSERT OR IGNORE INTO recommendations (video_id, title, artist, thumbnail, url, duration)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [track.id, track.title, track.artist, track.thumbnail, track.url, track.duration], (err) => {
            if (err) console.error('Error al migrar recommendations:', err);
          });
        });
      }
      console.log('Datos de userData.json migrados a SQLite');
    } catch (error) {
      console.error('Error al migrar datos de userData.json:', error);
    }
  } else {
    console.log('No se encontró userData.json para migrar');
  }
  // This file is a one-time migration source, not a backup to restore after
  // the user has reset the application.
  store.set(LEGACY_USER_DATA_MIGRATION_KEY, true);
}

// Actualizar historial de reproducción
function updatePlaybackHistory(track, expectedDataGeneration = applicationDataGeneration) {
  const trackId = getTrackId(track);
  if (expectedDataGeneration !== applicationDataGeneration) {
    return;
  }

  // Never persist a temporary fallback title: that was the source of the
  // permanent "Audio en caché (...)" names after playing old cache files.
  if (!trackId || !hasUsableTrackTitle(track?.title)) {
    console.warn('Se omitió guardar en el historial una pista sin metadata válida de caché');
    return;
  }

  db.run(`
    INSERT OR REPLACE INTO recently_played (video_id, title, artist, thumbnail, url, duration)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [trackId, track.title, track.artist, track.thumbnail, track.url, track.duration], (err) => {
    if (err) {
      console.error('Error al guardar en recently_played:', err);
      return;
    }

    db.run(`
      UPDATE recently_played
      SET played_at = CURRENT_TIMESTAMP
      WHERE video_id = ?
    `, [trackId], (updateErr) => {
      if (updateErr) console.error('Error al actualizar played_at:', updateErr);
      else console.log('Historial actualizado:', track.title);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ changes: this.changes || 0 });
    });
  });
}

function getTrackId(track = {}) {
  return String(track.id || track.video_id || '').trim();
}

function isTemporaryCacheTitle(title = '') {
  return /^audio en cach(?:e|é)(?:\s|\(|$)/i.test(String(title).trim());
}

function hasUsableTrackTitle(title = '') {
  const normalizedTitle = String(title).trim();
  return Boolean(normalizedTitle) && !isTemporaryCacheTitle(normalizedTitle);
}

function getAudioCacheDirectory() {
  return path.join(app.getPath('userData'), AUDIO_CACHE_DIRECTORY_NAME);
}

function normalizeCacheMetadata(track = {}) {
  const videoId = getTrackId(track);
  const title = String(track.title || '').trim();
  if (!videoId || !hasUsableTrackTitle(title)) return null;

  const duration = Number(track.duration);
  return {
    video_id: videoId,
    title,
    artist: String(track.artist || '').trim(),
    thumbnail: String(track.thumbnail || '').trim(),
    url: String(track.url || `https://www.youtube.com/watch?v=${videoId}`).trim(),
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0
  };
}

function saveAudioCacheMetadata(track, expectedDataGeneration = applicationDataGeneration) {
  const metadata = normalizeCacheMetadata(track);
  if (!metadata || expectedDataGeneration !== applicationDataGeneration) return Promise.resolve(false);

  return dbRun(`
    INSERT INTO audio_cache_metadata (video_id, title, artist, thumbnail, url, duration, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(video_id) DO UPDATE SET
      title = excluded.title,
      artist = CASE WHEN excluded.artist <> '' THEN excluded.artist ELSE audio_cache_metadata.artist END,
      thumbnail = CASE WHEN excluded.thumbnail <> '' THEN excluded.thumbnail ELSE audio_cache_metadata.thumbnail END,
      url = CASE WHEN excluded.url <> '' THEN excluded.url ELSE audio_cache_metadata.url END,
      duration = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE audio_cache_metadata.duration END,
      updated_at = CURRENT_TIMESTAMP
  `, [
    metadata.video_id,
    metadata.title,
    metadata.artist,
    metadata.thumbnail,
    metadata.url,
    metadata.duration
  ]).then(() => expectedDataGeneration === applicationDataGeneration);
}

async function getStoredTrackMetadata(videoId) {
  const normalizedVideoId = String(videoId || '').trim();
  if (!normalizedVideoId) return null;

  // Cache metadata is deliberately first. The other tables are fallbacks for
  // cache files created by an older version of the application.
  const tables = [
    'audio_cache_metadata',
    'recently_played',
    'recommendations',
    'library',
    'favorites'
  ];

  for (const table of tables) {
    try {
      const metadata = await dbGet(
        `SELECT video_id, title, artist, thumbnail, url, duration FROM ${table} WHERE video_id = ? LIMIT 1`,
        [normalizedVideoId]
      );

      if (!metadata || !hasUsableTrackTitle(metadata.title)) continue;

      const normalized = {
        ...metadata,
        id: metadata.video_id || normalizedVideoId
      };

      // Opportunistically repair metadata for cache files created before the
      // dedicated cache index existed.
      if (table !== 'audio_cache_metadata') {
        saveAudioCacheMetadata(normalized).catch((error) => {
          console.warn('No se pudo migrar metadata de caché:', error.message);
        });
      }

      return normalized;
    } catch (error) {
      console.warn(`No se pudo leer metadata de ${table}:`, error.message);
    }
  }

  return null;
}

function normalizeArtistName(artist = '') {
  return artist
    .toLowerCase()
    .replace(/\s*-\s*topic$/i, '')
    .replace(/\bofficial\b/gi, '')
    .replace(/\bvevo\b/gi, '')
    .replace(/[^\p{L}\p{N}\s&]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitleTerms(title = '') {
  return title
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(term => term.length >= 4)
    .filter(term => !['official', 'video', 'audio', 'lyrics', 'remix', 'live'].includes(term));
}

async function buildRecommendationProfile() {
  const [recentRows, favoriteRows, libraryRows, localRows] = await Promise.all([
    dbAll('SELECT * FROM recently_played ORDER BY played_at DESC LIMIT 60'),
    dbAll('SELECT * FROM favorites ORDER BY added_at DESC LIMIT 40'),
    dbAll('SELECT * FROM library ORDER BY added_at DESC LIMIT 60'),
    dbAll('SELECT * FROM local_music ORDER BY added_at DESC LIMIT 40')
  ]);

  const artistWeights = new Map();
  const titleWeights = new Map();
  const excludeIds = new Set();
  const excludeTitles = new Set();

  const ingest = (rows, baseWeight) => {
    rows.forEach((row, index) => {
      const recencyWeight = Math.max(1, baseWeight - index * 0.08);
      const normalizedArtist = normalizeArtistName(row.artist || '');
      if (normalizedArtist) {
        artistWeights.set(normalizedArtist, (artistWeights.get(normalizedArtist) || 0) + recencyWeight);
      }

      extractTitleTerms(row.title || '').forEach((term) => {
        titleWeights.set(term, (titleWeights.get(term) || 0) + recencyWeight * 0.5);
      });

      if (row.video_id) excludeIds.add(row.video_id);
      if (row.id) excludeIds.add(row.id);
      if (row.title) excludeTitles.add(row.title.toLowerCase().trim());
    });
  };

  ingest(recentRows, 6);
  ingest(favoriteRows, 4.5);
  ingest(libraryRows, 2.5);
  ingest(localRows, 1.5);

  const topArtists = [...artistWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([artist, weight]) => ({ artist, weight }));

  const topTerms = [...titleWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([term]) => term);

  return { topArtists, topTerms, excludeIds, excludeTitles };
}

function buildRecommendationQueries(profile) {
  const queries = [];
  profile.topArtists.forEach(({ artist }, index) => {
    queries.push({ q: `${artist} songs`, focusArtist: artist, weight: 12 - index });
    queries.push({ q: `${artist} official audio`, focusArtist: artist, weight: 10 - index });
    queries.push({ q: `${artist} topic`, focusArtist: artist, weight: 8 - index });
  });

  if (profile.topArtists.length >= 2) {
    const combo = `${profile.topArtists[0].artist} ${profile.topArtists[1].artist}`;
    queries.push({ q: `${combo} similar`, focusArtist: profile.topArtists[0].artist, weight: 5 });
  }

  if (!queries.length && profile.topTerms.length) {
    queries.push({ q: profile.topTerms.slice(0, 3).join(' '), focusArtist: '', weight: 4 });
  }

  if (!queries.length) {
    queries.push({ q: 'music recommendations', focusArtist: '', weight: 1 });
  }

  return queries.slice(0, 10);
}

function scoreRecommendationCandidate(video, query, profile, rank) {
  const normalizedArtist = normalizeArtistName(video.artist || '');
  const normalizedTitle = (video.title || '').toLowerCase().trim();
  const titleTerms = extractTitleTerms(video.title || '');

  let score = Math.max(0, 18 - rank);
  if (query.focusArtist && normalizedArtist.includes(query.focusArtist)) score += 30;

  profile.topArtists.forEach(({ artist, weight }) => {
    if (normalizedArtist.includes(artist)) score += weight * 4;
  });

  titleTerms.forEach((term) => {
    if (profile.topTerms.includes(term)) score += 3;
  });

  if (normalizedTitle.includes('full album') || normalizedTitle.includes('mix') || normalizedTitle.includes('playlist')) {
    score -= 10;
  }

  if (profile.excludeTitles.has(normalizedTitle)) score -= 40;
  return score + (query.weight || 0);
}

async function persistRecommendations(recommendations, expectedDataGeneration = applicationDataGeneration) {
  if (expectedDataGeneration !== applicationDataGeneration) return false;
  await new Promise((resolve) => db.run('DELETE FROM recommendations', () => resolve()));
  if (expectedDataGeneration !== applicationDataGeneration) return false;
  await Promise.all(recommendations.map((track) => new Promise((resolve) => {
    db.run(`
      INSERT OR REPLACE INTO recommendations (video_id, title, artist, thumbnail, url, duration)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [track.id, track.title, track.artist, track.thumbnail, track.url, track.duration], () => resolve());
  })));
  return expectedDataGeneration === applicationDataGeneration;
}

// Version nueva: recomendaciones afinadas por artista dominante, historial y titulos escuchados.
async function generateRecommendations(seedArtist = '', expectedDataGeneration = applicationDataGeneration) {
  try {
    if (expectedDataGeneration !== applicationDataGeneration) return [];
    ensureInternetAccess('Las recomendaciones');
    const profile = await buildRecommendationProfile();
    if (expectedDataGeneration !== applicationDataGeneration) return [];

    if (seedArtist) {
      const normalizedSeed = normalizeArtistName(seedArtist);
      const exists = profile.topArtists.find(item => item.artist === normalizedSeed);
      if (!exists && normalizedSeed) {
        profile.topArtists.unshift({ artist: normalizedSeed, weight: 8 });
      }
    }

    const queries = buildRecommendationQueries(profile);
    const unique = new Map();

    console.log('Generando recomendaciones con perfil:', profile.topArtists.map(item => item.artist));

    for (const query of queries) {
      if (expectedDataGeneration !== applicationDataGeneration) return [];
      let searchResults = [];
      try {
        searchResults = await searchVideosSafely(query.q);
      } catch (searchError) {
        console.error('Error buscando recomendaciones para query:', query.q, searchError);
        continue;
      }

      searchResults.slice(0, 18).forEach((video, index) => {
        const id = video.id;
        if (!id || profile.excludeIds.has(id)) return;

        const title = video.original_title || video.title || 'Sin título';
        const normalizedTitle = title.toLowerCase().trim();
        if (profile.excludeTitles.has(normalizedTitle)) return;

        const candidate = {
          id,
          title,
          artist: video.artist || 'Desconocido',
          duration: video.duration || 0,
          thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
          url: `https://www.youtube.com/watch?v=${id}`,
          genre: query.focusArtist ? `Afin a ${query.focusArtist}` : 'Basado en tu escucha'
        };

        const score = scoreRecommendationCandidate(candidate, query, profile, index);
        if (score <= 0) return;

        const previous = unique.get(id);
        if (!previous || previous.score < score) {
          unique.set(id, { ...candidate, score });
        }
      });
    }

    const recommendations = [...unique.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);

    await persistRecommendations(recommendations, expectedDataGeneration);
    if (expectedDataGeneration !== applicationDataGeneration) return [];
    return recommendations;
  } catch (error) {
    console.error('Error en recomendaciones:', error);
    return [];
  }
}

function createWindow() {
  const isDev = !app.isPackaged;
  
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    icon: path.join(__dirname, 'assets', 'logo2.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      devTools: true, // Permitir DevTools siempre
    },
    backgroundColor: '#121212',
    show: false // Ocultar inicialmente para maximizar
  });
  console.log('Ventana principal creada');

  const createdWindow = mainWindow;
  createdWindow.webContents.on('did-finish-load', () => {
    if (createdWindow.isDestroyed()) return;
    const updateStatus = appUpdaterController?.getStatus?.();
    if (updateStatus) {
      try {
        createdWindow.webContents.send('app-update:ready', updateStatus);
      } catch (error) {
        console.warn('[updates] No se pudo reenviar la actualización al renderer:', error.message);
      }
    }
  });

  // Maximizar la ventana al inicio
  mainWindow.maximize();
  mainWindow.show();

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  setThumbarButtons(false);
  mainWindow.setThumbnailToolTip('Lunera');
  
  // Solo abrir DevTools automáticamente en modo desarrollo
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    gameOverlay?.dispose();
    gameOverlay = null;
    mainWindow = null;
    if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
      miniPlayerWindow.close();
    }
    console.log('Ventana principal cerrada');
  });
}

function getMiniPlayerBounds() {
  const defaultWidth = 390;
  const defaultHeight = 238;
  const savedBounds = store.get('miniPlayerBounds') || {};
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const width = Math.max(300, Math.min(700, Number(savedBounds.width) || defaultWidth));
  const height = Math.max(180, Math.min(460, Number(savedBounds.height) || defaultHeight));
  const savedX = Number(savedBounds.x);
  const savedY = Number(savedBounds.y);
  const hasSafeSavedPosition = Number.isFinite(savedX)
    && Number.isFinite(savedY)
    && savedX > workArea.x - width + 80
    && savedX < workArea.x + workArea.width - 80
    && savedY > workArea.y - height + 80
    && savedY < workArea.y + workArea.height - 80;

  return {
    width,
    height,
    x: hasSafeSavedPosition ? savedX : workArea.x + workArea.width - width - 24,
    y: hasSafeSavedPosition ? savedY : workArea.y + workArea.height - height - 24
  };
}

function persistMiniPlayerBounds() {
  if (!miniPlayerWindow || miniPlayerWindow.isDestroyed()) return;
  if (miniPlayerBoundsTimer) clearTimeout(miniPlayerBoundsTimer);
  miniPlayerBoundsTimer = setTimeout(() => {
    if (!miniPlayerWindow || miniPlayerWindow.isDestroyed()) return;
    store.set('miniPlayerBounds', miniPlayerWindow.getBounds());
  }, 180);
}

function sendMiniPlayerState(payload = latestPlayerState) {
  if (!miniPlayerWindow || miniPlayerWindow.isDestroyed()) return;
  miniPlayerWindow.webContents.send('mini-player:state', payload);
}

function createMiniPlayerWindow() {
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.show();
    miniPlayerWindow.focus();
    miniPlayerWindow.setAlwaysOnTop(true, 'screen-saver');
    sendMiniPlayerState();
    return miniPlayerWindow;
  }

  const bounds = getMiniPlayerBounds();
  miniPlayerWindow = new BrowserWindow({
    ...bounds,
    minWidth: 300,
    minHeight: 180,
    maxWidth: 760,
    maxHeight: 520,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, 'assets', 'logo2.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      devTools: true
    }
  });

  miniPlayerWindow.setAlwaysOnTop(true, 'screen-saver');
  miniPlayerWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  miniPlayerWindow.loadFile(path.join(__dirname, 'mini-player.html'));

  miniPlayerWindow.once('ready-to-show', () => {
    if (!miniPlayerWindow || miniPlayerWindow.isDestroyed()) return;
    miniPlayerWindow.show();
    sendMiniPlayerState();
  });

  miniPlayerWindow.on('move', persistMiniPlayerBounds);
  miniPlayerWindow.on('resize', persistMiniPlayerBounds);
  miniPlayerWindow.on('closed', () => {
    miniPlayerWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mini-player:closed');
    }
  });

  return miniPlayerWindow;
}

function setMiniPlayerEnabled(enabled) {
  if (enabled) {
    createMiniPlayerWindow();
    return true;
  }

  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.close();
  }
  return false;
}

// Manejo de controles de ventana
ipcMain.on('minimize-window', () => {
  console.log('Minimizando ventana');
  mainWindow.minimize();
});

ipcMain.on('maximize-window', () => {
  console.log('Maximizando/restaurando ventana');
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.on('close-window', () => {
  console.log('Cerrando ventana');
  mainWindow.close();
});

function isMainWindowSender(event) {
  return Boolean(
    mainWindow
    && !mainWindow.isDestroyed()
    && event?.sender === mainWindow.webContents
  );
}

ipcMain.handle('app-update:get-status', (event) => {
  if (!isMainWindowSender(event)) return null;
  return appUpdaterController?.getStatus?.() || null;
});

ipcMain.handle('app-update:install', (event) => {
  if (!isMainWindowSender(event)) return false;
  return appUpdaterController?.install?.() === true;
});

function normalizeVideoSearchResults(searchResponse) {
  if (Array.isArray(searchResponse)) return searchResponse;
  if (Array.isArray(searchResponse?.videos)) return searchResponse.videos;
  if (Array.isArray(searchResponse?.items)) return searchResponse.items;
  if (Array.isArray(searchResponse?.results)) return searchResponse.results;
  return [];
}

function normalizeLyricsSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*(official|video|audio|lyrics?|lyric video|remaster(?:ed)?|live|hd)[^)]*\)/gi, '')
    .replace(/\[[^\]]*(official|video|audio|lyrics?|lyric video|remaster(?:ed)?|live|hd)[^\]]*\]/gi, '')
    .replace(/\b(ft|feat|featuring)\.?\s+.+$/i, '')
    .replace(/\s*-\s*(official|audio|video|lyrics?|live|remaster(?:ed)?|hd).*$/i, '')
    .replace(/[^\w\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripArtistPrefixFromTitle(title, artist) {
  if (!title || !artist) return title;
  const escapedArtist = artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return title.replace(new RegExp(`^${escapedArtist}\\s*[-:|]\\s*`, 'i'), '').trim();
}

function buildLyricsSearchCandidates(track = {}) {
  const artist = normalizeLyricsSearchText(track.artist);
  const rawTitle = normalizeLyricsSearchText(track.title);

  if (!artist || !rawTitle) return [];

  const candidates = new Set();
  const addCandidate = (value) => {
    const normalized = normalizeLyricsSearchText(value);
    if (normalized) candidates.add(normalized);
  };

  addCandidate(rawTitle);
  addCandidate(stripArtistPrefixFromTitle(rawTitle, artist));

  const titleParts = rawTitle.split(/\s[-:|]\s/).map(part => normalizeLyricsSearchText(part)).filter(Boolean);
  titleParts.forEach(addCandidate);

  return Array.from(candidates).map(title => ({ artist, title }));
}

function requestLyrics(artist, title) {
  return new Promise((resolve, reject) => {
    lyricGet.get(artist, title, (error, lyrics) => {
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      const normalizedLyrics = String(lyrics || '').replace(/\r\n/g, '\n').trim();
      if (!normalizedLyrics) {
        reject(new Error('No se encontró la letra'));
        return;
      }

      resolve(normalizedLyrics);
    });
  });
}

async function requestLyricsFallback(artist, title) {
  const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`lyrics.ovh responded with ${response.status}`);
  }

  const payload = await response.json();
  const normalizedLyrics = String(payload?.lyrics || '').replace(/\r\n/g, '\n').trim();
  if (!normalizedLyrics) {
    throw new Error(payload?.error || 'No se encontró la letra');
  }

  return normalizedLyrics;
}

async function getLyricsForTrack(track = {}) {
  const candidates = buildLyricsSearchCandidates(track);

  if (!candidates.length) {
    throw new Error('No hay metadata suficiente para buscar la letra');
  }

  let lastError = null;

  for (const candidate of candidates) {
    try {
      console.log('Buscando letra con lyric-get:', candidate);
      const lyrics = await requestLyrics(candidate.artist, candidate.title);
      return {
        lyrics,
        search: { ...candidate, provider: 'lyric-get' }
      };
    } catch (error) {
      lastError = error;
      console.warn('lyric-get no encontró letra con variante:', candidate, error.message);
    }

    try {
      console.log('Buscando letra con lyrics.ovh:', candidate);
      const lyrics = await requestLyricsFallback(candidate.artist, candidate.title);
      return {
        lyrics,
        search: { ...candidate, provider: 'lyrics.ovh' }
      };
    } catch (error) {
      lastError = error;
      console.warn('lyrics.ovh no encontró letra con variante:', candidate, error.message);
    }
  }

  throw lastError || new Error('No se encontró la letra');
}

async function searchVideosSafely(query) {
  const response = await usetube.searchVideo(query);
  const videos = normalizeVideoSearchResults(response);

  if (!videos.length) {
    const responseShape = response && typeof response === 'object'
      ? Object.keys(response).join(', ')
      : typeof response;
    console.warn('usetube devolvió una respuesta sin videos para query:', query, 'shape:', responseShape || 'unknown');
  }

  return videos;
}

function getPlayableCachePath(candidates) {
  for (const candidate of candidates || []) {
    try {
      if (!candidate || !fs.existsSync(candidate)) continue;
      const stats = fs.statSync(candidate);
      if (!stats.isFile() || stats.size < 32768) {
        try { fs.unlinkSync(candidate); } catch (cleanupError) {}
        continue;
      }
      return candidate;
    } catch (error) {
      console.warn('No se pudo validar archivo de caché:', candidate, error.message);
    }
  }

  return null;
}

async function buildCacheLibrary() {
  const dir = getAudioCacheDirectory();
  try {
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir)
      .filter(name => new RegExp(`\\.(${AUDIO_CACHE_EXTENSIONS.join('|')})$`, 'i').test(name))
      .map(name => {
        const filePath = path.join(dir, name);
        const stats = fs.statSync(filePath);
        return {
          name,
          filePath,
          ext: path.extname(name).replace('.', '').toLowerCase(),
          videoId: path.basename(name, path.extname(name)),
          size: stats.size,
          modifiedAt: stats.mtimeMs
        };
      })
      .filter(file => file.size >= 32768)
      .sort((a, b) => b.modifiedAt - a.modifiedAt);

    const cacheItems = [];
    for (const file of files) {
      const meta = await getStoredTrackMetadata(file.videoId);

      cacheItems.push({
        id: file.videoId,
        video_id: file.videoId,
        title: meta?.title || `Audio en caché (${file.videoId})`,
        artist: meta?.artist || 'Desconocido',
        thumbnail: meta?.thumbnail || `https://i.ytimg.com/vi/${file.videoId}/mqdefault.jpg`,
        url: meta?.url || `https://www.youtube.com/watch?v=${file.videoId}`,
        duration: meta?.duration || 0,
        container: file.ext,
        size: file.size,
        modifiedAt: file.modifiedAt,
        path: file.filePath
      });
    }

    return cacheItems;
  } catch (error) {
    console.error('Error al construir biblioteca de caché:', error);
    return [];
  }
}

function getAudioExtensionFromExtraction(extraction = {}) {
  const rawContainer = extraction.selectedFormat?.container
    || extraction.selectedFormat?.ext
    || extraction.metadata?.streamingProfile?.container
    || 'webm';
  const ext = String(rawContainer).toLowerCase().split('/').pop().replace(/[^a-z0-9]/g, '');
  if (['m4a', 'mp4', 'mp3', 'webm', 'opus', 'ogg', 'aac', 'wav', 'flac'].includes(ext)) {
    return ext === 'opus' ? 'webm' : ext;
  }
  return 'webm';
}

function isPersistentAudioCacheAllowed(extraction = {}) {
  return extraction?.sourcePolicy?.allowPersistentCache === true
    || extraction?.sourcePolicy?.persistMedia === true;
}

async function buildCachedTrackData(videoId, videoUrl, requestedQuality, cachedPath) {
  const meta = videoId
    ? await getStoredTrackMetadata(videoId)
    : null;

  return {
    id: videoId,
    title: meta?.title || `Audio en caché (${videoId || 'sin-id'})`,
    artist: meta?.artist || 'Modo offline',
    thumbnail: meta?.thumbnail || (videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : ''),
    duration: meta?.duration || 0,
    url: meta?.url || videoUrl,
    streamingProfile: {
      source: 'cache',
      requested: requestedQuality || 'medium',
      requestedLabel: getStreamingQualityLabel(requestedQuality || 'medium'),
      container: path.extname(cachedPath || '').replace('.', '') || 'cache',
      effectiveBitrate: null,
      extractor: 'cache',
      extractorMode: audioExtractorPreference,
      usedFallback: false,
      extractionMs: 0
    }
  };
}

function getMemoryStreamCacheKey(videoUrl, quality, extractorMode = audioExtractorPreference, manualFormatId = '') {
  const videoId = getVideoId(videoUrl);
  const mediaKey = videoId || String(videoUrl || '').trim();
  const manualKey = String(manualFormatId || '').trim().slice(0, 80);
  return `${normalizeExtractorMode(extractorMode)}|${quality || 'medium'}|${manualKey}|${mediaKey}`;
}

function cloneStreamExtraction(extraction = {}) {
  return {
    ...extraction,
    metadata: extraction.metadata ? {
      ...extraction.metadata,
      streamingProfile: extraction.metadata.streamingProfile
        ? { ...extraction.metadata.streamingProfile }
        : extraction.metadata.streamingProfile
    } : extraction.metadata,
    formats: Array.isArray(extraction.formats)
      ? extraction.formats.map(format => ({ ...format }))
      : extraction.formats,
    selectedFormat: extraction.selectedFormat ? { ...extraction.selectedFormat } : extraction.selectedFormat,
    httpHeaders: extraction.httpHeaders ? { ...extraction.httpHeaders } : extraction.httpHeaders,
    sourcePolicy: extraction.sourcePolicy ? { ...extraction.sourcePolicy } : extraction.sourcePolicy,
    attempts: Array.isArray(extraction.attempts)
      ? extraction.attempts.map(attempt => ({ ...attempt }))
      : extraction.attempts
  };
}

function pruneMemoryStreamCache() {
  const now = Date.now();
  for (const [key, entry] of memoryStreamCache) {
    if (!entry || now - entry.createdAt > MEMORY_STREAM_TTL_MS) {
      memoryStreamCache.delete(key);
    }
  }

  if (memoryStreamCache.size <= 40) return;

  const oldest = [...memoryStreamCache.entries()]
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .slice(0, memoryStreamCache.size - 40);

  oldest.forEach(([key]) => memoryStreamCache.delete(key));
}

function isUsableMemoryStreamExtraction(extraction = {}) {
  const expiresAt = Number(extraction?.sourcePolicy?.expiresAt || extraction?.expiresAt || 0);
  // Keep a small safety margin so a just-expiring signed resource is resolved
  // again before the audio element has a chance to request it.
  return !Number.isFinite(expiresAt) || expiresAt <= 0 || expiresAt > Date.now() + 5_000;
}

function getMemoryCachedExtraction(cacheKey) {
  pruneMemoryStreamCache();
  const entry = memoryStreamCache.get(cacheKey);
  if (!entry) return null;

  if (Date.now() - entry.createdAt > MEMORY_STREAM_TTL_MS || !isUsableMemoryStreamExtraction(entry.extraction)) {
    memoryStreamCache.delete(cacheKey);
    return null;
  }

  entry.lastUsedAt = Date.now();
  return cloneStreamExtraction(entry.extraction);
}

function storeMemoryStreamExtraction(cacheKey, extraction) {
  if (!cacheKey || !extraction?.audioUrl || !isUsableMemoryStreamExtraction(extraction)) return;
  memoryStreamCache.set(cacheKey, {
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    extraction: cloneStreamExtraction(extraction)
  });
  pruneMemoryStreamCache();
}

function prepareExtractionForPlayback(extraction, fromMemoryCache = false) {
  const prepared = cloneStreamExtraction(extraction);
  if (fromMemoryCache && prepared.metadata?.streamingProfile) {
    prepared.metadata.streamingProfile = {
      ...prepared.metadata.streamingProfile,
      memoryCache: true,
      extractionMs: 0
    };
  }
  return prepared;
}

async function getOrExtractAudio(videoUrl, extractionOptions = {}, options = {}) {
  const mode = normalizeExtractorMode(extractionOptions.mode || audioExtractorPreference);
  const quality = extractionOptions.quality || 'medium';
  const cacheKey = getMemoryStreamCacheKey(videoUrl, quality, mode, extractionOptions.manualFormatId);
  const signal = extractionOptions.signal;

  throwIfPlaybackAborted(signal);

  if (options.forceRefresh) {
    memoryStreamCache.delete(cacheKey);
  } else {
    const cachedExtraction = getMemoryCachedExtraction(cacheKey);
    if (cachedExtraction) {
      throwIfPlaybackAborted(signal);
      return { extraction: cachedExtraction, cacheKey, fromMemoryCache: true };
    }

    const preloadJob = memoryStreamPreloadJobs.get(cacheKey);
    if (preloadJob) {
      try {
        const preloadedExtraction = await preloadJob;
        throwIfPlaybackAborted(signal);
        if (isUsableMemoryStreamExtraction(preloadedExtraction)) {
          return {
            extraction: cloneStreamExtraction(preloadedExtraction),
            cacheKey,
            fromMemoryCache: true
          };
        }
      } catch (error) {
        console.warn('[audio-preload] precarga descartada:', error.message);
      }
    }
  }

  const extraction = await extractAudio(videoUrl, {
    ...extractionOptions,
    mode,
    quality,
    // A provider refresh must also bypass LTE's in-memory resolved URL.
    forceRefresh: options.forceRefresh === true
  });
  throwIfPlaybackAborted(signal);
  storeMemoryStreamExtraction(cacheKey, extraction);

  return { extraction: cloneStreamExtraction(extraction), cacheKey, fromMemoryCache: false };
}

function buildRequestHeaders(headers = {}) {
  return {
    'User-Agent': headers['User-Agent'] || headers['user-agent'] || 'Mozilla/5.0',
    Accept: headers.Accept || headers.accept || '*/*',
    ...headers
  };
}

function sanitizeRendererProxyHeaders(headers = {}) {
  const allowed = new Set(['user-agent', 'accept', 'accept-language', 'referer', 'origin']);
  const sanitized = {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return sanitized;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = String(rawName || '').toLowerCase();
    const value = String(rawValue || '').trim();
    if (!allowed.has(name) || !value || value.length > 1024 || /[\r\n]/.test(value)) continue;
    sanitized[name] = value;
  }
  return sanitized;
}

function cleanupAudioProxyEntries() {
  const now = Date.now();
  for (const [token, entry] of audioProxyEntries) {
    if (!entry || now - entry.createdAt > AUDIO_PROXY_TTL_MS) {
      releaseAudioProxyEntry(token, entry);
    }
  }
}

function releaseAudioProxyEntry(token, entry = audioProxyEntries.get(token)) {
  if (entry?.timeout) clearTimeout(entry.timeout);
  audioProxyEntries.delete(token);
  if (entry?.lteSessionId) {
    try { getTurboEngineInstance().streamManager.remove(entry.lteSessionId); } catch (error) {}
  }
}

function createAudioProxyUrl(extraction = {}, options = {}) {
  if (!audioProxyPort) {
    throw new Error('El proxy local de audio no esta listo');
  }

  validateProxyableAudioUrl(extraction.audioUrl, extraction.sourcePolicy);

  const isLteStream = extraction?.engine === 'lte' || extraction?.extractor === 'lte';
  let token = crypto.randomBytes(24).toString('hex');
  let lteSession = null;
  let sessionData = null;
  if (isLteStream) {
    lteSession = getTurboEngineInstance().createStreamSession(extraction, {
      requestId: options.requestId,
      resolutionKey: extraction?.lte?.resolutionKey
    });
    token = lteSession.id;
    sessionData = getTurboEngineInstance().getStreamSession(token);
  }
  const expiresAt = Number(sessionData?.expiresAt || extraction?.sourcePolicy?.expiresAt || 0);
  const ttlMs = Number.isFinite(expiresAt) && expiresAt > Date.now()
    ? Math.max(1_000, Math.min(AUDIO_PROXY_TTL_MS, expiresAt - Date.now()))
    : AUDIO_PROXY_TTL_MS;
  const timeout = setTimeout(() => {
    releaseAudioProxyEntry(token);
  }, ttlMs);
  if (typeof timeout.unref === 'function') timeout.unref();

  audioProxyEntries.set(token, {
    audioUrl: sessionData?.audioUrl || extraction.audioUrl,
    httpHeaders: sessionData?.httpHeaders || extraction.httpHeaders || {},
    sourcePolicy: sessionData?.sourcePolicy || extraction.sourcePolicy || null,
    createdAt: Date.now(),
    timeout,
    lteSessionId: lteSession?.id || null,
    requestId: String(options.requestId || extraction?.lte?.requestId || '').slice(0, 96),
    videoUrl: options.videoUrl || extraction?.metadata?.url || '',
    quality: options.quality || extraction?.metadata?.streamingProfile?.requested || 'medium',
    extractorMode: options.extractorMode || extraction?.mode || audioExtractorPreference,
    refreshAttempts: 0
  });
  cleanupAudioProxyEntries();

  return `http://${AUDIO_PROXY_HOST}:${audioProxyPort}/audio/${token}`;
}

function validateProxyableAudioUrl(audioUrl, sourcePolicy = null) {
  let parsedUrl;
  try {
    parsedUrl = new URL(audioUrl);
  } catch (error) {
    throw new Error('URL directa de audio inválida');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('La URL directa de audio debe usar http o https');
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const isLseDirectMedia = sourcePolicy?.type === 'direct-media'
    && sourcePolicy.publicNetworkOnly === true;

  if (isLseDirectMedia) {
    if (isBlockedHostname(hostname)) {
      throw new Error('El proxy LSE bloqueó un destino local o interno');
    }
    if (net.isIP(hostname) && isUnsafeIp(hostname)) {
      throw new Error('El proxy LSE bloqueó una IP privada');
    }
    if (sourcePolicy.approvedHost && hostname !== String(sourcePolicy.approvedHost).toLowerCase()) {
      throw new Error('La redirección de LSE cambió a un host no aprobado');
    }
    return true;
  }

  const isAllowedMediaHost = hostname === 'googlevideo.com'
    || hostname.endsWith('.googlevideo.com')
    || hostname === 'youtube.com'
    || hostname.endsWith('.youtube.com');

  if (!isAllowedMediaHost) {
    throw new Error('Solo se puede proxificar audio de YouTube');
  }
}

function isLseDirectMediaPolicy(sourcePolicy = null) {
  return sourcePolicy?.type === 'direct-media' && sourcePolicy.publicNetworkOnly === true;
}

async function getLseProxyDestination(parsedUrl, sourcePolicy) {
  if (!isLseDirectMediaPolicy(sourcePolicy)) return null;

  const approvedAddress = String(sourcePolicy.approvedAddress || '').trim();
  if (approvedAddress && !isUnsafeIp(approvedAddress)) {
    return {
      address: approvedAddress,
      family: approvedAddress.includes(':') ? 6 : 4
    };
  }

  // Compatibilidad con entradas de caché creadas antes de que LSE almacenara
  // la IP validada: se vuelve a validar y fija la resolución para este stream.
  const destination = await getLseEngineInstance().networkManager.assertPublicUrl(parsedUrl.toString());
  return { address: destination.address, family: destination.family };
}

function copyAudioProxyHeaders(remoteResponse, clientResponse) {
  const allowedHeaders = [
    'accept-ranges',
    'cache-control',
    'content-length',
    'content-range',
    'content-type',
    'etag',
    'last-modified'
  ];

  for (const header of allowedHeaders) {
    const value = remoteResponse.headers[header];
    if (value !== undefined) {
      clientResponse.setHeader(header, value);
    }
  }

  if (!remoteResponse.headers['cache-control']) {
    clientResponse.setHeader('cache-control', 'no-store');
  }

  clientResponse.setHeader('access-control-allow-origin', '*');
  clientResponse.setHeader('timing-allow-origin', '*');
}

async function refreshExpiredAudioProxyEntry(entry) {
  if (!entry) return false;
  if (entry.refreshPromise) return entry.refreshPromise;

  const refreshPromise = refreshExpiredAudioProxyEntryOnce(entry);
  entry.refreshPromise = refreshPromise;
  try {
    return await refreshPromise;
  } finally {
    if (entry.refreshPromise === refreshPromise) entry.refreshPromise = null;
  }
}

async function refreshExpiredAudioProxyEntryOnce(entry) {
  const isLteEntry = entry?.lteSessionId && entry?.extractorMode === 'lte';
  if (!isLteEntry || !entry.videoUrl || entry.refreshAttempts >= 1) return false;
  entry.refreshAttempts += 1;
  try {
    const result = await getOrExtractAudio(entry.videoUrl, {
      mode: 'lte',
      quality: entry.quality || 'medium',
      timeoutMs: getTurboSettings().extractionTimeoutMs,
      requestId: entry.requestId || `refresh-${Date.now()}`
    }, { forceRefresh: true });
    const extraction = prepareExtractionForPlayback(result.extraction, result.fromMemoryCache);
    validateProxyableAudioUrl(extraction.audioUrl, extraction.sourcePolicy);
    const refreshedSession = getTurboEngineInstance().refreshStreamSession(entry.lteSessionId, extraction);
    entry.audioUrl = refreshedSession?.audioUrl || extraction.audioUrl;
    entry.httpHeaders = refreshedSession?.httpHeaders || extraction.httpHeaders || {};
    entry.sourcePolicy = refreshedSession?.sourcePolicy || extraction.sourcePolicy || null;
    entry.refreshAttempts = 0;
    return true;
  } catch (error) {
    console.warn('[audio-proxy] no se pudo renovar el recurso LTE expirado:', error.message);
    return false;
  }
}

async function proxyRemoteAudio(entry, clientRequest, clientResponse, sourceUrl = entry.audioUrl, redirectCount = 0) {
  let parsedUrl;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch (error) {
    clientResponse.writeHead(502);
    clientResponse.end('URL de audio invalida');
    return;
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    clientResponse.writeHead(502);
    clientResponse.end('Protocolo de audio invalido');
    return;
  }

  try {
    validateProxyableAudioUrl(sourceUrl, entry.sourcePolicy);
  } catch (validationError) {
    clientResponse.writeHead(502, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store'
    });
    clientResponse.end(`Destino de audio bloqueado: ${validationError.message}`);
    return;
  }

  let lseDestination = null;
  try {
    lseDestination = await getLseProxyDestination(parsedUrl, entry.sourcePolicy);
  } catch (validationError) {
    clientResponse.writeHead(502, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store'
    });
    clientResponse.end(`Destino de audio bloqueado: ${validationError.message}`);
    return;
  }
  if (clientResponse.destroyed) return;

  const headers = buildRequestHeaders(entry.httpHeaders);
  if (clientRequest.headers.range && entry.sourcePolicy?.supportsRange !== false) {
    headers.Range = clientRequest.headers.range;
  }

  const transport = parsedUrl.protocol === 'https:' ? https : http;
  const requestOptions = {
    protocol: parsedUrl.protocol,
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || undefined,
    path: `${parsedUrl.pathname}${parsedUrl.search}`,
    method: clientRequest.method === 'HEAD' ? 'HEAD' : 'GET',
    headers
  };
  if (lseDestination) {
    requestOptions.lookup = (hostname, options, callback) => callback(null, lseDestination.address, lseDestination.family);
    if (parsedUrl.protocol === 'https:') requestOptions.servername = parsedUrl.hostname;
  }
  let completed = false;
  let upstreamResponseRef = null;
  if (entry.lteSessionId) getTurboEngineInstance().streamManager.markRequest(entry.lteSessionId);
  const upstreamRequest = transport.request(requestOptions, (upstreamResponse) => {
    upstreamResponseRef = upstreamResponse;
    if ([301, 302, 303, 307, 308].includes(upstreamResponse.statusCode) && upstreamResponse.headers.location) {
      upstreamResponse.resume();
      if (redirectCount >= 5) {
        clientResponse.writeHead(502);
        clientResponse.end('Demasiadas redirecciones de audio');
        return;
      }

      const redirectedUrl = new URL(upstreamResponse.headers.location, parsedUrl).toString();
      try {
        validateProxyableAudioUrl(redirectedUrl, entry.sourcePolicy);
      } catch (validationError) {
        clientResponse.writeHead(502, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store'
        });
        clientResponse.end(`Redirección de audio bloqueada: ${validationError.message}`);
        return;
      }
      void proxyRemoteAudio(entry, clientRequest, clientResponse, redirectedUrl, redirectCount + 1);
      return;
    }

    if ([403, 410].includes(upstreamResponse.statusCode) && !clientResponse.headersSent) {
      upstreamResponse.resume();
      void refreshExpiredAudioProxyEntry(entry).then((refreshed) => {
        if (refreshed && !clientResponse.destroyed) {
          void proxyRemoteAudio(entry, clientRequest, clientResponse, entry.audioUrl, redirectCount + 1);
          return;
        }
        clientResponse.writeHead(502, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store'
        });
        clientResponse.end('El recurso de audio expiró y no se pudo renovar');
      });
      return;
    }

    if (upstreamResponse.statusCode === 416) {
      copyAudioProxyHeaders(upstreamResponse, clientResponse);
      upstreamResponse.resume();
      clientResponse.writeHead(416);
      clientResponse.end();
      return;
    }

    if (upstreamResponse.statusCode < 200 || upstreamResponse.statusCode >= 300) {
      upstreamResponse.resume();
      if (entry.lteSessionId) getTurboEngineInstance().recordStreamFailure(entry.lteSessionId);
      if (!clientResponse.headersSent) {
        clientResponse.writeHead(502, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store'
        });
      }
      clientResponse.end(`El servidor de audio respondió HTTP ${upstreamResponse.statusCode}`);
      return;
    }

    copyAudioProxyHeaders(upstreamResponse, clientResponse);
    clientResponse.writeHead(upstreamResponse.statusCode || 200);
    if (clientRequest.method === 'HEAD') {
      completed = true;
      upstreamResponse.resume();
      clientResponse.end();
      return;
    }

    let firstChunk = true;
    upstreamResponse.on('data', (chunk) => {
      if (!entry.lteSessionId) return;
      if (firstChunk) {
        firstChunk = false;
        getTurboEngineInstance().recordStreamFirstByte(entry.lteSessionId, entry.requestId);
      }
      getTurboEngineInstance().recordStreamChunk(entry.lteSessionId, chunk.length);
    });

    upstreamResponse.on('end', () => {
      completed = true;
    });

    upstreamResponse.on('aborted', () => {
      if (!completed) {
        if (entry.lteSessionId) getTurboEngineInstance().recordStreamFailure(entry.lteSessionId);
        console.warn('[audio-proxy] upstream abortado por el servidor remoto');
        clientResponse.destroy(new Error('Stream remoto de audio abortado'));
      }
    });

    upstreamResponse.on('error', (error) => {
      if (!completed) {
        if (entry.lteSessionId) getTurboEngineInstance().recordStreamFailure(entry.lteSessionId);
        console.warn('[audio-proxy] error leyendo audio remoto:', error.message);
        clientResponse.destroy(error);
      }
    });

    upstreamResponse.pipe(clientResponse);
  });

  upstreamRequest.end();

  upstreamRequest.setTimeout(60000, () => {
    upstreamRequest.destroy(new Error('Timeout del proxy local de audio'));
  });

  upstreamRequest.on('error', (error) => {
    if (completed || clientResponse.destroyed) return;
    if (!clientResponse.headersSent) {
      clientResponse.writeHead(502, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store'
      });
      clientResponse.end(`Error del proxy local de audio: ${error.message}`);
      return;
    }
    clientResponse.destroy(error);
  });

  clientResponse.on('finish', () => {
    completed = true;
  });

  clientResponse.on('close', () => {
    if (completed) return;
    if (upstreamResponseRef && !upstreamResponseRef.destroyed) {
      upstreamResponseRef.destroy();
    }
    if (!upstreamRequest.destroyed) {
      upstreamRequest.destroy();
    }
  });
}

function handleAudioProxyRequest(request, response) {
  try {
    const requestUrl = new URL(request.url, `http://${AUDIO_PROXY_HOST}`);
    const match = requestUrl.pathname.match(/^\/audio\/([a-f0-9]{48})$/);
    if (!match) {
      response.writeHead(404);
      response.end('No encontrado');
      return;
    }

    const entry = audioProxyEntries.get(match[1]);
    if (!entry) {
      response.writeHead(404);
      response.end('Audio expirado');
      return;
    }

    void proxyRemoteAudio(entry, request, response);
  } catch (error) {
    response.writeHead(500);
    response.end(`Error del proxy local de audio: ${error.message}`);
  }
}

function startAudioProxyServer() {
  if (audioProxyServer && audioProxyPort) {
    return Promise.resolve(audioProxyPort);
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer(handleAudioProxyRequest);
    server.on('clientError', (error, socket) => {
      try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (socketError) {}
    });
    server.on('error', reject);
    server.listen(0, AUDIO_PROXY_HOST, () => {
      audioProxyServer = server;
      audioProxyPort = server.address().port;
      console.log(`Proxy local de audio iniciado en ${AUDIO_PROXY_HOST}:${audioProxyPort}`);
      resolve(audioProxyPort);
    });
  });
}

function sendPlaybackProgress(webContents, event = {}) {
  const payload = {
    ts: Date.now(),
    ...event
  };

  const stage = payload.stage || payload.type || 'progress';
  const detail = payload.message ? ` ${payload.message}` : '';
  const elapsed = typeof payload.elapsedMs === 'number' ? ` (${payload.elapsedMs}ms)` : '';
  console.log(`[playback-progress] ${stage}${elapsed}${detail}`);

  if (webContents && !webContents.isDestroyed()) {
    webContents.send('audio-extractor:progress', payload);
  }
}

function createAudioCacheClearedError() {
  const error = new Error('La descarga de caché fue cancelada porque la caché se vació');
  error.code = 'AUDIO_CACHE_CLEARED';
  return error;
}

function isAudioCacheClearedError(error) {
  return error?.code === 'AUDIO_CACHE_CLEARED';
}

function downloadUrlToFile(
  audioUrl,
  targetPath,
  headers = {},
  timeoutMs = 60000,
  redirectCount = 0,
  onProgress = null,
  signal = null
) {
  return new Promise((resolve, reject) => {
    let request = null;
    let response = null;
    let writeStream = null;
    let settled = false;

    const cleanupAbortListener = () => {
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanupAbortListener();
      if (error) reject(error);
      else resolve(true);
    };
    const abortListener = () => {
      const error = createAudioCacheClearedError();
      if (response && !response.destroyed) response.destroy(error);
      if (writeStream && !writeStream.destroyed) writeStream.destroy(error);
      if (request && !request.destroyed) request.destroy(error);
      finish(error);
    };

    if (signal?.aborted) {
      finish(createAudioCacheClearedError());
      return;
    }
    if (signal) signal.addEventListener('abort', abortListener, { once: true });

    let parsedUrl;
    try {
      parsedUrl = new URL(audioUrl);
    } catch (error) {
      finish(new Error('URL directa de audio inválida'));
      return;
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      finish(new Error('La URL directa de audio debe usar http o https'));
      return;
    }

    const transport = parsedUrl.protocol === 'https:' ? https : http;
    request = transport.get(parsedUrl, { headers: buildRequestHeaders(headers) }, (incomingResponse) => {
      response = incomingResponse;
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirectCount >= 3) {
          finish(new Error('Demasiadas redirecciones al descargar audio'));
          return;
        }
        const redirectedUrl = new URL(response.headers.location, parsedUrl).toString();
        downloadUrlToFile(
          redirectedUrl,
          targetPath,
          headers,
          timeoutMs,
          redirectCount + 1,
          onProgress,
          signal
        ).then(() => finish()).catch(finish);
        return;
      }

      // A cache entry must contain the complete resource, never an HTTP range.
      if (response.statusCode !== 200) {
        response.resume();
        finish(new Error(`La URL de audio respondió con HTTP ${response.statusCode}`));
        return;
      }

      writeStream = fs.createWriteStream(targetPath);
      const totalBytes = Number(response.headers['content-length'] || 0);
      let downloadedBytes = 0;

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (typeof onProgress === 'function' && totalBytes > 0) {
          onProgress({
            downloadedBytes,
            totalBytes,
            percent: Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
          });
        }
      });
      response.on('error', finish);
      response.pipe(writeStream);

      writeStream.on('finish', () => {
        writeStream.close(() => {
          if (!response.complete || (totalBytes > 0 && downloadedBytes !== totalBytes)) {
            finish(new Error('La descarga de audio quedó incompleta'));
          } else finish();
        });
      });
      writeStream.on('error', (error) => {
        if (response && !response.destroyed) response.destroy(error);
        finish(error);
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Timeout: La descarga de audio superó ${Math.round(timeoutMs / 1000)} segundos`));
    });
    request.on('error', finish);
  });
}

function cleanupPartialCacheFiles(cacheBase) {
  try {
    if (!cacheBase || !fs.existsSync(cacheBase)) return;
    fs.readdirSync(cacheBase)
      .filter(name => name.endsWith('.part'))
      .filter(name => ![...audioCacheJobs.values()].some(job => job.writeTargetPath === path.join(cacheBase, name)))
      .forEach(name => {
        try {
          fs.unlinkSync(path.join(cacheBase, name));
        } catch (error) {
          console.warn('No se pudo eliminar descarga parcial de caché:', name, error.message);
        }
      });
  } catch (error) {
    console.warn('No se pudo limpiar descargas parciales de caché:', error.message);
  }
}

async function cacheExtractedAudio(extraction, outPath, cacheSettings, cacheBase, onProgress = null) {
  const runningJob = audioCacheJobs.get(outPath);
  if (runningJob) return runningJob.promise;

  if (audioCacheClearPromise) {
    throw createAudioCacheClearedError();
  }

  const controller = new AbortController();
  const expectedCacheGeneration = audioCacheGeneration;
  const writeTargetPath = `${outPath}.${Date.now()}-${crypto.randomBytes(4).toString('hex')}.part`;
  let job;

  job = (async () => {
    try {
      await downloadUrlToFile(
        extraction.audioUrl,
        writeTargetPath,
        extraction.httpHeaders || {},
        60000,
        0,
        onProgress,
        controller.signal
      );

      if (controller.signal.aborted || expectedCacheGeneration !== audioCacheGeneration) {
        throw createAudioCacheClearedError();
      }

      const stats = fs.statSync(writeTargetPath);
      if (!stats.isFile() || stats.size < 32768) {
        try { if (fs.existsSync(writeTargetPath)) fs.unlinkSync(writeTargetPath); } catch (cleanupError) {}
        throw new Error('La descarga terminó vacía o incompleta y no se guardó en caché');
      }

      try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (cleanupError) {}
      if (controller.signal.aborted || expectedCacheGeneration !== audioCacheGeneration) {
        throw createAudioCacheClearedError();
      }

      fs.renameSync(writeTargetPath, outPath);
      pruneCache(cacheBase, cacheSettings.maxSizeMB);
      return outPath;
    } catch (error) {
      try { if (fs.existsSync(writeTargetPath)) fs.unlinkSync(writeTargetPath); } catch (cleanupError) {}
      throw error;
    } finally {
      if (audioCacheJobs.get(outPath)?.promise === job) {
        audioCacheJobs.delete(outPath);
      }
    }
  })();

  audioCacheJobs.set(outPath, {
    promise: job,
    writeTargetPath,
    abort: () => controller.abort()
  });
  return job;
}

async function clearAudioCache() {
  if (audioCacheClearPromise) return audioCacheClearPromise;

  const operation = (async () => {
    const activeJobs = [...audioCacheJobs.values()];
    audioCacheGeneration += 1;
    activeJobs.forEach((job) => job.abort?.());
    audioCacheJobs.clear();

    // Give aborted writers a chance to close their file handles before the
    // directory is removed. This prevents a background download from
    // recreating a file after the user empties the cache.
    await Promise.allSettled(activeJobs.map((job) => job.promise));

    const dir = getAudioCacheDirectory();
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, {
          recursive: true,
          force: true,
          maxRetries: 6,
          retryDelay: 150
        });
      }

      if (fs.existsSync(dir)) {
        throw new Error('No se pudo eliminar completamente la carpeta de caché');
      }

      await dbRun('DELETE FROM audio_cache_metadata');
      return { ok: true, cancelledJobs: activeJobs.length };
    } catch (error) {
      console.error('No se pudo vaciar la caché de audio:', error);
      return {
        ok: false,
        cancelledJobs: activeJobs.length,
        error: error.message || 'No se pudo vaciar la caché de audio'
      };
    }
  })();

  audioCacheClearPromise = operation.finally(() => {
    audioCacheClearPromise = null;
  });
  return audioCacheClearPromise;
}

// Implementación de búsqueda
ipcMain.handle('search-songs', async (event, query) => {
  console.log(`Buscando canciones con query: ${query}`);
  try {
    ensureInternetAccess('La búsqueda');
    const results = await searchVideosSafely(query);
    if (results.length === 0) return [];

    // Usar resultados de usetube directamente para evitar bloqueos de ytdl-core
    return results.slice(0, 15).map(result => {
      return {
        id: result.id,
        title: result.original_title || result.title || "Sin título",
        artist: result.artist || "Desconocido",
        duration: result.duration || 0,
        thumbnail: `https://i.ytimg.com/vi/${result.id}/mqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${result.id}`
      };
    });
  } catch (error) {
    console.error('Error detallado en la búsqueda:', error.stack);
    throw new Error(`No se pudo buscar canciones: ${error.message}`);
  }
});

const collectionReadJobs = new Map();
ipcMain.on('collection:cancel-read', (event, id) => {
  if (mainWindow && event.sender === mainWindow.webContents) collectionReadJobs.get(id)?.abort();
});
async function withCollectionRead(id, operation) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Identificador de importación no válido');
  if (collectionReadJobs.size >= 2) throw new Error('Ya hay una lectura de colección en curso');
  const controller = new AbortController();
  collectionReadJobs.set(id, controller);
  try { return await operation(controller.signal); }
  finally { if (collectionReadJobs.get(id) === controller) collectionReadJobs.delete(id); }
}
ipcMain.handle('spotify:read-collection', async (event, rawUrl, readId) => {
  requireMainWindowSender(event);
  ensureInternetAccess('Importar desde Spotify');
  const url = new URL(String(rawUrl));
  if (url.origin !== 'https://open.spotify.com' || !/^\/(playlist|album|track)\/[a-zA-Z0-9]+$/.test(url.pathname)) throw new Error('URL de Spotify no válida');
  const { fetchSpotifyPage } = require('./services/publicCollection');
  return withCollectionRead(readId, async signal => {
  const responses = await Promise.allSettled([
    fetchSpotifyPage(url.href, 0, signal), fetchSpotifyPage(`https://open.spotify.com/embed${url.pathname}`, 0, signal)
  ]);
  const pages = responses.filter(result => result.status === 'fulfilled').map(result => result.value);
  if (!pages.length) throw new Error('No se pudo leer Spotify. Comprueba que la colección sea pública.');
  return pages;
  });
});
ipcMain.handle('youtube:read-collection', async (event, rawUrl, readId) => {
  requireMainWindowSender(event);
  ensureInternetAccess('Importar desde YouTube');
  const url = new URL(String(rawUrl));
  if (url.origin !== 'https://www.youtube.com' || url.pathname !== '/playlist' || !/^[A-Za-z0-9_-]+$/.test(url.searchParams.get('list') || '')) throw new Error('URL de YouTube no válida');
  return withCollectionRead(readId, signal => ytdlpService.getPlaylistDetails(url.href, { signal }));
});

ipcMain.handle('fetch-spotify-playlist-html', async (event, playlistUrl) => {
  try {
    ensureInternetAccess('Importar playlist de Spotify');
    return await new Promise((resolve, reject) => {
      try {
        const parsedUrl = new URL(playlistUrl);
        const requestOptions = {
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + (parsedUrl.search || ''),
          protocol: parsedUrl.protocol,
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://open.spotify.com/'
          }
        };

        const requestFn = parsedUrl.protocol === 'https:' ? https.get : http.get;
        const req = requestFn(requestOptions, res => {
          let body = '';
          res.on('data', chunk => { body += chunk.toString(); });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(body);
            } else {
              reject(new Error(`Spotify responded with status ${res.statusCode}`));
            }
          });
        });

        req.on('error', reject);
      } catch (error) {
        reject(error);
      }
    });
  } catch (error) {
    console.error('Error al obtener HTML de Spotify:', error);
    throw error;
  }
});

// Handler para obtener HTML de playlist de YouTube (para parseo en renderer)
ipcMain.handle('fetch-youtube-playlist-html', async (event, playlistUrl) => {
  try {
    ensureInternetAccess('Importar playlist de YouTube');
    return await new Promise((resolve, reject) => {
      try {
        const parsedUrl = new URL(playlistUrl);
        const requestOptions = {
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + (parsedUrl.search || ''),
          protocol: parsedUrl.protocol,
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.youtube.com/'
          }
        };

        const requestFn = parsedUrl.protocol === 'https:' ? https.get : http.get;
        const req = requestFn(requestOptions, res => {
          let body = '';
          res.on('data', chunk => { body += chunk.toString(); });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(body);
            } else {
              reject(new Error(`YouTube responded with status ${res.statusCode}`));
            }
          });
        });

        req.on('error', reject);
      } catch (error) {
        reject(error);
      }
    });
  } catch (error) {
    console.error('Error al obtener HTML de YouTube:', error);
    throw error;
  }
});

// Fetch YouTube oEmbed JSON for a single video id to get title/author reliably
ipcMain.handle('fetch-youtube-oembed', async (event, videoId) => {
  try {
    ensureInternetAccess('Obtener metadata de YouTube');
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`;
    return await new Promise((resolve, reject) => {
      try {
        const parsedUrl = new URL(oembedUrl);
        const requestFn = parsedUrl.protocol === 'https:' ? https.get : http.get;
        const req = requestFn(oembedUrl, res => {
          let body = '';
          res.on('data', chunk => body += chunk.toString());
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try { const json = JSON.parse(body); resolve(json); } catch (e) { reject(e); }
            } else {
              resolve(null);
            }
          });
        });
        req.on('error', reject);
      } catch (err) { reject(err); }
    });
  } catch (error) {
    console.error('Error fetching YouTube oEmbed:', error);
    return null;
  }
});

// Streaming mejorado
ipcMain.handle('stream-song', async (event, videoUrl, quality, options = {}) => {
  requireMainWindowSender(event);
  const playbackStartedAt = Date.now();
  const requestId = options.requestId || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const extractorMode = audioExtractorPreference;
  const expectedDataGeneration = applicationDataGeneration;
  const progress = (payload) => sendPlaybackProgress(event.sender, {
    requestId,
    elapsedMs: Date.now() - playbackStartedAt,
    ...payload
  });

  progress({
    stage: 'start',
    message: `Preparando audio (${extractorMode})`
  });
  console.log(`Transmitiendo canción desde: ${videoUrl}`);
  try {
    if (!videoUrl) {
      throw new Error('URL de video no proporcionada');
    }
    validateMediaUrl(videoUrl, extractorMode);
    const forceRefresh = !!options.forceRefresh;
    const resolutionController = beginPlaybackResolution(requestId, videoUrl, quality || 'medium', extractorMode);

    // Destruir y eliminar el archivo del flujo anterior
    if (currentStream) {
      currentStream.destroy();
      if (currentStream.path) {
        try {
          fs.unlinkSync(currentStream.path);
          console.log('Archivo temporal anterior eliminado:', currentStream.path);
        } catch (err) {
          console.error('Error al eliminar archivo temporal anterior:', err);
        }
      }
      console.log('Flujo anterior destruido');
      currentStream = null;
    }

    console.log('Obteniendo información del video...');
    progress({ stage: 'cache-check', message: 'Revisando caché local' });
    const cacheSettings = await getCacheSettings();
    const cacheBase = getAudioCacheDirectory();
    try { if (!fs.existsSync(cacheBase)) fs.mkdirSync(cacheBase); } catch(e) {}
    cleanupPartialCacheFiles(cacheBase);

    const cachedVideoId = getVideoId(videoUrl);
    const allCacheCandidates = cachedVideoId
      ? AUDIO_CACHE_EXTENSIONS.map(ext => path.join(cacheBase, `${cachedVideoId}.${ext}`))
      : [];
    if (forceRefresh) {
      allCacheCandidates.forEach(candidate => {
        try {
          if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
        } catch (cleanupError) {
          console.warn('No se pudo limpiar caché forzada:', candidate, cleanupError.message);
        }
      });
    }
    const earlyReusableCachePath = cacheSettings.enabled && !forceRefresh
      ? getPlayableCachePath(allCacheCandidates)
      : null;

    if (!networkAccessEnabled) {
      if (!cacheSettings.enabled || !earlyReusableCachePath) {
        ensureInternetAccess('El streaming');
      }

      progress({ stage: 'ready', source: 'cache', message: 'Usando audio desde caché offline' });
      return {
        path: earlyReusableCachePath,
        metadata: await buildCachedTrackData(cachedVideoId, videoUrl, quality, earlyReusableCachePath)
      };
    }

    if (earlyReusableCachePath) {
      const trackData = await buildCachedTrackData(cachedVideoId, videoUrl, quality, earlyReusableCachePath);
      updatePlaybackHistory(trackData, expectedDataGeneration);
      progress({ stage: 'ready', source: 'cache', message: 'Usando audio cacheado' });
      return { path: earlyReusableCachePath, metadata: trackData };
    }

    ensureInternetAccess('El streaming');

    const extractionResult = await getOrExtractAudio(videoUrl, {
      mode: extractorMode,
      quality: quality || 'medium',
      timeoutMs: 30000,
      logger: console,
      requestId,
      manualFormatId: options.manualFormatId,
      signal: resolutionController.signal,
      metadataCacheEnabled: cacheSettings.enabled,
      onProgress: (payload) => progress({
        stage: 'extractor',
          ...payload
      })
    }, { forceRefresh });
    const extraction = prepareExtractionForPlayback(extractionResult.extraction, extractionResult.fromMemoryCache);
    throwIfPlaybackAborted(resolutionController.signal);
    if (extractionResult.fromMemoryCache) {
      progress({
        stage: 'extractor',
        type: 'memory-cache',
        message: 'Audio preparado desde precarga'
      });
      console.log('[audio-preload] usando stream precargado:', extractionResult.cacheKey);
    } else {
      console.log('[audio-preload] stream guardado en memoria:', extractionResult.cacheKey);
    }

    const extractedTrackData = extraction.metadata;

    const extractedVideoId = extractedTrackData.id || cachedVideoId;
    const extractedExt = getAudioExtensionFromExtraction(extraction);
    throwIfPlaybackAborted(resolutionController.signal);
    const playbackPath = createAudioProxyUrl(extraction, {
      requestId,
      videoUrl,
      quality: quality || 'medium',
      extractorMode
    });

    console.log(
      `[audio-extractor] preferencia=${extractorMode} usado=${extraction.extractor} fallback=${!!extraction.usedFallback} tiempo=${extraction.extractionMs}ms`
    );

    console.log('Actualizando historial de reproducción...');
    updatePlaybackHistory(extractedTrackData, expectedDataGeneration);

    console.log('Generando recomendaciones en segundo plano...');
    progress({ stage: 'history', message: 'Historial actualizado; recomendaciones en segundo plano' });
    generateRecommendations(extractedTrackData.artist, expectedDataGeneration).catch((recommendationError) => {
      console.warn('No se pudieron generar recomendaciones en segundo plano:', recommendationError.message);
      progress({
        stage: 'recommendations-error',
        message: `Recomendaciones fallaron: ${recommendationError.message}`
      });
    });

    if (
      cacheSettings.enabled
      && extractedVideoId
      && !audioCacheClearPromise
      && expectedDataGeneration === applicationDataGeneration
       && isPersistentAudioCacheAllowed(extraction)
    ) {
      const outPath = path.join(cacheBase, `${extractedVideoId}.${extractedExt}`);
      const cacheAlreadyRunning = audioCacheJobs.has(outPath);
      await saveAudioCacheMetadata(extractedTrackData, expectedDataGeneration).catch((error) => {
        console.warn('No se pudo guardar metadata de la caché:', error.message);
      });
      if (expectedDataGeneration !== applicationDataGeneration || audioCacheClearPromise) {
        return {
          path: playbackPath,
          metadata: extractedTrackData,
          formats: extraction.formats
        };
      }
      console.log('Caché activa: reproduciendo por proxy local y guardando copia en segundo plano con:', extraction.extractor);
      progress({
        stage: 'ready',
        source: 'network',
        playback: 'local-proxy',
        cache: 'background',
        message: cacheAlreadyRunning
          ? 'Audio listo; la caché ya se está guardando en segundo plano'
          : 'Audio listo; la caché se guardará en segundo plano'
      });

      let lastCacheBucket = -1;
      cacheExtractedAudio(extraction, outPath, cacheSettings, cacheBase, (cacheProgress) => {
        const percent = Number(cacheProgress.percent || 0);
        const bucket = percent >= 100 ? 100 : Math.floor(percent / 10) * 10;

        if (bucket === lastCacheBucket) return;
        lastCacheBucket = bucket;
        progress({
          stage: 'cache-download',
          percent: bucket,
          downloadedBytes: cacheProgress.downloadedBytes,
          totalBytes: cacheProgress.totalBytes,
          message: `Guardando caché ${bucket}%`
        });
      }).then((finalPath) => {
        progress({
          stage: 'cache-ready',
          message: 'Copia de caché guardada'
        });
        console.log('Caché de audio guardada:', finalPath);
      }).catch((cacheError) => {
        if (isAudioCacheClearedError(cacheError)) return;
        progress({
          stage: 'cache-error',
          message: `No se pudo guardar caché: ${cacheError.message}`
        });
        console.warn('No se pudo guardar caché de audio:', cacheError.message);
      });

      return {
        path: playbackPath,
        metadata: extractedTrackData,
        formats: extraction.formats
      };
    }

    progress({
      stage: 'ready',
      source: 'network',
      playback: 'local-proxy',
      message: 'Audio listo para reproducir desde proxy local'
    });
    return {
      path: playbackPath,
      metadata: extractedTrackData,
      formats: extraction.formats
    };

  } catch (error) {
    console.error('Error en streaming:', error);
    progress({
      stage: 'error',
      message: error.message
    });
    throw error;
  } finally {
    finishPlaybackResolution(requestId);
  }
});

function getCacheSettings() {
  return new Promise((resolve) => {
    db.get('SELECT value FROM settings WHERE key = "cacheSettings"', (err, row) => {
      if (err) return resolve({ enabled: false, maxSizeMB: 500 });
      if (!row) return resolve({ enabled: false, maxSizeMB: 500 });
      try { resolve(JSON.parse(row.value)); } catch(e) { resolve({ enabled: false, maxSizeMB: 500 }); }
    });
  });
}

function setCacheSettings(settings) {
  return new Promise((resolve, reject) => {
    const val = JSON.stringify({ enabled: !!settings.enabled, maxSizeMB: parseInt(settings.maxSizeMB || 500, 10) });
    db.run('INSERT OR REPLACE INTO settings (key, value) VALUES ("cacheSettings", ?)', [val], (err) => {
      if (err) return reject(err);
      resolve(true);
    });
  });
}

function pruneCache(dir, maxMB) {
  try {
    const files = fs.readdirSync(dir).filter(name => AUDIO_CACHE_EXTENSIONS.some(ext => name.endsWith(`.${ext}`))).map(name => {
      const p = path.join(dir, name);
      const s = fs.statSync(p);
      return { p, mtime: s.mtimeMs, size: s.size };
    });
    let total = files.reduce((a,b)=>a+b.size,0);
    const limit = (parseInt(maxMB||500,10))*1024*1024;
    files.sort((a,b)=>a.mtime-b.mtime);
    while (total > limit && files.length > 0) {
      const f = files.shift();
      try { fs.unlinkSync(f.p); total -= f.size; } catch(e) { break; }
    }
  } catch(e) {}
}

ipcMain.handle('set-cache-settings', async (event, settings) => {
  await setCacheSettings(settings || {});
  if (!settings?.enabled) {
    audioCacheGeneration += 1;
    for (const job of audioCacheJobs.values()) job.abort();
    audioCacheJobs.clear();
  }
  return true;
});

ipcMain.handle('get-cache-settings', async () => {
  return await getCacheSettings();
});

ipcMain.handle('clear-audio-cache', async () => {
  const result = await clearAudioCache();
  if (result?.ok && turboEngine) {
    await turboEngine.clearMetadataCache();
  }
  return result;
});

ipcMain.handle('get-audio-cache-library', async () => {
  return await buildCacheLibrary();
});

ipcMain.handle('proxy-audio-url', async (event, payload = {}) => {
  requireMainWindowSender(event);
  const audioUrl = typeof payload === 'string' ? payload : payload.audioUrl;
  const httpHeaders = sanitizeRendererProxyHeaders(typeof payload === 'object' && payload ? payload.httpHeaders : {});
  validateProxyableAudioUrl(audioUrl);
  return createAudioProxyUrl({ audioUrl, httpHeaders });
});

ipcMain.handle('preload-song', async (event, videoUrl, quality, options = {}) => {
  requireMainWindowSender(event);
  try {
    if (!videoUrl) return { ok: false, error: 'URL de video no proporcionada' };
    validateMediaUrl(videoUrl, options.extractorMode || audioExtractorPreference);

    const requestedQuality = quality || 'medium';
    const extractorMode = normalizeExtractorMode(options.extractorMode || audioExtractorPreference);
    const cacheKey = getMemoryStreamCacheKey(videoUrl, requestedQuality, extractorMode, options.manualFormatId);
    const cachedExtraction = getMemoryCachedExtraction(cacheKey);
    if (cachedExtraction) {
      return { ok: true, source: 'memory', extractor: cachedExtraction.extractor };
    }

    const cacheSettings = await getCacheSettings();

    if (extractorMode === 'lte') {
      const videoId = getVideoId(videoUrl);
      const cachedPath = cacheSettings.enabled && videoId
        ? getPlayableCachePath(AUDIO_CACHE_EXTENSIONS.map(ext => path.join(getAudioCacheDirectory(), `${videoId}.${ext}`)))
        : null;
      if (cachedPath) return { ok: true, source: 'cache', extractor: 'cache' };
      if (!networkAccessEnabled) return { ok: false, error: 'Acceso a internet desactivado' };
      const preload = await getTurboEngineInstance().preload(videoUrl, {
        quality: requestedQuality,
        manualFormatId: options.manualFormatId,
        requestId: options.requestId || `preload-${Date.now()}`,
        metadataCacheEnabled: cacheSettings.enabled
      });
      return {
        ok: preload.ok === true,
        source: preload.ok ? 'turbo-memory' : null,
        extractor: 'lte',
        code: preload.code,
        error: preload.error
      };
    }

    const cacheBase = getAudioCacheDirectory();
    const cachedVideoId = getVideoId(videoUrl);
    const allCacheCandidates = cachedVideoId
      ? AUDIO_CACHE_EXTENSIONS.map(ext => path.join(cacheBase, `${cachedVideoId}.${ext}`))
      : [];
    const reusableCachePath = cacheSettings.enabled ? getPlayableCachePath(allCacheCandidates) : null;
    if (reusableCachePath) {
      return { ok: true, source: 'cache' };
    }

    if (!networkAccessEnabled) {
      return { ok: false, error: 'Acceso a internet desactivado' };
    }

    if (memoryStreamPreloadJobs.has(cacheKey)) {
      const extraction = await memoryStreamPreloadJobs.get(cacheKey);
      return { ok: true, source: 'memory', extractor: extraction.extractor };
    }

    const job = extractAudio(videoUrl, {
      mode: extractorMode,
      quality: requestedQuality,
      manualFormatId: options.manualFormatId,
      timeoutMs: Number(options.timeoutMs || 20000),
      logger: console,
      requestId: options.requestId || `preload-${Date.now()}`,
      preload: extractorMode === 'lse'
    }).then((extraction) => {
      storeMemoryStreamExtraction(cacheKey, extraction);
      console.log('[audio-preload] stream precargado:', cacheKey);
      return cloneStreamExtraction(extraction);
    }).finally(() => {
      memoryStreamPreloadJobs.delete(cacheKey);
    });

    memoryStreamPreloadJobs.set(cacheKey, job);
    const extraction = await job;
    return { ok: true, source: 'memory', extractor: extraction.extractor };
  } catch (error) {
    console.warn('[audio-preload] no se pudo precargar:', error.message);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('get-audio-extractor', async (event) => {
  // Kept as a handler for the existing settings UI; configuration may only be
  // read by the application window, not an arbitrary renderer.
  requireMainWindowSender(event);
  return audioExtractorPreference;
});

ipcMain.handle('set-audio-extractor', async (event, extractorMode) => {
  requireMainWindowSender(event);
  audioExtractorPreference = normalizeExtractorMode(extractorMode);
  store.set('audioExtractor', audioExtractorPreference);
  console.log('[audio-extractor] preferencia guardada:', audioExtractorPreference);
  return audioExtractorPreference;
});

ipcMain.handle('lte:get-settings', (event) => {
  requireMainWindowSender(event);
  return { settings: getTurboSettings() };
});

ipcMain.handle('lte:update-settings', (event, patch) => {
  requireMainWindowSender(event);
  return { settings: updateTurboSettings(patch) };
});

ipcMain.handle('lte:reset-settings', (event) => {
  requireMainWindowSender(event);
  const settings = getTurboEngineInstance().resetSettings();
  store.set('turboSettings', settings);
  return { settings };
});

ipcMain.handle('lte:get-diagnostics', async (event) => {
  requireMainWindowSender(event);
  return getTurboDiagnostics();
});

ipcMain.handle('lte:check-dependencies', async (event) => {
  requireMainWindowSender(event);
  await getTurboEngineInstance().checkDependencies();
  return getTurboDiagnostics();
});

ipcMain.handle('lte:clear-metadata-cache', async (event) => {
  requireMainWindowSender(event);
  return getTurboEngineInstance().clearMetadataCache();
});

ipcMain.handle('lte:cancel-preloads', (event) => {
  requireMainWindowSender(event);
  return { cancelled: getTurboEngineInstance().cancelAllPreloads() };
});

ipcMain.handle('lte:run-benchmark', async (event, videoUrl, options = {}) => {
  requireMainWindowSender(event);
  return runTurboBenchmark(videoUrl, options);
});

ipcMain.handle('lte:cancel-benchmark', (event) => {
  requireMainWindowSender(event);
  if (!activeTurboBenchmark) return { cancelled: false };
  try { activeTurboBenchmark.controller.abort('Benchmark cancelado por el usuario'); } catch (error) {}
  return { cancelled: true };
});

ipcMain.handle('lte:report-playback-event', async (event, playbackEvent, payload = {}) => {
  requireMainWindowSender(event);
  const allowedEvents = new Set(['first-audio', 'playing', 'buffering', 'waiting', 'stalled', 'loadstart', 'canplay', 'metadata-ready', 'media-error', 'error']);
  const normalizedEvent = allowedEvents.has(playbackEvent) ? playbackEvent : 'error';
  const safePayload = {
    requestId: String(payload?.requestId || '').slice(0, 96),
    currentTime: Math.max(0, Number(payload?.currentTime || 0)),
    durationMs: Math.max(0, Math.min(600000, Number(payload?.durationMs || 0)))
  };
  getTurboEngineInstance().reportPlaybackEvent(normalizedEvent, safePayload);
  return getTurboDiagnostics();
});

ipcMain.handle('lte:export-settings', (event) => {
  requireMainWindowSender(event);
  return { format: 'lunera-lte-settings', version: 1, settings: getTurboSettings() };
});

ipcMain.handle('lte:export-diagnostics', async (event) => {
  requireMainWindowSender(event);
  return getTurboDiagnostics();
});

// LSE mantiene su configuración en Main: el renderer recibe copias sanitizadas
// y nunca decide destinos de red ni rutas de caché directamente.
ipcMain.handle('lse:get-settings', (event) => {
  requireMainWindowSender(event);
  return { settings: getLseSettings() };
});

ipcMain.handle('lse:update-settings', async (event, patch) => {
  requireMainWindowSender(event);
  return { settings: await updateLseSettings(patch) };
});

ipcMain.handle('lse:reset-settings', async (event) => {
  requireMainWindowSender(event);
  const engine = getLseEngineInstance();
  const settings = engine.resetSettings();
  engine.getExtractorStatus().forEach((extractor) => {
    if (extractor.enabled === false) engine.setExtractorEnabled(extractor.id, true);
  });
  store.set('lseSettings', settings);
  store.delete('lseExtractorStates');
  return { settings, extractors: engine.getExtractorStatus() };
});

ipcMain.handle('lse:clear-cache', async (event) => {
  requireMainWindowSender(event);
  const engine = getLseEngineInstance();
  const before = engine.getStats().metadataCache.entries;
  const stats = await engine.clearCache();
  return { ok: true, removed: before, stats };
});

ipcMain.handle('lse:get-diagnostics', (event) => {
  requireMainWindowSender(event);
  return getLseEngineInstance().getDiagnostics();
});

ipcMain.handle('lse:get-extractors', (event) => {
  requireMainWindowSender(event);
  return { extractors: getLseEngineInstance().getExtractorStatus() };
});

ipcMain.handle('lse:set-extractor-enabled', (event, id, enabled) => {
  requireMainWindowSender(event);
  const status = getLseEngineInstance().setExtractorEnabled(id, enabled !== false);
  const persisted = store.get('lseExtractorStates', {});
  store.set('lseExtractorStates', { ...(persisted && typeof persisted === 'object' ? persisted : {}), [status.id]: status.enabled });
  return { status, extractors: getLseEngineInstance().getExtractorStatus() };
});

ipcMain.handle('lse:cancel-preloads', (event) => {
  requireMainWindowSender(event);
  return { cancelled: getLseEngineInstance().cancelAllPreloads() };
});

ipcMain.handle('lse:report-audible-start', (event, payload = {}) => {
  requireMainWindowSender(event);
  const engine = getLseEngineInstance();
  engine.recordPlaybackEvent('first-audio', {
    requestId: String(payload?.requestId || '').slice(0, 96),
    currentTime: Number(payload?.currentTime || 0)
  });
  return engine.getDiagnostics();
});

ipcMain.handle('lse:report-buffering', (event, payload = {}) => {
  requireMainWindowSender(event);
  const engine = getLseEngineInstance();
  engine.recordPlaybackEvent('buffering', {
    requestId: String(payload?.requestId || '').slice(0, 96),
    durationMs: Math.max(0, Math.min(600000, Number(payload?.durationMs || 0)))
  });
  return engine.getDiagnostics();
});

ipcMain.handle('lse:export-settings', (event) => {
  requireMainWindowSender(event);
  return {
    format: 'lunera-lse-settings',
    version: 1,
    settings: getLseSettings(),
    extractorStates: store.get('lseExtractorStates', {})
  };
});

ipcMain.handle('lse:export-diagnostics', (event) => {
  requireMainWindowSender(event);
  // getDiagnostics ya devuelve detalles depurados por LSE; no se exportan
  // cookies, cabeceras de autorización ni URLs temporales completas.
  return getLseEngineInstance().getDiagnostics();
});

ipcMain.handle('lse:import-settings', async (event, payload) => {
  requireMainWindowSender(event);
  const candidate = payload?.settings && typeof payload.settings === 'object'
    ? payload.settings
    : payload;
  const settings = await updateLseSettings(candidate);
  const extractors = applyLseExtractorStates(payload?.extractorStates);
  return { settings, extractors };
});

ipcMain.handle('get-audio-formats', async (event, videoUrl, quality) => {
  requireMainWindowSender(event);
  ensureInternetAccess('La extracción de formatos');
  const extraction = await extractAudio(videoUrl, {
    mode: audioExtractorPreference,
    quality: quality || 'medium',
    timeoutMs: 30000,
    logger: console
  });

  return {
    extractor: extraction.extractor,
    selectedFormat: extraction.selectedFormat,
    formats: extraction.formats,
    attempts: extraction.attempts
  };
});

ipcMain.handle('extract-playlist', async (event, playlistUrl) => {
  requireMainWindowSender(event);
  ensureInternetAccess('La extracción de playlists');
  return extractPlaylist(playlistUrl, {
    mode: audioExtractorPreference,
    timeoutMs: 30000
  });
});

// Obtener datos para la página de inicio
ipcMain.handle('get-network-access', async () => {
  return networkAccessEnabled;
});

ipcMain.handle('get-song-lyrics', async (event, track) => {
  ensureInternetAccess('Las letras');
  try {
    return await getLyricsForTrack(track);
  } catch (error) {
    console.error('Error obteniendo letra:', error.message);
    throw error;
  }
});

ipcMain.handle('set-network-access', async (event, enabled) => {
  networkAccessEnabled = enabled !== false;
  store.set('networkAccessEnabled', networkAccessEnabled);
  return networkAccessEnabled;
});

ipcMain.handle('open-devtools', async () => {
  if (mainWindow && !mainWindow.webContents.isDevToolsOpened()) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
  return true;
});

ipcMain.handle('get-startup-enabled', async () => {
  try {
    return !!app.getLoginItemSettings().openAtLogin;
  } catch (error) {
    console.error('Error al obtener inicio automatico:', error);
    return false;
  }
});

ipcMain.handle('set-startup-enabled', async (event, enabled) => {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled });
    return !!app.getLoginItemSettings().openAtLogin;
  } catch (error) {
    console.error('Error al configurar inicio automatico:', error);
    return false;
  }
});

ipcMain.handle('get-home-data', async () => {
  console.log('Obteniendo datos de la página de inicio desde SQLite');
  return new Promise((resolve, reject) => {
    const data = {};
    db.all('SELECT * FROM recently_played ORDER BY played_at DESC LIMIT 100', async (err, rows) => {
      if (err) return reject(err);
      data.recentlyPlayed = rows;

      if (!networkAccessEnabled) {
        data.recommendations = [];
        resolve(data);
        return;
      }
      
      db.all('SELECT * FROM recommendations LIMIT 10', async (err, recs) => {
        if (err) return reject(err);
        
        if (rows && rows.length > 0) {
          const artistToUse = rows[0].artist || '';
          data.recommendations = await generateRecommendations(artistToUse);
        } else if (!recs || recs.length === 0) {
          data.recommendations = await generateRecommendations('');
        } else {
          data.recommendations = recs;
        }
        
        resolve(data);
      });
    });
  });
});

ipcMain.handle('clear-listening-history', async () => {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM recently_played', function(err) {
      if (err) return reject(err);
      resolve({ ok: true, deleted: this.changes || 0 });
    });
  });
});

// Actualizar historial manualmente desde renderer
ipcMain.handle('update-history', async (event, track) => {
    updatePlaybackHistory(track);
    // También actualizar recomendaciones basado en esto
    if (track.artist) {
        generateRecommendations(track.artist).catch(console.error);
    }
    return true;
});

// Manejo de biblioteca
ipcMain.handle('add-to-library', async (event, song) => {
  console.log(`Añadiendo a la biblioteca desde SQLite: ${song.title}`);
  return new Promise((resolve, reject) => {
    db.run(`
      INSERT INTO library (video_id, title, artist, thumbnail, url, duration)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        title = excluded.title,
        artist = excluded.artist,
        thumbnail = excluded.thumbnail,
        url = excluded.url,
        duration = excluded.duration
    `, [song.video_id || song.id, song.title, song.artist, song.thumbnail, song.url, song.duration], (err) => {
      if (err) return reject(err);
      db.all('SELECT * FROM library', (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
  });
});

ipcMain.handle('get-library', () => {
  console.log('Obteniendo biblioteca desde SQLite');
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM library', (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
});

ipcMain.handle('remove-from-library', async (event, videoId) => {
  console.log(`Eliminando de la biblioteca: ${videoId}`);
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM library WHERE video_id = ?', [videoId], (err) => {
      if (err) return reject(err);
      db.all('SELECT * FROM library', (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
  });
});

// Manejo de playlists
ipcMain.handle('create-playlist', async (event, name) => {
  console.log(`Creando playlist: ${name}`);
  return new Promise((resolve, reject) => {
    if (!name || name.trim() === '') {
      return reject(new Error('El nombre de la playlist no puede estar vacío'));
    }
    db.run('INSERT INTO playlists (name) VALUES (?)', [name.trim()], function(err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, name: name.trim(), created_at: new Date().toISOString() });
    });
  });
});

ipcMain.handle('get-playlists', () => {
  console.log('Obteniendo playlists desde SQLite');
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM playlists', (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
});

ipcMain.handle('add-to-playlist', async (event, playlistId, song) => {
  console.log(`🎵 Añadiendo canción a playlist ${playlistId}: ${song.title}`);
  console.log(`🎵 Datos de la canción:`, song);
  return new Promise((resolve, reject) => {
    // Primero, asegurarse de que la canción esté en la biblioteca y actualizarla si ya existe
    db.run(`
      INSERT INTO library (video_id, title, artist, thumbnail, url, duration)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        title = excluded.title,
        artist = excluded.artist,
        thumbnail = excluded.thumbnail,
        url = excluded.url,
        duration = excluded.duration
    `, [song.video_id || song.id, song.title, song.artist, song.thumbnail, song.url, song.duration], (err) => {
      if (err) {
        console.error('❌ Error al insertar en library:', err);
        return reject(err);
      }
      console.log('✅ Canción insertada/actualizada en library');
      // Luego, añadir la canción a la playlist
      db.run(`
        INSERT OR IGNORE INTO playlist_songs (playlist_id, video_id)
        VALUES (?, ?)
      `, [playlistId, song.video_id || song.id], (err) => {
        if (err) {
          console.error('❌ Error al insertar en playlist_songs:', err);
          return reject(err);
        }
        console.log('✅ Canción añadida a playlist_songs');
        resolve(true);
      });
    });
  });
});

ipcMain.handle('get-playlist-songs', (event, playlistId) => {
  console.log(`Obteniendo canciones de la playlist ${playlistId}`);
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT l.* FROM library l
      JOIN playlist_songs ps ON l.video_id = ps.video_id
      WHERE ps.playlist_id = ?
    `, [playlistId], (err, rows) => {
      if (err) return reject(/* Error al obtener canciones de la playlist */ err);
      resolve(rows || []);
    });
  });
});

// Eliminar una canción específica de una playlist
ipcMain.handle('remove-from-playlist-song', (event, playlistId, videoId) => {
  console.log(`🗑️ Eliminando canción ${videoId} de la playlist ${playlistId}`);
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM playlist_songs WHERE playlist_id = ? AND video_id = ?', [playlistId, videoId], (err) => {
      if (err) {
        console.error('❌ Error al eliminar canción de playlist:', err);
        return reject(err);
      }
      console.log('✅ Canción eliminada de playlist');
      resolve(true);
    });
  });
});

// Eliminar playlist
ipcMain.handle('delete-playlist', (event, playlistId) => {
  console.log(`🗑️ Eliminando playlist ${playlistId}`);
  return new Promise((resolve, reject) => {
    // Primero eliminar todas las canciones de la playlist
    db.run(`DELETE FROM playlist_songs WHERE playlist_id = ?`, [playlistId], (err) => {
      if (err) {
        console.error('❌ Error al eliminar canciónes de playlist:', err);
        return reject(err);
      }
      console.log('✅ Canciones eliminadas de playlist');
      
      // Luego eliminar la playlist
      db.run(`DELETE FROM playlists WHERE id = ?`, [playlistId], (err) => {
        if (err) {
          console.error('❌ Error al eliminar playlist:', err);
          return reject(err);
        }
        console.log('✅ Playlist eliminada');
        resolve(true);
      });
    });
  });
});

// Configuración visual
ipcMain.handle('get-visual-settings', () => {
  console.log('Obteniendo configuraciones visuales desde SQLite');
  return new Promise((resolve, reject) => {
    db.get('SELECT value FROM settings WHERE key = "visualSettings"', (err, row) => {
      if (err) return reject(err);
      resolve(row ? JSON.parse(row.value) : { showVisualizer: true });
    });
  });
});

ipcMain.handle('set-visual-settings', (event, settings) => {
  console.log('Guardando configuraciones visuales en SQLite:', settings);
  return new Promise((resolve, reject) => {
    db.run(`
      INSERT OR REPLACE INTO settings (key, value)
      VALUES ('visualSettings', ?)
    `, [JSON.stringify(settings)], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
});

function runResetStatements(statements) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN IMMEDIATE TRANSACTION', (beginError) => {
        if (beginError) return reject(beginError);

        let index = 0;
        const rollback = (error) => {
          db.run('ROLLBACK', () => reject(error));
        };
        const runNext = () => {
          if (index >= statements.length) {
            db.run('COMMIT', (commitError) => {
              if (commitError) return rollback(commitError);
              resolve();
            });
            return;
          }

          const sql = statements[index++];
          db.run(sql, (error) => {
            if (error) return rollback(error);
            runNext();
          });
        };

        runNext();
      });
    });
  });
}

function clearTransientAudioState() {
  cancelActivePlaybackResolution('Limpieza de datos temporales');
  if (currentStream) {
    try { currentStream.destroy(); } catch (error) {}
    currentStream = null;
  }

  try { activeTurboBenchmark?.controller?.abort('Benchmark cancelled during cleanup'); } catch (error) {}
  for (const [token, entry] of audioProxyEntries) releaseAudioProxyEntry(token, entry);
  memoryStreamCache.clear();
  memoryStreamPreloadJobs.clear();
  lseEngine?.cancelAllPreloads?.();
  turboEngine?.cancelAllPreloads?.();
}

// Borrar todos los datos, incluida la caché física de audio.
ipcMain.handle('delete-all-data', async () => {
  console.log('Restableciendo todos los datos de la aplicación');
  applicationDataGeneration += 1;
  clearTransientAudioState();

  const cacheResult = await clearAudioCache();
  if (!cacheResult.ok) {
    return {
      ok: false,
      error: cacheResult.error || 'No se pudo eliminar la caché de audio'
    };
  }

  const statements = [
    'DELETE FROM recently_played',
    'DELETE FROM recommendations',
    'DELETE FROM favorites',
    'DELETE FROM playlist_songs',
    'DELETE FROM playlists',
    'DELETE FROM library',
    'DELETE FROM settings',
    'DELETE FROM local_music',
    'DELETE FROM audio_cache_metadata'
  ];

  try {
    await runResetStatements(statements);
    store.clear();
    // Do not re-import the legacy seed data on the next launch.
    store.set(LEGACY_USER_DATA_MIGRATION_KEY, true);
    networkAccessEnabled = true;
    audioExtractorPreference = 'lte';
    store.set('audioExtractor', audioExtractorPreference);
    if (turboEngine) {
      await turboEngine.clearMetadataCache();
      store.set('turboSettings', turboEngine.resetSettings());
    }
    if (lseEngine) {
      await lseEngine.clearCache();
      store.set('lseSettings', lseEngine.resetSettings());
      lseEngine.getExtractorStatus().forEach((extractor) => {
        if (extractor.enabled === false) lseEngine.setExtractorEnabled(extractor.id, true);
      });
    }
    store.delete('lseExtractorStates');
    latestPlayerState = {
      isPlaying: false,
      playerUiState: 'empty',
      title: null,
      artist: null,
      thumbnail: null,
      volume: 1,
      muted: false,
      currentTime: 0,
      duration: 0,
      accentColor: '#1db954'
    };

    console.log('Restablecimiento completo finalizado');
    return { ok: true, cache: cacheResult };
  } catch (error) {
    console.error('No se pudo restablecer la base de datos:', error);
    return { ok: false, error: error.message || 'No se pudo restablecer la aplicación' };
  }
});

ipcMain.handle('add-to-favorites', async (event, song) => {
  console.log(`Añadiendo a favoritos desde SQLite: ${song.title}`);
  return new Promise((resolve, reject) => {
    db.run(`
      INSERT OR IGNORE INTO favorites (video_id, title, artist, thumbnail, url, duration)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [song.video_id || song.id, song.title, song.artist, song.thumbnail, song.url, song.duration], (err) => {
      if (err) return reject(err);
      db.all('SELECT * FROM favorites', (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
  });
});

ipcMain.handle('remove-from-favorites', async (event, videoId) => {
  console.log(`Eliminando de favoritos: ${videoId}`);
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM favorites WHERE video_id = ?', [videoId], (err) => {
      if (err) return reject(err);
      db.all('SELECT * FROM favorites', (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
  });
});

ipcMain.handle('get-favorites', () => {
  console.log('Obteniendo favoritos desde SQLite');
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM favorites', (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
});

// Manejo de música local
ipcMain.handle('add-local-music', async (event, trackData, fileData) => {
  console.log(`Añadiendo música local: ${trackData.title}`);
  return new Promise((resolve, reject) => {
    db.run(`
      INSERT OR REPLACE INTO local_music 
      (video_id, title, artist, album, thumbnail, url, local_path, file_size, file_type, duration, file_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      trackData.id,
      trackData.title,
      trackData.artist,
      trackData.album,
      trackData.thumbnail,
      trackData.url,
      trackData.localPath,
      trackData.fileSize,
      trackData.fileType,
      trackData.duration,
      Buffer.from(fileData)
    ], (err) => {
      if (err) return reject(err);
      resolve(true);
    });
  });
});

ipcMain.handle('get-local-music', () => {
  console.log('Obteniendo música local desde SQLite');
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM local_music ORDER BY added_at DESC', (err, rows) => {
      if (err) return reject(err);
      console.log('Música local encontrada:', rows?.length || 0, 'archivos');
      if (rows && rows.length > 0) {
        console.log('Primer archivo:', { id: rows[0].id, video_id: rows[0].video_id, title: rows[0].title });
      }
      resolve(rows || []);
    });
  });
});

ipcMain.handle('get-local-music-file', (event, videoId) => {
  console.log(`Obteniendo archivo de música local: ${videoId}`);
  return new Promise((resolve, reject) => {
    // Primero intentar con video_id
    db.get('SELECT file_data, file_type FROM local_music WHERE video_id = ?', [videoId], (err, row) => {
      if (err) {
        console.error('Error en consulta video_id:', err);
        return reject(err);
      }
      
      if (row) {
        console.log('Archivo encontrado con video_id:', videoId);
        // Crear un archivo temporal
        const tempPath = path.join(app.getPath('temp'), `${videoId}.${row.file_type.split('/')[1]}`);
        fs.writeFileSync(tempPath, row.file_data);
        
        resolve({
          path: tempPath,
          type: row.file_type
        });
        return;
      }
      
      // Si no se encuentra con video_id, intentar con id
      console.log('No encontrado con video_id, intentando con id:', videoId);
      db.get('SELECT file_data, file_type FROM local_music WHERE id = ?', [videoId], (err2, row2) => {
        if (err2) {
          console.error('Error en consulta id:', err2);
          return reject(err2);
        }
        
        if (!row2) {
          console.log('Archivo no encontrado en ninguna tabla');
          return reject(new Error('Archivo no encontrado'));
        }
        
        console.log('Archivo encontrado con id:', videoId);
        // Crear un archivo temporal
        const tempPath = path.join(app.getPath('temp'), `${videoId}.${row2.file_type.split('/')[1]}`);
        fs.writeFileSync(tempPath, row2.file_data);
        
        resolve({
          path: tempPath,
          type: row2.file_type
        });
      });
    });
  });
});

ipcMain.handle('remove-local-music', (event, identifier) => {
  console.log(`Eliminando música local: ${identifier}`);
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM local_music WHERE video_id = ? OR id = ?', [identifier, identifier], function(err) {
      if (err) return reject(err);
      resolve({ ok: true, deleted: this.changes > 0 });
    });
  });
});

app.whenReady().then(async () => {
  await initializeTurboEngine();
  await initializeLseEngine();
  configureNetworkInterception();
  await startAudioProxyServer();
  migrateUserData();
  createWindow();
  gameOverlay = createGameOverlay({
    getState: () => latestPlayerState,
    onVisibility: visible => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('game-overlay:visibility', visible);
    },
    onControl: (action, value) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const channels = { toggle: 'player:toggle', previous: 'player:previous', next: 'player:next',
        volume: 'player:set-volume', seek: 'player:seek-to', skip: 'player:skip-by' };
      if (channels[action]) mainWindow.webContents.send(channels[action], value);
    },
    onPlay: track => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('game-overlay:play-track', track);
    },
    search: async query => {
      ensureInternetAccess('La búsqueda');
      const tracks = await searchVideosSafely(query);
      return tracks.slice(0, 12).filter(track => /^[a-zA-Z0-9_-]{11}$/.test(track.id)).map(track => ({
        id: track.id, title: track.original_title || track.title || 'Sin título', artist: track.artist || 'Desconocido',
        duration: track.duration || 0, thumbnail: `https://i.ytimg.com/vi/${track.id}/mqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${track.id}`
      }));
    }
  });
  appUpdaterController = startAppUpdater({
    app,
    getWindow: () => mainWindow,
    isNetworkEnabled: () => networkAccessEnabled
  });
});

app.on('before-quit', () => {
  for (const controller of collectionReadJobs.values()) controller.abort();
  collectionReadJobs.clear();
  gameOverlay?.dispose();
  gameOverlay = null;
  try { activeTurboBenchmark?.controller?.abort('Application is closing'); } catch (error) {}
  cancelActivePlaybackResolution('La aplicación se está cerrando');
  for (const [token, entry] of audioProxyEntries) releaseAudioProxyEntry(token, entry);
  lseEngine?.dispose?.();
  turboEngine?.dispose?.();

  if (audioProxyServer) {
    audioProxyServer.close();
    audioProxyServer = null;
    audioProxyPort = null;
  }
});

app.on('window-all-closed', () => {
  console.log('Cerrando aplicación (plataforma no macOS)');
  db.close((err) => {
    if (err) console.error('Error al cerrar la base de datos:', err);
    else console.log('Base de datos cerrada');
    if (process.platform !== 'darwin') app.quit();
  });
});

app.on('activate', () => {
  console.log('Reactivando aplicación');
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

function loadThumbarIcon(fileName) {
  return nativeImage.createFromPath(path.join(__dirname, 'assets', fileName));
}

function setThumbarButtons(isPlaying) {
  thumbarPlaying = isPlaying;
  if (!mainWindow) return;
  const previous = {
    tooltip: 'Anterior',
    icon: loadThumbarIcon('backward.png'),
    click: () => {
      if (!mainWindow) return;
      mainWindow.webContents.send('player:previous');
    }
  };
  const playPause = {
    tooltip: isPlaying ? 'Pausar' : 'Reproducir',
    icon: loadThumbarIcon(isPlaying ? 'pause.png' : 'play.png'),
    click: () => {
      if (!mainWindow) return;
      mainWindow.webContents.send('player:toggle');
    }
  };
  const next = {
    tooltip: 'Siguiente',
    icon: loadThumbarIcon('forward.png'),
    click: () => {
      if (!mainWindow) return;
      mainWindow.webContents.send('player:next');
    }
  };
  mainWindow.setThumbarButtons([previous, playPause, next]);
}

ipcMain.handle('mini-player:set-enabled', async (event, enabled) => {
  return setMiniPlayerEnabled(!!enabled);
});

ipcMain.handle('game-overlay:toggle', event => {
  requireMainWindowSender(event);
  if (!gameOverlay) throw new Error('El overlay todavía no está listo');
  gameOverlay.toggle();
  return gameOverlay.getStatus();
});

ipcMain.handle('mini-player:get-enabled', async () => {
  return !!(miniPlayerWindow && !miniPlayerWindow.isDestroyed());
});

ipcMain.on('mini-player:state', (event, payload = {}) => {
  latestPlayerState = {
    ...latestPlayerState,
    ...payload,
    thumbnail: payload.thumbnail || null
  };
  sendMiniPlayerState(latestPlayerState);
});

ipcMain.on('mini-player:spectrum', (event, payload = {}) => {
  if (!miniPlayerWindow || miniPlayerWindow.isDestroyed()) return;
  miniPlayerWindow.webContents.send('mini-player:spectrum', payload);
});

ipcMain.on('birthday-video:show', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('birthday-video:play');
});

ipcMain.on('mini-player:control', (event, action, value) => {
  if (action === 'close') {
    setMiniPlayerEnabled(false);
    return;
  }

  if (action === 'show-main') {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    return;
  }

  if (!mainWindow || mainWindow.isDestroyed()) return;

  const controlMap = {
    toggle: 'player:toggle',
    previous: 'player:previous',
    next: 'player:next'
  };

  if (controlMap[action]) {
    mainWindow.webContents.send(controlMap[action]);
    return;
  }

  if (action === 'volume') {
    mainWindow.webContents.send('player:set-volume', value);
    return;
  }

  if (action === 'seek') {
    mainWindow.webContents.send('player:seek-to', value);
  }
});

ipcMain.on('player:state', (event, payload) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  const { isPlaying, title, artist } = payload || {};
  latestPlayerState = {
    ...latestPlayerState,
    ...payload,
    thumbnail: payload?.thumbnail || null
  };
  setThumbarButtons(!!isPlaying);
  gameOverlay?.publish(latestPlayerState);
  sendMiniPlayerState(latestPlayerState);
  if (mainWindow) {
    const tip = [title, artist].filter(Boolean).join(' — ');
    mainWindow.setThumbnailToolTip(tip || 'Lunera');
  }
});
