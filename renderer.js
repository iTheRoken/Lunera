const { ipcRenderer, shell } = require('electron');
const bcrypt = require('bcrypt');
const saltRounds = 10;
const fs = require('fs');
const path = require('path');

let audioContext = null;
let sourceNode = null;
let gainNode = null;
let equalizerPreampNode = null;
let equalizerLimiterNode = null;
let bassFilter = null;
let midFilter = null;
let trebleFilter = null;
let presenceFilter = null;
let brillianceFilter = null;
let analyser = null;
let audioDataArray = null;
let animationId = null;
let spectrogramCanvas = null;
let spectrogramCtx = null;
let spectrogramData = [];
let loadingCanvas = null;
let loadingCtx = null;
let loadingSignals = [];
let loadingAnimFrame = null;
let loadingResizeHandler = null;
let startupIntroTimer = null;
let spectrogramResizeHandler = null;
let spectrogramFrameId = null;
const STARTUP_INTRO_DURATION_MS = 2000;

function initLoadingBackground() {
  loadingCanvas = document.getElementById('loadingCanvas');
  if (!loadingCanvas) return;
  if (loadingAnimFrame) {
    cancelAnimationFrame(loadingAnimFrame);
    loadingAnimFrame = null;
  }
  loadingCtx = loadingCanvas.getContext('2d');
  function resize() {
    loadingCanvas.width = window.innerWidth;
    loadingCanvas.height = window.innerHeight;
  }
  resize();
  if (loadingResizeHandler) {
    window.removeEventListener('resize', loadingResizeHandler);
  }
  loadingResizeHandler = resize;
  window.addEventListener('resize', loadingResizeHandler);

  const palette = [
    '29,185,84',
    '0,212,255',
    '255,92,122',
    '246,196,83'
  ];
  loadingSignals = Array.from({ length: 18 }, (_, i) => ({
    offset: Math.random() * 900,
    lane: (i + 0.5) / 18,
    speed: 0.28 + Math.random() * 0.52,
    width: 70 + Math.random() * 170,
    height: 1 + Math.random() * 2.5,
    alpha: 0.12 + Math.random() * 0.28,
    color: palette[i % palette.length],
    skew: 18 + Math.random() * 34
  }));

  let t = 0;
  function draw() {
    if (!loadingCtx || !loadingCanvas) return;
    t += 0.016;
    const w = loadingCanvas.width;
    const h = loadingCanvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const backdrop = loadingCtx.createLinearGradient(0, 0, w, h);
    backdrop.addColorStop(0, '#030407');
    backdrop.addColorStop(0.5, '#06100d');
    backdrop.addColorStop(1, '#08060a');
    loadingCtx.fillStyle = backdrop;
    loadingCtx.fillRect(0, 0, w, h);

    const beam = loadingCtx.createLinearGradient(0, h * 0.18, w, h * 0.82);
    beam.addColorStop(0, 'rgba(29,185,84,0)');
    beam.addColorStop(0.42, 'rgba(29,185,84,0.08)');
    beam.addColorStop(0.5, 'rgba(255,255,255,0.08)');
    beam.addColorStop(0.58, 'rgba(0,212,255,0.07)');
    beam.addColorStop(1, 'rgba(0,212,255,0)');
    loadingCtx.fillStyle = beam;
    loadingCtx.fillRect(0, 0, w, h);

    loadingCtx.save();
    loadingCtx.globalCompositeOperation = 'lighter';
    loadingCtx.translate(cx, cy);
    loadingCtx.rotate(-0.18);
    for (const signal of loadingSignals) {
      const travel = Math.max(w, h) * 1.7;
      const x = ((t * signal.speed * 320 + signal.offset) % (travel + 420)) - (travel / 2 + 210);
      const y = (signal.lane - 0.5) * h * 1.18;
      const grad = loadingCtx.createLinearGradient(x - signal.width, y, x + signal.width, y);
      grad.addColorStop(0, `rgba(${signal.color}, 0)`);
      grad.addColorStop(0.46, `rgba(${signal.color}, ${signal.alpha})`);
      grad.addColorStop(0.52, 'rgba(255,255,255,0.22)');
      grad.addColorStop(1, `rgba(${signal.color}, 0)`);
      loadingCtx.fillStyle = grad;
      loadingCtx.beginPath();
      loadingCtx.moveTo(x - signal.width, y - signal.height);
      loadingCtx.lineTo(x + signal.width, y - signal.height + signal.skew);
      loadingCtx.lineTo(x + signal.width, y + signal.height + signal.skew);
      loadingCtx.lineTo(x - signal.width, y + signal.height);
      loadingCtx.closePath();
      loadingCtx.fill();
    }

    loadingCtx.rotate(0.18);
    loadingCtx.strokeStyle = 'rgba(255,255,255,0.13)';
    loadingCtx.lineWidth = 1.2;
    loadingCtx.beginPath();
    loadingCtx.moveTo(-120, 0);
    loadingCtx.lineTo(120, 0);
    loadingCtx.moveTo(0, -120);
    loadingCtx.lineTo(0, 120);
    loadingCtx.stroke();
    loadingCtx.restore();

    loadingAnimFrame = requestAnimationFrame(draw);
  }
  draw();
}

function stopLoadingBackground() {
  if (loadingAnimFrame) cancelAnimationFrame(loadingAnimFrame);
  loadingAnimFrame = null;
  if (loadingResizeHandler) {
    window.removeEventListener('resize', loadingResizeHandler);
    loadingResizeHandler = null;
  }
}

const FEEDBACK_FORM_URL = 'https://forms.gle/eFHx1ZnJy9Thf4KM9';
const INTERFACE_MODE_STORAGE_KEY = 'luneraInterfaceMode';
const VALID_INTERFACE_MODES = ['classic', 'neo'];
const EQ_FREQUENCIES = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
const EQ_LABELS = ['60', '170', '310', '600', '1k', '3k', '6k', '12k', '14k', '16k'];
const EQ_BAND_NAMES = ['Sub', 'Grave', 'Cuerpo', 'Calor', 'Medio', 'Presencia', 'Brillo', 'Aire', 'Lustre', 'Ultra'];
const EQ_DEFAULT_CURVE = Object.fromEntries(EQ_FREQUENCIES.map(freq => [freq, 0]));
const EQ_PRESETS = {
  flat: { label: 'Plano', vibe: 'Referencia neutral', curve: { ...EQ_DEFAULT_CURVE }, preamp: 0, q: 1 },
  luxe: { label: 'Luxe', vibe: 'Grave pulido y aire caro', curve: { 60: 2.5, 170: 1.5, 310: -0.5, 600: -1, 1000: 0, 3000: 1.5, 6000: 2, 12000: 2.5, 14000: 2, 16000: 1.5 }, preamp: -1, q: 0.9 },
  deep: { label: 'Deep Bass', vibe: 'Bajos grandes sin ensuciar', curve: { 60: 6, 170: 4, 310: 1, 600: -1, 1000: -1, 3000: 0, 6000: 1, 12000: 1, 14000: 0, 16000: 0 }, preamp: -3, q: 0.85 },
  clarity: { label: 'Claridad', vibe: 'Voces y detalles al frente', curve: { 60: -2, 170: -1, 310: 0, 600: 1, 1000: 2, 3000: 3.5, 6000: 2.5, 12000: 1.5, 14000: 1, 16000: 0 }, preamp: -1.5, q: 1.05 },
  rock: { label: 'Rock', vibe: 'Pegada con guitarras vivas', curve: { 60: 4, 170: 2, 310: -2, 600: -1, 1000: 1, 3000: 3, 6000: 2, 12000: 1, 14000: 0, 16000: 0 }, preamp: -2, q: 1 },
  pop: { label: 'Pop', vibe: 'Energico y radio friendly', curve: { 60: 2, 170: 1, 310: 0, 600: 1, 1000: 2, 3000: 1, 6000: 0, 12000: -1, 14000: -1, 16000: -2 }, preamp: -1, q: 0.95 },
  jazz: { label: 'Jazz', vibe: 'Textura, madera y aire', curve: { 60: 1, 170: 0, 310: 1, 600: 2, 1000: 1, 3000: 0, 6000: 1, 12000: 2, 14000: 1, 16000: 0 }, preamp: -1, q: 0.8 },
  classical: { label: 'Clasico', vibe: 'Escena amplia y natural', curve: { 60: 0, 170: 0.5, 310: 0, 600: 0, 1000: 0, 3000: 0.5, 6000: 1, 12000: 1.5, 14000: 1, 16000: 0.5 }, preamp: -0.5, q: 0.75 },
  electronic: { label: 'Electronica', vibe: 'Subgrave y brillo nocturno', curve: { 60: 6, 170: 4, 310: 2, 600: 0, 1000: 0, 3000: 2, 6000: 4, 12000: 3, 14000: 2, 16000: 1 }, preamp: -3, q: 0.9 },
  vocal: { label: 'Vocal', vibe: 'Voz intima y limpia', curve: { 60: -2, 170: -1, 310: 2, 600: 3, 1000: 2, 3000: 1, 6000: 0, 12000: -1, 14000: -2, 16000: -3 }, preamp: -1.5, q: 1.1 }
};

// Selección curada de artistas apoyados por Lunera. Mantener este catálogo en un
// único lugar hace que sumar nuevos artistas no requiera tocar la UI.
const LOCAL_ARTISTS_CATALOG = [
  {
    id: 'luk1',
    name: 'Luk1',
    initials: 'L',
    style: 'luk1',
    description: 'Un lanzamiento para conocer su propuesta.',
    channelUrl: 'https://www.youtube.com/channel/UCqTyWwzHuhTVumbjUjjLdvQ',
    profileImage: 'https://yt3.googleusercontent.com/T1ni6-zjOPGwhbkvUliUFz1kdLXmG8ab-EsjodepW8DyrsJiD1o_t8OU2o-1UPI2YsaxV3ML=s900-c-k-c0x00ffffff-no-rj',
    songs: [
      {
        id: 'qaUCe05CSJ0',
        title: 'Pibito Vago',
        duration: '2:10'
      }
    ]
  },
  {
    id: 'flawers-a',
    name: 'Flawers A',
    initials: 'FA',
    style: 'flawers-a',
    description: 'Tres lanzamientos para descubrir.',
    channelUrl: 'https://www.youtube.com/@Flawers_A_music',
    profileImage: 'https://yt3.googleusercontent.com/OFuZkGEFbHZ2XoDzp2cf-BxjpQblhcycaq10G6qIL0x1-NwKowVQYwsP1TTqa4xq7RanRMbf_Q=s900-c-k-c0x00ffffff-no-rj',
    songs: [
      {
        id: 'qL1hsJkoJAE',
        title: 'El atardecer - Flawers A',
        duration: '2:52'
      },
      {
        id: '8jwxZShhoW8',
        title: 'Tamo subiendo - Flawers A',
        duration: '2:07'
      },
      {
        id: 'GnBWpjHAeIA',
        title: 'Mis relicarios - Flawers A',
        duration: '1:51'
      }
    ]
  }
];

// Estado global de la aplicación
const state = {
  currentTrack: null,
  isPlaying: false,
  playerUiState: 'empty',
  queue: [],
  queueLoop: false,
  currentIndex: -1,
  volume: 1,
  shuffle: false,
  repeat: 'none', // none, one, all
  library: [],
  localMusic: [],
  favorites: [],
  playlists: [],
  searchResults: [],
  recentlyPlayed: JSON.parse(localStorage.getItem('recentlyPlayed') || '[]'),
  recommendations: [],
  settings: {
    showGif: false,
    gifUrl: null,
  },
  visualSettings: {
    showVisualizer: true,
    theme: 'dark',
    accentColor: '#1db954',
    interfaceMode: VALID_INTERFACE_MODES.includes(localStorage.getItem(INTERFACE_MODE_STORAGE_KEY)) ? localStorage.getItem(INTERFACE_MODE_STORAGE_KEY) : 'classic',
    spectrogramOpacity: 0.4,
    effectsIntensity: 70,
    panelOpacity: 92,
    animationQuality: 'balanced',
    compactMode: false,
    reduceMotion: false
  },
  currentPlaylist: null, // Añadido para almacenar las canciones de la playlist actual
  currentPlaylistId: null, // Añadido para almacenar el ID de la playlist actual
  isNewUser: (() => {
    const userData = localStorage.getItem('user');
    if (!userData) return true; // Si no hay datos, es un usuario nuevo
    const user = JSON.parse(userData);
    // Solo consideramos que no es un usuario nuevo si tiene username, email y password
    return !(user.username && user.email && user.password);
  })(), // Estado para manejar si es un usuario nuevo
  audioSettings: {
    normalizeVolume: false,
    streamingQuality: 'medium',
    lastStreamingProfile: null,
    equalizerPreamp: 0,
    equalizerQ: 1,
    equalizerLimiter: true,
    equalizer: {
      60: 0,    // Sub-bass
      170: 0,   // Bass
      310: 0,   // Low-mid
      600: 0,   // Mid
      1000: 0,  // High-mid
      3000: 0,  // Presence
      6000: 0,  // Brilliance
      12000: 0, // Air
      14000: 0, // Ultra-high
      16000: 0  // Super-high
    }
  },
  playbackSettings: {
    autoplay: false,
    autoQueue: false,
    smartShuffle: false,
    defaultVolume: 50,
    notificationsEnabled: true,
    miniPlayer: false
  },
  developerSettings: {
    enabled: false,
    internetEnabled: true,
    verbosePlayerLogs: false,
    audioExtractor: 'auto',
    performanceMode: 'balanced',
    startAtLogin: false
  },
  privacySettings: {
    saveListeningHistory: true
  },
  account: {
    username: '',
    email: ''
  },
  lyrics: {
    isOpen: false,
    cache: {},
    activeKey: null
  }
};

function renderPremiumSettingsShell() {
  const settingsPage = document.getElementById('settings');
  if (!settingsPage || settingsPage.dataset.premiumSettingsRendered === 'true') return;

  settingsPage.classList.add('settings-2026');
  settingsPage.dataset.premiumSettingsRendered = 'true';
  settingsPage.innerHTML = `
    <div class="settings-ambient" aria-hidden="true">
      <span></span>
      <span></span>
      <span></span>
    </div>

    <section class="settings-hero">
      <div class="settings-hero-main">
        <div class="settings-brand-mark">
          <img src="assets/logo2.png" alt="Lunera">
        </div>
        <div class="settings-title-section">
          <span class="settings-eyebrow">Centro de control</span>
          <h1 class="settings-title">Configuración</h1>
          <p class="settings-subtitle">Personaliza tu experiencia musical perfecta</p>
        </div>
      </div>

      <div class="settings-quick-actions">
        <button class="settings-quick-btn" id="resetSettingsBtn" type="button" data-tooltip="Restaurar configuración">
          <i class="fas fa-rotate-left"></i>
          <span>Restablecer</span>
        </button>
        <button class="settings-quick-btn" id="exportSettingsBtn" type="button" data-tooltip="Exportar configuración">
          <i class="fas fa-download"></i>
          <span>Exportar</span>
        </button>
        <button class="settings-quick-btn spotify-import-btn" id="importSpotifyPlaylistBtn" type="button" data-tooltip="Importar playlist de Spotify">
          <span>Importar playlist de Spotify</span>
          <i class="fab fa-spotify spotify-icon-behind" aria-hidden="true"></i>
        </button>
        <input type="file" id="importSettingsInput" accept=".json" class="file-input">
        <button class="settings-quick-btn" id="importSettingsBtn" type="button" data-tooltip="Importar configuración">
          <i class="fas fa-file-import"></i>
          <span>Importar</span>
        </button>
      </div>

      <div class="settings-summary-grid">
        <div class="settings-summary-card is-primary">
          <span class="settings-summary-label">Tema activo</span>
          <strong class="settings-summary-value" id="settingsThemeLabel">Oscuro</strong>
        </div>
        <div class="settings-summary-card">
          <span class="settings-summary-label">Calidad de streaming</span>
          <strong class="settings-summary-value" id="settingsStreamingLabel">Media</strong>
        </div>
        <div class="settings-summary-card">
          <span class="settings-summary-label">Biblioteca</span>
          <strong class="settings-summary-value" id="settingsLibraryCount">0 canciones</strong>
        </div>
        <div class="settings-summary-card">
          <span class="settings-summary-label">Modo desarrollador</span>
          <strong class="settings-summary-value" id="settingsDeveloperLabel">Desactivado</strong>
        </div>
      </div>
    </section>

    <div class="settings-shell">
      <nav class="settings-nav" aria-label="Secciones de configuración">
        <button class="settings-nav-btn active" data-section="general" type="button"><i class="fas fa-sliders"></i><span>General</span></button>
        <button class="settings-nav-btn" data-section="visual" type="button"><i class="fas fa-wand-magic-sparkles"></i><span>Apariencia</span></button>
        <button class="settings-nav-btn" data-section="audio" type="button"><i class="fas fa-volume-high"></i><span>Audio</span></button>
        <button class="settings-nav-btn" data-section="playback" type="button"><i class="fas fa-circle-play"></i><span>Reproducción</span></button>
        <button class="settings-nav-btn" data-section="account" type="button"><i class="fas fa-user"></i><span>Cuenta</span></button>
        <button class="settings-nav-btn" data-section="storage" type="button"><i class="fas fa-hard-drive"></i><span>Almacenamiento</span></button>
        <button class="settings-nav-btn" data-section="privacy" type="button"><i class="fas fa-shield-halved"></i><span>Privacidad</span></button>
        <button class="settings-nav-btn" data-section="shortcuts" type="button"><i class="fas fa-keyboard"></i><span>Atajos</span></button>
        <button class="settings-nav-btn" data-section="developer" type="button"><i class="fas fa-code"></i><span>Desarrollador</span></button>
        <button class="settings-nav-btn" data-section="experimental" type="button"><i class="fas fa-flask"></i><span>Experimental</span></button>
      </nav>

      <div class="settings-content">
        <section class="settings-section active" id="generalSection">
          <div class="settings-section-header">
            <span class="settings-section-kicker">Preferencias base</span>
            <div class="settings-section-title">
              <h2><i class="fas fa-sliders"></i> General</h2>
              <span class="settings-section-description">Ajustes esenciales de la experiencia diaria</span>
            </div>
          </div>
          <div class="settings-grid">
            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-language"></i></div>
                <div class="setting-info">
                  <h3>Idioma de la Interfaz</h3>
                  <p>Cambia el idioma de la aplicación</p>
                </div>
              </div>
              <div class="setting-control">
                <select id="languageSelect" class="modern-select">
                  <option value="es" selected>Español</option>
                  <option value="en">English</option>
                  <option value="fr">Français</option>
                  <option value="de">Deutsch</option>
                  <option value="it">Italiano</option>
                  <option value="pt">Português</option>
                </select>
              </div>
            </article>

            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-bell"></i></div>
                <div class="setting-info">
                  <h3>Notificaciones</h3>
                  <p>Activa los avisos de acciones y estado</p>
                </div>
              </div>
              <div class="setting-control setting-control-row">
                <label class="modern-switch">
                  <input type="checkbox" id="notificationsToggle" checked>
                  <span class="switch-slider"></span>
                </label>
                <span class="setting-status">Centro de avisos</span>
              </div>
            </article>

            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-power-off"></i></div>
                <div class="setting-info">
                  <h3>Inicio Automático</h3>
                  <p>Abre Lunera al iniciar Windows</p>
                </div>
              </div>
              <div class="setting-control setting-control-row">
                <label class="modern-switch">
                  <input type="checkbox" id="startupLaunchToggle">
                  <span class="switch-slider"></span>
                </label>
                <span class="setting-status" id="startupLaunchStatus">Manual</span>
              </div>
            </article>

            <article class="setting-card interface-mode-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-layer-group"></i></div>
                <div class="setting-info">
                  <h3>Interfaz de Lunera</h3>
                  <p>Cambia entre la apariencia antigua y la nueva interfaz Neo</p>
                </div>
              </div>
              <div class="setting-control">
                <div class="interface-mode-selector segmented-control" role="group" aria-label="Interfaz de Lunera">
                  <button class="interface-mode-option active" data-interface-mode="classic" type="button">
                    <i class="fas fa-desktop"></i>
                    <span>Antigua</span>
                  </button>
                  <button class="interface-mode-option" data-interface-mode="neo" type="button">
                    <i class="fas fa-wand-magic-sparkles"></i>
                    <span>Nueva Neo</span>
                  </button>
                </div>
                <div class="setting-inline-meta">
                  <span class="setting-status">Interfaz activa: <strong id="settingsInterfaceLabel">Antigua</strong></span>
                </div>
              </div>
            </article>
          </div>
        </section>

        <section class="settings-section" id="visualSection">
          <div class="settings-section-header">
            <span class="settings-section-kicker">Look & feel</span>
            <div class="settings-section-title">
              <h2><i class="fas fa-wand-magic-sparkles"></i> Apariencia</h2>
              <span class="settings-section-description">Tema, acento, movimiento y profundidad visual</span>
            </div>
          </div>
          <div class="settings-grid">
            <article class="setting-card setting-card-wide">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-palette"></i></div>
                <div class="setting-info">
                  <h3>Tema de la Interfaz</h3>
                  <p>Elige entre modo oscuro, claro o personalizado</p>
                </div>
              </div>
              <div class="setting-control">
                <div class="theme-selector segmented-control">
                  <button class="theme-option active" data-theme="dark" type="button"><i class="fas fa-moon"></i><span>Oscuro</span></button>
                  <button class="theme-option" data-theme="light" type="button"><i class="fas fa-sun"></i><span>Claro</span></button>
                  <button class="theme-option" data-theme="custom" type="button"><i class="fas fa-paint-brush"></i><span>Personalizado</span></button>
                </div>
                <div id="customThemeControls" class="custom-theme-controls" style="display: none;">
                  <div class="custom-color-group">
                    <label>Fondo Principal</label>
                    <div class="color-input-wrapper"><input type="color" id="customBgDark" value="#121212"><span class="color-value">#121212</span></div>
                  </div>
                  <div class="custom-color-group">
                    <label>Fondo Secundario</label>
                    <div class="color-input-wrapper"><input type="color" id="customBgLight" value="#1a1a1a"><span class="color-value">#1a1a1a</span></div>
                  </div>
                  <div class="custom-color-group">
                    <label>Texto Principal</label>
                    <div class="color-input-wrapper"><input type="color" id="customTextPrimary" value="#ffffff"><span class="color-value">#ffffff</span></div>
                  </div>
                  <div class="custom-color-group">
                    <label>Texto Secundario</label>
                    <div class="color-input-wrapper"><input type="color" id="customTextSecondary" value="#b3b3b3"><span class="color-value">#b3b3b3</span></div>
                  </div>
                </div>
              </div>
            </article>

            <article class="setting-card setting-card-wide">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-droplet"></i></div>
                <div class="setting-info">
                  <h3>Color de Acento</h3>
                  <p>Personaliza el color principal de la interfaz</p>
                </div>
              </div>
              <div class="setting-control">
                <div class="accent-control">
                  <div class="accent-preview-shell">
                    <div id="accentColorPreview" class="accent-color-preview"></div>
                    <div class="accent-preview-copy">
                      <span class="accent-preview-label">Color activo</span>
                      <strong id="accentColorHex">#1DB954</strong>
                    </div>
                  </div>
                  <div class="accent-actions">
                    <label class="accent-picker-button" for="accentColorPicker"><i class="fas fa-eye-dropper"></i><span>Elegir tono</span></label>
                    <input type="color" id="accentColorPicker" value="#1db954" class="modern-color-picker">
                    <button id="randomAccentBtn" class="modern-btn secondary accent-random-btn" type="button"><i class="fas fa-shuffle"></i><span>Aleatorio</span></button>
                  </div>
                  <div class="accent-presets-grid">
                    <button class="color-preset" data-color="#1db954" title="Verde Aurora" type="button"><span>Verde Aurora</span></button>
                    <button class="color-preset" data-color="#00c2ff" title="Azul Neón" type="button"><span>Azul Neón</span></button>
                    <button class="color-preset" data-color="#ff6b6b" title="Coral Vivo" type="button"><span>Coral Vivo</span></button>
                    <button class="color-preset" data-color="#f59e0b" title="Ámbar" type="button"><span>Ámbar</span></button>
                    <button class="color-preset" data-color="#8b5cf6" title="Violeta" type="button"><span>Violeta</span></button>
                    <button class="color-preset" data-color="#14b8a6" title="Turquesa" type="button"><span>Turquesa</span></button>
                  </div>
                </div>
              </div>
            </article>

            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-wave-square"></i></div>
                <div class="setting-info">
                  <h3>Espectrograma Visual</h3>
                  <p>Muestra un espectrograma animado que reacciona al ritmo</p>
                </div>
              </div>
              <div class="setting-control setting-control-row">
                <label class="modern-switch"><input type="checkbox" id="visualizerToggle" checked><span class="switch-slider"></span></label>
                <span class="setting-status">Reactivo al audio</span>
              </div>
            </article>

            <article class="setting-card visualizer-opacity-card" id="visualizerOpacityControl" style="display: none;">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-circle-half-stroke"></i></div>
                <div class="setting-info">
                  <h3>Opacidad del Espectrograma</h3>
                  <p>Ajusta la intensidad visual del espectrograma a tu gusto</p>
                </div>
              </div>
              <div class="setting-control slider-container">
                <input type="range" id="visualizerOpacitySlider" class="modern-slider" min="0" max="100" step="1" value="40">
                <div class="slider-labels"><span>Suave</span><strong id="visualizerOpacityValue">40%</strong><span>Intenso</span></div>
              </div>
            </article>

            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-sparkles"></i></div>
                <div class="setting-info">
                  <h3>Intensidad de Efectos Visuales</h3>
                  <p>Controla glow, blur y profundidad del panel</p>
                </div>
              </div>
              <div class="setting-control slider-container">
                <input type="range" id="effectsIntensitySlider" class="modern-slider" min="0" max="100" step="1" value="70">
                <div class="slider-labels"><span>Discreto</span><strong id="effectsIntensityValue">70%</strong><span>Cinemático</span></div>
              </div>
            </article>

            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-layer-group"></i></div>
                <div class="setting-info">
                  <h3>Transparencia de Paneles</h3>
                  <p>Ajusta la opacidad del vidrio visual</p>
                </div>
              </div>
              <div class="setting-control slider-container">
                <input type="range" id="panelOpacitySlider" class="modern-slider" min="70" max="100" step="1" value="92">
                <div class="slider-labels"><span>Glass</span><strong id="panelOpacityValue">92%</strong><span>Sólido</span></div>
              </div>
            </article>

            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-gauge-high"></i></div>
                <div class="setting-info">
                  <h3>Calidad de Animaciones</h3>
                  <p>Equilibra fluidez y consumo visual</p>
                </div>
              </div>
              <div class="setting-control">
                <select id="animationQualitySelect" class="modern-select">
                  <option value="reduced">Reducida</option>
                  <option value="balanced" selected>Balanceada</option>
                  <option value="high">Alta</option>
                </select>
              </div>
            </article>

            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-compress"></i></div>
                <div class="setting-info">
                  <h3>Modo Compacto</h3>
                  <p>Reduce espaciados en vistas densas</p>
                </div>
              </div>
              <div class="setting-control setting-control-row">
                <label class="modern-switch"><input type="checkbox" id="compactModeToggle"><span class="switch-slider"></span></label>
                <span class="setting-status">Densidad adaptable</span>
              </div>
            </article>

            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-universal-access"></i></div>
                <div class="setting-info">
                  <h3>Reducir Movimiento</h3>
                  <p>Minimiza animaciones y transiciones</p>
                </div>
              </div>
              <div class="setting-control setting-control-row">
                <label class="modern-switch"><input type="checkbox" id="reduceMotionToggle"><span class="switch-slider"></span></label>
                <span class="setting-status">Accesibilidad</span>
              </div>
            </article>

            <article class="setting-card gif-settings-master">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-image"></i></div>
                <div class="setting-info">
                  <h3>GIF de Reproducción</h3>
                  <p>Agrega tu propio GIF para la reproducción</p>
                </div>
              </div>
              <div class="setting-control">
                <div class="setting-control-row">
                  <label class="modern-switch"><input type="checkbox" id="gifToggle"><span class="switch-slider"></span></label>
                  <span class="setting-status">Animación personalizada</span>
                </div>
                <div class="gif-settings-card" style="display: none;">
                  <div class="gif-upload-container">
                    <input type="file" id="gifInput" accept=".gif" class="gif-input">
                    <button id="uploadGif" class="modern-btn secondary" type="button"><i class="fas fa-upload"></i><span>Seleccionar GIF</span></button>
                    <div id="gifPreview" class="gif-preview">
                      <img src="" alt="GIF Preview" style="display: none;">
                      <button class="remove-gif modern-btn danger" type="button"><i class="fas fa-times"></i></button>
                    </div>
                  </div>
                </div>
              </div>
            </article>
          </div>
        </section>

        <section class="settings-section" id="audioSection">
          <div class="settings-section-header">
            <span class="settings-section-kicker">Sonido</span>
            <div class="settings-section-title">
              <h2><i class="fas fa-volume-high"></i> Audio</h2>
              <span class="settings-section-description">Calidad, ecualización y estabilidad de escucha</span>
            </div>
          </div>
          <div class="settings-grid">
            <article class="setting-card setting-card-featured">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-sliders"></i></div>
                <div class="setting-info">
                  <h3>Ecualizador</h3>
                  <p>Ajusta los niveles de frecuencia para personalizar el sonido</p>
                </div>
              </div>
              <div class="setting-control">
                <button id="openEqualizerBtn" class="modern-btn primary" type="button"><i class="fas fa-arrow-up-right-from-square"></i><span>Abrir Ecualizador</span></button>
              </div>
            </article>

            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-scale-balanced"></i></div>
                <div class="setting-info">
                  <h3>Normalización de Volumen</h3>
                  <p>Ajusta automáticamente el volumen entre canciones</p>
                </div>
              </div>
              <div class="setting-control setting-control-row">
                <label class="modern-switch"><input type="checkbox" id="normalizeVolumeToggle"><span class="switch-slider"></span></label>
                <span class="setting-status">Límite inteligente</span>
              </div>
            </article>

            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-network-wired"></i></div>
                <div class="setting-info">
                  <h3>Calidad de Streaming</h3>
                  <p>Selecciona la calidad de audio para streaming</p>
                </div>
              </div>
              <div class="setting-control">
                <select id="streamingQualitySelect" class="modern-select">
                  <option value="low">Baja (128kbps)</option>
                  <option value="medium" selected>Media (256kbps)</option>
                  <option value="high">Alta (320kbps)</option>
                  <option value="lossless">Sin Pérdida (FLAC)</option>
                </select>
                <div class="setting-inline-meta">
                  <span id="streamingQualityHint" class="setting-status">Equilibrio entre calidad y velocidad</span>
                  <span id="streamingQualityStatus" class="setting-status">Aún no hay reproducción para medir</span>
                </div>
              </div>
            </article>
          </div>
        </section>

        <section class="settings-section" id="playbackSection">
          <div class="settings-section-header">
            <span class="settings-section-kicker">Flujo musical</span>
            <div class="settings-section-title">
              <h2><i class="fas fa-circle-play"></i> Reproducción</h2>
              <span class="settings-section-description">Automatización, cola y controles del reproductor</span>
            </div>
          </div>
          <div class="settings-grid">
            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-play"></i></div>
                <div class="setting-info">
                  <h3>Reproducción Automática</h3>
                  <p>Continúa reproduciendo canciones similares al terminar una lista</p>
                </div>
              </div>
              <div class="setting-control setting-control-row">
                <label class="modern-switch"><input type="checkbox" id="autoplayToggle"><span class="switch-slider"></span></label>
                <span class="setting-status">Continuidad</span>
              </div>
            </article>

            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-list"></i></div>
                <div class="setting-info">
                  <h3>Cola Automática</h3>
                  <p>Añade recomendaciones automáticamente a la cola</p>
                </div>
              </div>
              <div class="setting-control setting-control-row">
                <label class="modern-switch"><input type="checkbox" id="autoQueueToggle"><span class="switch-slider"></span></label>
                <span class="setting-status">Recomendaciones</span>
              </div>
            </article>

            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-shuffle"></i></div>
                <div class="setting-info">
                  <h3>Mezcla Inteligente</h3>
                  <p>Mezcla automáticamente las canciones para una mejor experiencia</p>
                </div>
              </div>
              <div class="setting-control setting-control-row">
                <label class="modern-switch"><input type="checkbox" id="smartShuffleToggle"><span class="switch-slider"></span></label>
                <span class="setting-status">Dinámica</span>
              </div>
            </article>

            <article class="setting-card setting-card-wide">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-volume-up"></i></div>
                <div class="setting-info">
                  <h3>Volumen Inicial</h3>
                  <p>Establece el volumen por defecto al iniciar la aplicación</p>
                </div>
              </div>
              <div class="setting-control">
                <div class="volume-stepper-card" id="defaultVolumeControl">
                  <div class="volume-stepper-display">
                    <span class="volume-stepper-label">Volumen elegido</span>
                    <strong id="defaultVolumeValue">50%</strong>
                  </div>
                  <div class="slider-container">
                    <input id="defaultVolumeSlider" class="modern-slider" type="range" min="0" max="100" step="1" value="50">
                  </div>
                  <div class="volume-presets" id="defaultVolumePresets">
                    <button type="button" class="volume-preset-btn" data-volume="0">0%</button>
                    <button type="button" class="volume-preset-btn" data-volume="25">25%</button>
                    <button type="button" class="volume-preset-btn" data-volume="50">50%</button>
                    <button type="button" class="volume-preset-btn" data-volume="75">75%</button>
                    <button type="button" class="volume-preset-btn" data-volume="100">100%</button>
                  </div>
                  <div class="setting-inline-meta">
                    <span id="defaultVolumeHint" class="setting-status">Se aplica al iniciar la app y al cambiar de pista</span>
                  </div>
                </div>
              </div>
            </article>

          </div>
        </section>

        <section class="settings-section" id="accountSection">
          <div class="settings-section-header">
            <span class="settings-section-kicker">Identidad</span>
            <div class="settings-section-title">
              <h2><i class="fas fa-user"></i> Cuenta</h2>
              <span class="settings-section-description">Perfil local y credenciales guardadas</span>
            </div>
          </div>
          <div class="settings-grid">
            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-user-circle"></i></div>
                <div class="setting-info">
                  <h3>Nombre de Usuario</h3>
                  <p>Actualiza tu nombre de usuario</p>
                </div>
              </div>
              <div class="setting-control"><input type="text" id="usernameInput" placeholder="Tu nombre de usuario" class="modern-input"></div>
            </article>

            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-envelope"></i></div>
                <div class="setting-info">
                  <h3>Correo Electrónico</h3>
                  <p>Actualiza tu correo electrónico</p>
                </div>
              </div>
              <div class="setting-control"><input type="email" id="emailInput" placeholder="Tu correo electrónico" class="modern-input"></div>
            </article>

            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-lock"></i></div>
                <div class="setting-info">
                  <h3>Cambiar Contraseña</h3>
                  <p>Actualiza tu contraseña de forma segura</p>
                </div>
              </div>
              <div class="setting-control"><button id="changePasswordBtn" class="modern-btn primary" type="button"><i class="fas fa-key"></i><span>Cambiar Contraseña</span></button></div>
            </article>
          </div>
        </section>

        <section class="settings-section" id="storageSection">
          <div class="settings-section-header">
            <span class="settings-section-kicker">Datos locales</span>
            <div class="settings-section-title">
              <h2><i class="fas fa-hard-drive"></i> Almacenamiento</h2>
              <span class="settings-section-description">Caché, importación, exportación y datos guardados</span>
            </div>
          </div>
          <div class="settings-grid">
            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-memory"></i></div>
                <div class="setting-info">
                  <h3>Cache de Audio</h3>
                  <p>Almacena canciones en caché para reproducción offline</p>
                </div>
              </div>
              <div class="setting-control">
                <div class="setting-control-row">
                  <label class="modern-switch"><input type="checkbox" id="audioCacheToggle"><span class="switch-slider"></span></label>
                  <span id="audioCacheStatus" class="setting-status">Caché desactivada</span>
                </div>
                <div class="setting-subcontrol">
                  <label for="audioCacheSizeSelect">Tamaño máximo</label>
                  <select id="audioCacheSizeSelect" class="modern-select">
                    <option value="250">250 MB</option>
                    <option value="500" selected>500 MB</option>
                    <option value="1024">1 GB</option>
                    <option value="2048">2 GB</option>
                  </select>
                </div>
                <button id="clearAudioCacheBtn" class="modern-btn danger" type="button"><i class="fas fa-trash"></i><span>Vaciar caché</span></button>
              </div>
            </article>

            <article class="setting-card cache-library-card setting-card-wide">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-folder-open"></i></div>
                <div class="setting-info">
                  <h3>Biblioteca de Caché</h3>
                  <p>Revisa qué canciones quedaron guardadas para uso offline</p>
                </div>
              </div>
              <div class="setting-control">
                <div class="setting-inline-meta"><span id="audioCacheCount" class="setting-status">Cargando caché...</span></div>
                <div id="audioCacheLibrary" class="audio-cache-library"></div>
              </div>
            </article>

            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-download"></i></div>
                <div class="setting-info">
                  <h3>Exportar Datos</h3>
                  <p>Descarga tus playlists y configuraciones</p>
                </div>
              </div>
              <div class="setting-control"><button id="exportDataBtn" class="modern-btn primary" type="button"><i class="fas fa-file-export"></i><span>Exportar</span></button></div>
            </article>

            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-upload"></i></div>
                <div class="setting-info">
                  <h3>Importar Datos</h3>
                  <p>Carga tus playlists y configuraciones desde un archivo</p>
                </div>
              </div>
              <div class="setting-control import-container">
                <input type="file" id="importDataInput" accept=".json" class="file-input">
                <button id="importDataBtn" class="modern-btn secondary" type="button"><i class="fas fa-file-import"></i><span>Importar</span></button>
              </div>
            </article>

            <article class="setting-card setting-card-wide" id="statsCard">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-chart-pie"></i></div>
                <div class="setting-info">
                  <h3>Estadísticas de Uso</h3>
                  <p>Ve tus estadísticas de escucha y actividad</p>
                </div>
              </div>
              <div class="setting-control" id="statsContent"></div>
            </article>

            <article class="setting-card danger-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-trash-alt"></i></div>
                <div class="setting-info">
                  <h3>Restablecer Aplicación</h3>
                  <p>Elimina todas las playlists, canciones recientes y configuraciones</p>
                </div>
              </div>
              <div class="setting-control"><button id="deleteAllDataBtn" class="modern-btn danger" type="button"><i class="fas fa-triangle-exclamation"></i><span>Borrar Todo</span></button></div>
            </article>
          </div>
        </section>

        <section class="settings-section" id="privacySection">
          <div class="settings-section-header">
            <span class="settings-section-kicker">Control personal</span>
            <div class="settings-section-title">
              <h2><i class="fas fa-shield-halved"></i> Privacidad</h2>
              <span class="settings-section-description">Historial local, búsquedas y estado del reproductor</span>
            </div>
          </div>
          <div class="settings-grid">
            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-clock-rotate-left"></i></div>
                <div class="setting-info">
                  <h3>Guardar Historial Reciente</h3>
                  <p>Conserva canciones recientes para recomendaciones</p>
                </div>
              </div>
              <div class="setting-control setting-control-row">
                <label class="modern-switch"><input type="checkbox" id="saveHistoryToggle" checked><span class="switch-slider"></span></label>
                <span class="setting-status">Local</span>
              </div>
            </article>

            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-eraser"></i></div>
                <div class="setting-info">
                  <h3>Historial de Búsqueda</h3>
                  <p>Limpia las búsquedas guardadas</p>
                </div>
              </div>
              <div class="setting-control"><button id="clearSearchHistoryBtn" class="modern-btn secondary" type="button"><i class="fas fa-eraser"></i><span>Limpiar Búsquedas</span></button></div>
            </article>

            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-history"></i></div>
                <div class="setting-info">
                  <h3>Canciones Recientes</h3>
                  <p>Vacía la lista de reproducción reciente</p>
                </div>
              </div>
              <div class="setting-control"><button id="clearRecentTracksBtn" class="modern-btn secondary" type="button"><i class="fas fa-history"></i><span>Limpiar Recientes</span></button></div>
            </article>

            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-rotate-left"></i></div>
                <div class="setting-info">
                  <h3>Resetear Reproductor</h3>
                  <p>Detiene audio, cola y visualizador activos</p>
                </div>
              </div>
              <div class="setting-control"><button id="resetPlayerStateBtn" class="modern-btn secondary" type="button"><i class="fas fa-rotate-left"></i><span>Resetear Reproductor</span></button></div>
            </article>
          </div>
        </section>

        <section class="settings-section" id="shortcutsSection">
          <div class="settings-section-header">
            <span class="settings-section-kicker">Control rápido</span>
            <div class="settings-section-title">
              <h2><i class="fas fa-keyboard"></i> Atajos</h2>
              <span class="settings-section-description">Accesos de teclado y navegación rápida</span>
            </div>
          </div>
          <div class="settings-grid">
            <article class="setting-card setting-card-featured">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-keyboard"></i></div>
                <div class="setting-info">
                  <h3>Atajos de Teclado</h3>
                  <p>Configura atajos de teclado personalizados</p>
                </div>
              </div>
              <div class="setting-control"><button id="keyboardShortcutsBtn" class="modern-btn secondary" type="button"><i class="fas fa-keyboard"></i><span>Configurar</span></button></div>
            </article>
          </div>
        </section>

        <section class="settings-section" id="developerSection">
          <div class="settings-section-header">
            <span class="settings-section-kicker">Diagnóstico</span>
            <div class="settings-section-title">
              <h2><i class="fas fa-code"></i> Desarrollador</h2>
              <span class="settings-section-description">Herramientas para depuración, red y extracción de audio</span>
            </div>
          </div>
          <div class="settings-grid">
            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-code"></i></div>
                <div class="setting-info">
                  <h3>Modo Desarrollador</h3>
                  <p>Habilita herramientas de desarrollo y debugging</p>
                </div>
              </div>
              <div class="setting-control setting-control-row">
                <label class="modern-switch"><input type="checkbox" id="developerModeToggle"><span class="switch-slider"></span></label>
                <span id="developerModeStatus" class="setting-status">Desactivado</span>
              </div>
            </article>

            <article class="setting-card developer-tools-card setting-card-wide" id="developerToolsCard" style="display: none;">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-flask"></i></div>
                <div class="setting-info">
                  <h3>Herramientas de Desarrollo</h3>
                  <p>Utilidades para probar streaming, caché y diagnóstico</p>
                </div>
              </div>
              <div class="setting-control developer-tools-grid">
                <div class="developer-tool-item">
                  <div><strong>Acceso a Internet</strong><p>Activa o corta llamadas de red para probar caché y modo offline</p></div>
                  <label class="modern-switch"><input type="checkbox" id="internetAccessToggle"><span class="switch-slider"></span></label>
                </div>
                <div class="developer-tool-item">
                  <div><strong>Logs del reproductor</strong><p>Muestra más mensajes de depuración en consola</p></div>
                  <label class="modern-switch"><input type="checkbox" id="verbosePlayerLogsToggle"><span class="switch-slider"></span></label>
                </div>
                <div class="developer-tool-item">
                  <div><strong>Motor de extracción de audio</strong><p>Si un motor falla por cambios de YouTube, podés cambiar temporalmente al otro.</p></div>
                  <select id="audioExtractorSelect" class="modern-select">
                    <option value="auto" selected>Automático recomendado</option>
                    <option value="yt-dlp">yt-dlp</option>
                    <option value="ytdl-core">ytdl-core</option>
                  </select>
                </div>
                <div class="developer-tool-actions">
                  <button id="devTestNotificationBtn" class="modern-btn secondary" type="button"><i class="fas fa-bell"></i><span>Probar Notificaciones</span></button>
                  <button id="openDevToolsBtn" class="modern-btn secondary" type="button"><i class="fas fa-terminal"></i><span>Abrir DevTools</span></button>
                  <button id="copyDiagnosticsBtn" class="modern-btn primary" type="button"><i class="fas fa-notes-medical"></i><span>Copiar Diagnóstico</span></button>
                </div>
              </div>
            </article>
          </div>
        </section>

        <section class="settings-section" id="experimentalSection">
          <div class="settings-section-header">
            <span class="settings-section-kicker">Laboratorio</span>
            <div class="settings-section-title">
              <h2><i class="fas fa-flask"></i> Experimental</h2>
              <span class="settings-section-description">Preferencias avanzadas y datos técnicos de Lunera</span>
            </div>
          </div>
          <div class="settings-grid">
            <article class="setting-card">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-microchip"></i></div>
                <div class="setting-info">
                  <h3>Preferencia de Rendimiento</h3>
                  <p>Prioriza fluidez, equilibrio o ahorro de recursos</p>
                </div>
              </div>
              <div class="setting-control">
                <select id="performanceModeSelect" class="modern-select">
                  <option value="battery">Ahorro</option>
                  <option value="balanced" selected>Balanceado</option>
                  <option value="performance">Rendimiento</option>
                </select>
              </div>
            </article>

            <article class="setting-card" id="appInfoCard">
              <div class="setting-card-header">
                <div class="setting-icon"><i class="fas fa-info-circle"></i></div>
                <div class="setting-info">
                  <h3>Información de la Aplicación</h3>
                  <p>Versión, licencia y detalles técnicos</p>
                </div>
              </div>
              <div class="setting-control" id="appInfoContent"></div>
            </article>
          </div>
        </section>
      </div>
    </div>
  `;
}

function initializeAudioContext() {
  // Si ya existe un contexto y no está cerrado, devuélvelo
  if (audioContext && audioContext.state !== 'closed') {
    // Si ya tenemos sourceNode, no necesitamos hacer nada más
  } else {
    // Solo crear nuevo contexto si no existe o está cerrado
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({
          latencyHint: 'interactive'
        });
        console.log('Contexto de audio inicializado');
    } catch (error) {
        console.error('Error al inicializar contexto de audio:', error);
        return null;
    }
  }

  try {
    // Recrear nodos solo si es necesario
    if (!gainNode || gainNode.context !== audioContext) gainNode = audioContext.createGain();
    if (!equalizerPreampNode || equalizerPreampNode.context !== audioContext) equalizerPreampNode = audioContext.createGain();
    if (!equalizerLimiterNode || equalizerLimiterNode.context !== audioContext) {
        equalizerLimiterNode = audioContext.createDynamicsCompressor();
        equalizerLimiterNode.threshold.value = -6;
        equalizerLimiterNode.knee.value = 8;
        equalizerLimiterNode.ratio.value = 10;
        equalizerLimiterNode.attack.value = 0.003;
        equalizerLimiterNode.release.value = 0.18;
    }

    // Crear analizador de audio si no existe
    if (!analyser || analyser.context !== audioContext) {
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 4096;
        analyser.smoothingTimeConstant = 0.85;
        audioDataArray = new Uint8Array(analyser.frequencyBinCount);
    }
    
    // Configurar filtros del ecualizador si no existen
    if (!window.equalizerFilters || window.equalizerFilters[0].context !== audioContext) {
        const filters = [];
        
        EQ_FREQUENCIES.forEach(freq => {
          const filter = audioContext.createBiquadFilter();
          filter.type = freq <= 200 ? 'lowshelf' : freq >= 10000 ? 'highshelf' : 'peaking';
          filter.frequency.value = freq;
          filter.Q.value = state.audioSettings.equalizerQ || 1;
          filters.push(filter);
        });
        window.equalizerFilters = filters;
    }

    // Crear sourceNode SOLO UNA VEZ
    if (!sourceNode && elements.audio) {
        try {
            sourceNode = audioContext.createMediaElementSource(elements.audio);
        } catch (e) {
            console.warn('Ya existe un MediaElementSourceNode para este elemento:', e);
            // ERROR CRÍTICO: El elemento audio YA tiene un MediaElementSourceNode asociado,
            // pero hemos perdido la referencia a él (sourceNode es null).
            // Esto ocurre porque `audioContext` persiste pero `sourceNode` se perdió o reinició.
            // La única forma de recuperarse es reemplazar el elemento <audio> del DOM.
            
            console.log('Reemplazando elemento de audio para recuperar control...');
            
            const oldAudio = elements.audio;
            const newAudio = oldAudio.cloneNode(true); // Clonar el elemento
            oldAudio.parentNode.replaceChild(newAudio, oldAudio);
            elements.audio = newAudio;
            
            // Re-conectar event listeners
            setupAudioEventListeners();
            
            // Intentar crear el nodo de nuevo con el nuevo elemento
            try {
                sourceNode = audioContext.createMediaElementSource(elements.audio);
                console.log('MediaElementSourceNode recuperado con éxito');
            } catch (retryError) {
                console.error('Fallo fatal al recrear MediaElementSourceNode:', retryError);
            }
        }
    }

    // Conectar todo: Source -> EQ -> Analyser -> Gain -> Destination
    if (sourceNode) {
        // Desconectar todo primero por seguridad
        try { sourceNode.disconnect(); } catch(e) {}
        
        // Asegurar que el nodo fuente pertenezca al contexto actual
        if (sourceNode.context !== audioContext) {
            console.warn('SourceNode pertenece a otro contexto. Recreando...');
            try {
                sourceNode = audioContext.createMediaElementSource(elements.audio);
            } catch(e) {
                console.error('Error al recrear sourceNode:', e);
                // Si falla, intentamos el clonado de emergencia
                 const oldAudio = elements.audio;
                 const newAudio = oldAudio.cloneNode(true);
                 oldAudio.parentNode.replaceChild(newAudio, oldAudio);
                 elements.audio = newAudio;
                 setupAudioEventListeners();
                 sourceNode = audioContext.createMediaElementSource(elements.audio);
            }
        }
        
        let currentNode = sourceNode;
        
        // Conectar filtros
        if (window.equalizerFilters && window.equalizerFilters.length > 0) {
            // Conectar filtros entre sí
            for (let i = 0; i < window.equalizerFilters.length; i++) {
                try { window.equalizerFilters[i].disconnect(); } catch(e) {}
                if (i > 0) {
                    window.equalizerFilters[i-1].connect(window.equalizerFilters[i]);
                }
            }
            
            // Conectar source al primer filtro
            currentNode.connect(window.equalizerFilters[0]);
            
            // El último filtro es el nuevo nodo actual
            currentNode = window.equalizerFilters[window.equalizerFilters.length - 1];
        }
        
        // Conectar al analizador
        try { analyser.disconnect(); } catch(e) {}
        currentNode.connect(analyser);

        try { equalizerPreampNode.disconnect(); } catch(e) {}
        analyser.connect(equalizerPreampNode);
        currentNode = equalizerPreampNode;

        try { equalizerLimiterNode.disconnect(); } catch(e) {}
        if (state.audioSettings.equalizerLimiter) {
            currentNode.connect(equalizerLimiterNode);
            currentNode = equalizerLimiterNode;
        }
        
        // Conectar al gain
        try { gainNode.disconnect(); } catch(e) {}
        currentNode.connect(gainNode);
        
        // Conectar al destino
        gainNode.connect(audioContext.destination);
    }
    
    return audioContext;
  } catch (error) {
    console.error('Error al configurar nodos de audio:', error);
    throw error;
  }
}

function applyEqualizerSettings() {
  if (!audioContext || !window.equalizerFilters) return;

  EQ_FREQUENCIES.forEach((freq, index) => {
    if (window.equalizerFilters[index]) {
      const filter = window.equalizerFilters[index];
      const now = audioContext.currentTime;
      filter.gain.cancelScheduledValues(now);
      filter.gain.setTargetAtTime(Number(state.audioSettings.equalizer[freq]) || 0, now, 0.015);
      filter.Q.setTargetAtTime(Number(state.audioSettings.equalizerQ) || 1, now, 0.025);
    }
  });

  if (equalizerPreampNode) {
    const preampDb = Number(state.audioSettings.equalizerPreamp) || 0;
    equalizerPreampNode.gain.setTargetAtTime(Math.pow(10, preampDb / 20), audioContext.currentTime, 0.02);
  }
  
  console.log('Ajustes de ecualizador aplicados:', state.audioSettings.equalizer);
}

function updateEqualizerVisualizer() {
  const visualizer = document.querySelector('#equalizerVisualizer');
  if (!visualizer) return;
  
  const frequencies = EQ_FREQUENCIES;
  
  // Actualizar barras existentes en lugar de recrearlas para mejor rendimiento
  const currentBars = visualizer.querySelectorAll('.equalizer-bar');
  
  if (currentBars.length !== frequencies.length) {
    // Solo recrear si el número de barras es diferente
    visualizer.innerHTML = '';
    
    frequencies.forEach((freq, index) => {
      const bar = document.createElement('div');
      bar.className = 'equalizer-bar';
      visualizer.appendChild(bar);
    });
  }
  
  // Actualizar alturas de barras existentes
  frequencies.forEach((freq, index) => {
    const bar = visualizer.querySelectorAll('.equalizer-bar')[index];
    if (!bar) return;
    
    const value = state.audioSettings.equalizer[freq];
    // Lógica INVERTIDA: valores más altos = barras más altas
    // -12dB = 100%, 0dB = 50%, +12dB = 0% (invertido)
    const normalizedValue = (value + 12) / 24;
    const height = Math.max(6, normalizedValue * 100);
    
    bar.style.height = `${height}%`;
    bar.style.setProperty('--bar-intensity', normalizedValue.toFixed(2));
  });
}

function getEqualizerHeadroom() {
  const gains = EQ_FREQUENCIES.map(freq => Number(state.audioSettings.equalizer[freq]) || 0);
  const boostAverage = gains.filter(value => value > 0).reduce((sum, value) => sum + value, 0) / EQ_FREQUENCIES.length;
  return Math.max(-12, Math.min(6, (Number(state.audioSettings.equalizerPreamp) || 0) + boostAverage));
}

function formatDb(value) {
  const rounded = Number(value).toFixed(Number(value) % 1 === 0 ? 0 : 1);
  return `${value > 0 ? '+' : ''}${rounded} dB`;
}

function equalizerDbToSliderValue(value) {
  return -(Number(value) || 0);
}

function sliderValueToEqualizerDb(value) {
  return -(Number(value) || 0);
}

function applyEqualizerPreset(presetKey, modal) {
  const preset = EQ_PRESETS[presetKey];
  if (!preset) return;
  state.audioSettings.equalizer = { ...EQ_DEFAULT_CURVE, ...preset.curve };
  state.audioSettings.equalizerPreamp = preset.preamp;
  state.audioSettings.equalizerQ = preset.q;
  refreshEqualizerModal(modal, presetKey);
  applyEqualizerSettings();
  saveSettings();
}

function refreshEqualizerModal(modal, activePreset = null) {
  if (!modal) return;
  modal.querySelectorAll('.slider-input').forEach(slider => {
    const freq = Number(slider.dataset.frequency);
    const value = Number(state.audioSettings.equalizer[freq]) || 0;
    slider.value = equalizerDbToSliderValue(value);
    slider.setAttribute('aria-valuetext', formatDb(value));
    slider.closest('.equalizer-slider')?.style.setProperty('--eq-fill', `${((value + 12) / 24) * 100}%`);
    slider.closest('.equalizer-slider')?.querySelector('.slider-value')?.replaceChildren(document.createTextNode(formatDb(value)));
  });

  const preampInput = modal.querySelector('#equalizerPreamp');
  if (preampInput) preampInput.value = state.audioSettings.equalizerPreamp;
  const preampValue = modal.querySelector('#equalizerPreampValue');
  if (preampValue) preampValue.textContent = formatDb(Number(state.audioSettings.equalizerPreamp) || 0);

  const qInput = modal.querySelector('#equalizerQ');
  if (qInput) qInput.value = state.audioSettings.equalizerQ;
  const qValue = modal.querySelector('#equalizerQValue');
  if (qValue) qValue.textContent = `${Number(state.audioSettings.equalizerQ || 1).toFixed(2)} Q`;

  const limiterToggle = modal.querySelector('#equalizerLimiter');
  if (limiterToggle) limiterToggle.checked = !!state.audioSettings.equalizerLimiter;

  const headroom = getEqualizerHeadroom();
  const headroomMeter = modal.querySelector('.eq-headroom-meter');
  if (headroomMeter) headroomMeter.style.setProperty('--headroom-fill', `${Math.max(0, Math.min(100, ((headroom + 12) / 18) * 100))}%`);
  const headroomValue = modal.querySelector('#equalizerHeadroomValue');
  if (headroomValue) {
    headroomValue.textContent = headroom > 2 ? 'Riesgo de clipping' : headroom > 0 ? 'Caliente' : 'Limpio';
    headroomValue.dataset.state = headroom > 2 ? 'danger' : headroom > 0 ? 'warm' : 'clean';
  }

  modal.querySelectorAll('.equalizer-preset-btn').forEach(button => {
    button.classList.toggle('active', button.dataset.preset === activePreset);
  });
  updateEqualizerVisualizer();
}

function openLuxuryEqualizer() {
  const existing = document.querySelector('.equalizer-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.className = 'equalizer-modal';
  modal.innerHTML = `
    <div class="equalizer-content" role="dialog" aria-modal="true" aria-label="Ecualizador Lunera Studio">
      <div class="equalizer-header">
        <div>
          <span class="equalizer-kicker">Lunera Studio</span>
          <h3 class="equalizer-title"><i class="fas fa-sliders-h"></i> Ecualizador Pro</h3>
        </div>
        <button class="equalizer-icon-btn equalizer-x-btn" type="button" aria-label="Cerrar"><i class="fas fa-times"></i></button>
      </div>

      <div class="equalizer-dashboard">
        <div class="eq-studio-panel">
          <span class="eq-panel-label">Headroom</span>
          <strong id="equalizerHeadroomValue">Limpio</strong>
          <div class="eq-headroom-meter"><span></span></div>
        </div>
        <label class="eq-studio-panel eq-control-panel">
          <span class="eq-panel-label">Preamp</span>
          <strong id="equalizerPreampValue">0 dB</strong>
          <input id="equalizerPreamp" type="range" min="-12" max="6" step="0.5" value="${state.audioSettings.equalizerPreamp}">
        </label>
        <label class="eq-studio-panel eq-control-panel">
          <span class="eq-panel-label">Suavidad</span>
          <strong id="equalizerQValue">1.00 Q</strong>
          <input id="equalizerQ" type="range" min="0.5" max="2" step="0.05" value="${state.audioSettings.equalizerQ}">
        </label>
        <label class="eq-limiter-switch">
          <input id="equalizerLimiter" type="checkbox" ${state.audioSettings.equalizerLimiter ? 'checked' : ''}>
          <span><i class="fas fa-shield-alt"></i></span>
          <strong>Limitador suave</strong>
        </label>
      </div>

      <div class="equalizer-presets">
        ${Object.entries(EQ_PRESETS).map(([key, preset]) => `
          <button class="equalizer-preset-btn" type="button" data-preset="${key}">
            <strong>${preset.label}</strong>
            <span>${preset.vibe}</span>
          </button>
        `).join('')}
      </div>

      <div class="equalizer-main">
        <div class="equalizer-sliders">
          ${EQ_FREQUENCIES.map((freq, index) => {
            const value = Number(state.audioSettings.equalizer[freq]) || 0;
            return `
              <div class="equalizer-slider" style="--eq-fill:${((value + 12) / 24) * 100}%">
                <div class="slider-band-name">${EQ_BAND_NAMES[index]}</div>
                <div class="slider-value">${formatDb(value)}</div>
                <div class="slider-track">
                  <input type="range" min="-12" max="12" value="${equalizerDbToSliderValue(value)}" data-frequency="${freq}" step="0.5" class="slider-input" aria-label="${EQ_BAND_NAMES[index]} ${EQ_LABELS[index]}Hz" aria-valuetext="${formatDb(value)}">
                </div>
                <label class="slider-label">${EQ_LABELS[index]}<span>Hz</span></label>
              </div>
            `;
          }).join('')}
        </div>
        <div class="equalizer-visualizer-wrap">
          <div class="equalizer-visualizer" id="equalizerVisualizer"></div>
          <div class="eq-visualizer-caption">Curva tonal</div>
        </div>
      </div>

      <div class="equalizer-controls">
        <button class="equalizer-reset-btn" type="button"><i class="fas fa-undo"></i> Reset</button>
        <button class="equalizer-close-btn" type="button"><i class="fas fa-check"></i> Aplicar</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  refreshEqualizerModal(modal, 'flat');

  modal.querySelectorAll('.equalizer-preset-btn').forEach(button => {
    button.addEventListener('click', () => applyEqualizerPreset(button.dataset.preset, modal));
  });

  modal.querySelectorAll('.slider-input').forEach(slider => {
    slider.addEventListener('input', (event) => {
      const freq = Number(event.target.dataset.frequency);
      const value = sliderValueToEqualizerDb(event.target.value);
      state.audioSettings.equalizer[freq] = value;
      refreshEqualizerModal(modal);
      applyEqualizerSettings();
      saveSettings();
    });
  });

  modal.querySelector('#equalizerPreamp')?.addEventListener('input', (event) => {
    state.audioSettings.equalizerPreamp = Number(event.target.value);
    refreshEqualizerModal(modal);
    applyEqualizerSettings();
    saveSettings();
  });

  modal.querySelector('#equalizerQ')?.addEventListener('input', (event) => {
    state.audioSettings.equalizerQ = Number(event.target.value);
    refreshEqualizerModal(modal);
    applyEqualizerSettings();
    saveSettings();
  });

  modal.querySelector('#equalizerLimiter')?.addEventListener('change', (event) => {
    state.audioSettings.equalizerLimiter = event.target.checked;
    initializeAudioContext();
    applyEqualizerSettings();
    saveSettings();
  });

  modal.querySelector('.equalizer-reset-btn')?.addEventListener('click', () => applyEqualizerPreset('flat', modal));
  modal.querySelector('.equalizer-close-btn')?.addEventListener('click', () => modal.remove());
  modal.querySelector('.equalizer-x-btn')?.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', event => {
    if (event.target === modal) modal.remove();
  });

  const handleEscape = (event) => {
    if (event.key === 'Escape') {
      modal.remove();
      document.removeEventListener('keydown', handleEscape);
    }
  };
  document.addEventListener('keydown', handleEscape);
}

function applyVolumeNormalization() {
  if (!audioContext) return;
  if (state.audioSettings.normalizeVolume) {
    gainNode.gain.value = 0.8; // Normalizar a un nivel consistente
  } else {
    gainNode.gain.value = state.volume;
  }
  console.log('Normalización de volumen aplicada:', state.audioSettings.normalizeVolume);
}

function resetAudioContext() {
  if (audioContext) {
    // Cierra el contexto de audio existente
    audioContext.close().catch(console.error);
    audioContext = null;
  }
  // Crea un nuevo contexto de audio
  initializeAudioContext();
}

async function cleanAudioResources() {
  // Detener efectos visuales si es necesario
  stopSpectrogram();
  
  // Ya no destruimos el contexto de audio ni el elemento de audio
  // Esto permite transiciones más suaves y evita errores de "InvalidStateError"
  
  console.log('Recursos de audio preparados para nueva pista');
}

// Nueva función para configurar los event listeners del audio
function setupAudioEventListeners() {
  if (!elements.audio) {
    console.warn('Elemento audio no encontrado');
    return;
  }

  let lastUpdate = 0;
  elements.audio.addEventListener('timeupdate', () => {
    const now = Date.now();
    if (now - lastUpdate < 33) return;
    lastUpdate = now;

    if (!state.currentTrack) return;

    updateProgressUI();
    applyCrossfade();
  });

  elements.audio.addEventListener('durationchange', () => {
    updateProgressUI();
  });

  elements.audio.addEventListener('volumechange', updateVolumeUI);

  elements.audio.addEventListener('play', () => {
    state.isPlaying = true;
    updatePlayingUI(true);
    showPlayingGif();
    if (state.visualSettings.showVisualizer && !spectrogramFrameId) {
      startSpectrogram();
    }
  });

  elements.audio.addEventListener('pause', () => {
    state.isPlaying = false;
    updatePlayingUI(false);
    hidePlayingGif();
  });

  // Cambiar esto:
  // elements.audio.addEventListener('ended', handleTrackEnded);
  // Por esto para mayor compatibilidad:
  elements.audio.addEventListener('ended', () => {
    handleTrackEnded().catch(error => {
      console.error('Error en handleTrackEnded:', error);
      notificationSystem.error('Error al manejar el fin de la canción');
    });
  });
}

// Elementos DOM
const elements = {
  audio: document.getElementById('audioPlayer'),
  playPauseButton: document.getElementById('playPauseButton'),
  nextButton: document.getElementById('nextButton'),
  previousButton: document.getElementById('previousButton'),
  shuffleButton: document.getElementById('shuffleButton'),
  repeatButton: document.getElementById('repeatButton'),
  progressBar: document.getElementById('progressBar'),
  volumeProgress: document.getElementById('volumeProgress'),
  currentTime: document.getElementById('currentTime'),
  totalTime: document.getElementById('totalTime'),
  currentTrackTitle: document.getElementById('currentTrackTitle'),
  currentTrackArtist: document.getElementById('currentTrackArtist'),
  currentTrackImg: document.getElementById('currentTrackImg'),
  currentTrackArtShell: document.querySelector('.track-art-shell'),
  emptyTrackArt: document.getElementById('emptyTrackArt'),
  nowPlayingBar: document.querySelector('.now-playing-bar'),
  nowPlayingStatus: document.getElementById('nowPlayingStatus'),
  nowPlayingQueueButton: document.getElementById('nowPlayingQueueButton'),
  nowPlayingQueueCount: document.getElementById('nowPlayingQueueCount'),
  lyricsButton: document.getElementById('lyricsButton'),
  miniPlayerButton: document.getElementById('miniPlayerButton'),
  lyricsModal: document.getElementById('lyricsModal'),
  lyricsModalBackdrop: document.getElementById('lyricsModalBackdrop'),
  closeLyricsButton: document.getElementById('closeLyricsButton'),
  lyricsModalTitle: document.getElementById('lyricsModalTitle'),
  lyricsModalArtist: document.getElementById('lyricsModalArtist'),
  lyricsContent: document.getElementById('lyricsContent'),
  searchInput: document.getElementById('searchInput'),
  searchResults: document.getElementById('searchResults'),
  libraryContent: document.getElementById('libraryContent'),
  volumeButton: document.getElementById('volumeButton'),
  volumeValue: document.getElementById('volumeValue'),
  gifToggle: document.getElementById('gifToggle'),
  uploadGifBtn: document.getElementById('uploadGif'),
  gifInput: document.getElementById('gifInput'),
  removeGifBtn: document.querySelector('.remove-gif'),
  closeGifBtn: document.querySelector('.close-gif'),
  visualizerToggle: document.getElementById('visualizerToggle'),
  visualizerOpacityControl: document.getElementById('visualizerOpacityControl'),
  visualizerOpacitySlider: document.getElementById('visualizerOpacitySlider'),
  visualizerOpacityValue: document.getElementById('visualizerOpacityValue'),
  dedicationLink: document.getElementById('dedicationLink'),
  dedicationCreditsBtn: document.getElementById('dedicationCreditsBtn'),
  // Elementos adicionales para la pantalla de carga y el menú de creación de cuenta
  loadingScreen: document.getElementById('loadingScreen'),
  signupScreen: document.getElementById('signupScreen'),
  signupForm: document.getElementById('authForm'), // Cambiado de signupForm a authForm
  skipSignup: document.getElementById('skipSignup'),
  feedbackPromptScreen: document.getElementById('feedbackPromptScreen'),
  feedbackPromptLink: document.getElementById('feedbackPromptLink'),
  openFeedbackFormBtn: document.getElementById('openFeedbackFormBtn'),
  closeFeedbackPromptBtn: document.getElementById('closeFeedbackPromptBtn'),
  signupTab: document.getElementById('signupTab'), // Nueva pestaña
  loginTab: document.getElementById('loginTab'), // Nueva pestaña
  signupMessage: document.getElementById('signupMessage'), // Nuevo mensaje
  authSubmitBtn: document.getElementById('authSubmitBtn'), // Nuevo botón de envío
  // Elementos de configuración avanzada
  crossfadeSlider: document.getElementById('crossfadeSlider'),
  crossfadeValue: document.getElementById('crossfadeValue'),
  normalizeVolumeToggle: document.getElementById('normalizeVolumeToggle'),
  themeSelector: document.getElementById('themeSelector'),
  accentColorPicker: document.getElementById('accentColorPicker'),
  autoplayToggle: document.getElementById('autoplayToggle'),
  autoQueueToggle: document.getElementById('autoQueueToggle'),
  usernameInput: document.getElementById('usernameInput'),
  emailInput: document.getElementById('emailInput'),
  changePasswordBtn: document.getElementById('changePasswordBtn'),
  exportDataBtn: document.getElementById('exportDataBtn'),
  importDataBtn: document.getElementById('importDataBtn'),
  importDataInput: document.getElementById('importDataInput'),
  importSpotifyPlaylistBtn: document.getElementById('importSpotifyPlaylistBtn'),
  deleteAllDataBtn: document.getElementById('deleteAllDataBtn'),
  openEqualizerBtn: document.getElementById('openEqualizerBtn'),
  accentColorPreview: document.getElementById('accentColorPreview'),
  accentColorHex: document.getElementById('accentColorHex'),
  randomAccentBtn: document.getElementById('randomAccentBtn'),
  developerModeToggle: document.getElementById('developerModeToggle'),
  developerModeStatus: document.getElementById('developerModeStatus'),
  developerToolsCard: document.getElementById('developerToolsCard'),
  internetAccessToggle: document.getElementById('internetAccessToggle'),
  verbosePlayerLogsToggle: document.getElementById('verbosePlayerLogsToggle'),
  audioExtractorSelect: document.getElementById('audioExtractorSelect'),
  openDevToolsBtn: document.getElementById('openDevToolsBtn'),
  copyDiagnosticsBtn: document.getElementById('copyDiagnosticsBtn'),
  clearSearchHistoryBtn: document.getElementById('clearSearchHistoryBtn'),
  clearRecentTracksBtn: document.getElementById('clearRecentTracksBtn'),
  resetPlayerStateBtn: document.getElementById('resetPlayerStateBtn'),
  interfaceSwitchLoader: document.getElementById('interfaceSwitchLoader'),
  interfaceSwitchTitle: document.getElementById('interfaceSwitchTitle'),
  interfaceSwitchMessage: document.getElementById('interfaceSwitchMessage'),
  audioCacheToggle: document.getElementById('audioCacheToggle'),
  audioCacheStatus: document.getElementById('audioCacheStatus'),
  audioCacheCount: document.getElementById('audioCacheCount'),
  audioCacheLibrary: document.getElementById('audioCacheLibrary'),
  streamingQualityHint: document.getElementById('streamingQualityHint'),
  streamingQualityStatus: document.getElementById('streamingQualityStatus'),
  defaultVolumeHint: document.getElementById('defaultVolumeHint'),
  // Upload elements
  fileInput: document.getElementById('fileInput'),
  selectFilesBtn: document.getElementById('selectFilesBtn'),
  uploadArea: document.getElementById('uploadArea'),
  uploadProgress: document.getElementById('uploadProgress'),
  progressBarFill: document.getElementById('progressBarFill'),
  uploadStatus: document.getElementById('uploadStatus'),
  filesList: document.getElementById('filesList'),
  localMusicContainer: document.getElementById('localMusicContainer'),
  spectrogram: document.getElementById('spectrogram'),
  spectrogramCanvas: document.getElementById('spectrogramCanvas')
};

function refreshSettingsElementReferences() {
  Object.assign(elements, {
    gifToggle: document.getElementById('gifToggle'),
    uploadGifBtn: document.getElementById('uploadGif'),
    gifInput: document.getElementById('gifInput'),
    removeGifBtn: document.querySelector('.remove-gif'),
    visualizerToggle: document.getElementById('visualizerToggle'),
    visualizerOpacityControl: document.getElementById('visualizerOpacityControl'),
    visualizerOpacitySlider: document.getElementById('visualizerOpacitySlider'),
    visualizerOpacityValue: document.getElementById('visualizerOpacityValue'),
    normalizeVolumeToggle: document.getElementById('normalizeVolumeToggle'),
    accentColorPicker: document.getElementById('accentColorPicker'),
    autoplayToggle: document.getElementById('autoplayToggle'),
    autoQueueToggle: document.getElementById('autoQueueToggle'),
    usernameInput: document.getElementById('usernameInput'),
    emailInput: document.getElementById('emailInput'),
    changePasswordBtn: document.getElementById('changePasswordBtn'),
    exportDataBtn: document.getElementById('exportDataBtn'),
    importDataBtn: document.getElementById('importDataBtn'),
    importDataInput: document.getElementById('importDataInput'),
    importSpotifyPlaylistBtn: document.getElementById('importSpotifyPlaylistBtn'),
    deleteAllDataBtn: document.getElementById('deleteAllDataBtn'),
    openEqualizerBtn: document.getElementById('openEqualizerBtn'),
    accentColorPreview: document.getElementById('accentColorPreview'),
    accentColorHex: document.getElementById('accentColorHex'),
    randomAccentBtn: document.getElementById('randomAccentBtn'),
    developerModeToggle: document.getElementById('developerModeToggle'),
    developerModeStatus: document.getElementById('developerModeStatus'),
    developerToolsCard: document.getElementById('developerToolsCard'),
    internetAccessToggle: document.getElementById('internetAccessToggle'),
    verbosePlayerLogsToggle: document.getElementById('verbosePlayerLogsToggle'),
    audioExtractorSelect: document.getElementById('audioExtractorSelect'),
    openDevToolsBtn: document.getElementById('openDevToolsBtn'),
    copyDiagnosticsBtn: document.getElementById('copyDiagnosticsBtn'),
    clearSearchHistoryBtn: document.getElementById('clearSearchHistoryBtn'),
    clearRecentTracksBtn: document.getElementById('clearRecentTracksBtn'),
    resetPlayerStateBtn: document.getElementById('resetPlayerStateBtn'),
    audioCacheToggle: document.getElementById('audioCacheToggle'),
    audioCacheStatus: document.getElementById('audioCacheStatus'),
    audioCacheCount: document.getElementById('audioCacheCount'),
    audioCacheLibrary: document.getElementById('audioCacheLibrary'),
    streamingQualityHint: document.getElementById('streamingQualityHint'),
    streamingQualityStatus: document.getElementById('streamingQualityStatus'),
    defaultVolumeHint: document.getElementById('defaultVolumeHint')
  });
}

renderPremiumSettingsShell();
refreshSettingsElementReferences();

console.log('Inicializando renderer.js...');

const NOW_PLAYING_STATE_COPY = {
  empty: 'Sin pista cargada',
  loading: 'Cargando audio',
  playing: 'Reproduciendo',
  paused: 'En pausa',
  error: 'Error de reproducción'
};

function setNowPlayingState(nextState, detailText = '') {
  const playerState = NOW_PLAYING_STATE_COPY[nextState] ? nextState : 'empty';
  state.playerUiState = playerState;

  if (!elements.nowPlayingBar) {
    elements.nowPlayingBar = document.querySelector('.now-playing-bar');
  }

  if (elements.nowPlayingBar) {
    elements.nowPlayingBar.dataset.playerState = playerState;
    elements.nowPlayingBar.classList.toggle('is-empty', playerState === 'empty');
    elements.nowPlayingBar.classList.toggle('is-loading', playerState === 'loading');
    elements.nowPlayingBar.classList.toggle('is-playing', playerState === 'playing');
    elements.nowPlayingBar.classList.toggle('is-paused', playerState === 'paused');
    elements.nowPlayingBar.classList.toggle('is-error', playerState === 'error');
  }

  if (elements.nowPlayingStatus) {
    elements.nowPlayingStatus.textContent = detailText || NOW_PLAYING_STATE_COPY[playerState];
  }

  if (elements.playPauseButton) {
    const isLoading = playerState === 'loading';
    const isPlaying = playerState === 'playing';
    const icon = isLoading ? 'spinner' : isPlaying ? 'pause' : 'play';
    elements.playPauseButton.innerHTML = `<i class="fas fa-${icon}"></i>`;
    elements.playPauseButton.title = isPlaying ? 'Pausar' : 'Reproducir';
    elements.playPauseButton.setAttribute('aria-label', elements.playPauseButton.title);
  }

  sendMiniPlayerState({ force: true });
}

function syncNowPlayingTextAttributes() {
  if (elements.currentTrackTitle) {
    elements.currentTrackTitle.title = elements.currentTrackTitle.textContent || '';
  }
  if (elements.currentTrackArtist) {
    elements.currentTrackArtist.title = elements.currentTrackArtist.textContent || '';
  }
}

function updateProgressUI() {
  if (!elements.audio || !elements.progressBar) return;

  const duration = Number(elements.audio.duration);
  const currentTime = Number(elements.audio.currentTime);
  const hasDuration = Number.isFinite(duration) && duration > 0;
  const safeCurrent = Number.isFinite(currentTime) ? currentTime : 0;
  const progress = hasDuration ? Math.min(Math.max((safeCurrent / duration) * 100, 0), 100) : 0;

  elements.progressBar.style.width = `${progress}%`;
  elements.progressBar.style.background = '';
  elements.progressBar.style.opacity = '1';
  elements.progressBar.parentElement?.setAttribute('aria-valuenow', String(Math.round(progress)));

  if (elements.currentTime) {
    elements.currentTime.textContent = formatTime(safeCurrent);
  }
  if (elements.totalTime) {
    elements.totalTime.textContent = hasDuration ? formatTime(duration) : '0:00';
  }

  sendMiniPlayerState({ throttleMs: 220 });
}

function updateNowPlayingQueueButton() {
  const queueLength = state.queue.length;

  if (elements.nowPlayingQueueCount) {
    elements.nowPlayingQueueCount.textContent = String(queueLength);
    elements.nowPlayingQueueCount.classList.toggle('has-items', queueLength > 0);
  }

  if (elements.nowPlayingQueueButton) {
    const queueContainer = document.querySelector('.queue-container');
    const isOpen = !!queueContainer?.classList.contains('active');
    elements.nowPlayingQueueButton.classList.toggle('active', isOpen);
    elements.nowPlayingQueueButton.title = isOpen ? 'Ocultar cola' : 'Mostrar cola';
    elements.nowPlayingQueueButton.setAttribute('aria-label', elements.nowPlayingQueueButton.title);
  }
}

function toggleNowPlayingQueue() {
  const queueContainer = document.querySelector('.queue-container');
  if (!queueContainer) return;

  const shouldOpen = !queueContainer.classList.contains('active');
  if (shouldOpen) {
    updateQueueUI({ forceVisible: true });
  } else {
    queueContainer.classList.remove('active');
    updateNowPlayingQueueButton();
  }
}

function getSavedInterfaceMode() {
  const savedMode = localStorage.getItem(INTERFACE_MODE_STORAGE_KEY);
  return VALID_INTERFACE_MODES.includes(savedMode) ? savedMode : 'classic';
}

function updateInterfaceModeButtons(mode) {
  document.querySelectorAll('.interface-mode-option').forEach(option => {
    option.classList.toggle('active', option.dataset.interfaceMode === mode);
  });
}

function showInterfaceSwitchLoader(mode) {
  const loader = document.getElementById('interfaceSwitchLoader');
  if (!loader) return;
  const title = document.getElementById('interfaceSwitchTitle');
  const message = document.getElementById('interfaceSwitchMessage');
  if (title) {
    title.textContent = mode === 'neo' ? 'Activando interfaz Neo' : 'Restaurando interfaz antigua';
  }
  if (message) {
    message.textContent = mode === 'neo' ? 'Reordenando paneles, colores y reproductor' : 'Volviendo al diseño clásico de Lunera';
  }
  loader.classList.add('active');
  loader.setAttribute('aria-hidden', 'false');
}

function hideInterfaceSwitchLoader() {
  const loader = document.getElementById('interfaceSwitchLoader');
  if (!loader) return;
  loader.classList.remove('active');
  loader.setAttribute('aria-hidden', 'true');
}

function applyInterfaceMode(mode, options = {}) {
  const nextMode = VALID_INTERFACE_MODES.includes(mode) ? mode : 'classic';
  state.visualSettings.interfaceMode = nextMode;
  localStorage.setItem(INTERFACE_MODE_STORAGE_KEY, nextMode);
  updateInterfaceModeButtons(nextMode);

  const commitMode = () => {
    document.body.dataset.interfaceMode = nextMode;
    document.body.classList.toggle('neo-interface', nextMode === 'neo');
    document.body.classList.toggle('classic-interface', nextMode === 'classic');
    const label = document.getElementById('settingsInterfaceLabel');
    if (label) label.textContent = nextMode === 'neo' ? 'Neo' : 'Antigua';
  };

  if (options.withLoader) {
    showInterfaceSwitchLoader(nextMode);
    window.setTimeout(() => {
      commitMode();
      window.setTimeout(hideInterfaceSwitchLoader, 520);
    }, 420);
    return;
  }

  commitMode();
}

function initializeInterfaceModeControls() {
  const mode = getSavedInterfaceMode();
  applyInterfaceMode(mode, { skipSave: true });
  document.querySelectorAll('.interface-mode-option').forEach(option => {
    if (option.dataset.bound) return;
    option.dataset.bound = 'true';
    option.addEventListener('click', () => {
      const selectedMode = option.dataset.interfaceMode || 'classic';
      if (selectedMode === state.visualSettings.interfaceMode) return;
      applyInterfaceMode(selectedMode, { withLoader: true });
      saveSettings();
    });
  });
}

function getLocalMusicContainer() {
  return document.getElementById('myMusicContainer') || elements.localMusicContainer;
}

elements.localMusicContainer = getLocalMusicContainer() || elements.localMusicContainer;

updateLibraryUI = function() {
  const updatedPlaylistsContainer = document.getElementById('playlistsContainer');
  const updatedFavoritesContainer = document.getElementById('favoritesContainer');
  const createPlaylistBtn = document.getElementById('createPlaylistBtn');

  if (!updatedPlaylistsContainer || !updatedFavoritesContainer || !createPlaylistBtn) {
    return;
  }

  if (state.playlists && state.playlists.length > 0) {
    updatedPlaylistsContainer.innerHTML = '';
    state.playlists.forEach(playlist => {
      const playlistDiv = document.createElement('div');
      playlistDiv.className = 'playlist-item';
      playlistDiv.innerHTML = `
        <span>${playlist.name}</span>
        <button class="view-playlist" data-id="${playlist.id}">Ver</button>
      `;
      updatedPlaylistsContainer.appendChild(playlistDiv);
    });
  } else {
    updatedPlaylistsContainer.innerHTML = '<p>No hay playlists. Crea una nueva.</p>';
  }

  if (state.favorites && state.favorites.length > 0) {
    updatedFavoritesContainer.innerHTML = '';
    state.favorites.forEach(track => {
      updatedFavoritesContainer.appendChild(createTrackCard(track));
    });
  } else {
    updatedFavoritesContainer.innerHTML = '<p>No hay canciones en tus favoritos.</p>';
  }

  createPlaylistBtn.removeEventListener('click', createPlaylist);
  createPlaylistBtn.addEventListener('click', createPlaylist);

  document.querySelectorAll('.view-playlist').forEach(btn => {
    btn.addEventListener('click', () => viewPlaylist(btn.dataset.id));
  });
};

displayLocalMusic = function(tracks) {
  const localMusicContainer = getLocalMusicContainer();
  if (!localMusicContainer) return;

  if (!tracks.length) {
    localMusicContainer.innerHTML = '<p>No hay música local subida.</p>';
    return;
  }

  const tracksGrid = document.createElement('div');
  tracksGrid.className = 'tracks-grid';

  tracks.forEach(track => {
    tracksGrid.appendChild(createTrackCard(track));
  });

  localMusicContainer.innerHTML = '';
  localMusicContainer.appendChild(tracksGrid);
};

// Cargar configuración guardada
const savedSettings = JSON.parse(localStorage.getItem('appSettings') || '{}');
state.settings = { ...state.settings, ...savedSettings };
state.audioSettings = { ...state.audioSettings, ...savedSettings.audioSettings };
state.audioSettings.equalizer = { ...EQ_DEFAULT_CURVE, ...(state.audioSettings.equalizer || {}) };
state.audioSettings.equalizerPreamp = Number(state.audioSettings.equalizerPreamp) || 0;
state.audioSettings.equalizerQ = Number(state.audioSettings.equalizerQ) || 1;
state.audioSettings.equalizerLimiter = state.audioSettings.equalizerLimiter !== false;
state.visualSettings = { ...state.visualSettings, ...savedSettings.visualSettings };
state.playbackSettings = { ...state.playbackSettings, ...savedSettings.playbackSettings };
state.developerSettings = { ...state.developerSettings, ...savedSettings.developerSettings };
state.privacySettings = { ...state.privacySettings, ...savedSettings.privacySettings };
const savedUser = JSON.parse(localStorage.getItem('user') || '{}');
state.account = { ...state.account, ...savedUser };

async function loadVisualSettings() {
  try {
    const visualSettings = await ipcRenderer.invoke('get-visual-settings');
    state.visualSettings = { ...state.visualSettings, ...visualSettings };
    console.log('Configuraciones visuales cargadas:', state.visualSettings);
    updateVisualizerState(state.visualSettings.showVisualizer);
    updateSettingsUI();
  } catch (error) {
    console.error('Error al cargar configuraciones visuales:', error);
  }
}

// Actualizar la UI de configuración
function updateSettingsUI() {
  if (elements.normalizeVolumeToggle) elements.normalizeVolumeToggle.checked = state.audioSettings.normalizeVolume;
  if (elements.visualizerToggle) elements.visualizerToggle.checked = state.visualSettings.showVisualizer;
  if (elements.visualizerOpacitySlider) {
    elements.visualizerOpacitySlider.value = Math.round((state.visualSettings.spectrogramOpacity ?? 0.4) * 100);
  }
  if (elements.gifToggle) elements.gifToggle.checked = state.settings.showGif;
  if (elements.themeSelector) elements.themeSelector.value = state.visualSettings.theme;
  if (elements.accentColorPicker) elements.accentColorPicker.value = state.visualSettings.accentColor;
  if (elements.autoplayToggle) elements.autoplayToggle.checked = state.playbackSettings.autoplay;
  if (elements.autoQueueToggle) elements.autoQueueToggle.checked = state.playbackSettings.autoQueue;
  const smartShuffleToggle = document.getElementById('smartShuffleToggle');
  if (smartShuffleToggle) smartShuffleToggle.checked = !!state.playbackSettings.smartShuffle;
  if (elements.developerModeToggle) elements.developerModeToggle.checked = !!state.developerSettings.enabled;
  if (elements.verbosePlayerLogsToggle) elements.verbosePlayerLogsToggle.checked = !!state.developerSettings.verbosePlayerLogs;
  if (elements.usernameInput) elements.usernameInput.value = state.account.username;
  if (elements.emailInput) elements.emailInput.value = state.account.email;

  updateProgressBarsColor(state.visualSettings.accentColor);
  refreshAccentColorUI(state.visualSettings.accentColor);
  refreshDefaultVolumeUI();
  refreshDeveloperModeUI();
  applyTheme(state.visualSettings.theme);
  applyInterfaceMode(getSavedInterfaceMode());
  applySpectrogramOpacity(state.visualSettings.spectrogramOpacity, { persist: false });
  updateVisualizerOpacityUI();
  refreshPremiumSettingsUI();
  const gifSettings = document.querySelector('.gif-settings-card');
  if (gifSettings) {
    gifSettings.style.display = state.settings.showGif ? 'block' : 'none';
  }
}

function clampSpectrogramOpacity(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return 0.4;
  return Math.min(1, Math.max(0, numericValue));
}

function updateVisualizerOpacityUI() {
  const opacityPercent = Math.round(clampSpectrogramOpacity(state.visualSettings.spectrogramOpacity) * 100);

  if (elements.visualizerOpacityValue) {
    elements.visualizerOpacityValue.textContent = `${opacityPercent}%`;
  }

  if (elements.visualizerOpacityControl) {
    elements.visualizerOpacityControl.style.display = state.visualSettings.showVisualizer ? 'block' : 'none';
  }
}

function applySpectrogramOpacity(value, { persist = true } = {}) {
  const opacity = clampSpectrogramOpacity(value);
  state.visualSettings.spectrogramOpacity = opacity;

  if (elements.visualizerOpacitySlider) {
    const sliderValue = String(Math.round(opacity * 100));
    if (elements.visualizerOpacitySlider.value !== sliderValue) {
      elements.visualizerOpacitySlider.value = sliderValue;
    }
  }

  if (elements.spectrogram) {
    elements.spectrogram.style.opacity = String(opacity);
    elements.spectrogram.style.backgroundColor = 'rgba(0, 0, 0, 1)';
  }

  updateVisualizerOpacityUI();

  if (!persist) {
    return;
  }

  saveSettings();
  ipcRenderer.invoke('set-visual-settings', state.visualSettings)
    .then(() => {
      console.log('Opacidad del espectrograma actualizada:', opacity);
    })
    .catch(error => {
      console.error('Error al actualizar opacidad del espectrograma:', error);
    });
}

// Aplicar tema
function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.style.setProperty('--background-dark', '#f5f5f5');
    document.documentElement.style.setProperty('--background-darker', '#e0e0e0');
    document.documentElement.style.setProperty('--background-light', '#ffffff');
    document.documentElement.style.setProperty('--text-primary', '#121212');
    document.documentElement.style.setProperty('--text-secondary', '#666666');
    document.documentElement.style.setProperty('--border-color', '#e0e0e0');
  } else if (theme === 'dark') {
    document.documentElement.style.setProperty('--background-dark', '#121212');
    document.documentElement.style.setProperty('--background-darker', '#000000');
    document.documentElement.style.setProperty('--background-light', '#282828');
    document.documentElement.style.setProperty('--text-primary', '#ffffff');
    document.documentElement.style.setProperty('--text-secondary', '#b3b3b3');
    document.documentElement.style.setProperty('--border-color', '#404040');
  } else if (theme === 'custom') {
    // Tema personalizado - usar colores guardados o valores por defecto
    const customTheme = state.visualSettings.customTheme || {
      backgroundDark: '#1a1a1a',
      backgroundDarker: '#0d0d0d',
      backgroundLight: '#2a2a2a',
      textPrimary: '#ffffff',
      textSecondary: '#cccccc',
      borderColor: '#404040'
    };
    
    document.documentElement.style.setProperty('--background-dark', customTheme.backgroundDark);
    document.documentElement.style.setProperty('--background-darker', customTheme.backgroundDarker);
    document.documentElement.style.setProperty('--background-light', customTheme.backgroundLight);
    document.documentElement.style.setProperty('--text-primary', customTheme.textPrimary);
    document.documentElement.style.setProperty('--text-secondary', customTheme.textSecondary);
    document.documentElement.style.setProperty('--border-color', customTheme.borderColor);
  }
  
  console.log('Tema aplicado:', theme);
}

// Oscurecer color
function darkenColor(hex, factor) {
  const clamp = (value) => Math.max(0, Math.min(255, value));
  const r = clamp(parseInt(hex.slice(1, 3), 16) * factor);
  const g = clamp(parseInt(hex.slice(3, 5), 16) * factor);
  const b = clamp(parseInt(hex.slice(5, 7), 16) * factor);
  return `#${Math.round(r).toString(16).padStart(2, '0')}${Math.round(g).toString(16).padStart(2, '0')}${Math.round(b).toString(16).padStart(2, '0')}`;
}


// Throttle para actualización de colores
let colorUpdateTimeout = null;

// Sistema optimizado de barras de progreso
function updateProgressBarsColor(color) {
  state.visualSettings.accentColor = color;
  
  // Aplicar variables CSS inmediatamente
  document.documentElement.style.setProperty('--primary-color', color);
  document.documentElement.style.setProperty('--primary-dark', darkenColor(color, 0.8));
  
  // Throttle para operaciones pesadas
  if (colorUpdateTimeout) {
    clearTimeout(colorUpdateTimeout);
  }
  
  colorUpdateTimeout = setTimeout(() => {
    // Aplicar directamente a las barras de progreso
    const progressElements = document.querySelectorAll('.progress-bar, .volume-progress, .progress, .volume-bar, .player-progress, .volume-control, .progress-container');
    progressElements.forEach(el => {
      el.style.background = '';
      el.style.boxShadow = '';
      el.style.border = '';
      el.style.filter = '';
    });
    
    // Aplicar color específico a las barras de progreso
    const progressBar = document.querySelector('.progress');
    if (progressBar) {
      progressBar.style.background = color;
      progressBar.style.opacity = '1';
    }
    
    const volumeProgress = document.querySelector('.volume-progress');
    if (volumeProgress) {
      volumeProgress.style.background = color;
      volumeProgress.style.opacity = '1';
    }
  }, 100); // 100ms de delay para operaciones pesadas
}

function updateSliderProgress(slider) {
  if (!slider) return;
  const min = Number(slider.min || 0);
  const max = Number(slider.max || 100);
  const value = Number(slider.value || min);
  const progress = ((value - min) / Math.max(1, max - min)) * 100;
  slider.style.setProperty('--slider-progress', `${progress}%`);
  slider.parentElement?.style.setProperty('--slider-progress', `${progress}%`);
}

function getRangeValueFromPointer(slider, clientX) {
  const rect = slider.getBoundingClientRect();
  const min = Number(slider.min || 0);
  const max = Number(slider.max || 100);
  const step = slider.step === 'any' ? 0 : Number(slider.step || 1);
  const ratio = rect.width > 0
    ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    : 0;
  const rawValue = min + ((max - min) * ratio);
  if (!step) return rawValue;

  const snappedValue = min + (Math.round((rawValue - min) / step) * step);
  const decimals = (String(step).split('.')[1] || '').length;
  return Number(Math.min(max, Math.max(min, snappedValue)).toFixed(decimals));
}

function setRangeValueFromPointer(slider, clientX, eventName = 'input') {
  if (!slider || slider.disabled) return;
  slider.value = String(getRangeValueFromPointer(slider, clientX));
  updateSliderProgress(slider);
  slider.dispatchEvent(new Event(eventName, { bubbles: true }));
}

function initializeModernRangeSliderInteractions(root = document) {
  root.querySelectorAll('input.modern-slider[type="range"]').forEach((slider) => {
    if (slider.dataset.pointerRangeBound) return;
    slider.dataset.pointerRangeBound = 'true';

    slider.addEventListener('input', () => updateSliderProgress(slider));
    slider.addEventListener('click', (event) => event.preventDefault());

    slider.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      slider.focus({ preventScroll: true });
      setRangeValueFromPointer(slider, event.clientX, 'input');

      const handlePointerMove = (moveEvent) => {
        moveEvent.preventDefault();
        setRangeValueFromPointer(slider, moveEvent.clientX, 'input');
      };

      const handlePointerUp = (upEvent) => {
        if (Number.isFinite(upEvent.clientX)) {
          setRangeValueFromPointer(slider, upEvent.clientX, 'change');
        } else {
          slider.dispatchEvent(new Event('change', { bubbles: true }));
        }
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerUp);
        document.removeEventListener('pointercancel', handlePointerUp);
      };

      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
      document.addEventListener('pointercancel', handlePointerUp);
    });
  });
}

function setDefaultVolume(rawValue, options = {}) {
  const value = Math.max(0, Math.min(100, Number(rawValue) || 0));
  state.playbackSettings.defaultVolume = value;
  state.volume = value / 100;
  localStorage.setItem('defaultVolume', String(value));

  if (elements.audio) {
    elements.audio.volume = state.volume;
    updateVolumeUI();
  }

  refreshDefaultVolumeUI();
  if (!options.skipSave) {
    saveSettings();
  }
}

function refreshDefaultVolumeUI() {
  const defaultVolumeValue = document.getElementById('defaultVolumeValue');
  if (defaultVolumeValue) {
    defaultVolumeValue.textContent = `${state.playbackSettings.defaultVolume}%`;
  }

  document.querySelectorAll('.volume-preset-btn').forEach((button) => {
    const presetValue = Number(button.dataset.volume || 0);
    button.classList.toggle('is-active', presetValue === state.playbackSettings.defaultVolume);
  });

  if (elements.defaultVolumeHint) {
    const profile =
      state.playbackSettings.defaultVolume === 0 ? 'Inicio en silencio' :
      state.playbackSettings.defaultVolume <= 25 ? 'Inicio muy bajo' :
      state.playbackSettings.defaultVolume <= 50 ? 'Inicio equilibrado' :
      state.playbackSettings.defaultVolume <= 75 ? 'Inicio intenso' :
      'Inicio al maximo';
    elements.defaultVolumeHint.textContent = profile;
  }
}

function normalizeAudioExtractor(value) {
  return ['auto', 'yt-dlp', 'ytdl-core'].includes(value) ? value : 'auto';
}

function getAudioExtractorLabel(value) {
  const labels = {
    auto: 'Automático',
    'yt-dlp': 'yt-dlp',
    'ytdl-core': 'ytdl-core',
    cache: 'Caché'
  };
  return labels[value] || value || 'Automático';
}

let activePlaybackRequestId = null;
let audioRecoveryInProgress = false;
let audioRecoveryAttempts = 0;
let lastPreloadedTrackKey = null;
const MAX_AUDIO_RECOVERY_ATTEMPTS = 1;

function createPlaybackRequestId(track = {}) {
  const id = track.id || track.video_id || 'track';
  return `${Date.now()}-${String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)}`;
}

function resolveRemoteTrackUrl(track = {}) {
  if (!track || track.isLocal || String(track.url || '').startsWith('local://')) return '';
  if (track.url) return track.url;

  const videoId = track.video_id || track.id;
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : '';
}

function warmPlaybackPipeline() {
  if (!elements.audio) return;

  elements.audio.preload = 'auto';
  try {
    initializeAudioContext();
    if (audioContext?.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
  } catch (error) {
    console.warn('No se pudo precalentar el audio:', error.message);
  }
}

function getUpcomingTrackForPreload() {
  if (state.queue.length > 0) {
    if (state.shuffle || state.playbackSettings.smartShuffle) return null;
    const currentQueueIndex = findCurrentQueueIndex();
    const nextIndex = currentQueueIndex >= 0
      ? (state.queueLoop ? (currentQueueIndex + 1) % state.queue.length : currentQueueIndex + 1)
      : 0;
    return state.queue[nextIndex] || null;
  }

  if (state.currentPlaylist && state.currentPlaylist.length > 1) {
    if (state.shuffle || state.playbackSettings.smartShuffle) return null;
    const nextIndex = (state.currentIndex + 1) % state.currentPlaylist.length;
    if (nextIndex === 0 && state.repeat !== 'all') return null;
    return state.currentPlaylist[nextIndex];
  }

  return null;
}

function preloadUpcomingTrack() {
  const track = getUpcomingTrackForPreload();
  const url = resolveRemoteTrackUrl(track);
  if (!url) return;

  const quality = state.audioSettings?.streamingQuality || 'medium';
  const key = `${quality}|${url}`;
  if (key === lastPreloadedTrackKey) return;
  lastPreloadedTrackKey = key;

  ipcRenderer.invoke('preload-song', url, quality, {
    extractorMode: state.developerSettings?.audioExtractor || 'auto',
    timeoutMs: 20000
  }).then((result) => {
    if (!result?.ok && key === lastPreloadedTrackKey) {
      lastPreloadedTrackKey = null;
    }
    if (state.developerSettings.verbosePlayerLogs) {
      console.info('[audio-preload]', result);
    }
  }).catch((error) => {
    if (key === lastPreloadedTrackKey) {
      lastPreloadedTrackKey = null;
    }
    if (state.developerSettings.verbosePlayerLogs) {
      console.warn('[audio-preload] fallo:', error.message);
    }
  });
}

function isHttpAudioPath(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function isLocalAudioProxyPath(value) {
  return typeof value === 'string'
    && /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/audio\/[a-f0-9]{48}(?:$|[?#])/i.test(value);
}

function isDirectYouTubeAudioPath(value) {
  if (!isHttpAudioPath(value) || isLocalAudioProxyPath(value)) return false;

  try {
    const { hostname } = new URL(value);
    const host = hostname.toLowerCase();
    return host === 'googlevideo.com'
      || host.endsWith('.googlevideo.com')
      || host === 'youtube.com'
      || host.endsWith('.youtube.com');
  } catch (error) {
    return false;
  }
}

function shouldCleanupPlaybackFile(track = {}) {
  const playbackPath = track?.path;
  if (!playbackPath || typeof playbackPath !== 'string') return false;
  if (isHttpAudioPath(playbackPath) || playbackPath.startsWith('local://')) return false;

  const normalizedPath = path.normalize(playbackPath).toLowerCase();
  const cacheSegment = `${path.sep}audio_cache${path.sep}`.toLowerCase();
  if (normalizedPath.includes(cacheSegment)) return false;

  return !!(track.isLocal || String(track.url || '').startsWith('local://'));
}

function cleanupPlaybackFile(track = {}) {
  if (!shouldCleanupPlaybackFile(track)) return;

  try {
    fs.unlinkSync(track.path);
    console.log('Archivo temporal eliminado:', track.path);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Error al eliminar archivo temporal:', error);
    }
  }
}

async function ensureSafePlaybackPath(streamData = {}) {
  if (!isDirectYouTubeAudioPath(streamData.path)) {
    return streamData;
  }

  console.warn('[reproducción] URL directa de YouTube recibida; usando proxy local antes de reproducir');
  const proxiedPath = await ipcRenderer.invoke('proxy-audio-url', {
    audioUrl: streamData.path,
    httpHeaders: streamData.httpHeaders || streamData.metadata?.httpHeaders || {}
  });

  return {
    ...streamData,
    path: proxiedPath,
    metadata: {
      ...(streamData.metadata || {}),
      streamingProfile: {
        ...(streamData.metadata?.streamingProfile || {}),
        playback: 'local-proxy',
        proxiedByRenderer: true
      }
    }
  };
}

function waitForAudioMetadata(timeoutMs = 5000) {
  if (elements.audio.readyState >= 1) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      elements.audio.removeEventListener('loadedmetadata', finish);
      elements.audio.removeEventListener('error', finish);
      resolve();
    };

    const timeout = setTimeout(finish, timeoutMs);
    elements.audio.addEventListener('loadedmetadata', finish, { once: true });
    elements.audio.addEventListener('error', finish, { once: true });
  });
}

async function recoverAudioPlaybackAfterError(mediaError) {
  if (audioRecoveryInProgress || audioRecoveryAttempts >= MAX_AUDIO_RECOVERY_ATTEMPTS) return false;
  if (!state.currentTrack || state.currentTrack.isLocal || !state.currentTrack.url) return false;

  audioRecoveryInProgress = true;
  audioRecoveryAttempts += 1;
  const resumeAt = Number(elements.audio.currentTime || 0);

  try {
    console.warn('[reproducción] recuperando stream tras error de audio', {
      code: mediaError?.code,
      message: mediaError?.message,
      resumeAt
    });
    setNowPlayingState('loading', 'Recuperando audio');

    const quality = state.audioSettings?.streamingQuality || 'medium';
    const requestId = activePlaybackRequestId || createPlaybackRequestId(state.currentTrack);
    activePlaybackRequestId = requestId;
    const recoveredStream = await ensureSafePlaybackPath(
      await ipcRenderer.invoke('stream-song', state.currentTrack.url, quality, {
        forceRefresh: true,
        requestId
      })
    );

    state.currentTrack = {
      ...state.currentTrack,
      ...recoveredStream.metadata,
      path: recoveredStream.path
    };
    state.audioSettings.lastStreamingProfile = recoveredStream.metadata?.streamingProfile || null;
    updateStreamingQualityStatus(state.audioSettings.lastStreamingProfile);

    if (isHttpAudioPath(recoveredStream.path)) {
      elements.audio.crossOrigin = 'anonymous';
    } else {
      elements.audio.removeAttribute('crossorigin');
    }
    elements.audio.src = recoveredStream.path;
    elements.audio.load();
    await waitForAudioMetadata();

    if (resumeAt > 1 && Number.isFinite(elements.audio.duration) && elements.audio.duration > resumeAt + 1) {
      elements.audio.currentTime = resumeAt;
    }

    await elements.audio.play();
    state.isPlaying = true;
    updatePlayingUI(true);
    if (state.visualSettings.showVisualizer) {
      startSpectrogram();
    }
    showPlayingGif();
    return true;
  } catch (error) {
    console.error('[reproducción] no se pudo recuperar el stream:', error);
    return false;
  } finally {
    audioRecoveryInProgress = false;
  }
}

function logPlaybackProgress(payload = {}) {
  if (!payload.requestId || payload.requestId !== activePlaybackRequestId) return;

  const label = payload.message || payload.stage || payload.type || 'Progreso de audio';
  const elapsed = typeof payload.elapsedMs === 'number' ? `${payload.elapsedMs}ms` : '';
  const percent = typeof payload.percent === 'number' ? `${payload.percent}%` : '';
  const suffix = [elapsed, percent].filter(Boolean).join(' | ');
  const line = suffix ? `${label} (${suffix})` : label;
  const logData = {
    stage: payload.stage,
    type: payload.type,
    extractor: payload.extractor,
    step: payload.step,
    from: payload.from,
    to: payload.to,
    error: payload.error,
    percent: payload.percent,
    formatsCount: payload.formatsCount,
    elapsedMs: payload.elapsedMs
  };

  if (payload.type === 'attempt-error' || payload.stage === 'error' || payload.stage === 'cache-error') {
    console.warn('[reproducción]', line, logData);
  } else {
    console.info('[reproducción]', line, logData);
  }

  if (payload.stage === 'ready') {
    setNowPlayingState('loading', 'Audio listo');
  } else if (payload.stage === 'error') {
    setNowPlayingState('error', label);
  } else if (payload.stage !== 'cache-download' && payload.stage !== 'cache-ready' && payload.stage !== 'recommendations-error') {
    setNowPlayingState('loading', label);
  }
}

ipcRenderer.on('audio-extractor:progress', (event, payload) => {
  logPlaybackProgress(payload);
});

function updateStreamingQualityStatus(profile) {
  if (!elements.streamingQualityStatus) return;
  const heroCacheStatus = document.getElementById('heroCacheStatus');

  if (!profile) {
    elements.streamingQualityStatus.textContent = 'Aún no hay reproducción para medir';
    if (heroCacheStatus) {
      heroCacheStatus.textContent = localStorage.getItem('audioCache') === 'true'
        ? 'Caché activa'
        : 'Streaming en vivo';
    }
    return;
  }

  const parts = [];
  if (profile.source === 'local') parts.push('Archivo local');
  if (profile.source === 'cache') parts.push('Caché offline');
  if (profile.extractor && profile.source !== 'local') parts.push(`Motor: ${getAudioExtractorLabel(profile.extractor)}`);
  if (profile.usedFallback) parts.push('Fallback aplicado');
  if (profile.requestedLabel) parts.push(`Pedido: ${profile.requestedLabel}`);
  if (profile.extractionMs) parts.push(`${profile.extractionMs}ms`);
  if (profile.effectiveBitrate) parts.push(`Real: ${profile.effectiveBitrate}kbps`);
  if (profile.container) parts.push(profile.container.toUpperCase());
  if (!parts.length) parts.push('Perfil de streaming disponible');
  if (heroCacheStatus) {
    heroCacheStatus.textContent = profile.source === 'cache'
      ? `Caché ${profile.container ? profile.container.toUpperCase() : 'lista'}`
      : profile.source === 'local'
        ? 'Archivo local'
        : `Streaming ${profile.container ? profile.container.toUpperCase() : 'activo'}`;
  }
  elements.streamingQualityStatus.textContent = parts.join(' ? ');
}

function refreshAccentColorUI(color) {
  if (elements.accentColorPreview) {
    elements.accentColorPreview.style.background = `linear-gradient(135deg, ${color}, ${darkenColor(color, 1.2)})`;
    elements.accentColorPreview.style.boxShadow = `0 18px 38px ${color}44`;
  }

  if (elements.accentColorHex) {
    elements.accentColorHex.textContent = color.toUpperCase();
  }

  document.querySelectorAll('.color-preset').forEach(preset => {
    const presetColor = preset.getAttribute('data-color');
    preset.style.setProperty('--preset-color', presetColor);
    preset.classList.toggle('is-active', presetColor?.toLowerCase() === color.toLowerCase());
  });
}

function refreshDeveloperModeUI() {
  if (elements.developerToolsCard) {
    elements.developerToolsCard.style.display = state.developerSettings.enabled ? 'block' : 'none';
  }

  if (elements.developerModeStatus) {
    elements.developerModeStatus.textContent = state.developerSettings.enabled ? 'Activado' : 'Desactivado';
  }

  if (elements.audioCacheStatus) {
    elements.audioCacheStatus.textContent = localStorage.getItem('audioCache') === 'true'
      ? 'Caché lista para uso offline'
      : 'Caché desactivada';
  }

  if (elements.internetAccessToggle) {
    elements.internetAccessToggle.checked = state.developerSettings.internetEnabled;
  }

  if (elements.audioExtractorSelect) {
    elements.audioExtractorSelect.value = normalizeAudioExtractor(state.developerSettings.audioExtractor);
  }

  if (elements.openDevToolsBtn) {
    elements.openDevToolsBtn.disabled = !state.developerSettings.enabled;
  }

  if (elements.copyDiagnosticsBtn) {
    elements.copyDiagnosticsBtn.disabled = !state.developerSettings.enabled;
  }

  if (elements.streamingQualityHint) {
    const hints = {
      low: 'Carga más rápida, menor calidad',
      medium: 'Equilibrio entre calidad y velocidad',
      high: 'Más calidad, mayor consumo',
      lossless: 'Máxima calidad, carga más pesada'
    };
    elements.streamingQualityHint.textContent = hints[state.audioSettings.streamingQuality || 'medium'];
  }

  updateStreamingQualityStatus(state.audioSettings.lastStreamingProfile || null);
  loadAudioCacheLibrary().catch(() => {});
  updateSettingsSummary();
}

function updateSettingsSummary() {
  const themeLabel = document.getElementById('settingsThemeLabel');
  const streamingLabel = document.getElementById('settingsStreamingLabel');
  const libraryCount = document.getElementById('settingsLibraryCount');
  const developerLabel = document.getElementById('settingsDeveloperLabel');

  if (themeLabel) {
    const themeLabels = {
      dark: 'Oscuro',
      light: 'Claro',
      custom: 'Personalizado'
    };
    themeLabel.textContent = themeLabels[state.visualSettings.theme || localStorage.getItem('theme') || 'dark'] || 'Oscuro';
  }

  if (streamingLabel) {
    const streamingLabels = {
      low: 'Baja',
      medium: 'Media',
      high: 'Alta',
      lossless: 'Lossless'
    };
    streamingLabel.textContent = streamingLabels[state.audioSettings.streamingQuality || localStorage.getItem('streamingQuality') || 'medium'] || 'Media';
  }

  if (libraryCount) {
    const totalSongs = state.library?.length || 0;
    libraryCount.textContent = `${totalSongs} canción${totalSongs === 1 ? '' : 'es'}`;
  }

  if (developerLabel) {
    developerLabel.textContent = state.developerSettings.enabled ? 'Activado' : 'Desactivado';
  }
}

function formatCacheSize(bytes = 0) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatCacheDate(timestamp) {
  if (!timestamp) return 'Sin fecha';
  return new Date(timestamp).toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

async function loadAudioCacheLibrary() {
  if (!elements.audioCacheLibrary) return;

  elements.audioCacheLibrary.innerHTML = '<div class="audio-cache-empty">Cargando canciones en caché...</div>';

  try {
    const cacheItems = await ipcRenderer.invoke('get-audio-cache-library');
    if (elements.audioCacheCount) {
      elements.audioCacheCount.textContent = `${cacheItems.length} archivo${cacheItems.length === 1 ? '' : 's'} en caché`;
    }

    if (!cacheItems.length) {
      elements.audioCacheLibrary.innerHTML = '<div class="audio-cache-empty">Aún no hay canciones guardadas en caché.</div>';
      return;
    }

    elements.audioCacheLibrary.innerHTML = cacheItems.map(item => `
      <button class="audio-cache-item" data-url="${item.url || ''}">
        <img src="${item.thumbnail}" alt="${item.title}" class="audio-cache-thumb">
        <div class="audio-cache-meta">
          <strong>${item.title}</strong>
          <span>${item.artist || 'Desconocido'}</span>
          <small>${item.container.toUpperCase()} · ${formatCacheSize(item.size)} · ${formatCacheDate(item.modifiedAt)}</small>
        </div>
      </button>
    `).join('');

    elements.audioCacheLibrary.querySelectorAll('.audio-cache-item').forEach((button, index) => {
      button.addEventListener('click', () => {
        const item = cacheItems[index];
        if (item) playSong(item);
      });
    });
  } catch (error) {
    if (elements.audioCacheCount) {
      elements.audioCacheCount.textContent = 'No se pudo cargar la caché';
    }
    elements.audioCacheLibrary.innerHTML = '<div class="audio-cache-empty">No se pudo cargar la biblioteca de caché.</div>';
  }
}

function updateVolumeUI() {
  if (!elements.audio || !elements.volumeProgress || !elements.volumeButton) return;
  
  const volumePercentage = elements.audio.muted ? 0 : elements.audio.volume * 100;
  elements.volumeProgress.style.width = `${volumePercentage}%`;
  elements.volumeProgress.style.background = '';
  elements.volumeProgress.style.opacity = '1';
  elements.volumeProgress.parentElement?.setAttribute('aria-valuenow', String(Math.round(volumePercentage)));

  if (elements.volumeValue) {
    elements.volumeValue.textContent = `${Math.round(volumePercentage)}%`;
  }

  if (elements.nowPlayingBar) {
    elements.nowPlayingBar.classList.toggle('is-muted', elements.audio.muted || elements.audio.volume === 0);
  }
  
  // Actualizar el icono del botón de volumen
  let volumeIcon;
  if (elements.audio.muted || elements.audio.volume === 0) {
    volumeIcon = 'volume-xmark';
  } else if (elements.audio.volume < 0.33) {
    volumeIcon = 'volume-off';
  } else if (elements.audio.volume < 0.66) {
    volumeIcon = 'volume-low';
  } else {
    volumeIcon = 'volume-high';
  }
  
  elements.volumeButton.innerHTML = `<i class="fas fa-${volumeIcon}"></i>`;
  elements.volumeButton.title = elements.audio.muted || elements.audio.volume === 0 ? 'Activar sonido' : 'Silenciar';
  elements.volumeButton.setAttribute('aria-label', elements.volumeButton.title);
  sendMiniPlayerState({ throttleMs: 160 });
}

let miniPlayerTelemetryTimer = null;
let lastMiniPlayerStateSync = 0;
let lastMiniPlayerSpectrumSync = 0;

function getAudioDuration() {
  const duration = Number(elements.audio?.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function getAudioCurrentTime() {
  const currentTime = Number(elements.audio?.currentTime);
  return Number.isFinite(currentTime) && currentTime > 0 ? currentTime : 0;
}

function isDefaultTrackArtwork(artworkUrl = '') {
  return /(^|\/)default-track\.png($|\?)/i.test(String(artworkUrl));
}

function getArtworkUrl(...candidates) {
  for (const candidate of candidates) {
    const artworkUrl = typeof candidate === 'string' ? candidate.trim() : '';
    if (artworkUrl && !isDefaultTrackArtwork(artworkUrl)) return artworkUrl;
  }
  return '';
}

function getArtworkInitials(label = '') {
  const words = String(label || 'Lunera')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  return words
    .slice(0, 2)
    .map(word => word[0])
    .join('')
    .toUpperCase() || 'LU';
}

function getGeneratedArtworkMarkup(label = '', className = '') {
  const safeClass = escapeLibraryHTML(className);
  const initials = escapeLibraryHTML(getArtworkInitials(label));
  return `<div class="generated-artwork ${safeClass}" aria-hidden="true"><span>${initials}</span></div>`;
}

function getArtworkMarkup(src, alt = '', className = '') {
  const artworkUrl = getArtworkUrl(src);
  const safeAlt = escapeLibraryHTML(alt);
  const safeClass = escapeLibraryHTML(className);

  if (!artworkUrl) return getGeneratedArtworkMarkup(alt, className);
  return `<img src="${escapeLibraryHTML(artworkUrl)}" alt="${safeAlt}"${safeClass ? ` class="${safeClass}"` : ''}>`;
}

function createArtworkElement(src, alt = '', className = '') {
  const artworkUrl = getArtworkUrl(src);

  if (artworkUrl) {
    const img = document.createElement('img');
    img.src = artworkUrl;
    img.alt = alt;
    if (className) img.className = className;
    img.onerror = () => {
      img.replaceWith(createArtworkElement('', alt, className));
    };
    return img;
  }

  const fallback = document.createElement('div');
  fallback.className = `generated-artwork ${className}`.trim();
  fallback.setAttribute('aria-hidden', 'true');
  const initials = document.createElement('span');
  initials.textContent = getArtworkInitials(alt);
  fallback.appendChild(initials);
  return fallback;
}

function setCurrentTrackArtwork(artworkUrl = '') {
  const normalizedUrl = typeof artworkUrl === 'string' ? artworkUrl.trim() : '';
  const safeArtworkUrl = getArtworkUrl(normalizedUrl);
  const hasArtwork = safeArtworkUrl.length > 0;

  if (elements.currentTrackImg) {
    if (hasArtwork) {
      elements.currentTrackImg.onerror = () => setCurrentTrackArtwork('');
      elements.currentTrackImg.src = safeArtworkUrl;
      elements.currentTrackImg.hidden = false;
    } else {
      elements.currentTrackImg.onerror = null;
      elements.currentTrackImg.removeAttribute('src');
      elements.currentTrackImg.hidden = true;
    }
  }

  if (!elements.currentTrackArtShell) {
    elements.currentTrackArtShell = document.querySelector('.track-art-shell');
  }

  elements.currentTrackArtShell?.classList.toggle('has-image', hasArtwork);
  elements.currentTrackArtShell?.classList.toggle('is-empty-art', !hasArtwork);
}

function getMiniPlayerArtwork() {
  if (state.currentTrack?.thumbnail && !isDefaultTrackArtwork(state.currentTrack.thumbnail)) return state.currentTrack.thumbnail;
  const currentSrc = elements.currentTrackImg && !elements.currentTrackImg.hidden
    ? (elements.currentTrackImg.getAttribute('src') || elements.currentTrackImg.src)
    : '';
  return currentSrc && !isDefaultTrackArtwork(currentSrc) ? currentSrc : null;
}

function getMiniPlayerStatePayload() {
  const hasTrack = !!state.currentTrack;
  return {
    isPlaying: !!state.isPlaying,
    playerUiState: state.playerUiState || (hasTrack ? (state.isPlaying ? 'playing' : 'paused') : 'empty'),
    title: hasTrack ? (state.currentTrack.title || elements.currentTrackTitle?.textContent || 'Sin título') : null,
    artist: hasTrack ? (state.currentTrack.artist || elements.currentTrackArtist?.textContent || 'Sin artista') : null,
    thumbnail: getMiniPlayerArtwork(),
    volume: Math.max(0, Math.min(1, Number(state.volume) || 0)),
    muted: !!elements.audio?.muted,
    currentTime: getAudioCurrentTime(),
    duration: getAudioDuration(),
    accentColor: state.visualSettings?.accentColor || '#1db954',
    repeat: state.repeat,
    shuffle: !!state.shuffle,
    queueLength: Array.isArray(state.queue) ? state.queue.length : 0
  };
}

function sendPlayerStateToMain() {
  ipcRenderer.send('player:state', getMiniPlayerStatePayload());
}

function sendMiniPlayerState(options = {}) {
  if (!state.playbackSettings?.miniPlayer) return;
  const now = Date.now();
  const throttleMs = Number(options.throttleMs) || 0;
  if (!options.force && throttleMs > 0 && now - lastMiniPlayerStateSync < throttleMs) return;
  lastMiniPlayerStateSync = now;
  ipcRenderer.send('mini-player:state', getMiniPlayerStatePayload());
}

function getMiniPlayerSpectrumValues(barCount = 96) {
  if (!state.playbackSettings?.miniPlayer) return [];

  if (!audioContext || audioContext.state === 'closed' || !analyser || !audioDataArray) {
    try {
      initializeAudioContext();
    } catch (error) {
      return [];
    }
  }

  if (!analyser || !audioDataArray) return [];
  analyser.getByteFrequencyData(audioDataArray);

  const usableLength = Math.max(1, Math.floor(audioDataArray.length * 0.82));
  const values = [];

  for (let i = 0; i < barCount; i++) {
    const startRatio = i / barCount;
    const endRatio = (i + 1) / barCount;
    const start = Math.floor(Math.pow(startRatio, 0.72) * usableLength);
    const end = Math.max(start + 1, Math.floor(Math.pow(endRatio, 0.72) * usableLength));
    let total = 0;
    let count = 0;

    for (let j = start; j < Math.min(end, audioDataArray.length); j++) {
      total += audioDataArray[j];
      count += 1;
    }

    values.push(count > 0 ? Math.round(total / count) : 0);
  }

  return values;
}

function sendMiniPlayerSpectrum(options = {}) {
  if (!state.playbackSettings?.miniPlayer) return;
  const now = Date.now();
  if (!options.force && now - lastMiniPlayerSpectrumSync < 66) return;
  lastMiniPlayerSpectrumSync = now;
  ipcRenderer.send('mini-player:spectrum', {
    values: getMiniPlayerSpectrumValues(),
    isPlaying: !!state.isPlaying
  });
}

function startMiniPlayerTelemetry() {
  if (miniPlayerTelemetryTimer) return;
  sendMiniPlayerState({ force: true });
  sendMiniPlayerSpectrum({ force: true });
  miniPlayerTelemetryTimer = setInterval(() => {
    if (!state.playbackSettings?.miniPlayer) {
      stopMiniPlayerTelemetry();
      return;
    }
    sendMiniPlayerSpectrum();
    sendMiniPlayerState({ throttleMs: 520 });
  }, 90);
}

function stopMiniPlayerTelemetry() {
  if (!miniPlayerTelemetryTimer) return;
  clearInterval(miniPlayerTelemetryTimer);
  miniPlayerTelemetryTimer = null;
}

function updateMiniPlayerButtonState(active = !!state.playbackSettings?.miniPlayer) {
  const button = elements.miniPlayerButton;
  if (!button) return;

  const isActive = !!active;
  const label = isActive ? 'Cerrar mini reproductor' : 'Abrir mini reproductor';
  button.classList.toggle('active', isActive);
  button.setAttribute('aria-pressed', String(isActive));
  button.setAttribute('aria-label', label);
  button.title = label;

  if (button.dataset.busy !== 'true') {
    button.disabled = false;
  }
}

async function handleMiniPlayerButtonClick() {
  const button = elements.miniPlayerButton;
  if (!button || button.dataset.busy === 'true') return;

  button.dataset.busy = 'true';
  button.disabled = true;

  try {
    await setMiniPlayerWindowEnabled(!state.playbackSettings?.miniPlayer);
  } finally {
    button.dataset.busy = 'false';
    button.disabled = false;
    updateMiniPlayerButtonState();
  }
}

async function setMiniPlayerWindowEnabled(enabled) {
  try {
    const active = await ipcRenderer.invoke('mini-player:set-enabled', !!enabled);
    state.playbackSettings.miniPlayer = !!active;
    localStorage.setItem('miniPlayer', String(!!active));

    if (active) {
      startMiniPlayerTelemetry();
      sendMiniPlayerState({ force: true });
      sendMiniPlayerSpectrum({ force: true });
    } else {
      stopMiniPlayerTelemetry();
    }

    applyPremiumUiPreferences();
    refreshPremiumSettingsUI();
    return !!active;
  } catch (error) {
    console.error('No se pudo actualizar el mini reproductor:', error);
    state.playbackSettings.miniPlayer = false;
    localStorage.setItem('miniPlayer', 'false');
    stopMiniPlayerTelemetry();
    refreshPremiumSettingsUI();
    if (typeof notificationSystem !== 'undefined') {
      notificationSystem.error('No se pudo abrir el mini reproductor');
    }
    return false;
  }
}

function syncMiniPlayerWindowWithPreference() {
  setMiniPlayerWindowEnabled(!!state.playbackSettings?.miniPlayer).catch(error => {
    console.error('No se pudo sincronizar el mini reproductor:', error);
  });
}

function setPlayerVolumeFromExternal(rawVolume) {
  if (!elements.audio) return;
  const volumeLevel = Math.max(0, Math.min(1, Number(rawVolume) || 0));
  state.volume = volumeLevel;
  elements.audio.muted = volumeLevel === 0;
  elements.audio.volume = state.audioSettings.normalizeVolume ? Math.min(volumeLevel, 0.8) : volumeLevel;
  updateVolumeUI();
}

function seekPlayerToTime(rawTime) {
  if (!elements.audio || !state.currentTrack) return;
  const duration = getAudioDuration();
  if (duration <= 0) return;
  const nextTime = Math.max(0, Math.min(duration, Number(rawTime) || 0));
  elements.audio.currentTime = nextTime;
  updateProgressUI();
  sendMiniPlayerState({ force: true });
}

function getTargetOutputVolume() {
  return state.audioSettings.normalizeVolume ? Math.min(state.volume, 0.8) : state.volume;
}

// Guardar configuraciones
function saveSettings() {
  const settings = {
    settings: state.settings,
    audioSettings: state.audioSettings,
    visualSettings: state.visualSettings,
    playbackSettings: state.playbackSettings,
    developerSettings: state.developerSettings,
    privacySettings: state.privacySettings
  };
  localStorage.setItem('appSettings', JSON.stringify(settings));
  console.log('Configuraciones guardadas:', settings);
}

// Inicializar estados
if (elements.gifToggle) {
  elements.gifToggle.checked = state.settings.showGif;
  const gifSettings = document.querySelector('.gif-settings-card');
  if (gifSettings) {
    gifSettings.style.display = state.settings.showGif ? 'block' : 'none';
  }
  if (state.settings.gifUrl) {
    const gifPreviewImg = document.querySelector('.gif-preview img');
    if (gifPreviewImg) {
      gifPreviewImg.src = state.settings.gifUrl;
      gifPreviewImg.style.display = 'block';
    }
  }
  console.log('Estado GIF inicializado:', state.settings.showGif, state.settings.gifUrl);
}

// Event Listeners para GIFs y configuración
if (elements.gifToggle && !elements.gifToggle.dataset.bound) {
  elements.gifToggle.dataset.bound = 'true';
  elements.gifToggle.addEventListener('change', (e) => {
    state.settings.showGif = e.target.checked;
    const gifSettings = document.querySelector('.gif-settings-card');
    if (gifSettings) {
      gifSettings.style.display = e.target.checked ? 'block' : 'none';
    }
    if (!e.target.checked) {
      hidePlayingGif();
    } else if (state.isPlaying && state.settings.gifUrl) {
      showPlayingGif();
    }
    saveSettings();
    console.log('Cambio en toggle GIF:', state.settings.showGif);
  });
}

if (elements.uploadGifBtn && !elements.uploadGifBtn.dataset.bound) {
  elements.uploadGifBtn.dataset.bound = 'true';
  elements.uploadGifBtn.addEventListener('click', () => {
    elements.gifInput.click();
    console.log('Botón de subir GIF clickeado');
  });
}

if (elements.gifInput) {
  elements.gifInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file && file.type === 'image/gif') {
      const reader = new FileReader();
      reader.onload = (e) => {
        state.settings.gifUrl = e.target.result;
        const gifPreviewImg = document.querySelector('.gif-preview img');
        if (gifPreviewImg) {
          gifPreviewImg.src = e.target.result;
          gifPreviewImg.style.display = 'block';
        }
        saveSettings();
        console.log('GIF cargado:', state.settings.gifUrl);
      };
      reader.readAsDataURL(file);
    } else {
      console.warn('Archivo no es un GIF vélido');
    }
  });
}

if (elements.removeGifBtn) {
  elements.removeGifBtn.addEventListener('click', () => {
    state.settings.gifUrl = null;
    const gifPreviewImg = document.querySelector('.gif-preview img');
    if (gifPreviewImg) {
      gifPreviewImg.src = '';
      gifPreviewImg.style.display = 'none';
    }
    hidePlayingGif();
    saveSettings();
    console.log('GIF eliminado');
  });
}

if (elements.closeGifBtn) {
  elements.closeGifBtn.addEventListener('click', hidePlayingGif);
}

function showPlayingGif() {
  if (state.settings.showGif && state.settings.gifUrl) {
    const playingGif = document.getElementById('playingGif');
    const gifImg = playingGif.querySelector('img');
    const overlay = document.querySelector('.gif-overlay');

    gifImg.src = state.settings.gifUrl;
    playingGif.style.display = 'flex';
    overlay.classList.add('active');
    console.log('Mostrando GIF durante reproducción');
  }
}

function hidePlayingGif() {
  const playingGif = document.getElementById('playingGif');
  const overlay = document.querySelector('.gif-overlay');
  playingGif.style.display = 'none';
  overlay.classList.remove('active');
  console.log('Ocultando GIF');
}

// Función para crear corazones flotantes
function createFloatingHeart() {
  const heart = document.createElement('div');
  heart.className = 'heart';
  heart.textContent = '❤️';
  heart.style.left = Math.random() * 80 + 10 + 'vw';
  heart.style.top = Math.random() * 70 + 10 + 'vh';
  document.body.appendChild(heart);

  heart.addEventListener('animationend', () => {
    heart.remove();
  });
}

const BIRTHDAY_VIDEO_SEQUENCE = '29052026';
const BIRTHDAY_VIDEO_SRC = 'assets/felizcumplea\u00f1os.mp4';

let secretCreditsBuffer = '';
let birthdayVideoBuffer = '';
let shouldRestorePlaybackAfterBirthdayVideo = false;

document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k.length === 1) {
    secretCreditsBuffer = (secretCreditsBuffer + k).slice(-6);
    birthdayVideoBuffer = /^\d$/.test(k)
      ? (birthdayVideoBuffer + k).slice(-BIRTHDAY_VIDEO_SEQUENCE.length)
      : '';

    if (birthdayVideoBuffer === BIRTHDAY_VIDEO_SEQUENCE) {
      showBirthdayVideo();
      birthdayVideoBuffer = '';
      return;
    }

    if (secretCreditsBuffer === '1ly4s0') {
      showIly4s0Credits();
      secretCreditsBuffer = '';
      return;
    }
  }
});

function showBirthdayVideo() {
  const existingOverlay = document.querySelector('.birthday-video-overlay');
  if (existingOverlay) {
    const existingVideo = existingOverlay.querySelector('video');
    if (existingVideo) {
      existingVideo.currentTime = 0;
      existingVideo.play().catch(error => {
        console.warn('No se pudo reproducir el video de cumplea\u00f1os:', error);
      });
    }
    return;
  }

  shouldRestorePlaybackAfterBirthdayVideo = !!(
    elements.audio
    && state.currentTrack
    && state.isPlaying
    && !elements.audio.paused
  );

  if (shouldRestorePlaybackAfterBirthdayVideo) {
    elements.audio.pause();
  }

  const overlay = document.createElement('div');
  overlay.className = 'birthday-video-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Video de cumplea\u00f1os');

  const stage = document.createElement('div');
  stage.className = 'birthday-video-stage';

  const frame = document.createElement('div');
  frame.className = 'birthday-video-frame';

  const video = document.createElement('video');
  video.src = BIRTHDAY_VIDEO_SRC;
  video.controls = true;
  video.autoplay = true;
  video.playsInline = true;
  video.preload = 'auto';

  const closeButton = document.createElement('button');
  closeButton.className = 'birthday-video-close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Cerrar video');
  closeButton.innerHTML = '<i class="fas fa-times" aria-hidden="true"></i>';

  const closeOverlay = () => closeBirthdayVideo();
  const handleEscape = (event) => {
    if (event.key === 'Escape') {
      closeOverlay();
    }
  };

  overlay.birthdayVideoEscapeHandler = handleEscape;
  closeButton.addEventListener('click', closeOverlay);
  video.addEventListener('ended', closeOverlay);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      closeOverlay();
    }
  });
  document.addEventListener('keydown', handleEscape);

  frame.appendChild(video);
  stage.append(closeButton, frame);
  overlay.appendChild(stage);
  document.body.appendChild(overlay);

  video.play().catch(error => {
    console.warn('No se pudo iniciar automaticamente el video de cumplea\u00f1os:', error);
  });
}

function closeBirthdayVideo() {
  const overlay = document.querySelector('.birthday-video-overlay');
  if (!overlay) return;

  const handleEscape = overlay.birthdayVideoEscapeHandler;
  if (handleEscape) {
    document.removeEventListener('keydown', handleEscape);
  }

  const video = overlay.querySelector('video');
  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }

  overlay.remove();

  if (
    shouldRestorePlaybackAfterBirthdayVideo
    && elements.audio
    && state.currentTrack
  ) {
    elements.audio.play().catch(error => {
      console.warn('No se pudo reanudar la reproduccion despues del video de cumplea\u00f1os:', error);
      state.isPlaying = false;
      updatePlayingUI(false);
    });
  }

  shouldRestorePlaybackAfterBirthdayVideo = false;
}

function showIly4s0Credits() {
  const overlay = document.createElement('div');
  overlay.className = 'credits-overlay';
  const content = document.createElement('div');
  content.className = 'credits-content';
  overlay.appendChild(content);
  document.body.appendChild(overlay);
  
  const lines = [
    { text: 'Créditos especiales', className: 'credit-line accent' },
    { text: 'A 1ly4s0 (Ilyas)', className: 'credit-line' },
    { text: 'Por acompañarme en el desarrollo de Lunera', className: 'credit-line' },
    { text: 'Resolviendo problemas que no sabia resolver y guiándome en arquitectura', className: 'credit-line' },
    { text: 'Optimización, rendimiento y calidad: Lo resolviste tu', className: 'credit-line' },
    { text: 'APIs y funcionamiento correcto: Gracias a ti', className: 'credit-line' },
    { text: 'Gracias por tu tiempo y dedicación', className: 'credit-line' },
    { text: 'Agradecimiento infinito ❤️', className: 'credit-line accent' }
  ];
  
  // Barra de progreso
  const progress = document.createElement('div');
  progress.className = 'credits-progress';
  const bar = document.createElement('div');
  bar.className = 'bar';
  progress.appendChild(bar);
  content.appendChild(progress);
  
  let delay = 0;
  lines.forEach((l, idx) => {
    const div = document.createElement('div');
    div.className = l.className;
    div.style.animationDelay = `${delay}s`;
    div.textContent = l.text;
    content.appendChild(div);
    delay += 1.1;
  });
  
  // Al terminar, corazones y redirección
  const total = delay + 1.6;
  bar.style.animationDuration = `${total}s`;
  setTimeout(() => {
    for (let i = 0; i < 20; i++) setTimeout(createFloatingHeart, i * 200);
  }, (total - 1.2) * 1000);
  
  setTimeout(() => {
    overlay.remove();
    try {
      shell.openExternal('https://www.1ly4s0.dev/');
    } catch(e) {}
  }, total * 1000);
}
// Evento para los corazones al hacer clic en la dedicatoria
if (elements.dedicationLink) {
  elements.dedicationLink.addEventListener('click', (e) => {
    e.preventDefault();
    console.log('Clic en la dedicatoria, generando corazones');
    for (let i = 0; i < 10; i++) {
      setTimeout(createFloatingHeart, i * 200);
    }
  });
}

if (elements.dedicationCreditsBtn) {
  elements.dedicationCreditsBtn.addEventListener('click', () => {
    showIly4s0Credits();
  });
}

function finishStartupIntro() {
  if (startupIntroTimer) {
    clearTimeout(startupIntroTimer);
    startupIntroTimer = null;
  }

  if (elements.loadingScreen) {
    elements.loadingScreen.classList.add('is-exiting');
    elements.loadingScreen.style.display = 'none';
  }
  stopLoadingBackground();

  if (state.isNewUser) {
    elements.signupScreen?.classList.add('active');
  } else {
    showFeedbackPrompt();
  }
}

// Intro inicial breve
function showLoadingMessages() {
  if (!elements.loadingScreen) {
    finishStartupIntro();
    return;
  }

  elements.loadingScreen.style.display = 'flex';
  elements.loadingScreen.classList.remove('is-exiting');
  initLoadingBackground();

  startupIntroTimer = setTimeout(finishStartupIntro, STARTUP_INTRO_DURATION_MS);
}

function enterAppAfterOnboarding() {
  elements.signupScreen.classList.remove('active');
  showFeedbackPrompt();
}

function showFeedbackPrompt() {
  if (elements.feedbackPromptScreen) {
    elements.feedbackPromptScreen.classList.add('active');
  }
  showPage('home');
}

function closeFeedbackPrompt() {
  if (elements.feedbackPromptScreen) {
    elements.feedbackPromptScreen.classList.remove('active');
  }
}

function setupFeedbackPrompt() {
  if (elements.feedbackPromptLink && !elements.feedbackPromptLink.dataset.bound) {
    elements.feedbackPromptLink.dataset.bound = 'true';
    elements.feedbackPromptLink.addEventListener('click', (event) => {
      event.preventDefault();
      shell.openExternal(FEEDBACK_FORM_URL);
      closeFeedbackPrompt();
    });
  }

  if (elements.openFeedbackFormBtn && !elements.openFeedbackFormBtn.dataset.bound) {
    elements.openFeedbackFormBtn.dataset.bound = 'true';
    elements.openFeedbackFormBtn.addEventListener('click', () => {
      shell.openExternal(FEEDBACK_FORM_URL);
      closeFeedbackPrompt();
    });
  }

  if (elements.closeFeedbackPromptBtn && !elements.closeFeedbackPromptBtn.dataset.bound) {
    elements.closeFeedbackPromptBtn.dataset.bound = 'true';
    elements.closeFeedbackPromptBtn.addEventListener('click', () => {
      closeFeedbackPrompt();
    });
  }
}

// Manejar el formulario de creación de cuenta
function handleSignup() {
  let isSignupMode = true;
  const usernameGroup = document.getElementById('usernameGroup');
  const usernameInput = document.getElementById('username');
  const authTitle = document.getElementById('authTitle');
  const authModeBadge = document.getElementById('authModeBadge');
  const passwordInput = document.getElementById('password');

  const setAuthMode = (signupMode) => {
    isSignupMode = signupMode;
    elements.signupScreen.classList.toggle('login-mode', !signupMode);
    elements.signupTab.classList.toggle('active', signupMode);
    elements.loginTab.classList.toggle('active', !signupMode);
    elements.signupTab.setAttribute('aria-selected', String(signupMode));
    elements.loginTab.setAttribute('aria-selected', String(!signupMode));

    if (authTitle) authTitle.textContent = signupMode ? 'Crea tu cuenta' : 'Inicia sesión';
    if (authModeBadge) authModeBadge.textContent = signupMode ? 'Nueva cuenta' : 'Acceso personal';
    elements.signupMessage.textContent = signupMode ? 'Únete a la experiencia musical definitiva' : 'Bienvenido de nuevo a tu universo';
    elements.authSubmitBtn.textContent = signupMode ? 'Crear cuenta' : 'Entrar';
    if (usernameGroup) usernameGroup.style.display = signupMode ? '' : 'none';
    if (usernameInput) usernameInput.required = signupMode;
    if (passwordInput) passwordInput.setAttribute('autocomplete', signupMode ? 'new-password' : 'current-password');
  };

  elements.signupTab.addEventListener('click', () => {
    setAuthMode(true);
    console.log('Modo: Crear cuenta');
  });

  elements.loginTab.addEventListener('click', () => {
    setAuthMode(false);
    console.log('Modo: Iniciar sesión');
  });

  elements.signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;

    if (isSignupMode) {
      // Crear cuenta
      try {
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        const user = { username, email, password: hashedPassword };
        localStorage.setItem('user', JSON.stringify(user));
        state.account = { username, email };
        state.isNewUser = false;
        notificationSystem.success('¡Bienvenido a Lunera!');
        enterAppAfterOnboarding();
        updateSettingsUI();
      } catch (error) {
        console.error('Error al crear cuenta:', error);
        notificationSystem.error('Error al crear la cuenta');
      }
    } else {
      // Iniciar sesión
      const storedUser = JSON.parse(localStorage.getItem('user'));
      if (storedUser && storedUser.email === email) {
        try {
          const isMatch = await bcrypt.compare(password, storedUser.password);
          if (isMatch) {
            state.isNewUser = false;
            state.account = { username: storedUser.username, email };
            notificationSystem.success('¡Qué bueno verte de nuevo!');
            enterAppAfterOnboarding();
            updateSettingsUI();
          } else {
            notificationSystem.error('Credenciales incorrectas');
          }
        } catch (error) {
          console.error('Error al iniciar sesión:', error);
          notificationSystem.error('Error al iniciar sesión');
        }
      } else {
        notificationSystem.error('Usuario no encontrado');
      }
    }
  });

  elements.skipSignup.addEventListener('click', () => {
    enterAppAfterOnboarding();
  });
  
  // Lógica de cambio de contraseña
  if (elements.changePasswordBtn && !elements.changePasswordBtn.dataset.passwordHandlerBound) {
      elements.changePasswordBtn.dataset.passwordHandlerBound = 'legacy-prompt';
      elements.changePasswordBtn.addEventListener('click', async () => {
          // Usamos prompt por simplicidad, pero podría ser un modal
          const currentPassword = prompt('Por seguridad, ingresa tu contraseña actual:');
          if (!currentPassword) return;
          
          const storedUser = JSON.parse(localStorage.getItem('user'));
          if (!storedUser) {
              notificationSystem.error('No hay sesión activa');
              return;
          }
          
          try {
              const isMatch = await bcrypt.compare(currentPassword, storedUser.password);
              if (!isMatch) {
                  notificationSystem.error('Contraseña actual incorrecta');
                  return;
              }
              
              const newPassword = prompt('Ingresa tu nueva contraseña:');
              if (!newPassword || newPassword.length < 4) {
                  notificationSystem.warning('La contraseña debe tener al menos 4 caracteres');
                  return;
              }
              
              const hashedPassword = await bcrypt.hash(newPassword, saltRounds);
              storedUser.password = hashedPassword;
              localStorage.setItem('user', JSON.stringify(storedUser));
              notificationSystem.success('Contraseña actualizada correctamente');
              
          } catch (error) {
              console.error('Error al cambiar contraseña:', error);
              notificationSystem.error('Ocurrió un error');
          }
      });
  }
}

// Consolidar eventos de audio
if (elements.audio) {
  elements.audio.addEventListener('play', () => {
    console.log('Audio reproduciéndose');
    state.isPlaying = true;
    updatePlayingUI(true);
    showPlayingGif();
    updateVisualizerState(state.visualSettings.showVisualizer);
    
  });

  elements.audio.addEventListener('pause', () => {
    console.log('Audio pausado');
    state.isPlaying = false;
    updatePlayingUI(false);
    hidePlayingGif();
    
  });

  elements.audio.addEventListener('ended', () => {
    handleTrackEnded().catch(error => {
      console.error('Error en handleTrackEnded:', error);
      notificationSystem.error('Error al manejar el fin de la canción');
    });
  });


if (elements.audio) {
  let lastUpdate = 0;
  elements.audio.addEventListener('timeupdate', () => {
    const now = Date.now();
    if (now - lastUpdate < 33) return;
    lastUpdate = now;
    
    updateProgressUI();
    
    applyCrossfade();
  });

  // Añadir este listener adicional para asegurar que la duración se actualice
  elements.audio.addEventListener('durationchange', () => {
    updateProgressUI();
  });
}

  elements.audio.addEventListener('loadedmetadata', () => {
    updateProgressUI();
    console.log('Metadatos cargados, duración:', elements.audio.duration);
  });

  elements.audio.addEventListener('loadeddata', () => {
    elements.audio.volume = state.audioSettings.normalizeVolume ? Math.min(state.volume, 0.8) : state.volume;
    updateVolumeUI();
    console.log('Datos de audio cargados, volumen:', state.volume);
  });

  elements.audio.addEventListener('volumechange', updateVolumeUI);

  elements.audio.addEventListener('error', () => {
    if (!state.currentTrack) return;
    const mediaError = elements.audio.error;
    console.error('Error del elemento de audio:', mediaError);
    recoverAudioPlaybackAfterError(mediaError).then((recovered) => {
      if (recovered) return;
      state.isPlaying = false;
      updatePlayingUI(false);
      setNowPlayingState('error', 'Error de audio');
    });
  });
}

function updateVisualizerState(shouldShow, persist = false) {
  state.visualSettings.showVisualizer = !!shouldShow;

  if (elements.visualizerToggle) {
    elements.visualizerToggle.checked = state.visualSettings.showVisualizer;
  }

  updateVisualizerOpacityUI();

  localStorage.setItem('visualizer', String(state.visualSettings.showVisualizer));

  if (state.visualSettings.showVisualizer && state.isPlaying) {
    startSpectrogram();
  } else {
    stopSpectrogram();
  }

  if (!persist) {
    return;
  }

  ipcRenderer.invoke('set-visual-settings', state.visualSettings)
    .then(() => {
      console.log('Estado del visualizador actualizado:', state.visualSettings.showVisualizer);
    })
    .catch(error => {
      console.error('Error al actualizar estado del visualizador:', error);
    });
}

// Función mejorada de reproducción/pausa
function togglePlayPause() {
  if (!state.currentTrack) {
    const canStartPlayback = state.queue.length > 0
      || (state.currentPlaylist && state.currentPlaylist.length > 0)
      || state.playbackSettings.autoQueue
      || state.playbackSettings.autoplay;

    if (canStartPlayback) {
      playNext();
      return;
    }

    console.warn('No hay canción seleccionada para reproducir');
    setNowPlayingState('empty');
    return;
  }
  
  if (state.isPlaying) {
    elements.audio.pause();
    state.isPlaying = false; // Asegurar que el estado se actualice
    updatePlayingUI(false); // Forzar actualización de UI
    stopSpectrogram();
  } else {
    elements.audio.play().then(() => {
      state.isPlaying = true; // Asegurar que el estado se actualice
      updatePlayingUI(true); // Forzar actualización de UI
      if (state.visualSettings.showVisualizer) {
        startSpectrogram();
      }
    }).catch(error => {
      console.error('Error al reproducir:', error);
      state.isPlaying = false;
      updatePlayingUI(false);
      setNowPlayingState('error', 'No se pudo reanudar');
      alert('Error al reproducir la canción: ' + error.message);
    });
  }
}

// Función para actualizar la UI
function updatePlayingUI(isPlaying) {
  state.isPlaying = isPlaying;
  const nextPlayerState = !state.currentTrack
    ? 'empty'
    : isPlaying
      ? 'playing'
      : state.playerUiState === 'loading'
        ? 'loading'
        : 'paused';
  setNowPlayingState(nextPlayerState);
  console.log('Actualizando UI de reproducción:', isPlaying);
  refreshSearchPlayingIndicators();
  sendPlayerStateToMain();
  sendMiniPlayerState({ force: true });
}

function addToRecentlyPlayed(track) {
  if (state.privacySettings?.saveListeningHistory === false || localStorage.getItem('saveListeningHistory') === 'false') {
    return;
  }

  // Eliminar si ya existe para evitar duplicados y mover al inicio
  state.recentlyPlayed = state.recentlyPlayed.filter(t => (t.id !== track.id && t.video_id !== track.video_id));
  
  // Agregar al inicio con la fecha actual
  const trackWithDate = { ...track, lastPlayed: new Date().toISOString() };
  state.recentlyPlayed.unshift(trackWithDate);
  
  // Mantener solo las últimas 20 canciones
  state.recentlyPlayed = state.recentlyPlayed.slice(0, 100);
  
  // Guardar en localStorage
  localStorage.setItem('recentlyPlayed', JSON.stringify(state.recentlyPlayed));
  
  // Actualizar UI si estamos en la página de inicio
  displayRecentlyPlayed(state.recentlyPlayed);
}

function updateRecommendationsForTrack(track) {
  // Simular actualización de recomendaciones basada en la canción actual
  console.log('Actualizando recomendaciones para:', track.title);
  loadRecommendations();
}

function getPlaybackTrackKey(track = {}) {
  const id = track.video_id || track.id;
  if (id) return `id:${id}`;
  if (track.url) return `url:${track.url}`;
  const title = String(track.title || '').trim().toLowerCase();
  const artist = String(track.artist || '').trim().toLowerCase();
  return title || artist ? `meta:${title}::${artist}` : '';
}

function areSamePlaybackTrack(a, b) {
  const aKey = getPlaybackTrackKey(a);
  const bKey = getPlaybackTrackKey(b);
  return !!aKey && !!bKey && aKey === bKey;
}

function findCurrentQueueIndex() {
  if (!state.currentTrack) return -1;
  return state.queue.findIndex(track => areSamePlaybackTrack(track, state.currentTrack));
}

function getSmartShuffleIndex(tracks, currentTrack = state.currentTrack) {
  if (!Array.isArray(tracks) || tracks.length === 0) return -1;
  if (tracks.length === 1) return 0;

  const currentKey = getPlaybackTrackKey(currentTrack);
  const currentArtist = String(currentTrack?.artist || '').trim().toLowerCase();
  const recentKeys = new Set(
    (state.recentlyPlayed || [])
      .slice(0, 12)
      .map(track => getPlaybackTrackKey(track))
      .filter(Boolean)
  );

  const candidates = tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => getPlaybackTrackKey(track) !== currentKey);

  const variedCandidates = candidates.filter(({ track }) => {
    const artist = String(track.artist || '').trim().toLowerCase();
    return !currentArtist || !artist || artist !== currentArtist;
  });

  const freshCandidates = (variedCandidates.length ? variedCandidates : candidates)
    .filter(({ track }) => !recentKeys.has(getPlaybackTrackKey(track)));

  const pool = freshCandidates.length ? freshCandidates : (variedCandidates.length ? variedCandidates : candidates);
  const selected = pool[Math.floor(Math.random() * pool.length)];
  return selected ? selected.index : 0;
}

function getSequentialOrShuffledIndex(tracks, preferredIndex = 0) {
  if (!Array.isArray(tracks) || tracks.length === 0) return -1;
  if (state.shuffle || state.playbackSettings.smartShuffle) {
    return getSmartShuffleIndex(tracks);
  }
  return Math.max(0, Math.min(preferredIndex, tracks.length - 1));
}

async function ensureAutoQueueSeed(minQueueSize = 3) {
  if (!state.playbackSettings.autoQueue) return 0;

  try {
    const homeData = await ipcRenderer.invoke('get-home-data');
    const recommendations = homeData.recommendations || [];
    let addedCount = 0;
    const existingIds = new Set(
      state.queue
        .map(item => getPlaybackTrackKey(item))
        .concat(state.currentTrack ? [getPlaybackTrackKey(state.currentTrack)] : [])
        .filter(Boolean)
    );

    while (state.queue.length < minQueueSize) {
      const candidate = recommendations.find(item => {
        const key = getPlaybackTrackKey(item);
        return key && !existingIds.has(key);
      });
      if (!candidate) break;

      state.queue.push(candidate);
      existingIds.add(getPlaybackTrackKey(candidate));
      addedCount += 1;
    }

    if (addedCount > 0) {
      updateQueueUI({ forceVisible: document.querySelector('.queue-container')?.classList.contains('active') });
    }

    return addedCount;
  } catch (error) {
    console.error('No se pudo rellenar la cola automática:', error);
    return 0;
  }
}

// Función para reproducir una canción
async function playSong(track) {
  let playbackRequestId = null;
  let playbackTimerRunning = false;

  try {
    if (!track) {
      throw new Error('Track inválido o sin URL');
    }

    console.log(`Reproduciendo canción: ${track.title}`);
    // Construir URL si viene de recomendaciones sin url
    if (!track.url) {
      const vid = track.video_id || track.id;
      if (vid) {
        track.url = `https://www.youtube.com/watch?v=${vid}`;
      }
    }
    if (!track.url) {
      throw new Error('Track inválido o sin URL');
    }

    playbackRequestId = createPlaybackRequestId(track);
    activePlaybackRequestId = playbackRequestId;
    audioRecoveryInProgress = false;
    audioRecoveryAttempts = 0;
    warmPlaybackPipeline();
    console.time(`[reproducción] preparar ${playbackRequestId}`);
    playbackTimerRunning = true;

    // Actualizar el estado de la canción actual
    state.currentTrack = track;
    updateTrackInfo();
    setNowPlayingState('loading', 'Preparando pista');

    // Si hay una playlist activa, intentar encontrar la canción en ella para actualizar el índice
    if (state.currentPlaylist && state.currentPlaylist.length > 0) {
      const index = state.currentPlaylist.findIndex(t => (t.id === track.id || t.video_id === track.id));
      if (index !== -1) {
        state.currentIndex = index;
        console.log(`índice de playlist actualizado a: ${index}`);
      }
    }
    
    // Guardar el volumen actual antes de limpiar
    const currentVolume = state.volume;
    const wasMuted = elements.audio.muted;

    // Crossfade: atenuar si hay reproducción y crossfade > 0
    const crossfadeSec = 0;
    if (elements.audio) {
      elements.audio.pause();
      elements.audio.currentTime = 0;
    }
    // Limpiar recursos existentes
    await cleanAudioResources();
    
    // Configurar nueva canción
    elements.currentTrackTitle.textContent = 'Cargando...';
    elements.currentTrackArtist.textContent = '';
    syncNowPlayingTextAttributes();
    setNowPlayingState('loading', 'Buscando audio');
    
    let streamData;
    console.log('Procesando track:', { id: track.id, video_id: track.video_id, url: track.url, isLocal: track.isLocal });
    
    if (track.isLocal || track.url.startsWith('local://')) {
      // Para música local, obtener el archivo desde la base de datos
      console.log('Usando método local para:', track.title);
      const trackId = track.video_id || track.id;
      streamData = await ipcRenderer.invoke('get-local-music-file', trackId);
      streamData.metadata = track;
    } else {
      // Para música de YouTube, usar el streaming normal
      console.log('Usando método YouTube para:', track.title);
      const q = (state.audioSettings && state.audioSettings.streamingQuality) ? state.audioSettings.streamingQuality : 'medium';
      streamData = await ipcRenderer.invoke('stream-song', track.url, q, { requestId: playbackRequestId });
    }
    streamData = await ensureSafePlaybackPath(streamData);
    if (playbackTimerRunning) {
      console.timeEnd(`[reproducción] preparar ${playbackRequestId}`);
      playbackTimerRunning = false;
    }
    
    state.currentTrack = {
      ...track,
      ...streamData.metadata,
      path: streamData.path
    };
    state.audioSettings.lastStreamingProfile = streamData.metadata?.streamingProfile || (track.isLocal ? {
      source: 'local',
      requestedLabel: 'Archivo local'
    } : null);
    if (state.developerSettings.verbosePlayerLogs && state.audioSettings.lastStreamingProfile) {
      console.info('[audio-extractor]', state.audioSettings.lastStreamingProfile);
    }
    updateStreamingQualityStatus(state.audioSettings.lastStreamingProfile);

    // Asegurar que el contexto de audio está inicializado
    initializeAudioContext();
    
    // Configurar nueva fuente de audio
    // NOTA: Establecer src y llamar a load() es suficiente para reutilizar el elemento
    if (/^https?:\/\//i.test(streamData.path)) {
      elements.audio.crossOrigin = 'anonymous';
    } else {
      elements.audio.removeAttribute('crossorigin');
    }
    elements.audio.preload = 'auto';
    elements.audio.src = streamData.path;
    elements.audio.load(); // Forzar recarga
    
    // Verificar que el contexto de audio está listo
    if (audioContext && audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    
    // Restaurar el volumen y mute
    elements.audio.volume = currentVolume;
    elements.audio.muted = wasMuted;

    // Configurar filtros y normalización antes de iniciar reproducción
    applyEqualizerSettings();
    applyVolumeNormalization();

    // Mostrar metadata real y resetear la UI de progreso apenas el stream está listo
    updateTrackInfo();
    if (elements.currentTime) elements.currentTime.textContent = '0:00';
    if (elements.progressBar) elements.progressBar.style.width = '0%';
    setNowPlayingState('loading', 'Iniciando reproducción');
    elements.audio.volume = state.volume;
    updateVolumeUI();

    const finalizePlaybackStart = () => {
      state.isPlaying = true;
      updatePlayingUI(true);
      addToRecentlyPlayed(state.currentTrack);
      updateRecommendationsForTrack(state.currentTrack);
      ipcRenderer.invoke('update-history', state.currentTrack).catch(err => {
        console.error('Error al actualizar historial:', err);
      });
      showPlayingGif();

      if (state.visualSettings.showVisualizer) {
        startSpectrogram();
      } else {
        stopSpectrogram();
      }

      ensureAutoQueueSeed();
      preloadUpcomingTrack();
    };

    const applyCrossfadeFadeIn = () => {
      if (!(crossfadeSec > 0) || elements.audio.muted) {
        applyVolumeNormalization();
        return;
      }

      if (gainNode && audioContext) {
        const targetGain = getTargetOutputVolume();
        const now = audioContext.currentTime;
        gainNode.gain.cancelScheduledValues(now);
        gainNode.gain.setValueAtTime(0, now);
        gainNode.gain.linearRampToValueAtTime(targetGain, now + crossfadeSec);
      } else {
        elements.audio.volume = state.volume;
      }

      updateVolumeUI();
    };

    try {
      const playPromise = elements.audio.play();
      if (playPromise !== undefined) {
        await playPromise;
      }
      finalizePlaybackStart();
      applyCrossfadeFadeIn();
    } catch (playError) {
      console.error('Error al iniciar reproducción:', playError);
      const isRemoteStreamPath = typeof streamData?.path === 'string' && /^https?:\/\//i.test(streamData.path);
      const shouldForceRefreshStream = !track.isLocal
        && typeof streamData?.path === 'string'
        && (streamData.path.includes('audio_cache') || isRemoteStreamPath)
        && (playError.name === 'NotSupportedError' || String(playError.message || '').includes('supported source'));

      if (shouldForceRefreshStream) {
        try {
          const q = (state.audioSettings && state.audioSettings.streamingQuality) ? state.audioSettings.streamingQuality : 'medium';
          const refreshedStreamData = await ensureSafePlaybackPath(
            await ipcRenderer.invoke('stream-song', track.url, q, { forceRefresh: true, requestId: playbackRequestId })
          );
          state.currentTrack = {
            ...track,
            ...refreshedStreamData.metadata,
            path: refreshedStreamData.path
          };
          state.audioSettings.lastStreamingProfile = refreshedStreamData.metadata?.streamingProfile || null;
          if (state.developerSettings.verbosePlayerLogs && state.audioSettings.lastStreamingProfile) {
            console.info('[audio-extractor]', state.audioSettings.lastStreamingProfile);
          }
          updateStreamingQualityStatus(state.audioSettings.lastStreamingProfile);
          if (/^https?:\/\//i.test(refreshedStreamData.path)) {
            elements.audio.crossOrigin = 'anonymous';
          } else {
            elements.audio.removeAttribute('crossorigin');
          }
          elements.audio.preload = 'auto';
          elements.audio.src = refreshedStreamData.path;
          elements.audio.load();
          await elements.audio.play();
          finalizePlaybackStart();
          applyCrossfadeFadeIn();
          return;
        } catch (refreshError) {
          console.error('Recarga forzada del stream fallida:', refreshError);
        }
      }
      setTimeout(async () => {
        try {
          await elements.audio.play();
          finalizePlaybackStart();
          applyCrossfadeFadeIn();
        } catch (retryError) {
          console.error('Reintento de reproducción fallido:', retryError);
        }
      }, 100);
    }


  } catch (error) {
    if (playbackTimerRunning && playbackRequestId) {
      console.timeEnd(`[reproducción] preparar ${playbackRequestId}`);
      playbackTimerRunning = false;
    }
    console.error('Error al reproducir canción:', error);
    
    // Mensaje de error más específico
    let errorMessage = 'Error al reproducir la canción';
    if (error.message.includes('Timeout')) {
      errorMessage = 'La canción tardó demasiado en cargar. Intenta con otra canción.';
    } else if (error.message.includes('Track inválido')) {
      errorMessage = 'La canción seleccionada no es válida.';
    } else if (error.message.includes('stream-song')) {
      errorMessage = 'Error al obtener el audio de la canción. Verifica tu conexión.';
    } else if (error.message.includes('Archivo no encontrado') || error.message.includes('get-local-music-file')) {
      errorMessage = 'Error al cargar el archivo de música local. El archivo puede estar corrupto.';
    } else if (error.message.includes('local://')) {
      errorMessage = 'Error al reproducir música local. Intenta subir el archivo nuevamente.';
    } else {
      errorMessage = 'Error al reproducir la canción: ' + error.message;
    }
    
    notificationSystem.info(errorMessage);
    state.isPlaying = false;
    state.currentTrack = null;
    updatePlayingUI(false);
    updateTrackInfo();
    if (elements.currentTrackTitle) elements.currentTrackTitle.textContent = 'No se pudo reproducir';
    if (elements.currentTrackArtist) elements.currentTrackArtist.textContent = errorMessage;
    syncNowPlayingTextAttributes();
    setNowPlayingState('error', 'Error de reproducción');
  }
}

function updateTrackInfo() {
  if (state.currentTrack) {
    elements.currentTrackTitle.textContent = state.currentTrack.title || 'Sin título';
    elements.currentTrackArtist.textContent = state.currentTrack.artist || 'Sin artista';
    setCurrentTrackArtwork(state.currentTrack.thumbnail || '');
    syncNowPlayingTextAttributes();
    if (state.playerUiState !== 'loading') {
      setNowPlayingState(state.isPlaying ? 'playing' : 'paused');
    }
    console.log('Información de pista actualizada:', state.currentTrack.title, state.currentTrack.artist);
    refreshSearchPlayingIndicators();
    
    // Actualizar estadísticas del usuario cuando se reproduce una canción
    updateUserStats();
    sendPlayerStateToMain();
    sendMiniPlayerState({ force: true });
  } else {
    elements.currentTrackTitle.textContent = 'No hay canción seleccionada';
    elements.currentTrackArtist.textContent = '-';
    setCurrentTrackArtwork('');
    syncNowPlayingTextAttributes();
    setNowPlayingState('empty');
    refreshSearchPlayingIndicators();
    if (elements.currentTime) elements.currentTime.textContent = '0:00';
    if (elements.totalTime) elements.totalTime.textContent = '0:00';
    if (elements.progressBar) {
      elements.progressBar.style.width = '0%';
      elements.progressBar.parentElement?.setAttribute('aria-valuenow', '0');
    }
    console.log('Sin pista actual, reiniciando UI');
    sendPlayerStateToMain();
    sendMiniPlayerState({ force: true });
  }
  syncLyricsModalTrackInfo();
  resetLyricsStateForTrack();
}

function getLyricsCacheKey(track = state.currentTrack) {
  if (!track) return null;
  const artist = String(track.artist || '').trim().toLowerCase();
  const title = String(track.title || '').trim().toLowerCase();
  if (!artist && !title) return null;
  return `${artist}::${title}`;
}

function setLyricsContent(content, { isPlaceholder = false } = {}) {
  if (!elements.lyricsContent) return;
  elements.lyricsContent.textContent = content;
  elements.lyricsContent.classList.toggle('is-placeholder', isPlaceholder);
}

function syncLyricsModalTrackInfo() {
  if (!elements.lyricsModalTitle || !elements.lyricsModalArtist) return;

  if (state.currentTrack) {
    elements.lyricsModalTitle.textContent = state.currentTrack.title || 'Sin título';
    elements.lyricsModalArtist.textContent = state.currentTrack.artist || 'Sin artista';
  } else {
    elements.lyricsModalTitle.textContent = 'No hay canción seleccionada';
    elements.lyricsModalArtist.textContent = '-';
    setLyricsContent('Selecciona una canción para ver su letra.', { isPlaceholder: true });
  }
}

function resetLyricsStateForTrack() {
  state.lyrics.activeKey = getLyricsCacheKey();

  if (!elements.lyricsButton) return;

  if (!state.currentTrack) {
    elements.lyricsButton.classList.remove('active', 'loading');
    elements.lyricsButton.disabled = false;
    return;
  }

  const cachedLyrics = state.lyrics.cache[state.lyrics.activeKey];
  elements.lyricsButton.disabled = false;
  elements.lyricsButton.classList.remove('loading');
  elements.lyricsButton.classList.toggle('active', !!cachedLyrics?.lyrics);

  if (state.lyrics.isOpen) {
    if (cachedLyrics?.lyrics) {
      setLyricsContent(cachedLyrics.lyrics);
    } else if (cachedLyrics?.error) {
      setLyricsContent(cachedLyrics.error, { isPlaceholder: true });
    } else {
      setLyricsContent('Pulsa el botón de letra para buscar la letra de esta canción.', { isPlaceholder: true });
    }
  }
}

function openLyricsModal() {
  if (!elements.lyricsModal) return;
  state.lyrics.isOpen = true;
  elements.lyricsModal.classList.add('active');
  elements.lyricsModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeLyricsModal() {
  if (!elements.lyricsModal) return;
  state.lyrics.isOpen = false;
  elements.lyricsModal.classList.remove('active');
  elements.lyricsModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

async function loadLyricsForCurrentTrack({ forceRefresh = false } = {}) {
  if (!state.currentTrack) {
    setLyricsContent('Selecciona una canción para ver su letra.', { isPlaceholder: true });
    return null;
  }

  const cacheKey = getLyricsCacheKey();
  const requestedTrackKey = cacheKey;
  state.lyrics.activeKey = cacheKey;

  if (!forceRefresh && cacheKey && state.lyrics.cache[cacheKey]) {
    const cached = state.lyrics.cache[cacheKey];
    setLyricsContent(cached.lyrics || cached.error, { isPlaceholder: !cached.lyrics });
    elements.lyricsButton?.classList.toggle('active', !!cached.lyrics);
    return cached;
  }

  elements.lyricsButton?.classList.add('loading');
  setLyricsContent('Buscando la letra...', { isPlaceholder: true });

  try {
    const result = await ipcRenderer.invoke('get-song-lyrics', {
      title: state.currentTrack.title,
      artist: state.currentTrack.artist
    });
    console.log('Lyrics loaded', {
      title: state.currentTrack?.title || null,
      artist: state.currentTrack?.artist || null,
      hasLyrics: !!result?.lyrics
    });

    const payload = {
      lyrics: result.lyrics,
      search: result.search
    };

    if (cacheKey) state.lyrics.cache[cacheKey] = payload;
    if (state.lyrics.activeKey !== requestedTrackKey) return payload;
    setLyricsContent(payload.lyrics);
    elements.lyricsButton?.classList.add('active');
    return payload;
  } catch (error) {
    console.error('Lyrics load failed', error);
    const message = error?.message?.includes('internet est')
      ? 'Activa el acceso a internet para consultar letras.'
      : 'No se encontró una letra disponible para esta canción.';
    const payload = { error: message };
    if (cacheKey) state.lyrics.cache[cacheKey] = payload;
    if (state.lyrics.activeKey !== requestedTrackKey) return payload;
    setLyricsContent(message, { isPlaceholder: true });
    elements.lyricsButton?.classList.remove('active');
    return payload;
  } finally {
    elements.lyricsButton?.classList.remove('loading');
  }
}

async function handleLyricsButtonClick() {
  console.log('Lyrics button clicked', {
    hasTrack: !!state.currentTrack,
    trackTitle: state.currentTrack?.title || null,
    trackArtist: state.currentTrack?.artist || null
  });

  if (!state.currentTrack) {
    notificationSystem.info('Selecciona una canción primero para ver su letra.');
    return;
  }

  syncLyricsModalTrackInfo();
  openLyricsModal();
  await loadLyricsForCurrentTrack();
}

async function playQueuedTrack({ consumeCurrent = true } = {}) {
  if (state.queue.length === 0) return false;

  const currentQueueIndex = findCurrentQueueIndex();
  let nextIndex = 0;

  if (currentQueueIndex >= 0) {
    if (state.queueLoop) {
      nextIndex = getSequentialOrShuffledIndex(
        state.queue,
        (currentQueueIndex + 1) % state.queue.length
      );
    } else if (consumeCurrent) {
      state.queue.splice(currentQueueIndex, 1);
      if (state.queue.length === 0) {
        state.currentIndex = -1;
        updateQueueUI({ forceVisible: document.querySelector('.queue-container')?.classList.contains('active') });
        return false;
      }
      if (!state.shuffle && !state.playbackSettings.smartShuffle && currentQueueIndex >= state.queue.length) {
        state.currentIndex = -1;
        updateQueueUI({ forceVisible: document.querySelector('.queue-container')?.classList.contains('active') });
        return false;
      }
      nextIndex = getSequentialOrShuffledIndex(state.queue, currentQueueIndex);
    } else {
      nextIndex = getSequentialOrShuffledIndex(
        state.queue,
        Math.min(currentQueueIndex + 1, state.queue.length - 1)
      );
    }
  } else {
    nextIndex = getSequentialOrShuffledIndex(state.queue, 0);
  }

  const nextTrack = state.queue[nextIndex];
  if (!nextTrack) return false;

  state.currentPlaylist = null;
  state.currentPlaylistId = null;
  state.currentIndex = nextIndex;
  updateQueueUI({ forceVisible: document.querySelector('.queue-container')?.classList.contains('active') });
  console.log(`Reproduciendo siguiente canción de la cola: ${nextTrack.title}`);
  await playSong(nextTrack);
  return true;
}

async function playAutoplayRecommendation() {
  if (!state.playbackSettings.autoplay) return false;

  try {
    const data = await ipcRenderer.invoke('get-home-data');
    const recommendations = data?.recommendations || [];
    if (recommendations.length === 0) {
      console.log('No hay recomendaciones disponibles para autoplay');
      return false;
    }

    const blockedKeys = new Set(
      [state.currentTrack, ...state.queue, ...(state.recentlyPlayed || []).slice(0, 10)]
        .map(track => getPlaybackTrackKey(track))
        .filter(Boolean)
    );
    const candidates = recommendations.filter(track => !blockedKeys.has(getPlaybackTrackKey(track)));
    const pool = candidates.length ? candidates : recommendations;
    const nextIndex = state.playbackSettings.smartShuffle
      ? getSmartShuffleIndex(pool)
      : Math.floor(Math.random() * pool.length);
    const nextTrack = pool[nextIndex] || pool[0];

    if (!nextTrack) return false;
    state.currentPlaylist = null;
    state.currentPlaylistId = null;
    state.currentIndex = -1;
    console.log(`Reproducción automática: ${nextTrack.title}`);
    await playSong(nextTrack);
    return true;
  } catch (error) {
    console.error('Error al obtener recomendaciones para autoplay:', error);
    return false;
  }
}

async function stopPlaybackAtEnd(message = 'No hay canciones en la cola ni en la playlist') {
  console.log(message);
  if (elements.audio) {
    elements.audio.pause();
    elements.audio.currentTime = 0;
    elements.audio.removeAttribute('src');
    elements.audio.load();
  }
  state.currentTrack = null;
  state.isPlaying = false;
  updateTrackInfo();
  updatePlayingUI(false);
}

async function playNext() {
  try {
    const addedToQueue = await ensureAutoQueueSeed(state.queue.length > 0 ? 1 : 3);
    if (state.queue.length > 0) {
      const playedFromQueue = await playQueuedTrack({ consumeCurrent: true });
      if (playedFromQueue) return;
      const refilledQueue = await ensureAutoQueueSeed(3);
      if (refilledQueue > 0) {
        const playedRefilledQueue = await playQueuedTrack({ consumeCurrent: false });
        if (playedRefilledQueue) return;
      }
    } else if (addedToQueue > 0) {
      const playedSeededQueue = await playQueuedTrack({ consumeCurrent: false });
      if (playedSeededQueue) return;
    }

    if (state.currentPlaylist && state.currentPlaylist.length > 0) {
      let nextIndex = state.currentIndex;

      if (state.shuffle || state.playbackSettings.smartShuffle) {
        nextIndex = getSmartShuffleIndex(state.currentPlaylist);
      } else {
        nextIndex = state.currentIndex + 1;
      }

      const reachedPlaylistEnd = nextIndex >= state.currentPlaylist.length;
      if (reachedPlaylistEnd) {
        if (state.repeat === 'all') {
          nextIndex = 0;
        } else {
          const autoplayStarted = await playAutoplayRecommendation();
          if (!autoplayStarted) {
            await stopPlaybackAtEnd('Fin de la playlist, deteniendo reproducción');
          }
          return;
        }
      }

      const nextTrack = state.currentPlaylist[nextIndex];
      if (!nextTrack) {
        await stopPlaybackAtEnd('No se encontró la siguiente canción de la playlist');
        return;
      }

      state.currentIndex = nextIndex;
      console.log(`Reproduciendo siguiente canción de la playlist: ${nextTrack.title}`);
      await playSong(nextTrack);
      return;
    }

    const autoplayStarted = await playAutoplayRecommendation();
    if (!autoplayStarted) {
      await stopPlaybackAtEnd();
    }
  } finally {
    updateQueueUI({ forceVisible: document.querySelector('.queue-container')?.classList.contains('active') });
  }
}

function playPrevious() {
  if (elements.audio.currentTime > 3) {
    elements.audio.currentTime = 0;
    console.log('Reiniciando canción actual');
    return;
  }

  if (state.currentPlaylist && state.currentPlaylist.length > 0) {
    // Reproduciendo desde una playlist
    state.currentIndex = (state.currentIndex - 1 + state.currentPlaylist.length) % state.currentPlaylist.length;
    const prevTrack = state.currentPlaylist[state.currentIndex];
    console.log(`Reproduciendo canción anterior de la playlist: ${prevTrack.title}`);
    playSong(prevTrack);
  } else if (state.queue.length > 0) {
    // Reproduciendo desde la cola
    state.currentIndex = (state.currentIndex - 1 + state.queue.length) % state.queue.length;
    const prevTrack = state.queue[state.currentIndex];
    console.log(`Reproduciendo canción anterior de la cola: ${prevTrack.title}`);
    playSong(prevTrack);
  } else {
    console.log('No hay canciones anteriores disponibles');
  }
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  elements.shuffleButton.classList.toggle('active');
  console.log('Modo aleatorio activado:', state.shuffle);
}

function toggleRepeat() {
  switch(state.repeat) {
    case 'none':
      state.repeat = 'all';
      elements.repeatButton.classList.add('active');
      elements.repeatButton.innerHTML = '<i class="fas fa-redo"></i>';
      elements.repeatButton.title = "Repetir todo";
      break;
    case 'all':
      state.repeat = 'one';
      elements.repeatButton.classList.add('active');
      elements.repeatButton.innerHTML = '<i class="fas fa-redo"></i><span class="repeat-one-badge">1</span>';
      elements.repeatButton.title = "Repetir una";
      break;
    case 'one':
      state.repeat = 'none';
      elements.repeatButton.classList.remove('active');
      elements.repeatButton.innerHTML = '<i class="fas fa-redo"></i>';
      elements.repeatButton.title = "No repetir";
      break;
  }
  console.log('Modo de repetición cambiado:', state.repeat);
}

function toggleMute() {
  elements.audio.muted = !elements.audio.muted;
  updateVolumeUI();
  console.log('Estado de mute cambiado:', elements.audio.muted);
}

let progressBarDragging = false;
let progressBarWasPlaying = false;
let progressBarHasMovedDuringDrag = false;

function handleVolumeChange(e) {
  const volumeContainer = elements.volumeProgress.parentElement;
  const rect = volumeContainer.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const volumeLevel = Math.min(Math.max(x / rect.width, 0), 1);
  
  state.volume = volumeLevel;
  elements.audio.muted = volumeLevel === 0 ? true : false;
  elements.audio.volume = state.audioSettings.normalizeVolume ? Math.min(volumeLevel, 0.8) : volumeLevel;
  updateVolumeUI();
  console.log('Volumen cambiado a:', volumeLevel);
}

// Función para manejar el arrastre del volumen
function handleVolumeDrag(e) {
  if (e.type === 'mousedown') {
    document.addEventListener('mousemove', handleVolumeChange);
    document.addEventListener('mouseup', () => {
      document.removeEventListener('mousemove', handleVolumeChange);
    });
  }
}

function getProgressContainerRect() {
  if (!elements.progressBar) return null;
  return (elements.progressBar.parentElement || elements.progressBar).getBoundingClientRect();
}

function getProgressPositionFromEvent(e) {
  const rect = getProgressContainerRect();
  if (!rect) return null;

  let clientX = 0;
  if (e.type.startsWith('touch')) {
    clientX = e.touches[0]?.clientX ?? e.changedTouches[0]?.clientX;
  } else {
    clientX = e.clientX;
  }

  return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
}

function seekAudioToPosition(position) {
  if (!state.currentTrack) {
    console.warn('No hay canción seleccionada para avanzar');
    return;
  }
  if (!Number.isFinite(elements.audio.duration) || elements.audio.duration <= 0) {
    console.warn('Duración no disponible para avanzar');
    return;
  }

  const newTime = position * elements.audio.duration;
  elements.audio.currentTime = newTime;
  updateProgressUI();
  console.log('Progreso cambiado a:', newTime);
}

function handleProgressBarClick(e) {
  const position = getProgressPositionFromEvent(e);
  if (position === null) return;
  seekAudioToPosition(position);
}

function handleProgressBarDragStart(e) {
  if (!elements.audio) return;

  progressBarDragging = true;
  progressBarHasMovedDuringDrag = false;
  progressBarWasPlaying = !elements.audio.paused;
  if (progressBarWasPlaying) {
    elements.audio.pause();
  }

  if (e.type === 'mousedown') {
    document.addEventListener('mousemove', handleProgressBarDragMove);
    document.addEventListener('mouseup', handleProgressBarDragEnd, { once: true });
    handleProgressBarDragMove(e);
  }
  if (e.type === 'touchstart') {
    document.addEventListener('touchmove', handleProgressBarDragMove, { passive: false });
    document.addEventListener('touchend', handleProgressBarDragEnd, { once: true });
    handleProgressBarDragMove(e);
  }
}

function handleProgressBarDragMove(e) {
  e.preventDefault();
  const position = getProgressPositionFromEvent(e);
  if (position === null) return;
  progressBarHasMovedDuringDrag = true;
  seekAudioToPosition(position);
}

function handleProgressBarDragEnd() {
  document.removeEventListener('mousemove', handleProgressBarDragMove);
  document.removeEventListener('touchmove', handleProgressBarDragMove);

  if (!elements.audio) return;
  progressBarDragging = false;
  if (progressBarWasPlaying) {
    elements.audio.play().catch(error => {
      console.warn('No se pudo reanudar reproducción tras el drag:', error);
    });
  }
}

function handleProgressBarClick(e) {
  const position = getProgressPositionFromEvent(e);
  if (position === null) return;
  if (progressBarDragging) {
    return;
  }
  seekAudioToPosition(position);
}

// Aplicar crossfade
function applyCrossfade() {
  return;
}

function initializeNavigationLinks() {
  document.querySelectorAll('.nav-link').forEach(link => {
    if (link.dataset.bound === 'true') return;
    link.dataset.bound = 'true';

    link.addEventListener('click', (e) => {
      e.preventDefault();
      const action = e.currentTarget.dataset.action;
      if (action === 'spotify-import') {
        openSpotifyImportPrompt();
        return;
      }
      if (action === 'youtube-import') {
        openYoutubeImportPrompt();
        return;
      }
      if (action === 'local-artists') {
        openLocalArtistsModal();
        return;
      }

      const page = e.currentTarget.dataset.page;
      if (!page) {
        console.warn('Nav link sin página configurada:', e.currentTarget);
        return;
      }

      showPage(page);
      console.log(`Navegando a página: ${page}`);
    });
  });
}

function getLocalArtistById(artistId) {
  return LOCAL_ARTISTS_CATALOG.find(artist => artist.id === artistId) || null;
}

function getLocalArtistThumbnail(videoId, quality = 'maxresdefault') {
  return `https://i.ytimg.com/vi/${videoId}/${quality}.jpg`;
}

function createLocalArtistTrack(artist, song) {
  return {
    id: song.id,
    video_id: song.id,
    title: song.title,
    artist: artist.name,
    thumbnail: getLocalArtistThumbnail(song.id, 'hqdefault'),
    duration: song.duration,
    url: `https://www.youtube.com/watch?v=${song.id}`,
    isLocal: false
  };
}

function syncLocalArtistsNavigationState() {
  const navLink = document.getElementById('localArtistsNavLink');
  if (!navLink) return;
  navLink.classList.toggle('is-open', Boolean(document.querySelector('.local-artists-modal')));
}

function dismissLocalArtistsModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;

  if (typeof modal._localArtistsClose === 'function') {
    modal._localArtistsClose();
  } else {
    modal.remove();
    syncLocalArtistsNavigationState();
  }
}

function bindLocalArtistArtworkFallbacks(container) {
  container.querySelectorAll('img[data-local-artwork]').forEach(image => {
    image.addEventListener('error', () => {
      const fallbackSrc = image.dataset.fallbackSrc;
      if (fallbackSrc && image.dataset.fallbackApplied !== 'true') {
        image.dataset.fallbackApplied = 'true';
        image.src = fallbackSrc;
        return;
      }

      image.closest('[data-local-artwork-container]')?.classList.add('is-artwork-fallback');
      image.remove();
    });
  });
}

function bindLocalArtistsModalClose(modal, onClose) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown);
    modal.remove();
    syncLocalArtistsNavigationState();
    if (typeof onClose === 'function') onClose();
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  modal._localArtistsClose = close;
  modal.querySelectorAll('[data-local-artists-dismiss]').forEach(button => {
    button.addEventListener('click', close);
  });
  document.addEventListener('keydown', onKeyDown);
}

function openLocalArtistsModal() {
  dismissLocalArtistsModal('localArtistSongsModal');
  dismissLocalArtistsModal('localArtistsModal');

  const modal = document.createElement('div');
  modal.id = 'localArtistsModal';
  modal.className = 'local-artists-modal local-artists-selection-modal';
  modal.innerHTML = `
    <div class="local-artists-backdrop" data-local-artists-dismiss></div>
    <section class="local-artists-dialog local-artists-selection-dialog" role="dialog" aria-modal="true" aria-labelledby="localArtistsModalTitle">
      <div class="local-artists-orbit local-artists-orbit-one" aria-hidden="true"></div>
      <div class="local-artists-orbit local-artists-orbit-two" aria-hidden="true"></div>
      <header class="local-artists-dialog-header">
        <div class="local-artists-heading">
          <span class="local-artists-kicker"><i class="fas fa-sparkles"></i> Selección de Lunera</span>
          <h2 id="localArtistsModalTitle">Artistas locales</h2>
          <p>Conocé a los artistas que Lunera está ayudando a impulsar.</p>
        </div>
        <button class="local-artists-close-button" type="button" data-local-artists-dismiss aria-label="Cerrar artistas locales">
          <i class="fas fa-times" aria-hidden="true"></i>
        </button>
      </header>

      <div class="local-artists-selection-copy">
        <span><i class="fas fa-heart" aria-hidden="true"></i> Artistas patrocinados</span>
        <p>Elegí un perfil y explorá sus lanzamientos sin salir de Lunera.</p>
      </div>

      <div class="local-artists-cards" role="list" aria-label="Artistas locales disponibles">
        ${LOCAL_ARTISTS_CATALOG.map(artist => {
          const releaseLabel = artist.songs.length === 1 ? '1 lanzamiento' : `${artist.songs.length} lanzamientos`;
          return `
            <button class="local-artists-card local-artists-card--${artist.style}" type="button" data-local-artist-id="${artist.id}" role="listitem" aria-label="Ver canciones de ${artist.name}">
              <div class="local-artists-card-glow" aria-hidden="true"></div>
              <div class="local-artists-card-avatar local-artists-artwork" data-local-artwork-container data-monogram="${artist.initials}">
                <img data-local-artwork src="${artist.profileImage}" alt="${artist.name}" referrerpolicy="no-referrer">
              </div>
              <div class="local-artists-card-copy">
                <span class="local-artists-card-status">Artista local</span>
                <h3>${artist.name}</h3>
                <p>${artist.description}</p>
              </div>
              <div class="local-artists-card-footer">
                <span>${releaseLabel}</span>
                <span class="local-artists-card-arrow"><i class="fas fa-arrow-right" aria-hidden="true"></i></span>
              </div>
            </button>
          `;
        }).join('')}
      </div>

      <footer class="local-artists-dialog-footer">
        <i class="fas fa-wave-square" aria-hidden="true"></i>
        <span>Una vitrina para el talento que está creciendo cerca.</span>
      </footer>
    </section>
  `;

  document.body.appendChild(modal);
  bindLocalArtistArtworkFallbacks(modal);
  bindLocalArtistsModalClose(modal);

  modal.querySelectorAll('[data-local-artist-id]').forEach(card => {
    card.addEventListener('click', () => {
      const artistId = card.dataset.localArtistId;
      dismissLocalArtistsModal('localArtistsModal');
      openLocalArtistSongsModal(artistId);
    });
  });

  syncLocalArtistsNavigationState();
  requestAnimationFrame(() => modal.querySelector('.local-artists-close-button')?.focus());
}

function openLocalArtistSongsModal(artistId) {
  const artist = getLocalArtistById(artistId);
  if (!artist) return;

  dismissLocalArtistsModal('localArtistSongsModal');
  dismissLocalArtistsModal('localArtistsModal');

  const modal = document.createElement('div');
  modal.id = 'localArtistSongsModal';
  modal.className = `local-artists-modal local-artist-songs-modal local-artist-songs-modal--${artist.style}`;
  const heroImage = getLocalArtistThumbnail(artist.songs[0].id);
  const heroFallbackImage = getLocalArtistThumbnail(artist.songs[0].id, 'hqdefault');

  modal.innerHTML = `
    <div class="local-artists-backdrop" data-local-artists-dismiss></div>
    <section class="local-artists-dialog local-artist-songs-dialog" role="dialog" aria-modal="true" aria-labelledby="localArtistSongsModalTitle">
      <div class="local-artist-songs-hero-art" aria-hidden="true">
        <img data-local-artwork src="${heroImage}" data-fallback-src="${heroFallbackImage}" alt="">
      </div>
      <header class="local-artist-songs-topbar">
        <button class="local-artist-back-button" type="button" data-local-artists-back>
          <i class="fas fa-arrow-left" aria-hidden="true"></i>
          <span>Artistas</span>
        </button>
        <button class="local-artists-close-button" type="button" data-local-artists-dismiss aria-label="Cerrar canciones de ${artist.name}">
          <i class="fas fa-times" aria-hidden="true"></i>
        </button>
      </header>

      <div class="local-artist-songs-hero">
        <div class="local-artist-songs-avatar local-artists-artwork" data-local-artwork-container data-monogram="${artist.initials}">
          <img data-local-artwork src="${artist.profileImage}" alt="${artist.name}" referrerpolicy="no-referrer">
        </div>
        <div class="local-artist-songs-heading">
          <span class="local-artists-kicker"><i class="fas fa-heart" aria-hidden="true"></i> Artista patrocinado</span>
          <h2 id="localArtistSongsModalTitle">${artist.name}</h2>
          <p>${artist.songs.length} ${artist.songs.length === 1 ? 'lanzamiento disponible' : 'lanzamientos disponibles'} en Lunera</p>
        </div>
        <button class="local-artist-channel-button" type="button" data-local-artist-channel>
          <i class="fab fa-youtube" aria-hidden="true"></i>
          <span>Ver canal</span>
        </button>
      </div>

      <div class="local-artist-songs-section-heading">
        <div>
          <span>Discografía</span>
          <h3>Escuchá los lanzamientos</h3>
        </div>
        <span class="local-artist-songs-count">${artist.songs.length}</span>
      </div>

      <div class="local-artist-song-list">
        ${artist.songs.map((song, index) => {
          const cover = getLocalArtistThumbnail(song.id);
          const fallbackCover = getLocalArtistThumbnail(song.id, 'hqdefault');
          return `
            <article class="local-artist-song" style="--local-song-order: ${index};">
              <span class="local-artist-song-number">${String(index + 1).padStart(2, '0')}</span>
              <div class="local-artist-song-cover local-artists-artwork" data-local-artwork-container data-monogram="♫">
                <img data-local-artwork src="${cover}" data-fallback-src="${fallbackCover}" alt="Portada de ${song.title}">
              </div>
              <div class="local-artist-song-copy">
                <h4>${song.title}</h4>
                <p>${artist.name} <span aria-hidden="true">·</span> YouTube</p>
              </div>
              <span class="local-artist-song-duration">${song.duration}</span>
              <div class="local-artist-song-actions">
                <button class="local-artist-song-play" type="button" data-local-artist-play="${song.id}" aria-label="Reproducir ${song.title}">
                  <i class="fas fa-play" aria-hidden="true"></i>
                  <span>Reproducir</span>
                </button>
                <button class="local-artist-song-external" type="button" data-local-artist-external="${song.id}" aria-label="Abrir ${song.title} en YouTube" title="Abrir en YouTube">
                  <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i>
                </button>
              </div>
            </article>
          `;
        }).join('')}
      </div>

      <footer class="local-artist-songs-footer">
        <i class="fas fa-circle-play" aria-hidden="true"></i>
        <span>Reproducí desde Lunera o abrí el lanzamiento en YouTube.</span>
      </footer>
    </section>
  `;

  document.body.appendChild(modal);
  bindLocalArtistArtworkFallbacks(modal);
  bindLocalArtistsModalClose(modal);

  modal.querySelector('[data-local-artists-back]')?.addEventListener('click', () => {
    dismissLocalArtistsModal('localArtistSongsModal');
    openLocalArtistsModal();
  });
  modal.querySelector('[data-local-artist-channel]')?.addEventListener('click', () => {
    shell.openExternal(artist.channelUrl).catch(error => {
      console.warn('No se pudo abrir el canal del artista local:', error);
    });
  });
  modal.querySelectorAll('[data-local-artist-play]').forEach(button => {
    button.addEventListener('click', () => {
      const song = artist.songs.find(item => item.id === button.dataset.localArtistPlay);
      if (!song) return;

      const artistTracks = artist.songs.map(item => createLocalArtistTrack(artist, item));
      const track = artistTracks.find(item => item.id === song.id);
      state.currentPlaylist = artistTracks;
      state.currentPlaylistId = null;
      state.currentIndex = artistTracks.findIndex(item => item.id === song.id);
      dismissLocalArtistsModal('localArtistSongsModal');
      void playSong(track);
    });
  });
  modal.querySelectorAll('[data-local-artist-external]').forEach(button => {
    button.addEventListener('click', () => {
      const songId = button.dataset.localArtistExternal;
      shell.openExternal(`https://www.youtube.com/watch?v=${songId}`).catch(error => {
        console.warn('No se pudo abrir el lanzamiento en YouTube:', error);
      });
    });
  });

  syncLocalArtistsNavigationState();
  requestAnimationFrame(() => modal.querySelector('.local-artists-close-button')?.focus());
}

function createSpotifyImportProgressModal() {
  const existing = document.getElementById('spotifyImportProgressModal');
  if (existing) return existing;

  const modal = document.createElement('div');
  modal.id = 'spotifyImportProgressModal';
  modal.className = 'spotify-import-progress-modal spotify-import-progress-modal--spotify';
  modal.innerHTML = `
    <div class="spotify-import-progress-backdrop"></div>
    <div class="spotify-import-progress-dialog">
      <div class="spotify-import-progress-header">
        <div class="spotify-import-progress-title-wrap">
          <div class="spotify-import-progress-icon spotify-import-progress-icon--spotify">
            <i class="fab fa-spotify"></i>
          </div>
          <div>
            <strong>Importando playlist de Spotify</strong>
            <p>Estableciendo conexión y preparando tu biblioteca.</p>
          </div>
        </div>
        <button type="button" id="cancelSpotifyImportBtn" class="spotify-import-cancel-btn">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <div class="spotify-import-progress-body">
        <div class="spotify-import-progress-meta">
          <span class="spotify-import-progress-pill">Sin abrir Spotify</span>
          <span class="spotify-import-progress-pill">Procesamiento local</span>
        </div>
        <p id="spotifyImportProgressMessage">Preparando importación...</p>
        <div class="spotify-import-progress-bar">
          <div class="spotify-import-progress-fill" id="spotifyImportProgressFill"></div>
        </div>
        <div class="spotify-import-progress-footer">
          <span id="spotifyImportProgressPercent">0%</span>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const cancelBtn = modal.querySelector('#cancelSpotifyImportBtn');
  cancelBtn.addEventListener('click', () => {
    modal.dataset.cancelRequested = 'true';
  });

  return modal;
}

function promptSpotifyImportUrl() {
  return new Promise((resolve) => {
    const existing = document.getElementById('spotifyImportUrlModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'spotifyImportUrlModal';
    modal.className = 'spotify-import-url-modal spotify-import-url-modal--spotify';
    modal.innerHTML = `
      <div class="spotify-import-url-backdrop"></div>
      <div class="spotify-import-url-dialog">
        <div class="spotify-import-url-header">
          <div class="spotify-import-url-title-wrap">
            <div class="spotify-import-url-icon spotify-import-url-icon--spotify">
              <i class="fab fa-spotify"></i>
            </div>
            <div>
              <strong>Importar desde Spotify</strong>
              <p>Pega una URL de playlist, álbum o canción y la importaremos a Lunera.</p>
            </div>
          </div>
        </div>
        <div class="spotify-import-url-body">
          <label for="spotifyPlaylistUrlInput">URL de Spotify</label>
          <div class="spotify-import-url-input-shell">
            <i class="fab fa-spotify"></i>
            <input id="spotifyPlaylistUrlInput" type="text" placeholder="https://open.spotify.com/playlist/..." autocomplete="off" autocapitalize="none" />
          </div>
          <p class="spotify-import-url-hint">Ejemplo: open.spotify.com/playlist/..., open.spotify.com/album/..., open.spotify.com/track/...</p>
        </div>
        <div class="spotify-import-url-actions">
          <button type="button" id="spotifyImportUrlCancelBtn" class="spotify-import-url-button spotify-import-url-cancel">Cancelar</button>
          <button type="button" id="spotifyImportUrlSubmitBtn" class="spotify-import-url-button spotify-import-url-submit">Importar</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const input = modal.querySelector('#spotifyPlaylistUrlInput');
    const cancelBtn = modal.querySelector('#spotifyImportUrlCancelBtn');
    const submitBtn = modal.querySelector('#spotifyImportUrlSubmitBtn');
    const backdrop = modal.querySelector('.spotify-import-url-backdrop');

    const cleanup = () => {
      cancelBtn?.removeEventListener('click', onCancel);
      submitBtn?.removeEventListener('click', onSubmit);
      backdrop?.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKeyDown);
      modal.remove();
    };

    const onCancel = () => {
      cleanup();
      resolve(null);
    };

    const onSubmit = () => {
      const value = input?.value.trim();
      if (!value) {
        input?.focus();
        return;
      }
      cleanup();
      resolve(value);
    };

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        onSubmit();
      }
    };

    cancelBtn?.addEventListener('click', onCancel);
    submitBtn?.addEventListener('click', onSubmit);
    backdrop?.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKeyDown);

    input?.focus();
  });
}

function updateSpotifyImportProgress(percent, message) {
  const modal = document.getElementById('spotifyImportProgressModal');
  if (!modal) return;
  const fill = modal.querySelector('#spotifyImportProgressFill');
  const messageElement = modal.querySelector('#spotifyImportProgressMessage');
  const percentElement = modal.querySelector('#spotifyImportProgressPercent');
  if (fill) fill.style.width = `${Math.min(Math.max(percent, 0), 100)}%`;
  if (messageElement) messageElement.textContent = message;
  if (percentElement) percentElement.textContent = `${Math.min(Math.max(percent, 0), 100)}%`;
}

function closeSpotifyImportProgressModal() {
  const modal = document.getElementById('spotifyImportProgressModal');
  if (modal) modal.remove();
}

async function openSpotifyImportPrompt() {
  const spotifyUrl = await promptSpotifyImportUrl();
  if (!spotifyUrl) return;

  const modal = createSpotifyImportProgressModal();
  modal.dataset.cancelRequested = 'false';
  updateSpotifyImportProgress(5, 'Validando URL de Spotify...');

  try {
    const { SpotifyImporter } = require('./spotifyImporter.js');
    const importer = new SpotifyImporter({ cacheEnabled: true });

    const cancelBtn = modal.querySelector('#cancelSpotifyImportBtn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        importer.cancel();
        modal.dataset.cancelRequested = 'true';
        updateSpotifyImportProgress(100, 'Cancelando importación...');
      });
    }

    const result = await importer.importUrl(spotifyUrl, {
      onProgress: ({ percent, message }) => {
        updateSpotifyImportProgress(percent || 0, message || 'Procesando...');
      }
    });

    if (modal.dataset.cancelRequested === 'true') {
      notificationSystem.warning('Importación de Spotify cancelada.');
      return;
    }

    const title = result.playlistName ? `Importación completada: ${result.playlistName}` : 'Importación completada desde Spotify';
    notificationSystem.success(`${title}. ${result.importedCount} canciones agregadas.`);
    showPage('library');
    await loadLibrary();
  } catch (error) {
    console.error('Error importando playlist de Spotify:', error);
    notificationSystem.error('No se pudo importar la playlist de Spotify');
  } finally {
    closeSpotifyImportProgressModal();
  }
}

function createYoutubeImportProgressModal() {
  const existing = document.getElementById('youtubeImportProgressModal');
  if (existing) return existing;

  const modal = document.createElement('div');
  modal.id = 'youtubeImportProgressModal';
  modal.className = 'spotify-import-progress-modal spotify-import-progress-modal--youtube';
  modal.innerHTML = `
    <div class="spotify-import-progress-backdrop"></div>
    <div class="spotify-import-progress-dialog">
      <div class="spotify-import-progress-header">
        <div class="spotify-import-progress-title-wrap">
          <div class="spotify-import-progress-icon spotify-import-progress-icon--youtube">
            <i class="fab fa-youtube"></i>
          </div>
          <div>
            <strong>Importando playlist de YouTube</strong>
            <p>Analizando la lista y añadiendo las canciones a tu espacio.</p>
          </div>
        </div>
        <button type="button" id="cancelYoutubeImportBtn" class="spotify-import-cancel-btn">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <div class="spotify-import-progress-body">
        <div class="spotify-import-progress-meta">
          <span class="spotify-import-progress-pill">Búsqueda automática</span>
          <span class="spotify-import-progress-pill">Duración variable</span>
        </div>
        <p id="youtubeImportProgressMessage">Preparando importación...</p>
        <div class="spotify-import-progress-bar">
          <div class="spotify-import-progress-fill" id="youtubeImportProgressFill"></div>
        </div>
        <div class="spotify-import-progress-footer">
          <span id="youtubeImportProgressPercent">0%</span>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const cancelBtn = modal.querySelector('#cancelYoutubeImportBtn');
  cancelBtn.addEventListener('click', () => {
    modal.dataset.cancelRequested = 'true';
  });

  return modal;
}

function promptYoutubeImportUrl() {
  return new Promise((resolve) => {
    const existing = document.getElementById('youtubeImportUrlModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'youtubeImportUrlModal';
    modal.className = 'spotify-import-url-modal spotify-import-url-modal--youtube';
    modal.innerHTML = `
      <div class="spotify-import-url-backdrop"></div>
      <div class="spotify-import-url-dialog">
        <div class="spotify-import-url-header">
          <div class="spotify-import-url-title-wrap">
            <div class="spotify-import-url-icon spotify-import-url-icon--youtube">
              <i class="fab fa-youtube"></i>
            </div>
            <div>
              <strong>Importar playlist de YouTube</strong>
              <p>Pega la URL de una playlist pública y la añadiremos a tu biblioteca.</p>
            </div>
          </div>
        </div>
        <div class="spotify-import-url-body">
          <label for="youtubePlaylistUrlInput">URL de la playlist</label>
          <div class="spotify-import-url-input-shell">
            <i class="fab fa-youtube"></i>
            <input id="youtubePlaylistUrlInput" type="text" placeholder="https://www.youtube.com/playlist?list=..." autocomplete="off" autocapitalize="none" />
          </div>
          <p class="spotify-import-url-hint">Ejemplo: youtube.com/playlist?list=...</p>
        </div>
        <div class="spotify-import-url-actions">
          <button type="button" id="youtubeImportUrlCancelBtn" class="spotify-import-url-button spotify-import-url-cancel">Cancelar</button>
          <button type="button" id="youtubeImportUrlSubmitBtn" class="spotify-import-url-button spotify-import-url-submit">Importar</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const input = modal.querySelector('#youtubePlaylistUrlInput');
    const cancelBtn = modal.querySelector('#youtubeImportUrlCancelBtn');
    const submitBtn = modal.querySelector('#youtubeImportUrlSubmitBtn');
    const backdrop = modal.querySelector('.spotify-import-url-backdrop');

    const cleanup = () => {
      cancelBtn?.removeEventListener('click', onCancel);
      submitBtn?.removeEventListener('click', onSubmit);
      backdrop?.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKeyDown);
      modal.remove();
    };

    const onCancel = () => { cleanup(); resolve(null); };
    const onSubmit = () => {
      const value = input?.value.trim();
      if (!value) { input?.focus(); return; }
      cleanup(); resolve(value);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
      if (event.key === 'Enter') { event.preventDefault(); onSubmit(); }
    };

    cancelBtn?.addEventListener('click', onCancel);
    submitBtn?.addEventListener('click', onSubmit);
    backdrop?.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKeyDown);

    input?.focus();
  });
}

function updateYoutubeImportProgress(percent, message) {
  const modal = document.getElementById('youtubeImportProgressModal');
  if (!modal) return;
  const fill = modal.querySelector('#youtubeImportProgressFill');
  const messageElement = modal.querySelector('#youtubeImportProgressMessage');
  const percentElement = modal.querySelector('#youtubeImportProgressPercent');
  if (fill) fill.style.width = `${Math.min(Math.max(percent, 0), 100)}%`;
  if (messageElement) messageElement.textContent = message;
  if (percentElement) percentElement.textContent = `${Math.min(Math.max(percent, 0), 100)}%`;
}

function closeYoutubeImportProgressModal() {
  const modal = document.getElementById('youtubeImportProgressModal');
  if (modal) modal.remove();
}

async function openYoutubeImportPrompt() {
  const youtubeUrl = await promptYoutubeImportUrl();
  if (!youtubeUrl) return;

  const modal = createYoutubeImportProgressModal();
  modal.dataset.cancelRequested = 'false';
  updateYoutubeImportProgress(5, 'Validando URL de YouTube...');

  try {
    const { YouTubeImporter } = require('./youtubeImporter.js');
    const importer = new YouTubeImporter({ cacheEnabled: true });

    const cancelBtn = modal.querySelector('#cancelYoutubeImportBtn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        importer.cancel();
        modal.dataset.cancelRequested = 'true';
        updateYoutubeImportProgress(100, 'Cancelando importación...');
      });
    }

    const result = await importer.importPlaylist(youtubeUrl, {
      onProgress: ({ percent, message }) => {
        updateYoutubeImportProgress(percent || 0, message || 'Procesando...');
      }
    });

    if (modal.dataset.cancelRequested === 'true') {
      notificationSystem.warning('Importación de YouTube cancelada.');
      return;
    }

    notificationSystem.success(`Playlist importada: ${result.playlistName}. ${result.importedCount} canciones agregadas.`);
    showPage('library');
    await loadLibrary();
  } catch (error) {
    console.error('Error importando playlist de YouTube:', error);
    notificationSystem.error('No se pudo importar la playlist de YouTube');
  } finally {
    closeYoutubeImportProgressModal();
  }
}

function showPage(pageId) {
  document.querySelectorAll('.page').forEach(page => {
    page.classList.remove('active');
  });
  document.getElementById(pageId).classList.add('active');
  
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.remove('active');
  });
  document.querySelector(`[data-page="${pageId}"]`).classList.add('active');

  // Limpiar currentPlaylist si no estamos en la página de biblioteca
  /* Comentado para permitir reproducción continua al navegar
  if (pageId !== 'library') {
    state.currentPlaylist = null;
    state.currentPlaylistId = null;
    state.currentIndex = -1;
  }
  */
  

  if (pageId === 'home') {
    loadLibrary().finally(() => {
      loadHomeContent();
    });
  } else if (pageId === 'library') {
    loadLibrary();
  } else if (pageId === 'mymusic') {
    loadMyMusicPage();
  } else if (pageId === 'upload') {
    loadLocalMusic();
  }
  console.log(`Página activa: ${pageId}`);
}

function openUploadPage() {
  showPage('upload');
}

function normalizeBrokenSpanishText(text) {
  if (typeof text !== 'string') return text;

  return text
    .replace(/Diagnóstico|Diagnóstico/g, 'Diagn\u00f3stico')
    .replace(/música|música/g, 'm\u00fasica')
    .replace(/Música|Música/g, 'M\u00fasica')
    .replace(/automática/g, 'autom\u00e1tica')
    .replace(/aquí|aquí/g, 'aqu\u00ed')
    .replace(/canción|canción/g, 'canci\u00f3n')
    .replace(/No se encontró|No se encontró/g, 'No se encontr\u00f3')
    .replace(/página/g, 'p\u00e1gina')
    .replace(/botón/g, 'bot\u00f3n');
}

function normalizeBrokenTextInNode(root) {
  if (!root || typeof root === 'string') return;

  if (root.nodeType === Node.TEXT_NODE) {
    const normalizedText = normalizeBrokenSpanishText(root.textContent);
    if (normalizedText !== root.textContent) {
      root.textContent = normalizedText;
    }
    return;
  }

  if (root.nodeType !== Node.ELEMENT_NODE) return;

  ['title', 'aria-label', 'placeholder'].forEach((attributeName) => {
    const value = root.getAttribute(attributeName);
    if (!value) return;

    const normalizedValue = normalizeBrokenSpanishText(value);
    if (normalizedValue !== value) {
      root.setAttribute(attributeName, normalizedValue);
    }
  });

  root.childNodes.forEach(normalizeBrokenTextInNode);
}

function patchNotificationSystemEncoding() {
  if (!window.notificationSystem || window.notificationSystem.__encodingPatched) return;

  ['success', 'error', 'warning', 'info'].forEach((method) => {
    if (typeof window.notificationSystem[method] !== 'function') return;

    const originalMethod = window.notificationSystem[method].bind(window.notificationSystem);
    window.notificationSystem[method] = (message, ...args) => {
      if (localStorage.getItem('notificationsEnabled') === 'false') return;
      originalMethod(normalizeBrokenSpanishText(message), ...args);
    };
  });

  window.notificationSystem.__encodingPatched = true;
}

function initializeTextEncodingGuards() {
  patchNotificationSystemEncoding();
  normalizeBrokenTextInNode(document.body);
  setTimeout(patchNotificationSystemEncoding, 0);

  if (window.__textEncodingObserverInitialized) return;

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === 'characterData') {
        normalizeBrokenTextInNode(mutation.target);
        return;
      }

      mutation.addedNodes.forEach(normalizeBrokenTextInNode);
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  window.__textEncodingObserverInitialized = true;
}

document.addEventListener('click', (event) => {
  const emptyUploadButton = event.target.closest('#myMusicContainer .empty-state .library-create-btn');
  if (!emptyUploadButton) return;

  event.preventDefault();
  openUploadPage();
});

// Cargar contenido de inicio
async function loadHomeContent() {
  try {
    console.log('Cargando contenido de inicio desde SQLite');
    await loadLibrary();
    const heroSubtitle = document.querySelector('.hero-subtitle');
    const heroVisualTitle = document.querySelector('.hero-visual-title');
    const heroVisualSubtitle = document.querySelector('.hero-visual-subtitle');
    const heroSearchLabel = document.querySelector('#heroSearchBtn span');
    const heroMyMusicLabel = document.querySelector('#heroMyMusicBtn span');
    if (heroSubtitle) heroSubtitle.textContent = 'Descubre tu próxima canción favorita';
    if (heroVisualTitle) heroVisualTitle.textContent = 'Accesos rápidos';
    if (heroVisualSubtitle) heroVisualSubtitle.textContent = 'Muévete entre búsqueda y tu música';
    if (heroSearchLabel) heroSearchLabel.textContent = 'Buscar música';
    if (heroMyMusicLabel) heroMyMusicLabel.textContent = 'Ir a Mi música';
    const homeData = await ipcRenderer.invoke('get-home-data');
    
    // Update stats in Hero section
    const totalSongs = document.getElementById('totalSongs');
    const totalPlaylists = document.getElementById('totalPlaylists');
    
    if (totalSongs) totalSongs.textContent = state.library ? state.library.length : 0;
    if (totalPlaylists) totalPlaylists.textContent = state.playlists ? state.playlists.length : 0;

    state.recentlyPlayed = mergeRecentTracks(homeData.recentlyPlayed || [], state.recentlyPlayed || []);
    localStorage.setItem('recentlyPlayed', JSON.stringify(state.recentlyPlayed));
    displayRecentlyPlayed(state.recentlyPlayed);
    displayRecommendations(homeData.recommendations || []);
    updateUserStats();
  } catch (error) {
    console.error('Error al cargar contenido de inicio:', error);
    displayRecentlyPlayed([]);
    displayRecommendations([]);
  }
}

function displayRecentlyPlayed(tracks) {
  const recentContainer = document.getElementById('recentTracks');
  const recentCount = document.getElementById('recentCount');
  
  if (!recentContainer) return;
  
  recentContainer.innerHTML = '';
  
  if (recentCount) {
      recentCount.textContent = `${tracks.length} canciones`;
  }
  
  if (recentCount) {
    recentCount.textContent = `${normalizedTracks.length} canciones`;
  }

  if (normalizedTracks.length === 0) {
    recentContainer.innerHTML = `
      <div class="empty-state" style="width: 100%; grid-column: 1/-1; text-align: center; padding: 2rem;">
        <i class="fas fa-history" style="font-size: 2rem; color: var(--text-secondary); margin-bottom: 1rem;"></i>
        <p style="color: var(--text-secondary);">No hay canciones reproducidas recientemente.</p>
      </div>
    `;
  } else {
    tracks.forEach(track => {
      const trackCard = createTrackCard(track);
      recentContainer.appendChild(trackCard);
    });
  }
  
  console.log('Mostrando canciones recientes:', tracks.length);
}

function displayRecommendations(tracks) {
  const recommendationsContainer = document.getElementById('recommendationsTracks');
  
  if (!recommendationsContainer) return;
  
  recommendationsContainer.innerHTML = '';
  
  if (tracks.length === 0) {
     // Si no hay recomendaciones, mostrar un mensaje o cargar defaults
     recommendationsContainer.innerHTML = `
      <div class="empty-state" style="width: 100%; grid-column: 1/-1; text-align: center; padding: 2rem;">
        <i class="fas fa-magic" style="font-size: 2rem; color: var(--text-secondary); margin-bottom: 1rem;"></i>
        <p style="color: var(--text-secondary);">Escucha música para recibir recomendaciones personalizadas.</p>
      </div>
    `;
  } else {
    tracks.forEach(track => {
      const trackCard = createTrackCard(track);
      recommendationsContainer.appendChild(trackCard);
    });
  }
  
  console.log('Mostrando recomendaciones:', tracks.length);
}

// Búsqueda mejorada
let searchTimeout;
let currentSearchFilter = 'all';
let currentSearchSort = ['relevance', 'duration', 'date'].includes(localStorage.getItem('searchSortMode'))
  ? localStorage.getItem('searchSortMode')
  : 'relevance';
let currentSearchView = localStorage.getItem('searchViewMode') || 'grid';
let activeSearchRequestId = 0;
let searchHistory = JSON.parse(localStorage.getItem('searchHistory') || '[]');

const SEARCH_TYPE_CONFIG = {
  song: { title: 'Canciones', label: 'Canción', icon: 'fas fa-music', order: 1 },
  playlist: { title: 'Playlists', label: 'Playlist', icon: 'fas fa-list-ul', order: 2 },
  recent: { title: 'Recientes', label: 'Reciente', icon: 'fas fa-clock-rotate-left', order: 3 }
};

const SEARCH_FILTER_TYPES = {
  all: ['song', 'playlist', 'recent'],
  songs: ['song'],
  playlists: ['playlist']
};

// Elementos de búsqueda
const searchElements = {
  searchInput: document.getElementById('searchInput'),
  searchResults: document.getElementById('searchResults'),
  searchSuggestions: document.getElementById('searchSuggestions'),
  suggestionsList: document.getElementById('suggestionsList'),
  searchClearBtn: document.getElementById('searchClearBtn'),
  clearHistoryBtn: document.getElementById('clearHistoryBtn'),
  searchState: document.getElementById('searchState'),
  searchResultsContainer: document.getElementById('searchResultsContainer'),
  searchResultsToolbar: document.getElementById('searchResultsToolbar'),
  searchResultsSummary: document.getElementById('searchResultsSummary'),
  searchResultsQuery: document.getElementById('searchResultsQuery'),
  searchSortSelect: document.getElementById('searchSortSelect'),
  searchGridViewBtn: document.getElementById('searchGridViewBtn'),
  searchListViewBtn: document.getElementById('searchListViewBtn'),
  searchLivePill: document.getElementById('searchLivePill'),
  searchRecentChips: document.getElementById('searchRecentChips'),
  searchQuickSuggestions: document.getElementById('searchQuickSuggestions')
};

// Inicializar funcionalidad de búsqueda
function initializeSearch() {
  if (!searchElements.searchInput) return;

  searchElements.searchInput.addEventListener('input', handleSearchInput);
  searchElements.searchInput.addEventListener('focus', () => {
    if (searchElements.searchInput.value.trim() && searchHistory.length > 0) showSuggestions();
  });

  searchElements.searchClearBtn?.addEventListener('click', clearSearch);
  searchElements.clearHistoryBtn?.addEventListener('click', clearSearchHistory);

  document.querySelectorAll('.search-filters .filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const filter = e.currentTarget.dataset.filter;
      setSearchFilter(filter);
    });
  });

  if (searchElements.searchSortSelect) {
    searchElements.searchSortSelect.value = currentSearchSort;
    searchElements.searchSortSelect.addEventListener('change', (event) => {
      currentSearchSort = event.target.value;
      localStorage.setItem('searchSortMode', currentSearchSort);
      if (state.searchResults.length > 0) {
        displaySearchResults(state.searchResults, { query: searchElements.searchInput.value.trim() });
      }
    });
  }

  searchElements.searchGridViewBtn?.addEventListener('click', () => setSearchView('grid'));
  searchElements.searchListViewBtn?.addEventListener('click', () => setSearchView('list'));

  document.querySelectorAll('[data-search-query]').forEach(button => {
    button.addEventListener('click', () => runSearchFromChip(button.dataset.searchQuery));
  });

  setSearchView(currentSearchView, false);
  renderSearchRecentChips();
  showSearchState();
}

function handleSearchInput(e) {
  const query = e.target.value.trim();
  searchElements.searchClearBtn.style.display = query ? 'flex' : 'none';
  setSearchLivePill(query ? 'typing' : 'ready', query ? 'Escribiendo' : 'Listo');

  clearTimeout(searchTimeout);

  if (query.length > 0) {
    if (searchHistory.length > 0) showSuggestions();
    searchTimeout = setTimeout(() => {
      performSearch(query);
    }, 300);
  } else {
    state.searchResults = [];
    hideSuggestions();
    showSearchState();
  }
}

async function performSearch(query) {
  const requestId = ++activeSearchRequestId;

  try {
    console.log(`Realizando búsqueda con: ${query}, filtro: ${currentSearchFilter}`);

    if (state.developerSettings.internetEnabled === false) {
      state.searchResults = [];
      hideSuggestions();
      showErrorState('Modo offline de desarrollo activo. Solo puedes usar cache o musica local.');
      return;
    }

    addToSearchHistory(query);
    renderSearchRecentChips();
    showLoadingState();

    const songs = await ipcRenderer.invoke('search-songs', query);
    if (requestId !== activeSearchRequestId) return;

    const songResults = (songs || []).map((song, index) => normalizeSongSearchResult(song, index));
    const results = buildSearchDataset(query, songResults);

    state.searchResults = results;
    displaySearchResults(results, { query });
    hideSuggestions();
    setSearchLivePill('ready', 'Listo');
  } catch (error) {
    if (requestId !== activeSearchRequestId) return;
    console.error('Error en la búsqueda:', error);
    showErrorState('Error al buscar. Inténtalo de nuevo.');
  }
}

function normalizeSongSearchResult(song, index = 0) {
  const id = song.id || song.video_id || song.url || `${song.title || 'song'}-${index}`;
  return {
    ...song,
    id,
    video_id: song.video_id || id,
    type: 'song',
    searchRank: index,
    searchedAt: Date.now(),
    thumbnail: song.thumbnail || song.cover || song.image,
    title: song.title || song.name || 'Sin título',
    artist: song.artist || 'Desconocido'
  };
}

function buildSearchDataset(query, songResults = []) {
  return [
    ...songResults,
    ...buildPlaylistSearchResults(query),
    ...buildRecentSearchResults(query)
  ];
}

function buildPlaylistSearchResults(query) {
  const normalizedQuery = normalizeSearchText(query);

  return (state.playlists || [])
    .filter(playlist => !normalizedQuery || normalizeSearchText(playlist.name || '').includes(normalizedQuery))
    .slice(0, 8)
    .map((playlist, index) => ({
      ...playlist,
      type: 'playlist',
      id: playlist.id,
      name: playlist.name || 'Playlist',
      title: playlist.name || 'Playlist',
      songsCount: playlist.songs?.length || playlist.songsCount || playlist.count || 0,
      searchRank: 30 + index
    }));
}

function buildRecentSearchResults(query) {
  const normalizedQuery = normalizeSearchText(query);

  return (state.recentlyPlayed || [])
    .filter(track => !normalizedQuery || matchesSearchQuery(track, normalizedQuery))
    .slice(0, 6)
    .map((track, index) => ({
      ...track,
      id: track.id || track.video_id || track.url || `recent-${index}`,
      video_id: track.video_id || track.id,
      type: 'recent',
      title: track.title || 'Sin título',
      artist: track.artist || 'Desconocido',
      thumbnail: track.thumbnail || track.cover || track.image,
      searchRank: 40 + index
    }));
}

function normalizeSearchText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function matchesSearchQuery(item, normalizedQuery) {
  if (!normalizedQuery) return true;
  return normalizeSearchText(`${item.title || item.name || ''} ${item.artist || ''}`).includes(normalizedQuery);
}

function displaySearchResults(results, options = {}) {
  if (!searchElements.searchResults) return;

  const query = options.query || searchElements.searchInput?.value.trim() || '';
  const filteredResults = getFilteredSearchResults(results);

  searchElements.searchResults.innerHTML = '';
  searchElements.searchResults.classList.toggle('is-list-view', currentSearchView === 'list');
  searchElements.searchResults.classList.toggle('is-grid-view', currentSearchView !== 'list');

  if (filteredResults.length === 0) {
    showNoResultsState(query);
    return;
  }

  searchElements.searchState.style.display = 'none';
  searchElements.searchResultsContainer.style.display = 'block';
  renderSearchToolbar(filteredResults, query);

  const groupedResults = groupResultsByType(filteredResults);
  getSearchSectionOrder(groupedResults).forEach(type => {
    const section = createResultsSection(type, sortSearchResults(groupedResults[type]));
    searchElements.searchResults.appendChild(section);
  });

  refreshSearchPlayingIndicators();
  console.log('Resultados de búsqueda mostrados:', filteredResults.length);
}

function getFilteredSearchResults(results = []) {
  const allowedTypes = SEARCH_FILTER_TYPES[currentSearchFilter] || SEARCH_FILTER_TYPES.all;
  return results.filter(result => allowedTypes.includes(result.type));
}

function sortSearchResults(results = []) {
  const sorted = [...results];

  sorted.sort((a, b) => {
    if (currentSearchSort === 'duration') {
      return getSearchDurationValue(b) - getSearchDurationValue(a) || (a.searchRank || 0) - (b.searchRank || 0);
    }

    if (currentSearchSort === 'date') {
      return getSearchDateValue(b) - getSearchDateValue(a) || (a.searchRank || 0) - (b.searchRank || 0);
    }

    return (a.searchRank || 0) - (b.searchRank || 0);
  });

  return sorted;
}

function getSearchDurationValue(result) {
  if (typeof result.duration === 'string' && result.duration.includes(':')) {
    const parts = result.duration.split(':').map(part => Number(part));
    return parts.reduce((total, part) => (total * 60) + (Number.isFinite(part) ? part : 0), 0);
  }

  const numericDuration = Number(result.duration || 0);
  return Number.isFinite(numericDuration) ? numericDuration : 0;
}

function getSearchDateValue(result) {
  const value = result.lastPlayed || result.added_at || result.dateAdded || result.searchedAt;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function groupResultsByType(results) {
  return results.reduce((grouped, result) => {
    const type = result.type || 'song';
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(result);
    return grouped;
  }, {});
}

function getSearchSectionOrder(groupedResults) {
  return Object.keys(groupedResults).sort((a, b) => {
    const orderA = SEARCH_TYPE_CONFIG[a]?.order || 99;
    const orderB = SEARCH_TYPE_CONFIG[b]?.order || 99;
    return orderA - orderB;
  });
}

function createResultsSection(type, results) {
  const section = document.createElement('section');
  section.className = 'results-section';
  section.dataset.type = type;

  const header = document.createElement('div');
  header.className = 'results-section-header';

  const title = document.createElement('h3');
  title.className = 'results-section-title';
  title.innerHTML = `<i class="${SEARCH_TYPE_CONFIG[type]?.icon || 'fas fa-search'}"></i><span>${getTypeTitle(type)}</span>`;
  header.appendChild(title);

  const count = document.createElement('span');
  count.className = 'results-section-count';
  count.textContent = `${results.length} ${results.length === 1 ? 'resultado' : 'resultados'}`;
  header.appendChild(count);

  section.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'search-results-grid';

  results.forEach(result => {
    grid.appendChild(createSearchResultCard(result));
  });

  section.appendChild(grid);
  return section;
}

function getTypeTitle(type) {
  return SEARCH_TYPE_CONFIG[type]?.title || 'Resultados';
}

function getTypeLabel(type) {
  return SEARCH_TYPE_CONFIG[type]?.label || 'Resultado';
}

function createSearchResultCard(result) {
  const card = document.createElement('article');
  card.className = `search-result-card search-result-${result.type || 'item'}`;
  card.tabIndex = 0;

  const resultId = getSearchResultId(result);
  if (resultId && isPlayableSearchResult(result)) {
    card.setAttribute('data-song-id', resultId);
  }

  const artwork = document.createElement('div');
  artwork.className = 'search-result-artwork';
  artwork.appendChild(createArtworkElement(
    getArtworkUrl(result.thumbnail, result.cover, result.image),
    result.title || result.name
  ));

  if (isPlayableSearchResult(result)) {
    const playOverlay = document.createElement('button');
    playOverlay.className = 'search-play-overlay';
    playOverlay.type = 'button';
    playOverlay.title = 'Reproducir';
    playOverlay.innerHTML = '<i class="fas fa-play"></i>';
    playOverlay.addEventListener('click', (event) => {
      event.stopPropagation();
      playSong(result);
    });
    artwork.appendChild(playOverlay);

    const nowPlayingBadge = document.createElement('span');
    nowPlayingBadge.className = 'search-playing-badge';
    nowPlayingBadge.innerHTML = '<i class="fas fa-volume-up"></i>';
    artwork.appendChild(nowPlayingBadge);
  }

  card.appendChild(artwork);

  const content = document.createElement('div');
  content.className = 'card-content';

  const type = document.createElement('span');
  type.className = 'card-type';
  type.textContent = getTypeLabel(result.type);
  content.appendChild(type);

  const title = document.createElement('h3');
  title.textContent = result.title || result.name || 'Sin título';
  title.title = title.textContent;
  content.appendChild(title);

  const subtitle = document.createElement('p');
  subtitle.textContent = getSearchSubtitle(result);
  subtitle.title = subtitle.textContent;
  content.appendChild(subtitle);

  const meta = createSearchMeta(result);
  if (meta) content.appendChild(meta);

  card.appendChild(content);

  const actions = createSearchActions(result);
  if (actions) card.appendChild(actions);

  card.addEventListener('click', (event) => {
    if (event.target.closest('button, a, select')) return;
    activateSearchResult(result);
  });

  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activateSearchResult(result);
    }
  });

  return card;
}

function createSearchMeta(result) {
  const metaItems = [];

  if (isPlayableSearchResult(result) && result.duration) {
    metaItems.push(`<span><i class="fas fa-clock"></i>${escapeLibraryHTML(formatTime(result.duration))}</span>`);
  }

  if (result.type === 'playlist') {
    metaItems.push(`<span><i class="fas fa-list-ul"></i>${result.songsCount || 0} canciones</span>`);
  }

  if (result.type === 'recent' && result.lastPlayed) {
    metaItems.push('<span><i class="fas fa-clock-rotate-left"></i>Reciente</span>');
  }

  if (metaItems.length === 0) return null;

  const meta = document.createElement('div');
  meta.className = 'search-result-meta';
  meta.innerHTML = metaItems.join('');
  return meta;
}

function createSearchActions(result) {
  const actions = document.createElement('div');
  actions.className = 'card-actions';

  if (isPlayableSearchResult(result)) {
    const playBtn = createSearchActionButton('search-action-btn play-now-btn', 'Reproducir', 'fas fa-play');
    playBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      playSong(result);
    });
    actions.appendChild(playBtn);

    const isFavorite = isFavoriteTrack(result);
    const favoriteBtn = createSearchActionButton(`favorite-btn search-action-btn ${isFavorite ? 'active' : ''}`, isFavorite ? 'Quitar de favoritos' : 'Agregar a favoritos', isFavorite ? 'fas fa-heart' : 'far fa-heart');
    favoriteBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      favoriteBtn.disabled = true;
      try {
        const wasFavorite = isFavoriteTrack(result);
        const success = await toggleFavorite(result);
        if (!success) updateFavoriteButton(getFavoriteTrackId(result), wasFavorite);
      } finally {
        favoriteBtn.disabled = false;
      }
    });
    actions.appendChild(favoriteBtn);

    const playlistBtn = createSearchActionButton('add-to-playlist search-action-btn', 'Agregar a playlist', 'fas fa-plus');
    playlistBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      showPlaylistSelector(result);
    });
    actions.appendChild(playlistBtn);

    const downloadBtn = createSearchActionButton('search-action-btn download-search-btn', 'Descargar', 'fas fa-download');
    downloadBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      prepareSearchDownload(result);
    });
    actions.appendChild(downloadBtn);
  } else {
    const openBtn = createSearchActionButton('search-action-btn open-search-btn', 'Abrir', 'fas fa-arrow-right');
    openBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      activateSearchResult(result);
    });
    actions.appendChild(openBtn);
  }

  const moreBtn = createSearchActionButton('search-action-btn more-search-btn', 'Más opciones', 'fas fa-ellipsis');
  moreBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    showSearchMoreOptions(result, moreBtn);
  });
  actions.appendChild(moreBtn);

  return actions;
}

function createSearchActionButton(className, title, iconClass) {
  const button = document.createElement('button');
  button.className = className;
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.innerHTML = `<i class="${iconClass}"></i>`;
  return button;
}

function getSearchSubtitle(result) {
  if (result.type === 'playlist') return `${result.songsCount || 0} canciones`;
  return result.artist || result.genre || '';
}

function isPlayableSearchResult(result) {
  return result?.type === 'song' || result?.type === 'recent';
}

function getSearchResultId(result) {
  return String(result?.video_id || result?.id || '');
}

function activateSearchResult(result) {
  if (isPlayableSearchResult(result)) {
    playSong(result);
  } else if (result.type === 'playlist') {
    openPlaylistSearchResult(result);
  }
}

function openPlaylistSearchResult(result) {
  if (result?.id && typeof loadPlaylistSongs === 'function') {
    showPage('library');
    loadPlaylistSongs(Number(result.id));
    return;
  }

  notificationSystem.info('Playlist lista para abrir cuando esté disponible en la biblioteca.');
}

async function prepareSearchDownload(result) {
  if (!result?.url) {
    notificationSystem.info('Descarga preparada para futuras fuentes compatibles.');
    return;
  }

  try {
    const cacheSettings = await ipcRenderer.invoke('get-cache-settings').catch(() => null);
    if (cacheSettings?.enabled) {
      notificationSystem.success('Descarga preparada: al reproducirla quedará guardada en caché offline.');
    } else {
      notificationSystem.info('Descarga directa no disponible todavía. Puedes activar caché offline para guardarla al reproducir.');
    }
  } catch (error) {
    console.warn('No se pudo consultar configuración de caché:', error);
    notificationSystem.info('Descarga preparada para cuando el backend dedicado esté disponible.');
  }
}

function showSearchMoreOptions(result, anchorButton) {
  document.querySelectorAll('.search-more-menu').forEach(menu => menu.remove());

  const card = anchorButton.closest('.search-result-card');
  if (!card) return;

  const menu = document.createElement('div');
  menu.className = 'search-more-menu';

  if (isPlayableSearchResult(result)) {
    const queueButton = document.createElement('button');
    queueButton.type = 'button';
    queueButton.innerHTML = '<i class="fas fa-list"></i><span>Agregar a cola</span>';
    queueButton.addEventListener('click', (event) => {
      event.stopPropagation();
      addToQueue(result);
      menu.remove();
    });
    menu.appendChild(queueButton);
  }

  if (result.url) {
    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.innerHTML = '<i class="fas fa-link"></i><span>Copiar enlace</span>';
    copyButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      await navigator.clipboard?.writeText(result.url).catch(() => {});
      notificationSystem.info('Enlace copiado');
      menu.remove();
    });
    menu.appendChild(copyButton);
  }

  if (!menu.children.length) {
    const emptyButton = document.createElement('button');
    emptyButton.type = 'button';
    emptyButton.innerHTML = '<i class="fas fa-info-circle"></i><span>Sin acciones extra</span>';
    menu.appendChild(emptyButton);
  }

  card.appendChild(menu);

  setTimeout(() => {
    const closeMenu = (event) => {
      if (!menu.contains(event.target) && event.target !== anchorButton) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    document.addEventListener('click', closeMenu);
  }, 0);
}

function renderSearchToolbar(results, query) {
  if (!searchElements.searchResultsToolbar) return;

  searchElements.searchResultsToolbar.style.display = 'flex';
  if (searchElements.searchResultsSummary) {
    searchElements.searchResultsSummary.textContent = `${results.length} ${results.length === 1 ? 'resultado encontrado' : 'resultados encontrados'}`;
  }
  if (searchElements.searchResultsQuery) {
    searchElements.searchResultsQuery.textContent = query ? `"${query}"` : '';
  }
}

// Gestión de filtros
function setSearchFilter(filter) {
  if (!SEARCH_FILTER_TYPES[filter]) return;
  currentSearchFilter = filter;

  document.querySelectorAll('.search-filters .filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });

  if (state.searchResults.length > 0) {
    displaySearchResults(state.searchResults, { query: searchElements.searchInput.value.trim() });
  }
}

function setSearchView(view, shouldRender = true) {
  currentSearchView = view === 'list' ? 'list' : 'grid';
  localStorage.setItem('searchViewMode', currentSearchView);

  searchElements.searchGridViewBtn?.classList.toggle('active', currentSearchView === 'grid');
  searchElements.searchListViewBtn?.classList.toggle('active', currentSearchView === 'list');
  searchElements.searchResults?.classList.toggle('is-list-view', currentSearchView === 'list');
  searchElements.searchResults?.classList.toggle('is-grid-view', currentSearchView !== 'list');

  if (shouldRender && state.searchResults.length > 0) {
    displaySearchResults(state.searchResults, { query: searchElements.searchInput.value.trim() });
  }
}

// Gestión de sugerencias
function showSuggestions() {
  if (!searchElements.suggestionsList || searchHistory.length === 0) return;

  searchElements.suggestionsList.innerHTML = '';

  searchHistory.slice(0, 6).forEach(query => {
    const item = document.createElement('button');
    item.className = 'suggestion-item';
    item.type = 'button';

    const icon = document.createElement('i');
    icon.className = 'fas fa-history';
    item.appendChild(icon);

    const text = document.createElement('span');
    text.className = 'suggestion-text';
    text.textContent = query;
    item.appendChild(text);

    item.addEventListener('click', () => runSearchFromChip(query));
    searchElements.suggestionsList.appendChild(item);
  });

  searchElements.searchSuggestions.style.display = 'block';
}

function hideSuggestions() {
  if (searchElements.searchSuggestions) searchElements.searchSuggestions.style.display = 'none';
}

function runSearchFromChip(query) {
  const safeQuery = String(query || '').trim();
  if (!safeQuery) return;

  searchElements.searchInput.value = safeQuery;
  searchElements.searchClearBtn.style.display = 'flex';
  hideSuggestions();
  performSearch(safeQuery);
}

function renderSearchRecentChips() {
  if (!searchElements.searchRecentChips) return;

  searchElements.searchRecentChips.innerHTML = '';

  if (searchHistory.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'search-chip-empty';
    empty.textContent = 'Tus búsquedas recientes aparecerán aquí';
    searchElements.searchRecentChips.appendChild(empty);
    return;
  }

  searchHistory.slice(0, 5).forEach(query => {
    const chip = document.createElement('button');
    chip.className = 'search-chip';
    chip.type = 'button';
    chip.textContent = query;
    chip.dataset.searchQuery = query;
    chip.addEventListener('click', () => runSearchFromChip(query));
    searchElements.searchRecentChips.appendChild(chip);
  });
}

function addToSearchHistory(query) {
  if (!query || query.length < 2) return;

  searchHistory = searchHistory.filter(item => item.toLowerCase() !== query.toLowerCase());
  searchHistory.unshift(query);
  searchHistory = searchHistory.slice(0, 10);
  localStorage.setItem('searchHistory', JSON.stringify(searchHistory));
}

function clearSearchHistory() {
  searchHistory = [];
  localStorage.removeItem('searchHistory');
  hideSuggestions();
  renderSearchRecentChips();
  notificationSystem.info('Historial de búsqueda vaciado');
}

function clearSearch() {
  activeSearchRequestId++;
  state.searchResults = [];
  searchElements.searchInput.value = '';
  searchElements.searchClearBtn.style.display = 'none';
  hideSuggestions();
  showSearchState();
}

// Estados de la interfaz
function showSearchState() {
  if (!searchElements.searchState || !searchElements.searchResultsContainer) return;

  searchElements.searchState.style.display = 'flex';
  searchElements.searchResultsContainer.style.display = 'none';
  if (searchElements.searchResultsToolbar) searchElements.searchResultsToolbar.style.display = 'none';
  if (searchElements.searchResults) searchElements.searchResults.innerHTML = '';
  renderSearchRecentChips();
  setSearchLivePill('ready', 'Listo');
}

function showLoadingState() {
  setSearchLivePill('loading', 'Buscando');
  searchElements.searchState.style.display = 'none';
  searchElements.searchResultsContainer.style.display = 'block';
  if (searchElements.searchResultsToolbar) searchElements.searchResultsToolbar.style.display = 'none';
  searchElements.searchResults.classList.remove('is-list-view');
  searchElements.searchResults.innerHTML = `
    <div class="search-loading-shell">
      <div class="loading-state">
        <div class="loading-spinner"></div>
        <p>Buscando...</p>
      </div>
      <div class="search-skeleton-grid" aria-hidden="true">
        ${Array.from({ length: 8 }).map(() => `
          <div class="search-skeleton-card">
            <span></span>
            <strong></strong>
            <em></em>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function showNoResultsState(query = '') {
  searchElements.searchState.style.display = 'none';
  searchElements.searchResultsContainer.style.display = 'block';
  if (searchElements.searchResultsToolbar) searchElements.searchResultsToolbar.style.display = 'none';
  setSearchLivePill('empty', 'Sin resultados');
  searchElements.searchResults.innerHTML = `
    <div class="no-results-state">
      <div class="search-state-icon"><i class="fas fa-search"></i></div>
      <h3>No se encontraron resultados</h3>
      <p>Intenta con otros términos de búsqueda${query ? ` para "${escapeLibraryHTML(query)}"` : ''}</p>
      <div class="search-chip-list centered">
        <button class="search-chip" type="button" data-search-query="lofi">lofi</button>
        <button class="search-chip" type="button" data-search-query="pop latino">pop latino</button>
        <button class="search-chip" type="button" data-search-query="indie">indie</button>
      </div>
    </div>
  `;

  searchElements.searchResults.querySelectorAll('[data-search-query]').forEach(button => {
    button.addEventListener('click', () => runSearchFromChip(button.dataset.searchQuery));
  });
}

function showErrorState(message) {
  searchElements.searchState.style.display = 'none';
  searchElements.searchResultsContainer.style.display = 'block';
  if (searchElements.searchResultsToolbar) searchElements.searchResultsToolbar.style.display = 'none';
  setSearchLivePill('error', 'Error');
  searchElements.searchResults.innerHTML = `
    <div class="error-state">
      <div class="search-state-icon error"><i class="fas fa-exclamation-triangle"></i></div>
      <h3>Error</h3>
      <p>${escapeLibraryHTML(message)}</p>
      <button class="search-retry-btn" type="button">Reintentar</button>
    </div>
  `;

  searchElements.searchResults.querySelector('.search-retry-btn')?.addEventListener('click', () => {
    const query = searchElements.searchInput.value.trim();
    if (query) performSearch(query);
  });
}

function setSearchLivePill(status, text) {
  if (!searchElements.searchLivePill) return;
  searchElements.searchLivePill.dataset.state = status;
  searchElements.searchLivePill.innerHTML = `<span></span>${escapeLibraryHTML(text)}`;
}

function refreshSearchPlayingIndicators() {
  const currentId = String(state.currentTrack?.id || state.currentTrack?.video_id || '');

  document.querySelectorAll('.search-result-card[data-song-id]').forEach(card => {
    const isCurrent = currentId && card.getAttribute('data-song-id') === currentId;
    card.classList.toggle('is-playing', !!isCurrent);
    if (isCurrent) {
      card.setAttribute('aria-current', state.isPlaying ? 'true' : 'false');
    } else {
      card.removeAttribute('aria-current');
    }
  });
}

function addToQueue(song) {
  console.log('Agregando canción a cola:', song);
  // Implementar lógica para agregar a cola
  if (song && song.id) {
    // Agregar a la cola de reproducción
    state.queue.push(song);
    updateQueueDisplay();
    notificationSystem.info('Canción agregada a la cola');
  }
}

function getFavoriteTrackId(trackOrId) {
  if (trackOrId === null || trackOrId === undefined) return '';
  if (typeof trackOrId === 'string' || typeof trackOrId === 'number') return String(trackOrId);
  return String(trackOrId.video_id || trackOrId.id || trackOrId.url || '');
}

function isFavoriteTrack(trackOrId) {
  const trackId = getFavoriteTrackId(trackOrId);
  if (!trackId) return false;
  return (state.favorites || []).some(favorite => getFavoriteTrackId(favorite) === trackId);
}

function findKnownTrackById(trackId) {
  const collections = [
    state.searchResults,
    state.library,
    state.favorites,
    state.recentlyPlayed,
    state.currentPlaylist,
    state.queue,
    state.currentTrack ? [state.currentTrack] : []
  ];

  for (const collection of collections) {
    if (!Array.isArray(collection)) continue;
    const track = collection.find(item => getFavoriteTrackId(item) === trackId);
    if (track) return track;
  }

  return null;
}

function normalizeFavoritePayload(trackOrId) {
  const trackId = getFavoriteTrackId(trackOrId);
  if (!trackId) return null;

  const source = typeof trackOrId === 'object' && trackOrId
    ? trackOrId
    : findKnownTrackById(trackId) || {};

  return {
    ...source,
    id: trackId,
    video_id: source.video_id || trackId,
    title: source.title || source.name || 'Sin título',
    artist: source.artist || 'Artista desconocido',
    thumbnail: getArtworkUrl(source.thumbnail, source.cover, source.image),
    url: source.url || '',
    duration: source.duration || 0
  };
}

async function toggleFavorite(song) {
  const favoriteTrack = normalizeFavoritePayload(song);
  if (!favoriteTrack) return false;

  const favoriteId = getFavoriteTrackId(favoriteTrack);
  const wasFavorite = isFavoriteTrack(favoriteTrack);
  const success = wasFavorite
    ? await removeFromFavorites(favoriteId)
    : await addToFavorites(favoriteTrack);

  if (!success) return false;

  updateFavoriteButton(favoriteId, !wasFavorite);
  notificationSystem.info(wasFavorite
    ? `${favoriteTrack.title} eliminado de favoritos`
    : `${favoriteTrack.title} añadido a favoritos`);
  return true;
}

function updateFavoriteButton(songId, isFavorite) {
  document.querySelectorAll('.search-result-card[data-song-id]').forEach(card => {
    if (card.getAttribute('data-song-id') !== String(songId)) return;
    const favoriteBtn = card.querySelector('.favorite-btn');
    if (!favoriteBtn) return;
    favoriteBtn.classList.toggle('active', isFavorite);
    favoriteBtn.innerHTML = isFavorite ? '<i class="fas fa-heart"></i>' : '<i class="far fa-heart"></i>';
    favoriteBtn.title = isFavorite ? 'Quitar de favoritos' : 'Agregar a favoritos';
    favoriteBtn.setAttribute('aria-label', favoriteBtn.title);
  });
}

function showPlaylistModal(song) {
  // Crear modal para seleccionar playlist
  const modal = document.createElement('div');
  modal.className = 'playlist-modal';
  modal.innerHTML = `
    <div class="modal-content">
      <h3>Agregar a Playlist</h3>
      <p>Selecciona una playlist para agregar "${song.title}"</p>
      <ul id="playlistList">
        ${state.playlists.map(playlist => `
          <li>
            <button onclick="addToPlaylist('${playlist.id}', '${song.id}')">
              <i class="fas fa-music"></i> ${playlist.name}
            </button>
          </li>
        `).join('')}
      </ul>
      <button class="close-modal">Cancelar</button>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Event listener para cerrar modal
  modal.querySelector('.close-modal').addEventListener('click', () => {
    document.body.removeChild(modal);
  });
  
  // Cerrar modal al hacer clic fuera
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      document.body.removeChild(modal);
    }
  });
}

function addToPlaylist(playlistId, songId) {
  const playlist = state.playlists.find(p => p.id === playlistId);
  const song = state.searchResults.find(s => s.id === songId);
  
  if (playlist && song) {
    if (!playlist.songs) {
      playlist.songs = [];
    }
    
    // Verificar si la canción ya está en la playlist
    const exists = playlist.songs.some(s => s.id === songId);
    if (!exists) {
      playlist.songs.push(song);
      saveState();
      notificationSystem.info(`Agregado a "${playlist.name}"`);
    } else {
      notificationSystem.info('La canción ya está en esta playlist');
    }
  }
  
  // Cerrar modal
  const modal = document.querySelector('.playlist-modal');
  if (modal) {
    document.body.removeChild(modal);
  }
}

// Función showNotification removida - se usa notificationSystem directamente

function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}

// Inicializar búsqueda cuando se carga la página
initializeSearch();

// Inicializar página de inicio
function initializeHomePage() {
  // Cargar estadísticas del usuario
  loadUserStats();
  
  // Cargar contenido de la página de inicio
  loadHomeContent();
  
  // Inicializar event listeners
  initializeHomeEventListeners();
  
  // Inicializar visualizador de música
  initializeMusicVisualizer();
  
  // Cargar recomendaciones
  loadRecommendations();
}

function loadUserStats() {
  // Calcular estadísticas del usuario
  const totalSongs = state.library.length;
  const totalPlaylists = state.playlists.length;
  
  // Actualizar UI
  const songsElement = document.getElementById('totalSongs');
  const playlistsElement = document.getElementById('totalPlaylists');
  
  if (songsElement) animateNumber(songsElement, totalSongs);
  if (playlistsElement) animateNumber(playlistsElement, totalPlaylists);
  
  // Guardar estadísticas para actualización posterior
  state.userStats = {
    totalSongs,
    totalPlaylists
  };
}

function updateUserStats() {
  // Recalcular estadísticas
  const totalSongs = state.library.length;
  const totalPlaylists = state.playlists.length;
  
  // Actualizar UI si los elementos existen
  const songsElement = document.getElementById('totalSongs');
  const playlistsElement = document.getElementById('totalPlaylists');
  
  if (songsElement && songsElement.textContent !== totalSongs.toString()) {
    animateNumber(songsElement, totalSongs);
  }
  if (playlistsElement && playlistsElement.textContent !== totalPlaylists.toString()) {
    animateNumber(playlistsElement, totalPlaylists);
  }
  
  // Actualizar estadísticas guardadas
  state.userStats = {
    totalSongs,
    totalPlaylists
  };
}

function animateNumber(element, targetNumber) {
  const duration = 2000;
  const startTime = performance.now();
  const startNumber = 0;
  
  function updateNumber(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const easeOut = 1 - Math.pow(1 - progress, 3);
    const currentNumber = Math.floor(startNumber + (targetNumber - startNumber) * easeOut);
    
    element.textContent = currentNumber.toLocaleString();
    
    if (progress < 1) {
      requestAnimationFrame(updateNumber);
    }
  }
  
  requestAnimationFrame(updateNumber);
}

function loadHomeContent() {
  const heroSubtitle = document.querySelector('.hero-subtitle');
  const heroVisualTitle = document.querySelector('.hero-visual-title');
  const heroVisualSubtitle = document.querySelector('.hero-visual-subtitle');
  const heroSearchLabel = document.querySelector('#heroSearchBtn span');
  const heroMyMusicLabel = document.querySelector('#heroMyMusicBtn span');
  if (heroSubtitle) heroSubtitle.textContent = 'Descubre tu próxima canción favorita';
  if (heroVisualTitle) heroVisualTitle.textContent = 'Accesos rápidos';
  if (heroVisualSubtitle) heroVisualSubtitle.textContent = 'Muévete entre búsqueda y tu música';
  if (heroSearchLabel) heroSearchLabel.textContent = 'Buscar música';
  if (heroMyMusicLabel) heroMyMusicLabel.textContent = 'Ir a Mi música';

  // Cargar canciones recientes
  displayRecentlyPlayed(state.recentlyPlayed || []);
  
  // Cargar recomendaciones
  displayRecommendations(state.recommendations || []);
  
  // Actualizar contadores
  updateSectionCounters();
  updateUserStats();
}

function initializeHomeEventListeners() {
  // Botón de reproducción aleatoria
  const shufflePlayBtn = document.getElementById('shufflePlayBtn');
  
  if (shufflePlayBtn) {
    shufflePlayBtn.addEventListener('click', () => {
      shufflePlay();
    });
  }
  
  // Botón de actualizar recomendaciones
  const refreshRecommendationsBtn = document.getElementById('refreshRecommendationsBtn');
  const heroSearchBtn = document.getElementById('heroSearchBtn');
  const heroMyMusicBtn = document.getElementById('heroMyMusicBtn');
  
  if (refreshRecommendationsBtn) {
    refreshRecommendationsBtn.addEventListener('click', () => {
      loadRecommendations();
      notificationSystem.info('Recomendaciones actualizadas');
    });
  }

  if (heroSearchBtn && !heroSearchBtn.dataset.bound) {
    heroSearchBtn.dataset.bound = 'true';
    heroSearchBtn.addEventListener('click', () => showPage('search'));
  }

  if (heroMyMusicBtn && !heroMyMusicBtn.dataset.bound) {
    heroMyMusicBtn.dataset.bound = 'true';
    heroMyMusicBtn.addEventListener('click', () => showPage('mymusic'));
  }
}

function initializeMusicVisualizer() {
  const visualizer = document.getElementById('homeVisualizer');
  if (!visualizer) return;
  
  // Animar las barras del visualizador
  const bars = visualizer.querySelectorAll('.visualizer-bar, .home-signal span');
  
  function animateBars() {
    bars.forEach((bar, index) => {
      const randomHeight = Math.random() * 80 + 20;
      bar.style.height = `${randomHeight}px`;
    });
  }
  
  // Animar cada 200ms
  setInterval(animateBars, 200);
}

function loadRecommendations() {
  // Simular carga de recomendaciones más realistas
  let recommendations = [
    {
      id: 'rec1',
      title: 'Blinding Lights',
      artist: 'The Weeknd',
      thumbnail: 'https://i.ytimg.com/vi/4NRXx6U8ABQ/maxresdefault.jpg',
      duration: '3:20',
      genre: 'Pop'
    },
    {
      id: 'rec2',
      title: 'Levitating',
      artist: 'Dua Lipa',
      thumbnail: 'https://i.ytimg.com/vi/TUVcZfQe-Kw/maxresdefault.jpg',
      duration: '3:23',
      genre: 'Pop'
    },
    {
      id: 'rec3',
      title: 'Good 4 U',
      artist: 'Olivia Rodrigo',
      thumbnail: 'https://i.ytimg.com/vi/gNi_6U5Pm_o/maxresdefault.jpg',
      duration: '2:58',
      genre: 'Pop Rock'
    },
    {
      id: 'rec4',
      title: 'Industry Baby',
      artist: 'Lil Nas X',
      thumbnail: 'https://i.ytimg.com/vi/UTHLKHL_whs/maxresdefault.jpg',
      duration: '3:32',
      genre: 'Hip Hop'
    },
    {
      id: 'rec5',
      title: 'Stay',
      artist: 'The Kid LAROI & Justin Bieber',
      thumbnail: 'https://i.ytimg.com/vi/kTJczUoc26U/maxresdefault.jpg',
      duration: '2:21',
      genre: 'Pop'
    },
    {
      id: 'rec6',
      title: 'Heat Waves',
      artist: 'Glass Animals',
      thumbnail: 'https://i.ytimg.com/vi/mRD0-GxqHVo/maxresdefault.jpg',
      duration: '3:58',
      genre: 'Indie Pop'
    },
    {
      id: 'rec7',
      title: 'As It Was',
      artist: 'Harry Styles',
      thumbnail: 'https://i.ytimg.com/vi/H5v3kku4y6Q/maxresdefault.jpg',
      duration: '2:47',
      genre: 'Pop'
    },
    {
      id: 'rec8',
      title: 'Save Your Tears',
      artist: 'The Weeknd',
      thumbnail: 'https://i.ytimg.com/vi/XXYlFuWEuKI/maxresdefault.jpg',
      duration: '3:35',
      genre: 'Synth-pop'
    }
  ];
  
  // Mezclar aleatoriamente las recomendaciones
  recommendations = recommendations.sort(() => Math.random() - 0.5);
  
  state.recommendations = recommendations.slice(0, 6);
  displayRecommendations(state.recommendations);
}

// Version nueva: usa recomendaciones reales del backend basadas en historial y afinidad.
function loadRecommendations() {
  ipcRenderer.invoke('get-home-data')
    .then((homeData) => {
      state.recommendations = homeData?.recommendations || [];
      displayRecommendations(state.recommendations);
    })
    .catch((error) => {
      console.error('Error cargando recomendaciones reales:', error);
      state.recommendations = [];
      displayRecommendations([]);
    });
}


// Funciones eliminadas - ya no se necesitan

function displayRecentlyPlayed(tracks) {
  const container = document.getElementById('recentTracks');
  const recentCount = document.getElementById('recentCount');
  const recentHeroCount = document.getElementById('recentHeroCount');
  if (!container) return;
  
  container.innerHTML = '';
  const normalizedTracks = mergeRecentTracks(tracks || []);
  
  if (tracks.length === 0) {
    if (recentCount) recentCount.textContent = '0 canciones';
    if (recentHeroCount) recentHeroCount.textContent = '0';
    container.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-clock"></i>
        <h3>No hay canciones recientes</h3>
        <p>Reproduce algunas canciones para verlas aquí</p>
      </div>
    `;
    return;
  }
  
  // Mostrar máximo 6 canciones recientes
  const recentTracks = normalizedTracks;
  if (recentCount) recentCount.textContent = `${recentTracks.length} canciones`;
  if (recentHeroCount) recentHeroCount.textContent = String(recentTracks.length);
  
  recentTracks.forEach((track, index) => {
    const trackCard = createRecentTrackCard(track, index);
    container.appendChild(trackCard);
  });
}

function createRecentTrackCard(track, index = 0) {
  const card = document.createElement('div');
  card.className = 'recent-track-card';
  
  const playedDate = getRecentTrackDate(track);
  const timeAgo = getTimeAgo(playedDate || new Date());
  const sourceLabel = track.isLocal ? 'Local' : (track.artist === 'Modo offline' ? 'Caché' : 'Streaming');
  
  card.innerHTML = `
    <div class="recent-track-head">
      <span class="recent-track-order">#${String(index + 1).padStart(2, '0')}</span>
      <span class="recent-track-badge">${sourceLabel}</span>
    </div>
    <div class="recent-track-info">
      ${getArtworkMarkup(getArtworkUrl(track.thumbnail, track.cover), track.title, 'recent-track-image')}
      <div class="recent-track-details">
        <h3 title="${track.title}">${track.title}</h3>
        <p title="${track.artist || 'Desconocido'}">${track.artist || 'Desconocido'}</p>
      </div>
    </div>
    <div class="recent-track-meta">
      <span class="recent-track-time">Hace ${timeAgo}</span>
      <span class="recent-track-date">${playedDate ? playedDate.toLocaleDateString() : ''}</span>
    </div>
  `;
  
  card.addEventListener('click', () => {
    playSong(track);
  });
  
  return card;
}

function getRecentTrackDate(track) {
  const rawValue = track?.played_at || track?.lastPlayed || track?.added_at;
  if (!rawValue) return null;
  const parsedDate = rawValue instanceof Date ? rawValue : new Date(rawValue);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

function mergeRecentTracks(...trackGroups) {
  const merged = [];
  const seen = new Set();

  trackGroups.flat().forEach((track) => {
    if (!track) return;
    const key = track.video_id || track.id || `${track.title}-${track.artist}`;
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push({
      ...track,
      id: track.id || track.video_id,
      video_id: track.video_id || track.id,
      lastPlayed: track.lastPlayed || track.played_at || track.added_at || null
    });
  });

  return merged.sort((a, b) => {
    const aTime = getRecentTrackDate(a)?.getTime() || 0;
    const bTime = getRecentTrackDate(b)?.getTime() || 0;
    return bTime - aTime;
  });
}

function displayRecommendations(recommendations) {
  const container = document.getElementById('recommendationsTracks');
  if (!container) return;
  
  container.innerHTML = '';
  
  recommendations.forEach(rec => {
    const recCard = createRecommendationCard(rec);
    container.appendChild(recCard);
  });
}

function createRecommendationCard(recommendation) {
  const card = document.createElement('div');
  card.className = 'recommendation-card';
  
  card.innerHTML = `
    ${getArtworkMarkup(recommendation.thumbnail, recommendation.title, 'recommendation-image')}
    <div class="recommendation-info">
      <h3>${recommendation.title}</h3>
      <p>${recommendation.artist} ? ${recommendation.genre}</p>
    </div>
  `;
  
  card.addEventListener('click', async () => {
    let videoId = recommendation.id || recommendation.video_id;
    let url = recommendation.url;
    const valid = videoId && /^[a-zA-Z0-9-_]{11}$/.test(videoId);
    const hasUrl = url && /^https?:\/\//.test(url);
    if (!valid || !hasUrl) {
      try {
        if (state.developerSettings.internetEnabled === false) {
          throw new Error('offline');
        }
        const query = [recommendation.title, recommendation.artist].filter(Boolean).join(' ');
        const results = await ipcRenderer.invoke('search-songs', query);
        if (results && results.length > 0) {
          const first = results[0];
          videoId = first.id;
          url = first.url;
          recommendation.video_id = videoId;
          recommendation.url = url;
          recommendation.thumbnail = recommendation.thumbnail || first.thumbnail;
          recommendation.artist = recommendation.artist || first.artist;
          recommendation.duration = recommendation.duration || first.duration;
        }
      } catch (e) {}
    }
    if (!url && !(videoId && /^[a-zA-Z0-9-_]{11}$/.test(videoId))) {
      notificationSystem.info('No se pudo encontrar una fuente para esta recomendación');
      return;
    }
    const mockTrack = {
      id: videoId,
      title: recommendation.title,
      artist: recommendation.artist,
      thumbnail: recommendation.thumbnail,
      duration: recommendation.duration,
      url: url || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : null),
      isLocal: false
    };
    playSong(mockTrack);
  });
  
  return card;
}

function displayRecentlyPlayed(tracks) {
  const container = document.getElementById('recentTracks');
  const recentCount = document.getElementById('recentCount');
  const recentHeroCount = document.getElementById('recentHeroCount');
  if (!container) return;

  container.innerHTML = '';
  const normalizedTracks = mergeRecentTracks(tracks || []);

  if (normalizedTracks.length === 0) {
    if (recentCount) recentCount.textContent = '0 canciones';
    if (recentHeroCount) recentHeroCount.textContent = '0';
    container.innerHTML = `
      <div class="home-empty-state">
        <i class="fas fa-clock"></i>
        <h3>Sin actividad reciente</h3>
        <p>Cuando reproduzcas canciones, aparecerán aquí para continuar rápido.</p>
      </div>
    `;
    return;
  }

  if (recentCount) recentCount.textContent = `${normalizedTracks.length} canciones`;
  if (recentHeroCount) recentHeroCount.textContent = String(normalizedTracks.length);

  normalizedTracks.slice(0, 12).forEach((track, index) => {
    container.appendChild(createRecentTrackCard(track, index));
  });
}

function createRecentTrackCard(track, index = 0) {
  const card = document.createElement('div');
  card.className = 'recent-track-card';
  const playedDate = getRecentTrackDate(track);
  const timeAgo = getTimeAgo(playedDate || new Date());
  const sourceLabel = track.isLocal ? 'Local' : (track.artist === 'Modo offline' ? 'Caché' : 'Streaming');

  card.innerHTML = `
    <span class="recent-track-order">${String(index + 1).padStart(2, '0')}</span>
    <div class="recent-track-art">
      ${getArtworkMarkup(getArtworkUrl(track.thumbnail, track.cover), track.title, 'recent-track-image')}
      <span class="recent-track-play"><i class="fas fa-play"></i></span>
    </div>
    <div class="recent-track-details">
      <h3 title="${track.title}">${track.title}</h3>
      <p title="${track.artist || 'Desconocido'}">${track.artist || 'Desconocido'}</p>
    </div>
    <div class="recent-track-meta">
      <span class="recent-track-badge">${sourceLabel}</span>
      <span class="recent-track-time">Hace ${timeAgo}</span>
    </div>
  `;

  card.addEventListener('click', () => playSong(track));
  return card;
}

function displayRecommendations(recommendations) {
  const container = document.getElementById('recommendationsTracks');
  if (!container) return;
  container.innerHTML = '';

  if (!recommendations || recommendations.length === 0) {
    container.innerHTML = `
      <div class="home-empty-state compact">
        <i class="fas fa-magic"></i>
        <h3>Sin recomendaciones</h3>
        <p>Escucha algunas canciones para afinar tus sugerencias.</p>
      </div>
    `;
    return;
  }

  recommendations.slice(0, 8).forEach((recommendation, index) => {
    const recCard = createRecommendationCard(recommendation);
    recCard.style.setProperty('--rec-index', index);
    container.appendChild(recCard);
  });
}

function createRecommendationCard(recommendation) {
  const card = document.createElement('div');
  card.className = 'recommendation-card';

  card.innerHTML = `
    <div class="recommendation-art">
      ${getArtworkMarkup(recommendation.thumbnail, recommendation.title, 'recommendation-image')}
      <span><i class="fas fa-play"></i></span>
    </div>
    <div class="recommendation-info">
      <h3>${recommendation.title}</h3>
      <p>${[recommendation.artist, recommendation.genre].filter(Boolean).join(' · ') || 'Nueva recomendación'}</p>
    </div>
    <i class="fas fa-chevron-right recommendation-arrow"></i>
  `;

  card.addEventListener('click', async () => {
    let videoId = recommendation.id || recommendation.video_id;
    let url = recommendation.url;
    const valid = videoId && /^[a-zA-Z0-9-_]{11}$/.test(videoId);
    const hasUrl = url && /^https?:\/\//.test(url);
    if (!valid || !hasUrl) {
      try {
        if (state.developerSettings.internetEnabled === false) throw new Error('offline');
        const query = [recommendation.title, recommendation.artist].filter(Boolean).join(' ');
        const results = await ipcRenderer.invoke('search-songs', query);
        if (results && results.length > 0) {
          const first = results[0];
          videoId = first.id;
          url = first.url;
          recommendation.video_id = videoId;
          recommendation.url = url;
          recommendation.thumbnail = recommendation.thumbnail || first.thumbnail;
          recommendation.artist = recommendation.artist || first.artist;
          recommendation.duration = recommendation.duration || first.duration;
        }
      } catch (e) {}
    }
    if (!url && !(videoId && /^[a-zA-Z0-9-_]{11}$/.test(videoId))) {
      notificationSystem.info('No se pudo encontrar una fuente para esta recomendacion');
      return;
    }
    playSong({
      id: videoId,
      title: recommendation.title,
      artist: recommendation.artist,
      thumbnail: recommendation.thumbnail,
      duration: recommendation.duration,
      url: url || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : null),
      isLocal: false
    });
  });

  return card;
}

// Funciones eliminadas - ya no se necesitan

function shufflePlay() {
  if (state.library.length === 0) {
    notificationSystem.info('No hay música en tu biblioteca');
    return;
  }
  
  // Seleccionar canción aleatoria
  const randomIndex = Math.floor(Math.random() * state.library.length);
  const randomSong = state.library[randomIndex];
  
  // Reproducir canción
  playSong(randomSong);
  notificationSystem.info(`Reproduciendo: ${randomSong.title}`);
}

function switchToPage(pageName) {
  // Ocultar todas las páginas
  document.querySelectorAll('.page').forEach(page => {
    page.classList.remove('active');
  });
  
  // Mostrar página seleccionada
  const targetPage = document.getElementById(pageName);
  if (targetPage) {
    targetPage.classList.add('active');
  }
  
  // Actualizar navegación
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.remove('active');
  });
  
  const activeLink = document.querySelector(`[data-page="${pageName}"]`);
  if (activeLink) {
    activeLink.classList.add('active');
  }
}

function updateSectionCounters() {
  // Actualizar contador de canciones recientes
  const recentCount = document.getElementById('recentCount');
  if (recentCount) {
    const count = state.recentlyPlayed ? state.recentlyPlayed.length : 0;
    recentCount.textContent = `${count} canciones`;
  }
}

function getTimeAgo(date) {
  const now = new Date();
  const pastDate = new Date(date);
  const diffInSeconds = Math.floor((now - pastDate) / 1000);
  
  if (isNaN(diffInSeconds)) return 'un momento';
  
  if (diffInSeconds < 60) {
    return 'unos segundos';
  } else if (diffInSeconds < 3600) {
    const minutes = Math.floor(diffInSeconds / 60);
    return `${minutes} minuto${minutes > 1 ? 's' : ''}`;
  } else if (diffInSeconds < 86400) {
    const hours = Math.floor(diffInSeconds / 3600);
    return `${hours} hora${hours > 1 ? 's' : ''}`;
  } else {
    const days = Math.floor(diffInSeconds / 86400);
    return `${days} día${days > 1 ? 's' : ''}`;
  }
}

// Inicializar página de inicio
initializeHomePage();

// Inicializar página de biblioteca
function loadMyMusicPage() {
  console.log('Cargando página Mi Música');
  
  // Recargar la biblioteca antes de mostrar Mi Música
  loadLibrary().then(() => {
    console.log('Biblioteca recargada, cargando página Mi Música');
    loadMyMusicContent();
  });
}

function loadMyMusicContent() {
  const container = document.getElementById('myMusicContainer');
  if (!container) {
    console.error('No se encontró el contenedor myMusicContainer');
    return;
  }
  
  console.log('Contenedor encontrado:', container);
  console.log('Cargando Mi Música. Total de canciones en biblioteca:', state.library.length);
  console.log('Biblioteca actual:', state.library);
  
  // Limpiar contenido anterior
  container.innerHTML = '';
  
  if (state.library.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1; text-align: center; padding: 3rem 2rem; color: var(--text-secondary); position: relative; z-index: 2;">
        <i class="fas fa-music" style="font-size: 3rem; color: var(--primary-color); margin-bottom: 1.5rem; display: block; text-shadow: 0 4px 8px rgba(29, 185, 84, 0.2);"></i>
        <h3 style="color: var(--text-primary); margin-bottom: 1rem; font-size: 1.5rem; font-weight: 700;">No hay música local subida</h3>
        <p style="margin-bottom: 1.5rem; font-size: 1rem; opacity: 0.8;">Sube música local para verla aquí</p>
        <button class="library-create-btn" onclick="document.querySelector('[data-page=\"upload\"]').click()" style="padding: 0.75rem 1.5rem; font-size: 0.9rem; border-radius: 25px; background: var(--primary-color); border: none; color: white; cursor: pointer; transition: all 0.3s ease; box-shadow: 0 4px 15px rgba(29, 185, 84, 0.2);">
          <i class="fas fa-upload"></i>
          Subir Música
        </button>
      </div>
    `;
    return;
  }
  
  // Actualizar contadores
  const myMusicTotalSongs = document.getElementById('myMusicTotalSongs');
  
  if (myMusicTotalSongs) {
    myMusicTotalSongs.textContent = `${state.library.length} canción${state.library.length > 1 ? 'es' : ''}`;
  }
  
  // Crear y agregar tarjetas
  state.library.forEach((song, index) => {
    console.log(`Creando card ${index + 1} para canción:`, song.title);
    
    setTimeout(() => {
      const myMusicCard = createMyMusicCard(song);
      myMusicCard.style.opacity = '0';
      myMusicCard.style.transform = 'translateY(20px)';
      container.appendChild(myMusicCard);
      
      // Animar la aparición
      setTimeout(() => {
        myMusicCard.style.transition = 'all 0.4s ease';
        myMusicCard.style.opacity = '1';
        myMusicCard.style.transform = 'translateY(0)';
      }, 100);
      
      console.log(`Card ${index + 1} agregada al contenedor. Contenedor ahora tiene ${container.children.length} elementos`);
    }, index * 80);
  });
  
  console.log('Contenedor final:', container);
  console.log('HTML del contenedor:', container.innerHTML);
  console.log('Número de elementos hijos:', container.children.length);
}

function createLocalMusicCard(song) {
  const card = document.createElement('div');
  card.className = 'local-music-card';
  
  // Asegurar que tenemos datos vélidos
  const title = song.title || 'Título desconocido';
  const artist = song.artist || 'Artista desconocido';
  const thumbnail = getArtworkUrl(song.thumbnail, song.cover);
  
  // Forzar estilos para asegurar visibilidad
  card.style.cssText = `
    background: linear-gradient(135deg, var(--background-dark), rgba(29, 185, 84, 0.05)) !important;
    border-radius: 20px !important;
    padding: 2rem !important;
    transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275) !important;
    cursor: pointer !important;
    position: relative !important;
    overflow: hidden !important;
    border: 3px solid rgba(29, 185, 84, 0.3) !important;
    min-height: 140px !important;
    display: flex !important;
    align-items: center !important;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2) !important;
    z-index: 1 !important;
    visibility: visible !important;
    opacity: 1 !important;
  `;
  
  card.innerHTML = `
    <div class="local-music-card-info" style="display: flex !important; align-items: center !important; gap: 1.5rem !important; position: relative !important; z-index: 2 !important; width: 100% !important;">
      ${thumbnail
        ? `<img src="${escapeLibraryHTML(thumbnail)}" alt="${escapeLibraryHTML(title)}" class="local-music-card-image" style="width: 80px !important; height: 80px !important; border-radius: 20px !important; object-fit: cover !important; border: 4px solid var(--primary-color) !important; box-shadow: 0 8px 25px rgba(29, 185, 84, 0.4) !important; transition: all 0.3s ease !important;">`
        : `<div class="generated-artwork local-music-card-image" aria-hidden="true" style="width: 80px !important; height: 80px !important; border-radius: 20px !important; border: 4px solid var(--primary-color) !important; box-shadow: 0 8px 25px rgba(29, 185, 84, 0.4) !important;"><span>${escapeLibraryHTML(getArtworkInitials(title))}</span></div>`}
      <div class="local-music-card-details" style="flex: 1 !important;">
        <h3 style="color: var(--text-primary) !important; margin: 0 0 0.75rem 0 !important; font-size: 1.3rem !important; font-weight: 800 !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; text-shadow: 0 3px 6px rgba(0, 0, 0, 0.4) !important; background: linear-gradient(135deg, var(--text-primary), var(--primary-color)) !important; -webkit-background-clip: text !important; -webkit-text-fill-color: transparent !important; background-clip: text !important;">${title}</h3>
        <p style="color: var(--text-secondary) !important; margin: 0 !important; font-size: 1rem !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; font-weight: 600 !important; text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3) !important;">${artist}</p>
      </div>
    </div>
  `;
  
  // Agregar evento de click
  card.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('Reproduciendo canción local:', title);
    playSong(song);
  });
  
  // Agregar efectos hover mejorados
  card.addEventListener('mouseenter', () => {
    card.style.transform = 'translateY(-8px) scale(1.03)';
    card.style.boxShadow = '0 25px 50px rgba(29, 185, 84, 0.3)';
    card.style.borderColor = 'var(--primary-color)';
    card.style.background = 'linear-gradient(135deg, var(--background-dark), rgba(29, 185, 84, 0.15))';
    
    const img = card.querySelector('.local-music-card-image');
    if (img) {
      img.style.transform = 'scale(1.1)';
      img.style.boxShadow = '0 12px 35px rgba(29, 185, 84, 0.6)';
    }
  });
  
  card.addEventListener('mouseleave', () => {
    card.style.transform = 'translateY(0) scale(1)';
    card.style.boxShadow = '0 10px 30px rgba(0, 0, 0, 0.2)';
    card.style.borderColor = 'rgba(29, 185, 84, 0.3)';
    card.style.background = 'linear-gradient(135deg, var(--background-dark), rgba(29, 185, 84, 0.05))';
    
    const img = card.querySelector('.local-music-card-image');
    if (img) {
      img.style.transform = 'scale(1)';
      img.style.boxShadow = '0 8px 25px rgba(29, 185, 84, 0.4)';
    }
  });
  
  return card;
}

function createMyMusicCard(song) {
  const card = document.createElement('div');
  card.className = 'my-music-card';
  
  // Asegurar que tenemos datos vélidos
  const title = song.title || 'Título desconocido';
  const artist = song.artist || 'Artista desconocido';
  const thumbnail = getArtworkUrl(song.thumbnail, song.cover);
  
  card.innerHTML = `
    <div class="my-music-card-info">
      ${getArtworkMarkup(thumbnail, title, 'my-music-card-image')}
      <div class="my-music-card-details">
        <h3>${title}</h3>
        <p>${artist}</p>
      </div>
    </div>
    <button class="delete-library-btn" title="Eliminar de mi música">
      <i class="fas fa-trash"></i>
    </button>
  `;
  
  const infoDiv = card.querySelector('.my-music-card-info');
  infoDiv.addEventListener('click', (e) => {
    e.preventDefault();
    console.log('Reproduciendo canción local:', title);
    playSong(song);
  });
  
  const deleteBtn = card.querySelector('.delete-library-btn');
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (confirm(`¿Estás seguro de que quieres eliminar "${title}" de tu música?`)) {
      await removeFromLibrary(song.video_id || song.id);
      loadMyMusicContent();
      notificationSystem.info(`${title} eliminado de tu música`);
    }
  });
  
  return card;
}

function loadMyMusicContent() {
  const container = document.getElementById('myMusicContainer');
  if (!container) {
    console.error('No se encontró el contenedor myMusicContainer');
    return;
  }

  const localTracks = Array.isArray(state.localMusic) ? state.localMusic : [];
  container.innerHTML = '';

  if (localTracks.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1; text-align: center; padding: 3rem 2rem; color: var(--text-secondary); position: relative; z-index: 2;">
        <i class="fas fa-music" style="font-size: 3rem; color: var(--primary-color); margin-bottom: 1.5rem; display: block;"></i>
        <h3 style="color: var(--text-primary); margin-bottom: 1rem; font-size: 1.5rem; font-weight: 700;">No hay música local subida</h3>
        <p style="margin-bottom: 1.5rem; font-size: 1rem; opacity: 0.8;">Sube canciones desde "Subir Música" para verlas aquí.</p>
        <button class="library-create-btn" onclick="document.querySelector('[data-page=\"upload\"]').click()">
          <i class="fas fa-upload"></i>
          Subir Música
        </button>
      </div>
    `;
    return;
  }

  const myMusicTotalSongs = document.getElementById('myMusicTotalSongs');

  if (myMusicTotalSongs) {
    myMusicTotalSongs.textContent = `${localTracks.length} canción${localTracks.length > 1 ? 'es' : ''}`;
  }

  localTracks.forEach((song) => {
    container.appendChild(createMyMusicCard(song));
  });
}

function createMyMusicCard(song) {
  const card = document.createElement('div');
  card.className = 'my-music-card';

  const title = song.title || 'Título desconocido';
  const artist = song.artist || 'Artista desconocido';
  const thumbnail = getArtworkUrl(song.thumbnail, song.cover);
  const addedLabel = song.added_at ? new Date(song.added_at).toLocaleDateString() : 'Sin fecha';

  card.innerHTML = `
    <button class="delete-library-btn visible" title="Eliminar de mi música">
      <i class="fas fa-trash"></i>
    </button>
    <div class="my-music-card-info">
      ${getArtworkMarkup(thumbnail, title, 'my-music-card-image')}
      <div class="my-music-card-details">
        <div class="my-music-card-topline">
          <span class="my-music-origin">Subida local</span>
          <span class="my-music-added">${addedLabel}</span>
        </div>
        <h3 title="${title}">${title}</h3>
        <p title="${artist}">${artist}</p>
      </div>
    </div>
  `;

  const infoDiv = card.querySelector('.my-music-card-info');
  infoDiv.addEventListener('click', (e) => {
    e.preventDefault();
    playSong({
      ...song,
      isLocal: true,
      id: song.id || song.video_id,
      video_id: song.video_id || song.id
    });
  });

  const deleteBtn = card.querySelector('.delete-library-btn');
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (confirm(`¿Estás seguro de que quieres eliminar "${title}" de tu música subida?`)) {
      await ipcRenderer.invoke('remove-local-music', song.video_id || song.id);
      await loadLocalMusic();
      notificationSystem.info(`${title} eliminado de tu música`);
    }
  });

  return card;
}

function loadMyMusicPage() {
  console.log('Cargando página Mi Música');
  loadLocalMusic();
}

function createLibrarySongCard(song) {
  const card = document.createElement('div');
  card.className = 'song-card';
  
  const isFavorite = isFavoriteTrack(song);
  
  card.innerHTML = `
    <div class="song-card-info">
      ${getArtworkMarkup(getArtworkUrl(song.thumbnail, song.cover), song.title, 'song-card-image')}
      <div class="song-card-details">
        <h3>${song.title}</h3>
        <p>${song.artist}</p>
      </div>
    </div>
    <div class="song-card-actions">
      <button class="song-card-action" onclick="playSong(${JSON.stringify(song).replace(/"/g, '&quot;')})" title="Reproducir">
        <i class="fas fa-play"></i>
      </button>
      <button class="song-card-action" onclick="toggleFavorite('${song.video_id || song.id}')" title="Favorito">
        <i class="fas fa-heart ${isFavorite ? 'favorited' : ''}"></i>
      </button>
      <button class="song-card-action" onclick="addToQueue(${JSON.stringify(song).replace(/"/g, '&quot;')})" title="Agregar a cola">
        <i class="fas fa-plus"></i>
      </button>
    </div>
  `;
  
  return card;
}

function loadPlaylistsTab() {
  const container = document.getElementById('playlistsGrid');
  if (!container) return;
  
  container.innerHTML = '';
  
  if (state.playlists.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-list"></i>
        <h3>No hay playlists en tu biblioteca</h3>
        <p>Crea tu primera playlist para comenzar</p>
      </div>
    `;
    return;
  }
  
  state.playlists.forEach(playlist => {
    const playlistCard = createLibraryPlaylistCard(playlist);
    container.appendChild(playlistCard);
  });
}

function createLibraryPlaylistCard(playlist) {
  const card = document.createElement('div');
  card.className = 'playlist-card';
  
  card.innerHTML = `
    <div class="playlist-card-info">
      <h3>${playlist.name}</h3>
      <p>${playlist.songs ? playlist.songs.length : 0} canción${playlist.songs && playlist.songs.length > 1 ? 'es' : ''}</p>
    </div>
  `;
  
  card.addEventListener('click', () => {
    openPlaylistModal(playlist);
  });
  
  return card;
}

async function openPlaylistModal(playlist) {
  try {
    const modal = document.getElementById('playlistModal');
    const title = document.getElementById('playlistModalTitle');
    const list = document.getElementById('playlistSongsList');
    const closeBtn = document.getElementById('closePlaylistModal');
    
    if (!modal || !title || !list || !closeBtn) {
      console.error('Elementos del modal de playlist no encontrados');
      return;
    }
    
    title.textContent = playlist.name;
    
    const songs = await ipcRenderer.invoke('get-playlist-songs', playlist.id);
    
    if (!songs || songs.length === 0) {
      list.innerHTML = `<div class="empty-state"><i class="fas fa-music"></i><h3>Playlist vacía</h3><p>Agrega canciones para empezar</p></div>`;
    } else {
      list.innerHTML = songs.map(song => {
        const title = song.title || 'Sin título';
        const artist = song.artist || 'Desconocido';
        const thumb = getArtworkUrl(song.thumbnail, song.cover);
        return `
          <div class="playlist-song-item">
            ${getArtworkMarkup(thumb, title)}
            <div class="playlist-song-info">
              <div class="playlist-song-title" title="${title}">${title}</div>
              <div class="playlist-song-artist" title="${artist}">${artist}</div>
            </div>
            <button class="playlist-song-remove" data-video-id="${song.video_id || song.id}" title="Eliminar de la playlist">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        `;
      }).join('');
      
      list.querySelectorAll('.playlist-song-remove').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const videoId = e.currentTarget.getAttribute('data-video-id');
          try {
            await ipcRenderer.invoke('remove-from-playlist-song', playlist.id, videoId);
            notificationSystem.info('Canción eliminada de la playlist');
            // Recargar lista
            openPlaylistModal(playlist);
          } catch (err) {
            console.error('Error al eliminar de la playlist:', err);
            notificationSystem.error('No se pudo eliminar la canción de la playlist');
          }
        });
      });
    }
    
    modal.style.display = 'block';
    
    const backdrop = modal.querySelector('.modal-backdrop');
    const close = () => { modal.style.display = 'none'; };
    closeBtn.onclick = close;
    if (backdrop) backdrop.onclick = close;
  } catch (error) {
    console.error('Error abriendo modal de playlist:', error);
  }
}

function searchSongs(query) {
  const container = document.getElementById('songsGrid');
  if (!container) return;
  
  const filteredSongs = state.library.filter(song => 
    song.title.toLowerCase().includes(query.toLowerCase()) ||
    song.artist.toLowerCase().includes(query.toLowerCase())
  );
  
  container.innerHTML = '';
  
  if (filteredSongs.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-search"></i>
        <h3>No se encontraron canciones</h3>
        <p>Intenta con otros términos de búsqueda</p>
      </div>
    `;
    return;
  }
  
  filteredSongs.forEach(song => {
    const songCard = createLibrarySongCard(song);
    container.appendChild(songCard);
  });
}

function searchPlaylists(query) {
  const container = document.getElementById('playlistsGrid');
  if (!container) return;
  
  // Implementar búsqueda de playlists
  console.log('Buscando playlists:', query);
}

function shuffleAllLibrary() {
  if (state.library.length === 0) {
    notificationSystem.info('No hay música en tu biblioteca');
    return;
  }
  
  // Crear una copia de la biblioteca y mezclarla
  const shuffledLibrary = [...state.library].sort(() => Math.random() - 0.5);
  
  // Establecer como playlist actual
  state.currentPlaylist = shuffledLibrary;
  state.currentIndex = 0;
  
  // Reproducir primera canción
  if (shuffledLibrary.length > 0) {
    playSong(shuffledLibrary[0]);
    notificationSystem.info('Reproduciendo biblioteca mezclada');
  }
}

function showSortOptions() {
  // Implementar opciones de ordenamiento
  console.log('Mostrar opciones de ordenamiento');
}

// Inicializar página de biblioteca
const librarySectionLoaders = {
  playlists: loadPlaylistsSection,
  favorites: loadFavoritesSection
};

function initializeLibraryPage() {
  initializeLibraryEventListeners();
  initializeLibraryVisualizer();
  loadLibraryContent();
}

function escapeLibraryHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getTrackKey(track) {
  return String(track?.video_id || track?.id || `${track?.title || ''}-${track?.artist || ''}-${track?.url || ''}`);
}

function getTrackTitle(track) {
  return track?.title || 'Sin título';
}

function getTrackArtist(track) {
  return track?.artist || 'Artista desconocido';
}

function getTrackImage(track) {
  return getArtworkUrl(track?.thumbnail, track?.cover);
}

function getLibraryCatalogTracks() {
  const uniqueTracks = new Map();
  [...(state.library || []), ...(state.favorites || [])].forEach(track => {
    if (!track) return;
    const key = getTrackKey(track);
    if (!uniqueTracks.has(key)) uniqueTracks.set(key, track);
  });
  return Array.from(uniqueTracks.values());
}

function formatLibraryCount(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function setTextContent(id, text) {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

function makeLibraryEmptyState(icon, title, text) {
  return `
    <div class="library-empty-state">
      <i class="fas ${icon}"></i>
      <h3>${escapeLibraryHTML(title)}</h3>
      <p>${escapeLibraryHTML(text)}</p>
    </div>
  `;
}

function playLibraryCollection(tracks, label) {
  if (!tracks || tracks.length === 0) return;
  state.currentPlaylist = tracks;
  state.currentPlaylistId = null;
  state.currentIndex = 0;
  playSong(tracks[0]);
  notificationSystem.info(`Reproduciendo ${label}`);
}

function updateLibrarySignal(catalogTracks) {
  const signalLabel = document.getElementById('librarySignalLabel');
  if (!signalLabel) return;

  if (state.favorites.length > 0) {
    signalLabel.textContent = `${state.favorites.length} favoritos activos`;
  } else if (state.playlists.length > 0) {
    signalLabel.textContent = `${state.playlists.length} playlists listas`;
  } else if (catalogTracks.length > 0) {
    signalLabel.textContent = `${catalogTracks.length} canciones listas`;
  } else {
    signalLabel.textContent = 'Coleccion lista';
  }
}

function initializeLibraryEventListeners() {
  document.querySelectorAll('.library-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchLibrarySection(btn.dataset.section);
    });
  });

  const shuffleBtn = document.getElementById('libraryShuffleBtn');
  if (shuffleBtn) shuffleBtn.addEventListener('click', shuffleAllLibrary);

  [document.getElementById('createPlaylistBtn'), document.getElementById('libraryHeroCreateBtn')]
    .filter(Boolean)
    .forEach(btn => btn.addEventListener('click', createPlaylist));

  const deleteAllFavoritesBtn = document.getElementById('deleteAllFavoritesBtn');
  if (deleteAllFavoritesBtn) {
    deleteAllFavoritesBtn.addEventListener('click', async () => {
      if (state.favorites.length === 0) return;
      if (confirm(`¿Eliminar todos los favoritos (${state.favorites.length} canciones)?`)) {
        const favoritesToDelete = [...state.favorites];
        for (const favorite of favoritesToDelete) {
          await removeFromFavorites(favorite.video_id || favorite.id);
        }
        loadLibraryContent();
        notificationSystem.info('Favoritos eliminados');
      }
    });
  }
}

function initializeLibraryVisualizer() {
  const bars = document.querySelectorAll('.library-spectrum span');
  bars.forEach((bar, index) => {
    bar.style.setProperty('--library-bar-delay', `${index * 90}ms`);
  });
}

function loadLibraryContent() {
  updateLibraryStats();
  loadPlaylistsSection();
  loadFavoritesSection();
}

function refreshLibraryContent() {
  loadLibraryContent();
}

function updateLibraryStats() {
  const catalogTracks = getLibraryCatalogTracks();
  const totalSongs = catalogTracks.length;
  const totalPlaylists = state.playlists.length;
  const totalFavorites = state.favorites.length;

  setTextContent('libraryTotalSongs', formatLibraryCount(totalSongs, 'canción', 'canciones'));
  setTextContent('libraryTotalPlaylists', formatLibraryCount(totalPlaylists, 'playlist', 'playlists'));
  setTextContent('librarySongsCount', totalSongs);
  setTextContent('libraryPlaylistsCount', totalPlaylists);
  setTextContent('libraryFavoritesCount', totalFavorites);

  updateLibrarySignal(catalogTracks);
  updateSettingsSummary();
}

function switchLibrarySection(sectionName) {
  const targetName = librarySectionLoaders[sectionName] ? sectionName : 'playlists';

  document.querySelectorAll('.library-section').forEach(section => {
    section.classList.remove('active');
  });

  document.querySelectorAll('.library-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.section === targetName);
  });

  const targetSection = document.getElementById(`${targetName}Section`);
  if (targetSection) targetSection.classList.add('active');

  librarySectionLoaders[targetName]();
}

function loadPlaylistsSection() {
  const container = document.getElementById('playlistsContainer');
  if (!container) return;

  container.innerHTML = '';
  setTextContent('playlistsCount', formatLibraryCount(state.playlists.length, 'playlist', 'playlists'));

  if (state.playlists.length === 0) {
    container.innerHTML = makeLibraryEmptyState(
      'fa-layer-group',
      'Sin playlists todavía',
      'Tus colecciones aparecerán acá cuando las crees.'
    );
    return;
  }

  state.playlists.forEach((playlist, index) => {
    const playlistCard = createPlaylistCard(playlist, index);
    container.appendChild(playlistCard);
    loadPlaylistCardMeta(playlist.id);
  });
}

function createPlaylistCard(playlist, index = 0) {
  const card = document.createElement('article');
  card.className = 'playlist-card';
  card.tabIndex = 0;
  card.style.setProperty('--card-index', index);

  const playlistName = escapeLibraryHTML(playlist.name || 'Playlist');
  card.innerHTML = `
    <div class="playlist-card-cover" id="playlist-cover-${playlist.id}">
      <span>${String(index + 1).padStart(2, '0')}</span>
      <i class="fas fa-wave-square"></i>
    </div>
    <div class="playlist-card-info">
      <span class="playlist-card-tag">Playlist</span>
      <h3 title="${playlistName}">${playlistName}</h3>
      <p id="playlist-count-${playlist.id}">Cargando...</p>
    </div>
    <div class="playlist-card-footer">
      <button class="playlist-open-btn" title="Abrir playlist" type="button">
        <i class="fas fa-arrow-right"></i>
      </button>
      <button class="delete-playlist-btn" title="Eliminar playlist" type="button">
        <i class="fas fa-trash"></i>
      </button>
    </div>
  `;

  const openPlaylist = () => loadPlaylistSongs(playlist.id);

  card.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    openPlaylist();
  });

  card.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    openPlaylist();
  });

  card.querySelector('.playlist-open-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openPlaylist();
  });

  card.querySelector('.delete-playlist-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    deletePlaylist(playlist);
  });

  return card;
}

async function loadPlaylistCardMeta(playlistId) {
  try {
    const songs = await ipcRenderer.invoke('get-playlist-songs', playlistId);
    const countElement = document.getElementById(`playlist-count-${playlistId}`);
    if (countElement) {
      countElement.textContent = formatLibraryCount(songs.length, 'tema', 'temas');
    }

    const cover = document.getElementById(`playlist-cover-${playlistId}`);
    if (cover && songs.length) {
      const images = songs.slice(0, 4).map(getTrackImage).filter(Boolean);
      cover.innerHTML = `
        <div class="playlist-cover-mosaic">
          ${images.length ? images.map(image => `<img src="${escapeLibraryHTML(image)}" alt="">`).join('') : getGeneratedArtworkMarkup('Playlist')}
        </div>
      `;
    }
  } catch (error) {
    console.error('Error al cargar metadata de playlist:', error);
    const countElement = document.getElementById(`playlist-count-${playlistId}`);
    if (countElement) countElement.textContent = 'No disponible';
  }
}

function loadFavoritesSection() {
  const container = document.getElementById('favoritesContainer');
  if (!container) return;

  container.innerHTML = '';
  setTextContent('favoritesCount', formatLibraryCount(state.favorites.length, 'canción', 'canciones'));

  const deleteAllBtn = document.getElementById('deleteAllFavoritesBtn');
  if (deleteAllBtn) deleteAllBtn.style.display = state.favorites.length > 0 ? 'inline-flex' : 'none';

  if (state.favorites.length === 0) {
    container.innerHTML = makeLibraryEmptyState(
      'fa-heart',
      'Sin favoritos todavía',
      'Los temas marcados con corazón van a vivir en esta lista.'
    );
    return;
  }

  state.favorites.forEach((favorite, index) => {
    const favoriteCard = createFavoriteCard(favorite, index);
    container.appendChild(favoriteCard);
  });
}

function createFavoriteCard(favorite, index = 0) {
  const card = document.createElement('article');
  card.className = 'favorite-card';
  card.tabIndex = 0;
  card.style.setProperty('--card-index', index);

  const title = escapeLibraryHTML(getTrackTitle(favorite));
  const artist = escapeLibraryHTML(getTrackArtist(favorite));

  card.innerHTML = `
    <button class="favorite-play-btn" title="Reproducir favorito" type="button">
      <i class="fas fa-play"></i>
    </button>
    ${getArtworkMarkup(getTrackImage(favorite), getTrackTitle(favorite), 'favorite-card-image')}
    <div class="favorite-card-details">
      <span class="favorite-card-index">${String(index + 1).padStart(2, '0')}</span>
      <h3 title="${title}">${title}</h3>
      <p title="${artist}">${artist}</p>
    </div>
    <button class="delete-favorite-btn" title="Eliminar de favoritos" type="button">
      <i class="fas fa-trash"></i>
    </button>
  `;

  const playFavorite = () => {
    state.currentPlaylist = state.favorites;
    state.currentIndex = index;
    playSong(favorite);
  };

  card.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    playFavorite();
  });

  card.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    playFavorite();
  });

  card.querySelector('.favorite-play-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    playFavorite();
  });

  card.querySelector('.delete-favorite-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (confirm(`¿Eliminar "${getTrackTitle(favorite)}" de favoritos?`)) {
      await removeFromFavorites(favorite.video_id || favorite.id);
      loadLibraryContent();
      notificationSystem.info(`${getTrackTitle(favorite)} eliminado de favoritos`);
    }
  });

  return card;
}

initializeLibraryPage();

function createTrackCard(track) {
  const card = document.createElement('div');
  card.className = 'track-card';
  const isFavorite = isFavoriteTrack(track);
  card.innerHTML = `
    ${getArtworkMarkup(track.thumbnail, track.title)}
    <h3>${track.title}</h3>
    <p>${track.artist}</p>
    <div class="card-controls">
      <button class="play-button"><i class="fas fa-play"></i></button>
      <button class="like-button ${isFavorite ? 'active' : ''}" title="${isFavorite ? 'Quitar de favoritos' : 'Añadir a favoritos'}">
        <i class="fas fa-heart"></i>
      </button>
      <button class="queue-button" title="Añadir a la cola"><i class="fas fa-list"></i></button>
      <button class="add-to-playlist" title="Añadir a playlist"><i class="fas fa-plus"></i></button>
    </div>
  `;

  const playButton = card.querySelector('.play-button');
  const likeButton = card.querySelector('.like-button');
  const queueButton = card.querySelector('.queue-button');
  const addToPlaylistButton = card.querySelector('.add-to-playlist');

  playButton.addEventListener('click', () => {
    playSong(track);
    console.log(`Reproduciendo desde tarjeta: ${track.title}`);
  });

  likeButton.addEventListener('click', async () => {
    likeButton.disabled = true;
    try {
      const wasFavorite = isFavoriteTrack(track);
      const success = await toggleFavorite(track);

      if (success && wasFavorite) {
        likeButton.classList.remove('active');
        likeButton.title = 'Añadir a favoritos';
      } else if (success) {
        likeButton.classList.add('active');
        likeButton.title = 'Quitar de favoritos';
      }
    } finally {
      likeButton.disabled = false;
    }
  });

  queueButton.addEventListener('click', () => {
    addToQueue({ ...track });
    notificationSystem.info(`${track.title} añadido a la cola`);
    console.log(`Añadido a cola: ${track.title}`);
  });

  addToPlaylistButton.addEventListener('click', () => {
    showPlaylistSelector(track);
  });

  return card;
}

function addToQueue(track) {
  if (!track) return;

  const isDuplicate = state.queue.some(queuedTrack => areSamePlaybackTrack(queuedTrack, track));

  if (!isDuplicate) {
    state.queue.push(track);
    updateQueueUI();
    notificationSystem.success(`${track.title} agregada a la cola`);
    console.log(`Canción añadida a cola: ${track.title}`);
  } else {
    notificationSystem.warning(`${track.title} ya está en la cola`);
    console.log(`Canción duplicada en cola: ${track.title}`);
  }
}

// Sistema de notificaciones removido - se usa notification-system.js

function removeFromQueue(index) {
  if (index >= 0 && index < state.queue.length) {
    const removedTrack = state.queue[index];
    state.queue.splice(index, 1);
    updateQueueUI();
    notificationSystem.info(`${removedTrack.title} eliminada de la cola`);
    console.log(`Canción eliminada de cola: ${removedTrack.title}`);
  }
}

function clearQueue() {
  state.queue = [];
  updateQueueUI();
  notificationSystem.info('Cola limpiada');
  console.log('Cola limpiada');
}

function toggleQueueLoop() {
  state.queueLoop = !state.queueLoop;
  const queueLoopButton = document.getElementById('queueLoopButton');
  if (queueLoopButton) {
    queueLoopButton.classList.toggle('active');
  }
  updateQueueUI({ forceVisible: document.querySelector('.queue-container')?.classList.contains('active') });
  console.log('Modo bucle de cola cambiado:', state.queueLoop);
}

function updateQueueUI(options = {}) {
  const forceVisible = !!options.forceVisible;
  const queueContainer = document.querySelector('.queue-container');
  const queueItems = document.querySelector('.queue-items');
  const queueCount = document.getElementById('queueCount');
  const queueHint = document.getElementById('queueHint');
  
  if (!queueContainer || !queueItems) return;
  
  if (queueCount) {
    const totalTracks = state.queue.length;
    queueCount.textContent = `${totalTracks} canción${totalTracks === 1 ? '' : 'es'}`;
  }
  
  if (state.queue.length > 0) {
    queueContainer.classList.add('active');
    if (queueHint) {
      queueHint.textContent = state.queueLoop ? 'Bucle de cola activado' : 'Cola lista para reproducirse';
    }
    
    let html = '<div class="queue-section-title">Próximas canciones</div>';
    
    html += state.queue.map((track, index) => {
      const trackTitle = track.title || 'Sin título';
      const trackArtist = track.artist || 'Artista desconocido';
      const trackId = track.id || track.video_id || '';
      const currentTrackId = state.currentTrack ? (state.currentTrack.id || state.currentTrack.video_id || '') : '';
      const isCurrentTrack = currentTrackId && currentTrackId === trackId;
      const durationDisplay = track.duration ? formatTime(track.duration) : '--:--';
      
      return `
      <div class="queue-item ${isCurrentTrack ? 'is-current' : ''}" data-index="${index}">
        <div class="queue-item-order">${String(index + 1).padStart(2, '0')}</div>
        ${getArtworkMarkup(track.thumbnail, trackTitle)}
        <div class="queue-item-info">
          <div class="queue-item-title" title="${trackTitle}">${trackTitle}</div>
          <div class="queue-item-artist" title="${trackArtist}">${trackArtist}</div>
        </div>
        <div class="queue-item-meta">
          <span class="queue-item-duration">${durationDisplay}</span>
        </div>
        <button class="queue-item-remove" data-index="${index}" title="Quitar de la cola" type="button">
            <i class="fas fa-times"></i>
        </button>
      </div>
    `}).join('');
    
    queueItems.innerHTML = html;

    queueItems.querySelectorAll('.queue-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.queue-item-remove')) return;
        const index = parseInt(item.dataset.index, 10);
        const track = state.queue[index];
        if (!track) return;
        state.currentPlaylist = null;
        state.currentPlaylistId = null;
        state.currentIndex = index;
        playSong(track);
      });
    });

    queueItems.querySelectorAll('.queue-item-remove').forEach(button => {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = parseInt(e.currentTarget.dataset.index, 10);
        removeFromQueue(index);
      });
    });
    
    console.log('Interfaz de cola actualizada:', state.queue.length, 'canciones');
  } else {
    if (queueHint) {
      queueHint.textContent = 'Añade temas para verlos aquí';
    }
    queueItems.innerHTML = `
      <div class="queue-empty-state">
        <div class="queue-empty-icon">
          <i class="fas fa-music"></i>
        </div>
        <strong>Tu cola está vacía</strong>
        <p>Usa el botón de cola en una canción para preparar lo próximo que quieres escuchar.</p>
      </div>
    `;
    queueContainer.classList.toggle('active', forceVisible);
    console.log(forceVisible ? 'Cola vacía, interfaz visible' : 'Cola vacía, interfaz oculta');
  }
  updateNowPlayingQueueButton();
}

async function handleTrackEnded() {
  console.log('Audio terminado');
  state.isPlaying = false;
  updatePlayingUI(false);
  hidePlayingGif();

  // PRIORIDAD 1: Si repetir una está activado, repetir la misma canción
  if (state.repeat === 'one' && state.currentTrack) {
    console.log('Repitiendo canción actual (Modo: Repetir Una)');
    elements.audio.currentTime = 0;
    elements.audio.play();
    state.isPlaying = true;
    updatePlayingUI(true);
    return;
  }

  cleanupPlaybackFile(state.currentTrack);

  // La decisión de "qué sigue" vive en playNext: cola primero, playlist después,
  // y por último reproducción automática si está activada.
  await playNext();
}

// Controles de ventana
document.getElementById('minimizeBtn').addEventListener('click', () => {
  ipcRenderer.send('minimize-window');
  console.log('Ventana minimizada');
});

document.getElementById('maximizeBtn').addEventListener('click', () => {
  ipcRenderer.send('maximize-window');
  console.log('Ventana maximizada/restaurada');
});

document.getElementById('closeBtn').addEventListener('click', () => {
  ipcRenderer.send('close-window');
  console.log('Ventana cerrada');
});

// Biblioteca
async function addToLibrary(track) {
  try {
    console.log(`Añadiendo a biblioteca: ${track.title}`);
    const updatedLibrary = await ipcRenderer.invoke('add-to-library', track);
    state.library = updatedLibrary;
    updateLibraryUI();
    notificationSystem.info(`${track.title} añadida a la biblioteca`);
  } catch (error) {
    console.error('Error al agregar a biblioteca:', error);
      notificationSystem.info('Error al agregar a la biblioteca', 'error');
  }
}

async function addToFavorites(track) {
  try {
    console.log(`Añadiendo a favoritos: ${track.title}`);
    const updatedFavorites = await ipcRenderer.invoke('add-to-favorites', track);
    state.favorites = updatedFavorites;
    updateLibraryUI();
    return true;
  } catch (error) {
    console.error('Error al agregar a favoritos:', error);
    notificationSystem.info('Error al agregar a favoritos');
    return false;
  }
}

async function removeFromFavorites(videoId) {
  try {
    console.log(`Eliminando de favoritos: ${videoId}`);
    const updatedFavorites = await ipcRenderer.invoke('remove-from-favorites', videoId);
    state.favorites = updatedFavorites;
    updateLibraryUI();
    return true;
  } catch (error) {
    console.error('Error al eliminar de favoritos:', error);
    notificationSystem.info('Error al eliminar de favoritos');
    return false;
  }
}

async function removeFromLibrary(videoId) {
  try {
    console.log(`Eliminando de la biblioteca: ${videoId}`);
    const updatedLibrary = await ipcRenderer.invoke('remove-from-library', videoId);
    state.library = updatedLibrary;
    updateUserStats();
    return true;
  } catch (error) {
    console.error('Error al eliminar de la biblioteca:', error);
    notificationSystem.info('Error al eliminar de la biblioteca');
    return false;
  }
}

async function loadLibrary() {
  try {
    console.log('Cargando biblioteca desde SQLite');
    state.library = await ipcRenderer.invoke('get-library');
    state.favorites = await ipcRenderer.invoke('get-favorites');
    state.playlists = await ipcRenderer.invoke('get-playlists');
    if (!state.playlists) state.playlists = [];
    updateLibraryUI();
    
    // Actualizar el contenido de la biblioteca si estamos en la página de biblioteca
    if (document.getElementById('library').classList.contains('active')) {
      refreshLibraryContent();
    }
  } catch (error) {
    console.error('Error al cargar biblioteca:', error);
    state.library = [];
    state.favorites = [];
    state.playlists = [];
    updateLibraryUI();
    
    // Actualizar el contenido de la biblioteca incluso si hay error
    if (document.getElementById('library').classList.contains('active')) {
      refreshLibraryContent();
    }
  }
}

function updateLibraryUI() {
  updateLibraryStats();
  if (document.getElementById('library')?.classList.contains('active')) {
    loadLibraryContent();
  }
  return;

  if (elements.libraryContent) {
    const playlistsSection = document.getElementById('playlistsSection');
    const favoritesSection = document.getElementById('favoritesSection');
    const localMusicSection = document.getElementById('localMusicSection');
    const playlistsContainer = document.getElementById('playlistsContainer');
    const favoritesContainer = document.getElementById('favoritesContainer');
    const localMusicContainer = document.getElementById('localMusicContainer');

    if (!playlistsSection || !favoritesSection || !localMusicSection) {
      elements.libraryContent.innerHTML = `
        <div class="playlist-section" id="playlistsSection">
          <h2>Playlists</h2>
          <button id="createPlaylistBtn" class="create-playlist-btn">
            <i class="fas fa-plus"></i> Crear nueva playlist
          </button>
          <div id="playlistsContainer"></div>
        </div>
        <div class="favorites-section" id="favoritesSection" style="display: none;">
          <h2>Favoritos</h2>
          <div id="favoritesContainer"></div>
        </div>
        <div class="local-music-section" id="localMusicSection" style="display: none;">
          <h2>Mi Música</h2>
          <div id="localMusicContainer"></div>
        </div>
      `;
    }

    const updatedPlaylistsContainer = document.getElementById('playlistsContainer');
    const updatedFavoritesContainer = document.getElementById('favoritesContainer');

    if (state.playlists && state.playlists.length > 0) {
      updatedPlaylistsContainer.innerHTML = '';
      state.playlists.forEach(playlist => {
        const playlistDiv = document.createElement('div');
        playlistDiv.className = 'playlist-item';
        playlistDiv.innerHTML = `
          <span>${playlist.name}</span>
          <button class="view-playlist" data-id="${playlist.id}">Ver</button>
        `;
        updatedPlaylistsContainer.appendChild(playlistDiv);
      });
    } else {
      updatedPlaylistsContainer.innerHTML = '<p>No hay playlists. Crea una nueva.</p>';
    }

    if (state.favorites && state.favorites.length > 0) {
      updatedFavoritesContainer.innerHTML = '';
      state.favorites.forEach(track => {
        const trackCard = createTrackCard(track);
        updatedFavoritesContainer.appendChild(trackCard);
      });
    } else {
      updatedFavoritesContainer.innerHTML = '<p>No hay canciones en tus favoritos.</p>';
    }

    const createPlaylistBtn = document.getElementById('createPlaylistBtn');
    createPlaylistBtn.removeEventListener('click', createPlaylist);
    createPlaylistBtn.addEventListener('click', createPlaylist);

    document.querySelectorAll('.view-playlist').forEach(btn => {
      btn.removeEventListener('click', () => viewPlaylist(btn.dataset.id));
      btn.addEventListener('click', () => viewPlaylist(btn.dataset.id));
    });

    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const filter = btn.textContent.toLowerCase();
        if (filter === 'playlists') {
          document.getElementById('playlistsSection').style.display = 'block';
          document.getElementById('favoritesSection').style.display = 'none';
          document.getElementById('localMusicSection').style.display = 'none';
        } else if (filter === 'favoritos') {
          document.getElementById('playlistsSection').style.display = 'none';
          document.getElementById('favoritesSection').style.display = 'block';
          document.getElementById('localMusicSection').style.display = 'none';
        } else if (filter === 'mi música') {
          document.getElementById('playlistsSection').style.display = 'none';
          document.getElementById('favoritesSection').style.display = 'none';
          document.getElementById('localMusicSection').style.display = 'block';
          loadLocalMusic();
        }
      });
    });

    console.log('Interfaz de biblioteca actualizada:', state.favorites.length, 'favoritos');
  }
}

async function createPlaylist() {
  document.querySelectorAll('.playlist-create-modal').forEach(existingModal => existingModal.remove());

  const modal = document.createElement('div');
  modal.className = 'playlist-create-modal';
  modal.innerHTML = `
    <div class="playlist-create-backdrop"></div>
    <div class="playlist-create-dialog" role="dialog" aria-modal="true" aria-labelledby="playlistCreateTitle">
      <button class="playlist-create-close" type="button" aria-label="Cerrar">
        <i class="fas fa-times"></i>
      </button>
      <div class="playlist-create-icon">
        <i class="fas fa-compact-disc"></i>
      </div>
      <span class="playlist-create-kicker">Nueva colección</span>
      <h3 id="playlistCreateTitle">Crear playlist</h3>
      <p>Elige un nombre con personalidad para encontrarla rápido cuando vuelvas a tu biblioteca.</p>
      <label class="playlist-create-label" for="playlistNameInput">Nombre de la playlist</label>
      <input type="text" id="playlistNameInput" placeholder="Ej: Noches tranquilas" class="playlist-create-input" maxlength="60">
      <div class="playlist-create-actions">
        <button class="playlist-create-secondary" type="button">Cancelar</button>
        <button id="createPlaylistConfirmBtn" class="playlist-create-primary" type="button">
          <i class="fas fa-plus"></i>
          <span>Crear playlist</span>
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const confirmBtn = modal.querySelector('#createPlaylistConfirmBtn');
  const input = modal.querySelector('#playlistNameInput');
  const closeBtn = modal.querySelector('.playlist-create-close');
  const cancelBtn = modal.querySelector('.playlist-create-secondary');
  const backdrop = modal.querySelector('.playlist-create-backdrop');
  const closeModal = () => modal.remove();

  setTimeout(() => input.focus(), 30);

  confirmBtn.addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) {
      notificationSystem.info('El nombre de la playlist no puede estar vacío');
      input.focus();
      return;
    }

    try {
      const newPlaylist = await ipcRenderer.invoke('create-playlist', name);
      state.playlists.push(newPlaylist);
      loadPlaylistsSection();
      notificationSystem.info(`Playlist "${name}" creada`);
      closeModal();
    } catch (error) {
      console.error('Error al crear playlist:', error);
      notificationSystem.info('Error al crear la playlist: ' + error.message);
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmBtn.click();
    if (e.key === 'Escape') closeModal();
  });

  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);
  backdrop.addEventListener('click', closeModal);
}

async function viewPlaylist(playlistId) {
  try {
    const songs = await ipcRenderer.invoke('get-playlist-songs', playlistId);
    const playlist = state.playlists.find(p => p.id === parseInt(playlistId));
    
    // Guardar las canciones de la playlist en el estado
    state.currentPlaylist = songs;
    state.currentPlaylistId = playlistId;
    state.currentIndex = -1; // Resetear el índice

    elements.libraryContent.innerHTML = `
      <h2>Playlist: ${playlist ? playlist.name : 'Desconocida'}</h2>
      <button id="backToLibraryBtn" class="create-playlist-btn">
        <i class="fas fa-arrow-left"></i> Volver a la biblioteca
      </button>
      <div class="playlist-songs-table">
        <div class="table-header">
          <div class="table-column number-column">#</div>
          <div class="table-column title-column">Título</div>
          <div class="table-column date-column">Fecha de adición</div>
          <div class="table-column duration-column"><i class="fas fa-clock"></i></div>
        </div>
        <div id="playlistSongs" class="table-body"></div>
      </div>
    `;
    const songsContainer = document.getElementById('playlistSongs');
    if (songs && songs.length > 0) {
      songs.forEach((track, index) => {
        const trackRow = document.createElement('div');
        trackRow.className = 'table-row';
        trackRow.dataset.index = index; // Guardamos el índice para la reproducción
        trackRow.innerHTML = `
          <div class="table-column number-column">${index + 1}</div>
          <div class="table-column title-column">
            ${getArtworkMarkup(track.thumbnail, track.title)}
            <div class="track-info">
              <span class="track-title">${track.title || 'Sin título'}</span>
              <span class="track-artist">${track.artist || 'Sin artista'}</span>
            </div>
          </div>
          <div class="table-column date-column">${track.dateAdded || 'Desconocido'}</div>
          <div class="table-column duration-column">${formatTime(track.duration || 0)}</div>
        `;
        songsContainer.appendChild(trackRow);

        // Añadir evento de clic para reproducir la canción
        trackRow.addEventListener('click', () => {
          state.currentIndex = index; // Actualizamos el índice actual
          playSong(track);
        });
      });
    } else {
      songsContainer.innerHTML = '<p>No hay canciones en esta playlist.</p>';
    }

    document.getElementById('backToLibraryBtn').addEventListener('click', () => {
      showPage('library');
    });
  } catch (error) {
    console.error('Error al cargar canciones de playlist:', error);
    elements.libraryContent.innerHTML = '<p>Error al cargar la playlist.</p>';
  }
}

async function showPlaylistSelector(track) {
  console.log('[dev] showPlaylistSelector called with track:', track);
  console.log('[dev] Current playlists:', state.playlists);
  
  if (!state.playlists || state.playlists.length === 0) {
    notificationSystem.warning('No hay playlists disponibles. Crea una primero.');
    return;
  }

  const modal = document.createElement('div');
  modal.className = 'playlist-modal';
  modal.innerHTML = `
    <div class="modal-content">
      <h3>Añadir "${track.title}" a una playlist</h3>
      <ul id="playlistList"></ul>
      <button class="close-modal">Cerrar</button>
    </div>
  `;
  document.body.appendChild(modal);
  console.log('[dev] Modal de playlist creado y agregado al DOM');

  const playlistList = document.getElementById('playlistList');
  state.playlists.forEach(playlist => {
    const li = document.createElement('li');
    li.innerHTML = `<button data-id="${playlist.id}">${playlist.name}</button>`;
    playlistList.appendChild(li);
  });

  playlistList.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (btn) {
      const playlistId = parseInt(btn.dataset.id);
      console.log('Intentando añadir a playlist:', playlistId, track);
      try {
        const result = await ipcRenderer.invoke('add-to-playlist', playlistId, track);
        console.log('Resultado del IPC:', result);
        if (result) {
          notificationSystem.success(`Añadido a ${btn.textContent}`);
          // Recargar biblioteca y verificar que se guardó
          await loadLibrary();
          // Verificar que la canción se guardó
          await verifyPlaylistAddition(playlistId, track);
        } else {
          notificationSystem.error('Error al añadir a la playlist');
        }
      } catch (error) {
        console.error('Error al añadir a la playlist:', error);
        notificationSystem.error('Error al añadir a la playlist');
      }
      modal.remove();
    }
  });

  modal.querySelector('.close-modal').addEventListener('click', () => modal.remove());
}

// Función para verificar que la canción se agregó a la playlist
async function verifyPlaylistAddition(playlistId, track) {
  try {
    const playlistSongs = await ipcRenderer.invoke('get-playlist-songs', playlistId);
    const songExists = playlistSongs.some(song => song.video_id === track.id);
    if (songExists) {
      console.log('? Verificación exitosa: Canción encontrada en playlist');
      // Actualizar el contador de la playlist
      await loadPlaylistCount(playlistId);
    } else {
      console.log('? Verificación fallida: Canción NO encontrada en playlist');
      notificationSystem.warning('La canción no se guardó correctamente en la playlist');
    }
  } catch (error) {
    console.error('Error al verificar playlist:', error);
  }
}

// Función para cargar el contador de canciones de una playlist
async function loadPlaylistCount(playlistId) {
  try {
    const songs = await ipcRenderer.invoke('get-playlist-songs', playlistId);
    const countElement = document.getElementById(`playlist-count-${playlistId}`);
    if (countElement) {
      countElement.textContent = `${songs.length} canción${songs.length !== 1 ? 'es' : ''}`;
    }
  } catch (error) {
    console.error('Error al cargar contador de playlist:', error);
    const countElement = document.getElementById(`playlist-count-${playlistId}`);
    if (countElement) {
      countElement.textContent = 'Error al cargar';
    }
  }
}

// Función para cargar y mostrar las canciones de una playlist
async function loadPlaylistSongs(playlistId) {
  try {
    console.log(`[dev] Cargando canciones de playlist ${playlistId}`);
    const songs = await ipcRenderer.invoke('get-playlist-songs', playlistId);
    console.log('[dev] Canciones encontradas:', songs);

    showPlaylistInLibrary(playlistId, songs);
    
  } catch (error) {
    console.error('Error al cargar canciones de playlist:', error);
    notificationSystem.error('Error al cargar la playlist');
  }
}

// Función para mostrar las canciones de una playlist en la biblioteca
function showPlaylistInLibrary(playlistId, songs) {
  const numericPlaylistId = Number(playlistId);
  const playlist = state.playlists.find(p => Number(p.id) === numericPlaylistId);
  const playlistName = playlist ? playlist.name : 'Playlist desconocida';
  const safePlaylistName = escapeLibraryHTML(playlistName);
  const firstImage = songs[0] ? getTrackImage(songs[0]) : '';

  state.currentPlaylist = songs;
  state.currentPlaylistId = numericPlaylistId;
  state.currentIndex = -1;

  const libraryPage = document.getElementById('library');
  if (libraryPage && !libraryPage.classList.contains('active')) {
    showPage('library');
  }

  switchLibrarySection('playlists');

  const playlistsSection = document.getElementById('playlistsSection');
  if (!playlistsSection) return;

  playlistsSection.innerHTML = `
    <div class="playlist-detail-shell">
      <div class="playlist-detail-hero">
        <div class="playlist-detail-cover">
          ${songs.length ? getArtworkMarkup(firstImage, playlistName) : '<i class="fas fa-music"></i>'}
        </div>
        <div class="playlist-detail-copy">
          <span class="playlist-detail-kicker">Playlist</span>
          <h2 title="${safePlaylistName}">${safePlaylistName}</h2>
          <p>${formatLibraryCount(songs.length, 'tema', 'temas')}</p>
          <div class="playlist-detail-chips">
            <span>${formatLibraryCount(songs.length, 'tema', 'temas')}</span>
          </div>
        </div>
        <div class="playlist-detail-actions">
          <button class="playlist-detail-play-btn" id="playlistDetailPlayBtn" type="button" title="Reproducir playlist" ${songs.length ? '' : 'disabled'}>
            <i class="fas fa-play"></i>
            <span>Reproducir</span>
          </button>
          <button class="back-to-library-btn" id="backToLibraryInlineBtn" type="button" title="Volver">
            <i class="fas fa-arrow-left"></i>
            <span>Volver</span>
          </button>
        </div>
      </div>
      <div class="playlist-detail-table">
        <div class="playlist-detail-table-head">
          <div>#</div>
          <div>Cancion</div>
          <div>Agregado</div>
          <div>Duracion</div>
          <div></div>
        </div>
        <div class="playlist-detail-table-body" id="playlistDetailTableBody"></div>
      </div>
    </div>
  `;

  const backBtn = document.getElementById('backToLibraryInlineBtn');
  if (backBtn) backBtn.addEventListener('click', showNormalLibrary);

  const playBtn = document.getElementById('playlistDetailPlayBtn');
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      if (!songs.length) return;
      state.currentPlaylist = songs;
      state.currentIndex = 0;
      playSong(songs[0]);
    });
  }

  const tableBody = document.getElementById('playlistDetailTableBody');
  if (!tableBody) return;

  if (!songs.length) {
    tableBody.innerHTML = makeLibraryEmptyState(
      'fa-compact-disc',
      'Playlist vacia',
      'Todavia no hay temas en esta coleccion.'
    );
    return;
  }

  songs.forEach((song, index) => {
    const row = document.createElement('div');
    row.className = 'playlist-detail-row';
    row.tabIndex = 0;

    const title = escapeLibraryHTML(getTrackTitle(song));
    const artist = escapeLibraryHTML(getTrackArtist(song));
    const dateAdded = escapeLibraryHTML(song.dateAdded || '-');
    const duration = formatTime(song.duration || 0);
    const videoId = escapeLibraryHTML(song.video_id || song.id || '');

    row.innerHTML = `
      <div class="playlist-detail-index">${String(index + 1).padStart(2, '0')}</div>
      <div class="playlist-detail-track">
        ${getArtworkMarkup(getTrackImage(song), getTrackTitle(song))}
        <div class="playlist-detail-track-copy">
          <strong title="${title}">${title}</strong>
          <span title="${artist}">${artist}</span>
        </div>
      </div>
      <div class="playlist-detail-date">${dateAdded}</div>
      <div class="playlist-detail-duration">${duration}</div>
      <div class="playlist-detail-tools">
        <button class="playlist-remove-btn" data-video-id="${videoId}" title="Eliminar de la playlist" type="button">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    `;

    const playRow = () => {
      state.currentPlaylist = songs;
      state.currentIndex = index;
      playSong(song);
    };

    row.addEventListener('click', (e) => {
      if (e.target.closest('.playlist-remove-btn')) return;
      playRow();
    });

    row.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      playRow();
    });

    row.querySelector('.playlist-remove-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = e.currentTarget.getAttribute('data-video-id');
      try {
        await ipcRenderer.invoke('remove-from-playlist-song', numericPlaylistId, id);
        notificationSystem.info('Cancion eliminada de la playlist');
        await loadPlaylistSongs(numericPlaylistId);
      } catch (err) {
        console.error('Error al eliminar canción de la playlist:', err);
        notificationSystem.error('No se pudo eliminar la canción');
      }
    });

    tableBody.appendChild(row);
  });
}

function showNormalLibrary() {
  const playlistsSection = document.getElementById('playlistsSection');
  if (playlistsSection) {
    playlistsSection.innerHTML = `
      <div class="library-section-header">
        <div class="library-section-title">
          <span class="library-section-kicker">Colecciones</span>
          <h2>Playlists</h2>
        </div>
        <div class="library-section-actions">
          <span class="library-section-count" id="playlistsCount">0 playlists</span>
          <button class="library-create-btn" id="createPlaylistBtn" type="button" title="Crear playlist">
            <i class="fas fa-plus"></i>
            <span>Crear</span>
          </button>
        </div>
      </div>
      <div id="playlistsContainer" class="playlists-container library-card-grid"></div>
    `;

    const createPlaylistBtn = document.getElementById('createPlaylistBtn');
    if (createPlaylistBtn) createPlaylistBtn.addEventListener('click', createPlaylist);
  }

  switchLibrarySection('playlists');
  loadLibraryContent();
}

async function deletePlaylist(playlist) {
  // Mostrar confirmación
  const confirmed = confirm(`¿Estás seguro de que quieres eliminar la playlist "${playlist.name}"?\n\nEsta acción no se puede deshacer.`);
  
  if (!confirmed) return;
  
  try {
  console.log(`[dev] Eliminando playlist: ${playlist.name} (ID: ${playlist.id})`);
    const result = await ipcRenderer.invoke('delete-playlist', playlist.id);
    
    if (result) {
      notificationSystem.success(`Playlist "${playlist.name}" eliminada`);
      // Recargar biblioteca para actualizar la UI
      await loadLibrary();
    } else {
      notificationSystem.error('Error al eliminar la playlist');
    }
  } catch (error) {
    console.error('Error al eliminar playlist:', error);
    notificationSystem.error('Error al eliminar la playlist');
  }
}

// Configuración visual en "Configuración"
async function toggleVisualizer() {
  const shouldShow = typeof arguments[0] === 'boolean'
    ? arguments[0]
    : !state.visualSettings.showVisualizer;
  updateVisualizerState(shouldShow, true);
  console.log('Visualizador cambiado:', state.visualSettings.showVisualizer);
}

// Modal de confirmación para borrar datos
function showDeleteConfirmationModal() {
    const modal = document.createElement('div');
    modal.className = 'playlist-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <h3>¿Borrar todos los datos?</h3>
            <p>Esta acción eliminará todas las playlists, canciones recientes, recomendaciones, configuraciones y datos de usuario. No se puede deshacer.</p>
            <button id="confirmDeleteBtn" class="delete-btn">Confirmar</button>
            <button class="close-modal">Cancelar</button>
        </div>
    `;
    document.body.appendChild(modal);

    const confirmBtn = document.getElementById('confirmDeleteBtn');
    const closeBtn = modal.querySelector('.close-modal');

    confirmBtn.addEventListener('click', async () => {
        try {
            await ipcRenderer.invoke('delete-all-data');
            // Reiniciar estado local
            state.library = [];
            state.playlists = [];
            state.queue = [];
            state.currentTrack = null;
            state.currentPlaylist = null;
            state.currentPlaylistId = null;
            state.searchResults = [];
            state.settings = { showGif: false, gifUrl: null };
            state.visualSettings = {
              showVisualizer: true,
              theme: 'dark',
              accentColor: '#1db954',
              interfaceMode: 'classic',
              spectrogramOpacity: 0.4,
              effectsIntensity: 70,
              panelOpacity: 92,
              animationQuality: 'balanced',
              compactMode: false,
              reduceMotion: false
            };
            state.audioSettings = {
              normalizeVolume: false,
              streamingQuality: 'medium',
              lastStreamingProfile: null,
              equalizerPreamp: 0,
              equalizerQ: 1,
              equalizerLimiter: true,
              equalizer: { 60: 0, 170: 0, 310: 0, 600: 0, 1000: 0, 3000: 0, 6000: 0, 12000: 0, 14000: 0, 16000: 0 }
            };
            state.playbackSettings = { autoplay: false, autoQueue: false, smartShuffle: false, defaultVolume: 50, notificationsEnabled: true, miniPlayer: false };
            state.developerSettings = { enabled: false, internetEnabled: true, verbosePlayerLogs: false, audioExtractor: 'auto', performanceMode: 'balanced', cacheSizeMB: 500, startAtLogin: false };
            state.privacySettings = { saveListeningHistory: true };
            state.account = { username: '', email: '' };
            state.isNewUser = true;
            localStorage.removeItem('appSettings');
            localStorage.removeItem('user');
            updateLibraryUI();
            updateQueueUI();
            updateTrackInfo();
            updateSettingsUI();
            notificationSystem.info('Todos los datos han sido eliminados');
            elements.signupScreen.classList.add('active'); // Volver a la pantalla de registro
        } catch (error) {
            console.error('Error al borrar datos:', error);
            notificationSystem.info('Error al borrar los datos');
        }
        modal.remove();
    });

    closeBtn.addEventListener('click', () => modal.remove());
}

// Funcionalidad de subida de archivos
function initializeUploadFunctionality() {
  // Event listeners para el botón de seleccionar archivos
  if (elements.selectFilesBtn) {
    elements.selectFilesBtn.addEventListener('click', () => {
      elements.fileInput.click();
    });
  }

  // Event listener para el input de archivos
  if (elements.fileInput) {
    elements.fileInput.addEventListener('change', handleFileSelection);
  }

  // Drag and drop functionality
  if (elements.uploadArea) {
    elements.uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      elements.uploadArea.classList.add('dragover');
    });

    elements.uploadArea.addEventListener('dragleave', () => {
      elements.uploadArea.classList.remove('dragover');
    });

    elements.uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      elements.uploadArea.classList.remove('dragover');
      const files = Array.from(e.dataTransfer.files);
      handleFiles(files);
    });

    // Click en el área de subida
    elements.uploadArea.addEventListener('click', () => {
      elements.fileInput.click();
    });
  }
}

function handleFileSelection(e) {
  const files = Array.from(e.target.files);
  handleFiles(files);
}

async function handleFiles(files) {
  const audioFiles = files.filter(file => {
    const audioTypes = ['audio/mpeg', 'audio/wav', 'audio/flac', 'audio/aac', 'audio/ogg', 'audio/mp3'];
    return audioTypes.includes(file.type) || file.name.match(/\.(mp3|wav|flac|aac|ogg)$/i);
  });

  if (audioFiles.length === 0) {
    notificationSystem.info('No se encontraron archivos de audio vélidos');
    return;
  }

  if (audioFiles.length !== files.length) {
    notificationSystem.info(`${files.length - audioFiles.length} archivos no son de audio y fueron omitidos`);
  }

  await uploadFiles(audioFiles);
}

async function uploadFiles(files) {
  elements.uploadProgress.style.display = 'block';
  elements.uploadStatus.textContent = 'Preparando archivos...';
  elements.progressBarFill.style.width = '0%';

  const totalFiles = files.length;
  let processedFiles = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    elements.uploadStatus.textContent = `Procesando ${file.name}... (${i + 1}/${totalFiles})`;
    
    try {
      // Leer el archivo como ArrayBuffer
      const arrayBuffer = await file.arrayBuffer();
      
      // Extraer metadatos básicos del archivo
      const metadata = await extractAudioMetadata(file);
      
      // Guardar en la base de datos
      const trackData = {
        id: `local_${Date.now()}_${i}`,
        title: metadata.title || file.name.replace(/\.[^/.]+$/, ""),
        artist: metadata.artist || 'Artista Desconocido',
        album: metadata.album || null,
        duration: metadata.duration || 0,
        thumbnail: null,
        url: `local://${file.name}`,
        localPath: file.name,
        isLocal: true,
        fileSize: file.size,
        fileType: file.type
      };

      await ipcRenderer.invoke('add-local-music', trackData, arrayBuffer);
      
      processedFiles++;
      const progress = (processedFiles / totalFiles) * 100;
      elements.progressBarFill.style.width = `${progress}%`;
      
    } catch (error) {
      console.error(`Error procesando ${file.name}:`, error);
      notificationSystem.info(`Error al procesar ${file.name}: ${error.message}`);
    }
  }

  elements.uploadStatus.textContent = `¡Completado! ${processedFiles} archivos subidos exitosamente`;
  
  // Ocultar progreso después de 3 segundos
  setTimeout(() => {
    elements.uploadProgress.style.display = 'none';
    elements.fileInput.value = ''; // Limpiar input
  }, 3000);

  // Actualizar la lista de archivos y la biblioteca
  await loadLocalMusic();
  await loadLibrary();
  
  notificationSystem.info(`${processedFiles} archivos de música subidos exitosamente`);
}

async function extractAudioMetadata(file) {
  return new Promise((resolve) => {
    const audio = new Audio();
    const url = URL.createObjectURL(file);
    
    audio.addEventListener('loadedmetadata', () => {
      const metadata = {
        title: null,
        artist: null,
        album: null,
        duration: audio.duration || 0
      };
      
      URL.revokeObjectURL(url);
      resolve(metadata);
    });
    
    audio.addEventListener('error', () => {
      URL.revokeObjectURL(url);
      resolve({
        title: null,
        artist: null,
        album: null,
        duration: 0
      });
    });
    
    audio.src = url;
  });
}

async function loadLocalMusic() {
  try {
    const localMusic = await ipcRenderer.invoke('get-local-music');
    state.localMusic = localMusic || [];
    displayLocalMusic(localMusic);
    loadMyMusicContent();
  } catch (error) {
    console.error('Error al cargar música local:', error);
  }
}

function displayLocalMusic(tracks) {
  const localMusicContainer = getLocalMusicContainer();
  if (!localMusicContainer) return;
  if (tracks.length === 0) {
    localMusicContainer.innerHTML = '<p>No hay música local subida.</p>';
    return;
  }
  const tracksGrid = document.createElement('div');
  tracksGrid.className = 'tracks-grid';
  tracks.forEach(track => {
    const trackCard = createTrackCard(track);
    tracksGrid.appendChild(trackCard);
  });
  localMusicContainer.innerHTML = '';
  localMusicContainer.appendChild(tracksGrid);
  return;
  /*
  
  if (tracks.length === 0) {
    elements.localMusicContainer.innerHTML = '<p>No hay música local subida.</p>';
    return;
  }

  const tracksGrid = document.createElement('div');
  tracksGrid.className = 'tracks-grid';
  
  tracks.forEach(track => {
    const trackCard = createTrackCard(track);
    tracksGrid.appendChild(trackCard);
  });
  
  elements.localMusicContainer.innerHTML = '';
  elements.localMusicContainer.appendChild(tracksGrid);
  */
}


// Efecto Visual de Ondas Fluidas
let waveData = [];
let time = 0;

function initSpectrogram() {
  if (!elements.spectrogramCanvas) return;
  
  spectrogramCanvas = elements.spectrogramCanvas;
  spectrogramCtx = spectrogramCanvas.getContext('2d');
  
  function resizeSpectrogram() {
    if (!spectrogramCanvas) return;
    spectrogramCanvas.width = window.innerWidth;
    spectrogramCanvas.height = window.innerHeight;
  }

  resizeSpectrogram();

  if (spectrogramResizeHandler) {
    window.removeEventListener('resize', spectrogramResizeHandler);
  }
  spectrogramResizeHandler = resizeSpectrogram;
  window.addEventListener('resize', spectrogramResizeHandler);

  // Inicializar datos de ondas
  waveData = [];
  for (let i = 0; i < 5; i++) {
    waveData.push({
      amplitude: 0,
      frequency: 0.01 + (i * 0.005),
      phase: i * Math.PI / 3,
      speed: 0.02 + (i * 0.01),
      color: `rgba(0, ${100 + i * 30}, ${200 + i * 20}, 0.3)`,
      thickness: 3 + i * 2
    });
  }

  console.log('Efecto de ondas inicializado');
}

// Estado del bloom de resonancia del espectrograma.
let spectrogramBursts = [];
let spectrogramBassSmooth = 0;
let spectrogramEnergySmooth = 0;
let lastSpectrogramImpactTime = 0;

function startSpectrogram() {
  if (!spectrogramCanvas || !spectrogramCtx) {
    initSpectrogram();
  }

  if (!spectrogramCanvas || !spectrogramCtx) return;
  applySpectrogramOpacity(state.visualSettings.spectrogramOpacity, { persist: false });

  if (spectrogramFrameId) return;
  console.log('Efecto de espectrograma de lujo iniciado');

  function animateLuxury() {
    if (!spectrogramCtx || !spectrogramCanvas) {
      spectrogramFrameId = requestAnimationFrame(animateLuxury);
      return;
    }

    if (!state.visualSettings.showVisualizer) {
      if (elements.spectrogram) {
        elements.spectrogram.style.display = 'none';
      }
      spectrogramFrameId = requestAnimationFrame(animateLuxury);
      return;
    }

    const width = window.innerWidth;
    const height = window.innerHeight;
    if (spectrogramCanvas.width !== width || spectrogramCanvas.height !== height) {
      spectrogramCanvas.width = width;
      spectrogramCanvas.height = height;
    }

    if (!state.isPlaying) {
      if (elements.spectrogram) {
        elements.spectrogram.style.display = 'none';
      }
      spectrogramFrameId = requestAnimationFrame(animateLuxury);
      return;
    }

    if (elements.spectrogram && (elements.spectrogram.style.display === 'none' || elements.spectrogram.style.display === '')) {
      elements.spectrogram.style.display = 'block';
    }

    if (analyser && audioDataArray) {
      analyser.getByteFrequencyData(audioDataArray);
    }

    spectrogramCtx.clearRect(0, 0, width, height);
    spectrogramCtx.fillStyle = 'rgba(10, 12, 18, 0.25)';
    spectrogramCtx.fillRect(0, 0, width, height);

    const bufferLength = analyser ? analyser.frequencyBinCount : 0;
    const barCount = 200;
    const spacing = width / barCount;
    const barWidth = spacing * 0.7;

    const gradient = spectrogramCtx.createLinearGradient(0, height, 0, 0);
    const timeHue = (time * 0.3) % 360;
    gradient.addColorStop(0, `hsla(${timeHue}, 80%, 50%, 1)`);
    gradient.addColorStop(0.5, `hsla(${timeHue + 40}, 90%, 60%, 1)`);
    gradient.addColorStop(1, `hsla(${timeHue + 80}, 100%, 80%, 1)`);

    spectrogramCtx.fillStyle = gradient;
    spectrogramCtx.shadowBlur = 15;
    spectrogramCtx.shadowColor = `hsla(${timeHue}, 80%, 60%, 0.6)`;
    spectrogramCtx.beginPath();

    const usefulBands = Math.floor(bufferLength * 0.8);
    for (let i = 0; i < barCount / 2; i++) {
      const indexRatio = i / (barCount / 2);
      const dataIndex = Math.floor(Math.pow(indexRatio, 0.8) * usefulBands);
      let value = audioDataArray ? audioDataArray[dataIndex] : 0;
      value = Math.max(value, 3);
      const barHeight = (Math.pow(value / 255, 1.2)) * (height * 0.6);
      const xLeft = width / 2 - (i * spacing) - spacing;
      const y = height / 2 - barHeight / 2;
      const xRight = width / 2 + (i * spacing);

      if (spectrogramCtx.roundRect) {
        spectrogramCtx.roundRect(xLeft, y, barWidth, barHeight, barWidth / 2);
        spectrogramCtx.roundRect(xRight, y, barWidth, barHeight, barWidth / 2);
      } else {
        spectrogramCtx.rect(xLeft, y, barWidth, barHeight);
        spectrogramCtx.rect(xRight, y, barWidth, barHeight);
      }
    }
    spectrogramCtx.fill();
    spectrogramCtx.shadowBlur = 0;

    drawResonanceBloom(width, height, audioDataArray, timeHue);

    time += 1;
    spectrogramFrameId = requestAnimationFrame(animateLuxury);
  }

  spectrogramFrameId = requestAnimationFrame(animateLuxury);
}

function clampVisualValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getBandAverage(data, start, end) {
  if (!data || data.length === 0) return 0;

  const first = Math.max(0, Math.min(data.length, start));
  const last = Math.max(first, Math.min(data.length, end));
  if (last <= first) return 0;

  let total = 0;
  for (let i = first; i < last; i++) {
    total += data[i];
  }

  return total / (last - first);
}

function drawResonanceBloom(width, height, data, hue) {
  if (!spectrogramCtx || !data) return;

  const bass = getBandAverage(data, 0, 18) / 255;
  const body = getBandAverage(data, 18, 72) / 255;
  const air = getBandAverage(data, 96, 220) / 255;
  const energy = clampVisualValue((bass * 0.62) + (body * 0.28) + (air * 0.1), 0, 1);
  const previousBass = spectrogramBassSmooth;
  const bassAttack = bass > spectrogramBassSmooth ? 0.24 : 0.07;
  const energyAttack = energy > spectrogramEnergySmooth ? 0.16 : 0.06;
  const now = performance.now();
  const impact = Math.max(0, bass - previousBass);

  spectrogramBassSmooth += (bass - spectrogramBassSmooth) * bassAttack;
  spectrogramEnergySmooth += (energy - spectrogramEnergySmooth) * energyAttack;

  if ((impact > 0.16 || bass > 0.84) && bass > 0.5 && now - lastSpectrogramImpactTime > 115 && spectrogramBursts.length < 10) {
    lastSpectrogramImpactTime = now;
    spectrogramBursts.push({
      age: 0,
      life: 34 + Math.floor(bass * 20),
      strength: clampVisualValue((impact * 2.2) + (bass * 0.42), 0.35, 1),
      hue: hue + (body * 70),
      spin: Math.random() * Math.PI * 2,
      twist: (Math.random() - 0.5) * 0.72
    });
  }

  spectrogramCtx.save();
  spectrogramCtx.globalCompositeOperation = 'screen';
  drawEpicCenterFlare(width, height, hue, energy, impact);
  drawCornerRadiance(width, height, hue, energy);
  drawSpectrogramBursts(width, height);
  drawImpactFlares(width, height, hue, energy, impact);
  spectrogramCtx.restore();
}

function drawEpicCenterFlare(width, height, hue, energy, impact) {
  if (!spectrogramCtx) return;

  const centerX = width / 2;
  const centerY = height / 2;
  const minDim = Math.min(width, height);
  let coreRadius = minDim * (0.05 + energy * 0.14 + impact * 0.14);
  let glowRadius = minDim * (0.22 + energy * 0.24 + impact * 0.1);

  // Defensive: ensure radii are finite and non-negative to avoid Canvas IndexSizeError
  if (!Number.isFinite(coreRadius)) coreRadius = 0;
  if (!Number.isFinite(glowRadius)) glowRadius = 0;
  coreRadius = Math.max(0, coreRadius);
  glowRadius = Math.max(0, glowRadius);

  const coreGlow = spectrogramCtx.createRadialGradient(centerX, centerY, 0, centerX, centerY, glowRadius);
  coreGlow.addColorStop(0, `hsla(${hue + 12}, 100%, 84%, ${0.22 + impact * 0.16})`);
  coreGlow.addColorStop(0.18, `hsla(${hue + 48}, 100%, 72%, ${0.16 + energy * 0.08})`);
  coreGlow.addColorStop(0.48, `hsla(${hue + 72}, 96%, 66%, ${0.1 + energy * 0.04})`);
  coreGlow.addColorStop(1, 'hsla(0,0%,100%,0)');

  if (glowRadius > 0.0001) {
    spectrogramCtx.fillStyle = coreGlow;
    spectrogramCtx.fillRect(centerX - glowRadius, centerY - glowRadius, glowRadius * 2, glowRadius * 2);
  }

  const ringHue = hue + 30;
  spectrogramCtx.strokeStyle = `hsla(${ringHue}, 100%, 82%, ${0.08 + impact * 0.1})`;
  spectrogramCtx.lineWidth = 2.2 + impact * 3.4;
  if (coreRadius * 1.12 > 0.0001) {
    spectrogramCtx.beginPath();
    spectrogramCtx.arc(centerX, centerY, coreRadius * 1.12, 0, Math.PI * 2);
    spectrogramCtx.stroke();
  }

  const pulseCount = 10;
  const baseAlpha = 0.08 + impact * 0.12;
  for (let i = 0; i < pulseCount; i++) {
    const angle = (Math.PI * 2 / pulseCount) * i + time * 0.02;
    const length = coreRadius * (1.1 + energy * 0.8 + impact * 0.9);
    const x = centerX + Math.cos(angle) * length;
    const y = centerY + Math.sin(angle) * length;

    spectrogramCtx.strokeStyle = `hsla(${hue + 22 + i * 12}, 100%, 88%, ${baseAlpha * (1 - i / pulseCount)})`;
    spectrogramCtx.lineWidth = 0.9 + energy * 1.1;
    spectrogramCtx.beginPath();
    spectrogramCtx.moveTo(centerX + Math.cos(angle) * coreRadius * 0.6, centerY + Math.sin(angle) * coreRadius * 0.6);
    spectrogramCtx.lineTo(x, y);
    spectrogramCtx.stroke();

    spectrogramCtx.fillStyle = `hsla(${hue + 28 + i * 10}, 100%, 82%, ${baseAlpha * 0.75})`;
    if ((2 + impact * 2) > 0.0001) {
      spectrogramCtx.beginPath();
      spectrogramCtx.arc(x, y, 2 + impact * 2, 0, Math.PI * 2);
      spectrogramCtx.fill();
    }
  }

  if (impact > 0.1) {
    const confettiCount = 14;
    for (let i = 0; i < confettiCount; i++) {
      const angle = (Math.PI * 2 / confettiCount) * i + (time * 0.03);
      const distance = coreRadius * (1.2 + Math.sin(time * 0.017 + i) * 0.18 + impact * 0.28);
      const px = centerX + Math.cos(angle) * distance;
      const py = centerY + Math.sin(angle) * distance;
      const hueOffset = hue + (i * 18);
      const size = 1.5 + Math.sin(i + time * 0.05) * 1.8 + impact * 1.8;
      if (size > 0.0001) {
        spectrogramCtx.fillStyle = `hsla(${hueOffset}, 100%, 78%, ${0.18 + impact * 0.1})`;
        spectrogramCtx.beginPath();
        spectrogramCtx.arc(px, py, size, 0, Math.PI * 2);
        spectrogramCtx.fill();
      }
    }
  }
}

function drawCornerRadiance(width, height, hue, energy) {
  if (!spectrogramCtx || energy < 0.12) return;

  const minDim = Math.min(width, height);
  // Hacer que el propio círculo de la esquina reaccione: mayor energía -> mayor tamaño y alpha
  const baseRadiance = minDim * 0.12;
  const radiance = baseRadiance * (1 + energy * 1.6);
  const bottomOffset = height * 0.08;
  const corners = [
    { x: 0, y: 0, offset: 0 },
    { x: width, y: 0, offset: 36 },
    { x: 0, y: height - bottomOffset, offset: 72 },
    { x: width, y: height - bottomOffset, offset: 108 }
  ];

  // Smoke/soft particle near corner - subtle animated noise using time
  corners.forEach(({ x, y, offset }, cornerIndex) => {
    const cornerHue = hue + offset;

    // Glow gradient for the corner circle
    const glow = spectrogramCtx.createRadialGradient(x, y, 0, x, y, radiance);
    const alphaMain = Math.min(0.6, 0.18 + energy * 0.22);
    glow.addColorStop(0, `hsla(${cornerHue}, 100%, 74%, ${alphaMain})`);
    glow.addColorStop(0.28, `hsla(${cornerHue + 34}, 92%, 70%, ${Math.min(0.42, 0.09 + energy * 0.12)})`);
    glow.addColorStop(1, 'hsla(0,0%,100%,0)');

    spectrogramCtx.fillStyle = glow;
    spectrogramCtx.fillRect(x - radiance, y - radiance, radiance * 2, radiance * 2);

    // Subtle animated smoke: low-opacity radial with slight offset
    const smokeStrength = Math.max(0, Math.min(0.32, energy * 0.6));
    if (smokeStrength > 0.01) {
      const smokeRadius = radiance * (1.25 + Math.sin(time * 0.012 + cornerIndex) * 0.08);
      const sx = x + Math.cos(time * 0.007 + cornerIndex * 1.3) * (radiance * 0.06);
      const sy = y + Math.sin(time * 0.009 + cornerIndex * 0.9) * (radiance * 0.04);
      const smoke = spectrogramCtx.createRadialGradient(sx, sy, 0, sx, sy, smokeRadius);
      smoke.addColorStop(0, `hsla(${cornerHue + 8}, 100%, 84%, ${smokeStrength * 0.65})`);
      smoke.addColorStop(0.45, `hsla(${cornerHue + 28}, 92%, 76%, ${smokeStrength * 0.28})`);
      smoke.addColorStop(1, 'hsla(0,0%,100%,0)');
      spectrogramCtx.globalCompositeOperation = 'lighter';
      spectrogramCtx.fillStyle = smoke;
      spectrogramCtx.fillRect(sx - smokeRadius, sy - smokeRadius, smokeRadius * 2, smokeRadius * 2);
      spectrogramCtx.globalCompositeOperation = 'source-over';
    }

    // Small confetti burst near corner when energy is high
    if (energy > 0.64) {
      const confettiCount = 6;
      for (let c = 0; c < confettiCount; c++) {
        const ang = Math.random() * Math.PI * 0.9 + (cornerIndex % 2 ? -0.2 : 0.2);
        const dist = radiance * (0.6 + Math.random() * 0.6);
        const cx = x + Math.cos(ang) * dist;
        const cy = y + Math.sin(ang) * dist;
        const confHue = cornerHue + (Math.random() * 60 - 30);
        const w = 2 + Math.random() * 4;
        const h = 1 + Math.random() * 3;
        spectrogramCtx.fillStyle = `hsla(${confHue}, 100%, 78%, ${0.18 + Math.random() * 0.26})`;
        spectrogramCtx.fillRect(cx - w / 2, cy - h / 2, w, h);
      }
    }
  });
}

function drawImpactFlares(width, height, hue, energy, impact) {
  if (!spectrogramCtx || impact <= 0.08) return;

  const flareStrength = Math.min(0.55, impact * 0.28 + energy * 0.16);
  const flareRadius = Math.max(width, height) * 0.14;
  const verticalOffset = height * 0.08;
  const positions = [
    { x: width * 0.16, y: height * 0.16 },
    { x: width * 0.84, y: height * 0.16 },
    { x: width * 0.16, y: height * 0.84 - verticalOffset },
    { x: width * 0.84, y: height * 0.84 - verticalOffset }
  ];

  // Draw larger flares but remove the small luminous dots near corners
  positions.forEach((pos, index) => {
    const flareHue = hue + index * 20;
    const flare = spectrogramCtx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, flareRadius);
    flare.addColorStop(0, `hsla(${flareHue}, 100%, 86%, ${flareStrength * 0.32})`);
    flare.addColorStop(0.18, `hsla(${flareHue + 22}, 98%, 77%, ${flareStrength * 0.18})`);
    flare.addColorStop(0.46, `hsla(${flareHue + 48}, 90%, 70%, ${flareStrength * 0.1})`);
    flare.addColorStop(1, 'hsla(0,0%,100%,0)');

    spectrogramCtx.fillStyle = flare;
    spectrogramCtx.fillRect(pos.x - flareRadius, pos.y - flareRadius, flareRadius * 2, flareRadius * 2);
  });

  const streakHue = hue + 56;
  const streak = spectrogramCtx.createLinearGradient(0, 0, width, height);
  streak.addColorStop(0, `hsla(${streakHue}, 100%, 82%, ${flareStrength * 0.09})`);
  streak.addColorStop(0.32, `hsla(${streakHue + 20}, 100%, 78%, ${flareStrength * 0.05})`);
  streak.addColorStop(1, 'hsla(0,0%,100%,0)');

  spectrogramCtx.strokeStyle = streak;
  spectrogramCtx.lineWidth = 0.9 + flareStrength * 2.2;
  spectrogramCtx.beginPath();
  spectrogramCtx.moveTo(width * 0.12, height * 0.48);
  spectrogramCtx.quadraticCurveTo(width * 0.5, height * 0.5 + impact * 0.08 * height, width * 0.88, height * 0.48);
  spectrogramCtx.stroke();
}

function drawResonanceRibbons(width, height, data, hue, energy) {
  // Ribbons are intentionally disabled to avoid floating line artifacts.
}

function drawSpectrogramBursts(width, height) {
  const centerX = width / 2;
  const centerY = height / 2;
  const minDim = Math.min(width, height);

  for (let i = spectrogramBursts.length - 1; i >= 0; i--) {
    const burst = spectrogramBursts[i];
    burst.age += 1;

    const progress = burst.age / burst.life;
    if (progress >= 1) {
      spectrogramBursts.splice(i, 1);
      continue;
    }

    const fade = Math.pow(1 - progress, 1.85) * burst.strength;
    const radius = minDim * (0.07 + progress * (0.48 + burst.strength * 0.2));
    const ringHue = burst.hue + progress * 34;
    const bandHeight = height * (0.045 + burst.strength * 0.065) * (1 - progress * 0.55);
    const flash = spectrogramCtx.createLinearGradient(0, centerY, width, centerY);

    flash.addColorStop(0, `hsla(${ringHue}, 100%, 65%, 0)`);
    flash.addColorStop(0.43, `hsla(${ringHue + 35}, 100%, 70%, ${fade * 0.08})`);
    flash.addColorStop(0.5, `hsla(${ringHue + 95}, 100%, 78%, ${fade * 0.13})`);
    flash.addColorStop(0.57, `hsla(${ringHue + 35}, 100%, 70%, ${fade * 0.08})`);
    flash.addColorStop(1, `hsla(${ringHue}, 100%, 65%, 0)`);

    spectrogramCtx.fillStyle = flash;
    spectrogramCtx.fillRect(0, centerY - bandHeight, width, bandHeight * 2);

    spectrogramCtx.beginPath();
    spectrogramCtx.ellipse(centerX, centerY, radius * 1.65, radius * 0.42, burst.spin + progress * burst.twist, 0, Math.PI * 2);
    spectrogramCtx.shadowBlur = 24 * fade;
    spectrogramCtx.shadowColor = `hsla(${ringHue + 32}, 100%, 70%, ${fade * 0.65})`;
    spectrogramCtx.strokeStyle = `hsla(${ringHue + 18}, 100%, 72%, ${fade * 0.62})`;
    spectrogramCtx.lineWidth = Math.max(1, (1 - progress) * 5.5 * burst.strength);
    spectrogramCtx.stroke();

    spectrogramCtx.beginPath();
    spectrogramCtx.ellipse(centerX, centerY, radius * 1.08, radius * 0.72, -burst.spin * 0.4 - progress * burst.twist, 0, Math.PI * 2);
    spectrogramCtx.strokeStyle = `hsla(${ringHue + 118}, 100%, 74%, ${fade * 0.28})`;
    spectrogramCtx.lineWidth = Math.max(0.7, (1 - progress) * 2.5 * burst.strength);
    spectrogramCtx.stroke();

    spectrogramCtx.beginPath();
    for (let spoke = 0; spoke < 14; spoke++) {
      const angle = (spoke / 14) * Math.PI * 2 + burst.spin + progress * 0.9;
      const yScale = 0.46 + Math.sin(spoke + burst.spin) * 0.08;
      const inner = radius * 0.24;
      const outer = radius * (0.76 + Math.sin((progress * 8) + spoke) * 0.07);

      spectrogramCtx.moveTo(centerX + Math.cos(angle) * inner, centerY + Math.sin(angle) * inner * yScale);
      spectrogramCtx.lineTo(centerX + Math.cos(angle) * outer, centerY + Math.sin(angle) * outer * yScale);
    }

    spectrogramCtx.shadowBlur = 10 * fade;
    spectrogramCtx.strokeStyle = `hsla(${ringHue + 62}, 100%, 76%, ${fade * 0.18})`;
    spectrogramCtx.lineWidth = 1;
    spectrogramCtx.stroke();
  }
}

// Funciones antiguas vacías para evitar errores
function drawWaves(audioIntensity) {}
function drawAdditionalWaves(audioIntensity) {}

function stopSpectrogram() {
  if (spectrogramFrameId) {
    cancelAnimationFrame(spectrogramFrameId);
    spectrogramFrameId = null;
  }
  if (spectrogramResizeHandler) {
    window.removeEventListener('resize', spectrogramResizeHandler);
    spectrogramResizeHandler = null;
  }
  spectrogramBursts = [];
  spectrogramBassSmooth = 0;
  spectrogramEnergySmooth = 0;
  lastSpectrogramImpactTime = 0;
  if (elements.spectrogram) {
    elements.spectrogram.style.display = 'none';
  }
  if (spectrogramCtx && spectrogramCanvas) {
      spectrogramCtx.clearRect(0, 0, spectrogramCanvas.width, spectrogramCanvas.height);
  }
  console.log('Efecto de ondas detenido');
}

// Efectos visuales del fondo
let pulseValue = 0;

function startBackgroundPulse() {
  // Verificar si la configuración lo permite
  if (!state.visualSettings.showBackgroundPulse) {
    console.log('Efecto de fondo desactivado por configuración');
    if (backgroundOverlay) {
        backgroundOverlay.style.background = 'transparent';
    }
    return;
  }

  console.log('Iniciando efectos visuales del fondo (Latidos)...');
  
  // Crear overlay si no existe
  createBackgroundOverlay();
  
  // Si no hay analizador, usar efecto simulado
  if (!analyser || !audioDataArray) {
    console.log('Usando efecto simulado (sin analizador)');
    startSimulatedPulse();
    return;
  }
  
  function animate() {
    if (!state.isPlaying || !state.visualSettings.showBackgroundPulse) {
        // Desvanecer si se pausa o se desactiva
        if (pulseValue > 0.01) {
            pulseValue *= 0.9;
            if (backgroundOverlay) {
                backgroundOverlay.style.background = `rgba(255, 255, 255, ${pulseValue * 0.15})`;
            }
            animationId = requestAnimationFrame(animate);
        } else {
             animationId = null;
             if (backgroundOverlay) {
                 backgroundOverlay.style.background = 'transparent';
             }
        }
        return;
    }
    
    analyser.getByteFrequencyData(audioDataArray);
    
    // Calcular la intensidad del bajo (primeras 10 bandas)
    let bassIntensity = 0;
    for (let i = 0; i < 10; i++) {
      bassIntensity += audioDataArray[i];
    }
    bassIntensity = bassIntensity / 10;
    
    // Lógica de "Latido"
    let targetPulse = (bassIntensity / 255);
    
    // Solo reaccionar a golpes fuertes (threshold)
    if (targetPulse < 0.4) targetPulse = 0;
    else targetPulse = Math.pow(targetPulse, 3); // Hacerlo más explosivo
    
    // Suavizado con ataque rápido y decay lento
    if (targetPulse > pulseValue) {
        pulseValue = pulseValue * 0.6 + targetPulse * 0.4; // Ataque
    } else {
        pulseValue *= 0.92; // Decay (~1 segundo)
    }
    
    // Aplicar al overlay (Blanco con opacidad baja)
    const maxOpacity = 0.15; // Sutil
    const finalOpacity = pulseValue * maxOpacity;
    
    if (backgroundOverlay) {
        backgroundOverlay.style.background = `rgba(255, 255, 255, ${finalOpacity})`;
    }
    
    animationId = requestAnimationFrame(animate);
  }
  
  animate();
}

// Efecto simulado cuando no hay analizador
function startSimulatedPulse() {
  // Verificar si la configuración lo permite
  if (!state.visualSettings.showBackgroundPulse) {
    if (backgroundOverlay) {
        backgroundOverlay.style.background = 'transparent';
    }
    return;
  }

  console.log('Iniciando pulso simulado...');
  
  let intensity = 0;
  let direction = 1;
  
  function simulatePulse() {
    if (!state.isPlaying || !state.visualSettings.showBackgroundPulse) {
      if (backgroundOverlay) {
          backgroundOverlay.style.background = 'transparent';
      }
      animationId = requestAnimationFrame(simulatePulse);
      return;
    }
    
    // Simular latido
    intensity += direction * 0.05;
    
    if (intensity >= 1) {
      direction = -1;
    } else if (intensity <= 0) {
      direction = 1;
      // Pausa entre latidos
      if (Math.random() > 0.1) intensity = -0.5; 
    }
    
    const val = Math.max(0, intensity);
    const opacity = val * 0.15;
    
    if (backgroundOverlay) {
        backgroundOverlay.style.background = `rgba(255, 255, 255, ${opacity})`;
    }
    
    animationId = requestAnimationFrame(simulatePulse);
  }
  
  simulatePulse();
}

// Mantenemos la función por compatibilidad, aunque ya no se usa internamente
function applyBackgroundEffects(bassIntensity, totalIntensity) {
    if (!backgroundOverlay) createBackgroundOverlay();
    const normalizedBass = bassIntensity / 255;
    const opacity = normalizedBass * 0.15;
    backgroundOverlay.style.background = `rgba(255, 255, 255, ${opacity})`;
}

function stopBackgroundPulse() {
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
  
  // Limpiar overlay
  if (backgroundOverlay) {
    backgroundOverlay.style.background = 'transparent';
  }
}

// Crear overlay para efectos visuales
let backgroundOverlay = null;

function createBackgroundOverlay() {
  if (backgroundOverlay) return backgroundOverlay;
  
  backgroundOverlay = document.createElement('div');
  backgroundOverlay.id = 'background-pulse-overlay';
  backgroundOverlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: -1;
    background: transparent;
    transition: background 0.05s ease-out;
  `;
  
  document.body.appendChild(backgroundOverlay);
  console.log('Overlay creado:', backgroundOverlay);
  return backgroundOverlay;
}

function testBackgroundEffect() {
  console.log('Probando efecto de fondo...');
  
  // Crear div directamente
  const testDiv = document.createElement('div');
  testDiv.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: red;
    z-index: 9999;
    pointer-events: none;
  `;
  
  document.body.appendChild(testDiv);
  console.log('Div rojo creado:', testDiv);
  
  // Cambiar a verde después de 1 segundo
  setTimeout(() => {
    testDiv.style.background = 'green';
    console.log('Cambiado a verde');
  }, 1000);
  
  // Cambiar a azul después de 2 segundos
  setTimeout(() => {
    testDiv.style.background = 'blue';
    console.log('Cambiado a azul');
  }, 2000);
  
  // Remover después de 3 segundos
  setTimeout(() => {
    testDiv.remove();
    console.log('Div removido');
  }, 3000);
}

// Función de prueba ultra simple
function testSimple() {
  console.log('Test ultra simple...');
  alert('Si ves este mensaje, JavaScript funciona');
  
  // Intentar cambiar el color del body directamente
  document.body.style.backgroundColor = 'red';
  console.log('Body color cambiado a rojo');
  
  setTimeout(() => {
    document.body.style.backgroundColor = 'blue';
    console.log('Body color cambiado a azul');
  }, 1000);
  
  setTimeout(() => {
    document.body.style.backgroundColor = '';
    console.log('Body color restaurado');
  }, 2000);
}

// Función de prueba con música simulada
function testMusicEffect() {
  console.log('Probando efecto con música simulada...');
  const overlay = createBackgroundOverlay();
  
  let intensity = 0;
  let direction = 1;
  let speed = 0.05;
  
  const testInterval = setInterval(() => {
    intensity += direction * speed;
    
    if (intensity >= 1) {
      direction = -1;
      speed = Math.random() * 0.1 + 0.02; // Velocidad variable
    } else if (intensity <= 0) {
      direction = 1;
      speed = Math.random() * 0.1 + 0.02; // Velocidad variable
    }
    
    const red = Math.floor(255 * intensity);
    const green = Math.floor(255 * intensity);
    const blue = Math.floor(255 * intensity);
    const alpha = intensity * 0.6;
    
    overlay.style.background = `rgba(${red}, ${green}, ${blue}, ${alpha})`;
    console.log('Música simulada - intensity:', intensity.toFixed(2));
  }, 50); // Más rápido para simular música
  
  // Detener después de 10 segundos
  setTimeout(() => {
    clearInterval(testInterval);
    overlay.style.background = 'transparent';
    console.log('Música simulada terminada');
  }, 10000);
}

// Función para activar efecto simulado manualmente
function startManualPulse() {
  console.log('Activando pulso manual...');
  state.isPlaying = true; // Simular que está reproduciendo
  startBackgroundPulse();
}

// Función para detener el efecto
function stopManualPulse() {
  console.log('Deteniendo pulso...');
  state.isPlaying = false;
  stopBackgroundPulse();
}

// Redimensionar canvas cuando cambie el tamaño de la ventana
window.addEventListener('resize', () => {
  if (spectrogramCanvas && spectrogramCtx) {
    spectrogramCanvas.width = window.innerWidth;
    spectrogramCanvas.height = window.innerHeight;
  }
});

// Exponer funciones globalmente
window.testBackgroundEffect = testBackgroundEffect;
window.testSimple = testSimple;
window.testMusicEffect = testMusicEffect;
window.startManualPulse = startManualPulse;
window.stopManualPulse = stopManualPulse;


// Inicialización
document.addEventListener('DOMContentLoaded', async () => {
    console.log('DOM cargado');
    applyInterfaceMode(getSavedInterfaceMode());
  initializeTextEncodingGuards();
    showLoadingMessages();

    // Esperar a que los elementos de la pantalla de inicio de sesión están disponibles
    const waitForSignupElements = setInterval(() => {
        if (document.getElementById('skipSignup') && 
            document.getElementById('signupTab') && 
            document.getElementById('loginTab') &&
            document.getElementById('feedbackPromptLink') &&
            document.getElementById('openFeedbackFormBtn') &&
            document.getElementById('closeFeedbackPromptBtn')) {
            clearInterval(waitForSignupElements);
            handleSignup();
            setupFeedbackPrompt();
        }
    }, 100);

    await loadLibrary();
    await loadVisualSettings();
    
    // Aplicar color de acento inicial
    updateProgressBarsColor(state.visualSettings.accentColor);
    
    // Forzar aplicación de estilos después de un breve delay
    setTimeout(() => {
      updateProgressBarsColor(state.visualSettings.accentColor);
    }, 500);
    
    initializeSettings();
    initializeQueueControls();
    initializeUploadFunctionality();
    initializeNavigationLinks();
    
    // Event listeners para Mi Música
    document.getElementById('myMusicShuffleBtn')?.addEventListener('click', () => {
        shuffleMyMusic();
    });
    
    document.getElementById('uploadMusicBtn')?.addEventListener('click', () => {
        openUploadPage();
    });
    
    // Event listener para botón de prueba de notificaciones
    const testNotificationBtn = document.getElementById('testNotificationBtn');
    if (testNotificationBtn && !testNotificationBtn.dataset.bound) {
        testNotificationBtn.dataset.bound = 'true';
        testNotificationBtn.addEventListener('click', () => {
        console.log('Botón de prueba presionado');
        notificationSystem.info('¡Notificación de prueba!', 'success');
    });
    
    }
    // Event listener adicional para asegurar que funcione
    setTimeout(() => {
        const testBtn = document.getElementById('testNotificationBtn');
        if (testBtn) {
            testBtn.addEventListener('click', () => {
                console.log('Botón de prueba presionado (timeout)');
                notificationSystem.info('¡Notificación de prueba!', 'success');
            });
        }
    }, 1000);
    
    // Event listeners para Configuración
    // Inicializar configuración después de que el DOM está listo
    setTimeout(() => {
        initializeSettingsPage();
    }, 100);
    
    // Sistema de notificaciones - usando notification-system.js
    window.testNewNotifications = () => {
        console.log('[dev] Probando nuevo sistema de notificaciones');
        notificationSystem.success('¡Notificación de éxito!');
        setTimeout(() => notificationSystem.error('Error de prueba'), 1000);
        setTimeout(() => notificationSystem.warning('Advertencia de prueba'), 2000);
        setTimeout(() => notificationSystem.info('Información de prueba'), 3000);
    };
    
    // Prueba automática al cargar
    setTimeout(() => {
        notificationSystem.success('Sistema de notificaciones cargado');
    }, 1000);
    
    // Función de prueba para playlist
    window.testPlaylist = () => {
        console.log('[dev] Probando funcionalidad de playlist');
        const testTrack = {
            id: 'test123',
            title: 'Canción de Prueba',
            artist: 'Artista de Prueba',
            thumbnail: null,
            url: 'test-url',
            duration: '3:45'
        };
        showPlaylistSelector(testTrack);
    };
    
    // Función de prueba para eliminar playlist
    window.testDeletePlaylist = () => {
        console.log('[dev] Probando eliminación de playlist');
        if (state.playlists.length > 0) {
            const firstPlaylist = state.playlists[0];
            console.log('Eliminando playlist:', firstPlaylist);
            deletePlaylist(firstPlaylist);
        } else {
            notificationSystem.warning('No hay playlists para eliminar');
        }
    };
    
    // Función de prueba para ver playlist
    window.testViewPlaylist = () => {
        console.log('[dev] Probando visualización de playlist');
        if (state.playlists.length > 0) {
            const firstPlaylist = state.playlists[0];
            console.log('Viendo playlist:', firstPlaylist);
            loadPlaylistSongs(firstPlaylist.id);
        } else {
            notificationSystem.warning('No hay playlists para ver');
        }
    };
    
    // Función de prueba completa para playlist
    window.testFullPlaylist = async () => {
        console.log('[dev] Prueba completa de playlist');
        
        // 1. Crear una playlist de prueba
        const testPlaylist = {
            id: Date.now(),
            name: 'Playlist de Prueba',
            created_at: new Date().toISOString()
        };
        
        // 2. Crear canciones de prueba
        const testSongs = [
            {
                video_id: 'test1',
                title: 'Canción 1',
                artist: 'Artista 1',
                thumbnail: null,
                url: 'test-url-1',
                duration: '3:30'
            },
            {
                video_id: 'test2',
                title: 'Canción 2',
                artist: 'Artista 2',
                thumbnail: null,
                url: 'test-url-2',
                duration: '4:15'
            }
        ];
        
        // 3. Simular mostrar la playlist
        showPlaylistInLibrary(testPlaylist.id, testSongs);
        
        notificationSystem.success('Prueba de playlist completada');
    };
    
    // Función de prueba para verificar que las funciones globales funcionen
    window.testPlaylistFunctions = () => {
        console.log('[dev] Probando funciones de playlist');
        console.log('playSong:', typeof window.playSong);
        console.log('toggleFavorite:', typeof window.toggleFavorite);
        console.log('addToQueue:', typeof window.addToQueue);
        console.log('showNormalLibrary:', typeof window.showNormalLibrary);
        notificationSystem.info('Funciones verificadas - revisa la consola');
    };
    
    // Función de prueba para el botón de regreso
    window.testBackButton = () => {
        console.log('[dev] Probando botón de regreso');
        showNormalLibrary();
        notificationSystem.success('Botón de regreso probado');
    };
    
    // Función de prueba para el ecualizador
    window.testEqualizer = () => {
        console.log('[dev] Probando ecualizador');
        const equalizerBtn = document.getElementById('openEqualizerBtn');
        if (equalizerBtn) {
            equalizerBtn.click();
            notificationSystem.success('Ecualizador abierto');
            
            // Probar visualizador después de un momento
            setTimeout(() => {
                updateEqualizerVisualizer();
                console.log('? Visualizador actualizado');
            }, 100);
        } else {
            notificationSystem.error('Botón de ecualizador no encontrado');
        }
    };
    
    // Función para probar la lógica de las barras
    window.testEqualizerBars = () => {
        console.log('[dev] Probando lógica INVERTIDA de barras del ecualizador');
        
        // Probar diferentes valores con la nueva lógica invertida
        const testValues = [-12, -6, 0, 6, 12];
        testValues.forEach(value => {
            const normalizedValue = (12 - value) / 24; // Lógica invertida
            const height = Math.max(2, normalizedValue * 100);
            console.log(`Valor: ${value}dB -> Normalizado: ${normalizedValue.toFixed(2)} -> Altura: ${height.toFixed(1)}%`);
        });
        
        console.log('[dev] Resultado esperado:');
        console.log('-12dB = 100% (barra alta)');
        console.log('0dB = 50% (barra media)');
        console.log('+12dB = 0% (barra baja)');
    };
    
    // Función para probar los temas
    window.testThemes = () => {
        console.log('[dev] Probando temas');
        
        // Probar tema claro
        console.log('[dev] Aplicando tema claro...');
        state.visualSettings.theme = 'light';
        applyTheme('light');
        notificationSystem.success('Tema claro aplicado');
        
        setTimeout(() => {
            // Probar tema oscuro
            console.log('[dev] Aplicando tema oscuro...');
            state.visualSettings.theme = 'dark';
            applyTheme('dark');
            notificationSystem.success('Tema oscuro aplicado');
            
            setTimeout(() => {
                // Probar tema personalizado
                console.log('[dev] Aplicando tema personalizado...');
                state.visualSettings.theme = 'custom';
                applyTheme('custom');
                notificationSystem.success('Tema personalizado aplicado');
            }, 1000);
        }, 1000);
    };
    
    // Función para probar colores de acento
    window.testAccentColors = () => {
        console.log('[dev] Probando colores de acento');
        
        const colors = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57', '#ff9ff3'];
        let index = 0;
        
        const changeColor = () => {
            if (index < colors.length) {
                const color = colors[index];
                console.log(`[dev] Aplicando color: ${color}`);
                updateProgressBarsColor(color);
                notificationSystem.info(`Color aplicado: ${color}`);
                index++;
                setTimeout(changeColor, 1000);
            } else {
                notificationSystem.success('Prueba de colores completada');
            }
        };
        
        changeColor();
    };
    
    // Función de prueba para verificar contadores
    window.testPlaylistCounts = async () => {
        console.log('[dev] Probando contadores de playlist');
        for (const playlist of state.playlists) {
            await loadPlaylistCount(playlist.id);
        }
        notificationSystem.success('Contadores actualizados');
    };
    
    // Hacer funciones globales para los botones de las tarjetas
    window.showNormalLibrary = showNormalLibrary;
    window.playSong = playSong;
    window.toggleFavorite = toggleFavorite;
    window.addToQueue = addToQueue;
});

// Control de reproducción
if (elements.playPauseButton) {
  elements.playPauseButton.addEventListener('click', togglePlayPause);
}
if (elements.nextButton) {
  elements.nextButton.addEventListener('click', playNext);
}
if (elements.previousButton) {
  elements.previousButton.addEventListener('click', playPrevious);
}
if (elements.shuffleButton) {
  elements.shuffleButton.addEventListener('click', toggleShuffle);
}
if (elements.repeatButton) {
  elements.repeatButton.addEventListener('click', toggleRepeat);
}
if (elements.lyricsButton) {
  elements.lyricsButton.addEventListener('click', handleLyricsButtonClick);
}
if (elements.miniPlayerButton) {
  elements.miniPlayerButton.addEventListener('click', handleMiniPlayerButtonClick);
}
if (elements.nowPlayingQueueButton) {
  elements.nowPlayingQueueButton.addEventListener('click', toggleNowPlayingQueue);
}
if (elements.volumeButton) {
  elements.volumeButton.addEventListener('click', toggleMute);
}
if (elements.volumeProgress) {
  elements.volumeProgress.parentElement.addEventListener('click', handleVolumeChange);
  elements.volumeProgress.parentElement.addEventListener('mousedown', handleVolumeDrag);
}

// Event listener para el toggle del espectrograma
if (elements.visualizerToggle && !elements.visualizerToggle.dataset.bound) {
  elements.visualizerToggle.dataset.bound = 'true';
  elements.visualizerToggle.addEventListener('change', (e) => {
    toggleVisualizer(e.target.checked);
    console.log('Espectrograma visual:', state.visualSettings.showVisualizer ? 'activado' : 'desactivado');
  });
}
if (elements.progressBar) {
  const progressContainer = elements.progressBar.parentElement || elements.progressBar;
  progressContainer.addEventListener('click', handleProgressBarClick);
  progressContainer.addEventListener('mousedown', handleProgressBarDragStart);
  progressContainer.addEventListener('touchstart', handleProgressBarDragStart, { passive: false });
}
if (elements.closeLyricsButton) {
  elements.closeLyricsButton.addEventListener('click', closeLyricsModal);
}
if (elements.lyricsModalBackdrop) {
  elements.lyricsModalBackdrop.addEventListener('click', closeLyricsModal);
}

if (elements.lyricsModal && elements.lyricsModal.parentElement !== document.body) {
  document.body.appendChild(elements.lyricsModal);
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.lyrics.isOpen) {
    closeLyricsModal();
  }
});

syncLyricsModalTrackInfo();
resetLyricsStateForTrack();
setNowPlayingState(state.currentTrack ? (state.isPlaying ? 'playing' : 'paused') : 'empty');
updateNowPlayingQueueButton();
updateVolumeUI();

ipcRenderer.on('player:toggle', () => {
  togglePlayPause();
});

ipcRenderer.on('player:previous', () => {
  playPrevious();
});

ipcRenderer.on('player:next', () => {
  playNext();
});

ipcRenderer.on('player:set-volume', (event, value) => {
  setPlayerVolumeFromExternal(value);
});

ipcRenderer.on('player:seek-to', (event, value) => {
  seekPlayerToTime(value);
});

ipcRenderer.on('mini-player:closed', () => {
  state.playbackSettings.miniPlayer = false;
  localStorage.setItem('miniPlayer', 'false');
  stopMiniPlayerTelemetry();
  applyPremiumUiPreferences();
  refreshPremiumSettingsUI();
  saveSettings();
});

ipcRenderer.on('birthday-video:play', () => {
  showBirthdayVideo();
});

function initializeSettings() {
  // Configuración de eventos para la sección avanzada
  if (false && elements.crossfadeSlider) {
    elements.crossfadeSlider.addEventListener('input', () => {
      state.audioSettings.crossfade = parseInt(elements.crossfadeSlider.value);
      elements.crossfadeValue.textContent = `${state.audioSettings.crossfade}s`;
      saveSettings();
    });
  }

  if (false && elements.normalizeVolumeToggle) {
    elements.normalizeVolumeToggle.addEventListener('change', () => {
      state.audioSettings.normalizeVolume = elements.normalizeVolumeToggle.checked;
      applyVolumeNormalization();
      saveSettings();
    });
  }

  if (elements.gifToggle && !elements.gifToggle.dataset.bound) {
    elements.gifToggle.dataset.bound = 'true';
    elements.gifToggle.addEventListener('change', (e) => {
      state.settings.showGif = e.target.checked;
      const gifSettings = document.querySelector('.gif-settings-card');
      if (gifSettings) {
        gifSettings.style.display = e.target.checked ? 'block' : 'none';
      }
      if (!e.target.checked) {
        hidePlayingGif();
      } else if (state.isPlaying && state.settings.gifUrl) {
        showPlayingGif();
      }
      saveSettings();
      console.log('Cambio en toggle GIF:', state.settings.showGif);
    });
  }

  if (elements.themeSelector) {
    elements.themeSelector.addEventListener('change', () => {
      state.visualSettings.theme = elements.themeSelector.value;
      applyTheme(state.visualSettings.theme);
      saveSettings();
    });
  }

  if (elements.visualizerOpacitySlider) {
    elements.visualizerOpacitySlider.classList.add('modern-slider');
    elements.visualizerOpacitySlider.addEventListener('input', (e) => {
      applySpectrogramOpacity(Number(e.target.value) / 100, { persist: false });
    });

    elements.visualizerOpacitySlider.addEventListener('change', (e) => {
      applySpectrogramOpacity(Number(e.target.value) / 100);
    });
  }

  if (false && elements.accentColorPicker) {
    let colorTimeout = null;
    
    elements.accentColorPicker.addEventListener('input', () => {
      const color = elements.accentColorPicker.value;
      
      // Actualizar color inmediatamente para feedback visual
      updateProgressBarsColor(color);
      
      // Throttle para guardar configuración
      if (colorTimeout) {
        clearTimeout(colorTimeout);
      }
      
      colorTimeout = setTimeout(() => {
        saveSettings();
      }, 500); // 500ms de delay para guardar
    });
  }

  if (false && elements.autoplayToggle) {
    elements.autoplayToggle.addEventListener('change', () => {
      state.playbackSettings.autoplay = elements.autoplayToggle.checked;
      saveSettings();
    });
  }

  if (false && elements.autoQueueToggle) {
    elements.autoQueueToggle.addEventListener('change', () => {
      state.playbackSettings.autoQueue = elements.autoQueueToggle.checked;
      saveSettings();
    });
  }

  if (elements.usernameInput) {
    elements.usernameInput.addEventListener('change', () => {
      state.account.username = elements.usernameInput.value;
      const user = JSON.parse(localStorage.getItem('user') || '{}');
      localStorage.setItem('user', JSON.stringify({ ...user, username: state.account.username }));
    });
  }

  if (elements.emailInput) {
    elements.emailInput.addEventListener('change', () => {
      state.account.email = elements.emailInput.value;
      const user = JSON.parse(localStorage.getItem('user') || '{}');
      localStorage.setItem('user', JSON.stringify({ ...user, email: state.account.email }));
    });
  }

  if (elements.changePasswordBtn && !elements.changePasswordBtn.dataset.passwordHandlerBound) {
  elements.changePasswordBtn.dataset.passwordHandlerBound = 'modal';
  elements.changePasswordBtn.addEventListener('click', () => {
    const modal = document.createElement('div');
    modal.className = 'playlist-modal';
    modal.innerHTML = `
      <div class="modal-content">
        <h3>Cambiar Contraseña</h3>
        <input type="password" id="newPassword" placeholder="Nueva contraseña" class="search-input">
        <input type="password" id="confirmPassword" placeholder="Confirmar contraseña" class="search-input">
        <button id="confirmPasswordChange">Confirmar</button>
        <button class="close-modal">Cancelar</button>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('confirmPasswordChange').addEventListener('click', async () => {
      const newPassword = document.getElementById('newPassword').value;
      const confirmPassword = document.getElementById('confirmPassword').value;
      if (newPassword && newPassword === confirmPassword) {
        try {
          const hashedPassword = await bcrypt.hash(newPassword, saltRounds);
          const user = JSON.parse(localStorage.getItem('user') || '{}');
          localStorage.setItem('user', JSON.stringify({ ...user, password: hashedPassword }));
          notificationSystem.info('Contraseña actualizada');
          modal.remove();
        } catch (error) {
          console.error('Error al cambiar contraseña:', error);
          notificationSystem.info('Error al cambiar la contraseña');
        }
      } else {
        notificationSystem.info('Las contraseñas no coinciden o están vacías');
      }
    });

    modal.querySelector('.close-modal').addEventListener('click', () => modal.remove());
  });
}

  if (elements.exportDataBtn && !elements.exportDataBtn.dataset.bound) {
    elements.exportDataBtn.dataset.bound = 'true';
    elements.exportDataBtn.addEventListener('click', async () => {
      try {
        const data = {
          library: await ipcRenderer.invoke('get-library'),
          playlists: await ipcRenderer.invoke('get-playlists'),
          settings: JSON.parse(localStorage.getItem('appSettings') || '{}'),
          user: JSON.parse(localStorage.getItem('user') || '{}')
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'rokmusic_data.json';
        a.click();
        URL.revokeObjectURL(url);
        notificationSystem.info('Datos exportados correctamente');
      } catch (error) {
        console.error('Error al exportar datos:', error);
        notificationSystem.info('Error al exportar datos');
      }
    });
  }

  if (elements.importDataBtn && !elements.importDataBtn.dataset.bound) {
    elements.importDataBtn.dataset.bound = 'true';
    elements.importDataBtn.addEventListener('click', () => {
      elements.importDataInput.click();
    });
  }


  if (elements.importDataInput && !elements.importDataInput.dataset.bound) {
    elements.importDataInput.dataset.bound = 'true';
    elements.importDataInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file && file.type === 'application/json') {
        const reader = new FileReader();
        reader.onload = async (event) => {
          try {
            const data = JSON.parse(event.target.result);
            if (data.library) {
              for (const track of data.library) {
                await ipcRenderer.invoke('add-to-library', track);
              }
            }
            if (data.playlists) {
              for (const playlist of data.playlists) {
                await ipcRenderer.invoke('create-playlist', playlist.name);
              }
            }
            if (data.settings) {
              localStorage.setItem('appSettings', JSON.stringify(data.settings));
            }
            if (data.user) {
              localStorage.setItem('user', JSON.stringify(data.user));
              state.account = { username: data.user.username || '', email: data.user.email || '' };
            }
            await loadLibrary();
            await loadVisualSettings();
            notificationSystem.info('Datos importados correctamente');
          } catch (error) {
            console.error('Error al importar datos:', error);
            notificationSystem.info('Error al importar datos');
          }
        };
        reader.readAsText(file);
      }
    });
  }

  if (elements.deleteAllDataBtn && !elements.deleteAllDataBtn.dataset.bound) {
      elements.deleteAllDataBtn.dataset.bound = 'true';
      elements.deleteAllDataBtn.addEventListener('click', () => {
          showDeleteConfirmationModal();
      });
  }

  if (elements.openEqualizerBtn) {
    elements.openEqualizerBtn.addEventListener('click', () => {
      openLuxuryEqualizer();
      return;
      const modal = document.createElement('div');
      modal.className = 'equalizer-modal';
      
      const frequencies = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
      const labels = ['60Hz', '170Hz', '310Hz', '600Hz', '1kHz', '3kHz', '6kHz', '12kHz', '14kHz', '16kHz'];
      
      modal.innerHTML = `
        <div class="equalizer-content">
          <div class="equalizer-header">
            <h3 class="equalizer-title">
              <i class="fas fa-sliders-h"></i>
              Ecualizador
            </h3>
          </div>
          
          <div class="equalizer-presets">
            <button class="equalizer-preset-btn" data-preset="flat">Flat</button>
            <button class="equalizer-preset-btn" data-preset="rock">Rock</button>
            <button class="equalizer-preset-btn" data-preset="pop">Pop</button>
            <button class="equalizer-preset-btn" data-preset="jazz">Jazz</button>
            <button class="equalizer-preset-btn" data-preset="classical">Classical</button>
            <button class="equalizer-preset-btn" data-preset="electronic">Electronic</button>
            <button class="equalizer-preset-btn" data-preset="vocal">Vocal</button>
          </div>
          
          <div class="equalizer-main">
            <div class="equalizer-sliders">
              ${frequencies.map((freq, index) => `
                <div class="equalizer-slider">
                  <div class="slider-track">
                    <input type="range" min="-12" max="12" value="${state.audioSettings.equalizer[freq]}" data-frequency="${freq}" step="0.5" class="slider-input">
                  </div>
                  <div class="slider-value">${state.audioSettings.equalizer[freq]}dB</div>
                  <label class="slider-label">${labels[index]}</label>
                </div>
              `).join('')}
            </div>
            
            <div class="equalizer-visualizer" id="equalizerVisualizer">
              <!-- Las barras se crearán dinámicamente -->
            </div>
          </div>
          
          <div class="equalizer-controls">
            <button class="equalizer-reset-btn">
              <i class="fas fa-undo"></i> Resetear
            </button>
            <button class="equalizer-close-btn">
              <i class="fas fa-check"></i> Aplicar
            </button>
          </div>
        </div>
      `;
      
      document.body.appendChild(modal);
      
      // Presets del ecualizador
      const presets = {
        flat: { 60: 0, 170: 0, 310: 0, 600: 0, 1000: 0, 3000: 0, 6000: 0, 12000: 0, 14000: 0, 16000: 0 },
        rock: { 60: 4, 170: 2, 310: -2, 600: -1, 1000: 1, 3000: 3, 6000: 2, 12000: 1, 14000: 0, 16000: 0 },
        pop: { 60: 2, 170: 1, 310: 0, 600: 1, 1000: 2, 3000: 1, 6000: 0, 12000: -1, 14000: -1, 16000: -2 },
        jazz: { 60: 1, 170: 0, 310: 1, 600: 2, 1000: 1, 3000: 0, 6000: 1, 12000: 2, 14000: 1, 16000: 0 },
        classical: { 60: 0, 170: 0, 310: 0, 600: 0, 1000: 0, 3000: 0, 6000: 0, 12000: 0, 14000: 0, 16000: 0 },
        electronic: { 60: 6, 170: 4, 310: 2, 600: 0, 1000: 0, 3000: 2, 6000: 4, 12000: 3, 14000: 2, 16000: 1 },
        vocal: { 60: -2, 170: -1, 310: 2, 600: 3, 1000: 2, 3000: 1, 6000: 0, 12000: -1, 14000: -2, 16000: -3 }
      };
      
      // Event listeners para presets
      modal.querySelectorAll('.equalizer-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const preset = btn.dataset.preset;
          const presetValues = presets[preset];
          
          // Actualizar todos los sliders
          modal.querySelectorAll('.slider-input').forEach(slider => {
            const freq = parseInt(slider.dataset.frequency);
            slider.value = presetValues[freq];
            const valueElement = slider.closest('.equalizer-slider').querySelector('.slider-value');
            valueElement.textContent = `${presetValues[freq]}dB`;
          });
          
          // Actualizar estado
          state.audioSettings.equalizer = { ...presetValues };
          applyEqualizerSettings();
          saveSettings();
          
          // Actualizar visualización
          updateEqualizerVisualizer();
          
          // Marcar preset activo
          modal.querySelectorAll('.equalizer-preset-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });
      
      // Event listeners para sliders con actualización en tiempo real
      modal.querySelectorAll('.slider-input').forEach(slider => {
        let sliderTimeout = null;
        
        slider.addEventListener('input', (e) => {
          const freq = parseInt(e.target.dataset.frequency);
          const value = parseFloat(e.target.value);
          
          // Actualizar valor inmediatamente para feedback visual
          state.audioSettings.equalizer[freq] = value;
          const valueElement = e.target.closest('.equalizer-slider').querySelector('.slider-value');
          valueElement.textContent = `${value}dB`;
          
          // Actualizar visualizador en tiempo real
          updateEqualizerVisualizer();
          
          // Throttle solo para operaciones pesadas
          if (sliderTimeout) {
            clearTimeout(sliderTimeout);
          }
          
          sliderTimeout = setTimeout(() => {
            applyEqualizerSettings();
            saveSettings();
          }, 200); // 200ms de delay solo para operaciones pesadas
          
          // Desmarcar presets cuando se ajusta manualmente
          modal.querySelectorAll('.equalizer-preset-btn').forEach(b => b.classList.remove('active'));
        });
      });
      
      // Usar la función global updateEqualizerVisualizer
      
      // Botón resetear
      modal.querySelector('.equalizer-reset-btn').addEventListener('click', () => {
        const flatPreset = presets.flat;
        modal.querySelectorAll('.slider-input').forEach(slider => {
          const freq = parseInt(slider.dataset.frequency);
          slider.value = flatPreset[freq];
          const valueElement = slider.closest('.equalizer-slider').querySelector('.slider-value');
          valueElement.textContent = `${flatPreset[freq]}dB`;
        });
        
        state.audioSettings.equalizer = { ...flatPreset };
        applyEqualizerSettings();
        saveSettings();
        updateEqualizerVisualizer();
        
        modal.querySelectorAll('.equalizer-preset-btn').forEach(b => b.classList.remove('active'));
        modal.querySelector('[data-preset="flat"]').classList.add('active');
      });
      
      // Botón cerrar/aplicar
      modal.querySelector('.equalizer-close-btn').addEventListener('click', () => {
        modal.remove();
      });
      
      // Inicializar visualizador
      updateEqualizerVisualizer();
      
      // Cerrar con Escape
      const handleEscape = (e) => {
        if (e.key === 'Escape') {
          modal.remove();
          document.removeEventListener('keydown', handleEscape);
        }
      };
      document.addEventListener('keydown', handleEscape);
      
      // Inicializar visualización
      updateEqualizerVisualizer();
    });
  }

  console.log('Configuraciones inicializadas');
}

function initializeQueueControls() {
  const queueLoopButton = document.getElementById('queueLoopButton');
  const clearQueueButton = document.getElementById('clearQueueButton');
  
  if (queueLoopButton) {
    queueLoopButton.addEventListener('click', toggleQueueLoop);
  }
  if (clearQueueButton) {
    clearQueueButton.addEventListener('click', clearQueue);
  }
  console.log('Controles de cola inicializados');
}

function formatTime(seconds) {
  if (typeof seconds === 'string' && seconds.includes(':')) {
    return seconds;
  }
  const numericSeconds = Number(seconds);
  if (!Number.isFinite(numericSeconds) || numericSeconds < 0) {
    return '0:00';
  }
  const mins = Math.floor(numericSeconds / 60);
  const secs = Math.floor(numericSeconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function isShortcutTypingTarget(target) {
  if (!target) return false;
  const tagName = target.tagName;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName);
}

function seekCurrentTrack(seconds) {
  if (!elements.audio || !state.currentTrack) return;
  const duration = Number(elements.audio.duration);
  const nextTime = Math.max(0, Math.min(
    Number(elements.audio.currentTime || 0) + seconds,
    Number.isFinite(duration) && duration > 0 ? duration : Number.MAX_SAFE_INTEGER
  ));
  elements.audio.currentTime = nextTime;
  updateProgressUI();
}

// Atajos de teclado
document.addEventListener('keydown', (e) => {
  if (isShortcutTypingTarget(e.target)) return;
  if (document.querySelector('.keyboard-shortcuts-modal')) return;
  if (e.repeat && ['Space', 'KeyK', 'KeyM', 'KeyS', 'KeyR', 'KeyQ', 'KeyL'].includes(e.code)) return;

  const withModifier = e.ctrlKey || e.metaKey;

  if (e.code === 'Space' || e.code === 'KeyK') {
    e.preventDefault();
    togglePlayPause();
    console.log('Atajo de teclado reproducir/pausar activado');
    return;
  }

  if (e.code === 'ArrowRight') {
    e.preventDefault();
    if (withModifier) {
      playNext();
    } else {
      seekCurrentTrack(5);
    }
    return;
  }

  if (e.code === 'ArrowLeft') {
    e.preventDefault();
    if (withModifier) {
      playPrevious();
    } else {
      seekCurrentTrack(-5);
    }
    return;
  }

  if (e.code === 'KeyN') {
    e.preventDefault();
    playNext();
    return;
  }

  if (e.code === 'KeyP') {
    e.preventDefault();
    playPrevious();
    return;
  }

  if (e.code === 'KeyM') {
    e.preventDefault();
    toggleMute();
    return;
  }

  if (e.code === 'KeyS') {
    e.preventDefault();
    toggleShuffle();
    return;
  }

  if (e.code === 'KeyR') {
    e.preventDefault();
    toggleRepeat();
    return;
  }

  if (e.code === 'KeyQ') {
    e.preventDefault();
    toggleNowPlayingQueue();
    return;
  }

  if (e.code === 'KeyL') {
    e.preventDefault();
    handleLyricsButtonClick();
    return;
  }

  if ((e.code === 'Slash' && e.shiftKey) || e.code === 'F1') {
    e.preventDefault();
    showKeyboardShortcutsModal();
  }
});

// Configuración Moderna - Funciones Principales
function initializeSettingsPage() {
  console.log('Inicializando página de configuración moderna');
  renderPremiumSettingsShell();
  refreshSettingsElementReferences();
  
  // Verificar que los elementos existan antes de inicializar
  const settingsNav = document.querySelector('.settings-nav');
  if (!settingsNav) {
    console.warn('Navegación de configuración no encontrada, saltando inicialización');
    return;
  }
  
  // Navegación de configuración
  const legacyCreditsCard = document.getElementById('creditsBtn')?.closest('.setting-card');
  if (legacyCreditsCard) {
    legacyCreditsCard.remove();
  }

  initializeSettingsNavigation();
  
  // Controles de configuración
  initializeSettingsControls();
  initializeSettingsButtons();
  
  // Cargar configuración inicial
  loadSettingsValues();
}

function initializeSettingsNavigation() {
  const navButtons = document.querySelectorAll('.settings-nav-btn');
  
  navButtons.forEach(button => {
    if (button.dataset.bound) return;
    button.dataset.bound = 'true';
    button.addEventListener('click', () => {
      const section = button.getAttribute('data-section');
      switchSettingsSection(section);
    });
  });
}

function switchSettingsSection(sectionName) {
  console.log('Cambiando a sección de configuración:', sectionName);
  
  // Ocultar todas las secciones
  document.querySelectorAll('.settings-section').forEach(section => {
    section.classList.remove('active');
  });
  
  // Remover active de todos los nav buttons
  document.querySelectorAll('.settings-nav-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  
  // Mostrar sección seleccionada
  const targetSection = document.getElementById(`${sectionName}Section`);
  const targetNavBtn = document.querySelector(`[data-section="${sectionName}"]`);
  
  if (targetSection) {
    targetSection.classList.add('active');
  }
  
  if (targetNavBtn) {
    targetNavBtn.classList.add('active');
  }
  
  // Recargar contenido dinámico cuando se cambia a las secciones correspondientes
  if (sectionName === 'data') {
    setTimeout(() => {
      if (typeof loadStatsContent === 'function') {
        loadStatsContent();
      }
    }, 100);
  } else if (sectionName === 'storage') {
    setTimeout(() => {
      if (typeof loadStatsContent === 'function') loadStatsContent();
      loadAudioCacheLibrary().catch(() => {});
    }, 100);
  } else if (sectionName === 'developer' || sectionName === 'experimental' || sectionName === 'advanced') {
    setTimeout(() => {
      if (typeof loadAppInfoContent === 'function') {
        loadAppInfoContent();
        attachCreditsButtonToAppInfoCard();
      }
    }, 100);
  }
}

function initializeSettingsControls() {
  // Antes esto fallaba porque el mismo ajuste se registraba varias veces en distintas zonas
  // del archivo: el estado se invertía, se guardaba por duplicado y la UI no reflejaba el valor real.
  const smartShuffleToggle = document.getElementById('smartShuffleToggle');
  const normalizeVolumeToggle = document.getElementById('normalizeVolumeToggle');
  const colorPresets = document.querySelectorAll('.color-preset');
  const colorPicker = document.getElementById('accentColorPicker');
  const selects = document.querySelectorAll('.modern-select');
  const defaultVolumeSlider = document.getElementById('defaultVolumeSlider');
  const defaultVolumeValue = document.getElementById('defaultVolumeValue');
  const developerToolActions = document.querySelector('.developer-tool-actions');

  void developerToolActions;

  document.querySelectorAll('.volume-preset-btn').forEach((button) => {
    if (button.dataset.bound) return;
    button.dataset.bound = 'true';
    button.addEventListener('click', () => {
      setDefaultVolume(button.dataset.volume);
    });
  });

  if (defaultVolumeSlider && !defaultVolumeSlider.dataset.bound) {
    defaultVolumeSlider.dataset.bound = 'true';
    // Este control fallaba por dos motivos:
    // 1. Había listeners duplicados que pisaban `state.volume`.
    // 2. El slider nunca actualizaba su progreso visual, por eso parecía trabado.
    const syncDefaultVolume = (rawValue) => {
      const value = Number(rawValue);
      state.playbackSettings.defaultVolume = value;
      state.volume = value / 100;
      localStorage.setItem('defaultVolume', String(value));
      if (defaultVolumeValue) defaultVolumeValue.textContent = `${value}%`;
      updateSliderProgress(defaultVolumeSlider);
      if (elements.audio) {
        elements.audio.volume = state.volume;
        updateVolumeUI();
      }
      saveSettings();
    };

    defaultVolumeSlider.addEventListener('input', (e) => syncDefaultVolume(e.target.value));
    defaultVolumeSlider.addEventListener('change', (e) => syncDefaultVolume(e.target.value));
    updateSliderProgress(defaultVolumeSlider);
  }

  initializeModernRangeSliderInteractions();

  if (elements.autoplayToggle && !elements.autoplayToggle.dataset.bound) {
    elements.autoplayToggle.dataset.bound = 'true';
    elements.autoplayToggle.addEventListener('change', (e) => {
      state.playbackSettings.autoplay = e.target.checked;
      localStorage.setItem('autoplay', String(e.target.checked));
      saveSettings();
      notificationSystem.info(e.target.checked ? 'Reproducción automática activada' : 'Reproducción automática desactivada');
    });
  }

  if (elements.autoQueueToggle && !elements.autoQueueToggle.dataset.bound) {
    elements.autoQueueToggle.dataset.bound = 'true';
    elements.autoQueueToggle.addEventListener('change', async (e) => {
      state.playbackSettings.autoQueue = e.target.checked;
      localStorage.setItem('autoQueue', String(e.target.checked));
      saveSettings();
      if (e.target.checked) {
        const added = await ensureAutoQueueSeed(3);
        notificationSystem.info(added > 0 ? 'Cola automática preparada' : 'Cola automática activada');
      } else {
        notificationSystem.info('Cola automática desactivada');
      }
    });
  }

  if (smartShuffleToggle && !smartShuffleToggle.dataset.bound) {
    smartShuffleToggle.dataset.bound = 'true';
    smartShuffleToggle.addEventListener('change', (e) => {
      state.playbackSettings.smartShuffle = e.target.checked;
      localStorage.setItem('smartShuffle', String(e.target.checked));
      saveSettings();
      notificationSystem.info(e.target.checked ? 'Mezcla inteligente activada' : 'Mezcla inteligente desactivada');
    });
  }

  if (normalizeVolumeToggle && !normalizeVolumeToggle.dataset.bound) {
    normalizeVolumeToggle.dataset.bound = 'true';
    normalizeVolumeToggle.addEventListener('change', (e) => {
      state.audioSettings.normalizeVolume = e.target.checked;
      localStorage.setItem('normalizeVolume', String(e.target.checked));
      applyVolumeNormalization();
      saveSettings();
    });
  }

  if (elements.visualizerToggle && !elements.visualizerToggle.dataset.bound) {
    elements.visualizerToggle.dataset.bound = 'true';
    elements.visualizerToggle.addEventListener('change', (e) => {
      toggleVisualizer(e.target.checked);
    });
  }

  if (elements.gifToggle && !elements.gifToggle.dataset.bound) {
    elements.gifToggle.dataset.bound = 'true';
    elements.gifToggle.addEventListener('change', (e) => {
      state.settings.showGif = e.target.checked;
      const gifSettings = document.querySelector('.gif-settings-card');
      if (gifSettings) {
        gifSettings.style.display = e.target.checked ? 'block' : 'none';
      }
      if (!e.target.checked) {
        hidePlayingGif();
      } else if (state.isPlaying && state.settings.gifUrl) {
        showPlayingGif();
      }
      saveSettings();
    });
  }

  if (elements.developerModeToggle && !elements.developerModeToggle.dataset.bound) {
    elements.developerModeToggle.dataset.bound = 'true';
    elements.developerModeToggle.addEventListener('change', (e) => {
      state.developerSettings.enabled = e.target.checked;
      localStorage.setItem('developerMode', String(e.target.checked));
      refreshDeveloperModeUI();
      saveSettings();
    });
  }

  if (elements.audioCacheToggle && !elements.audioCacheToggle.dataset.bound) {
    elements.audioCacheToggle.dataset.bound = 'true';
    elements.audioCacheToggle.addEventListener('change', async (e) => {
      localStorage.setItem('audioCache', String(e.target.checked));
      const size = parseInt(localStorage.getItem('audioCacheSizeMB') || '500', 10);
      await ipcRenderer.invoke('set-cache-settings', { enabled: e.target.checked, maxSizeMB: size }).catch(() => {});
      refreshDeveloperModeUI();
    });
  }

  if (elements.clearAudioCacheBtn && !elements.clearAudioCacheBtn.dataset.bound) {
    elements.clearAudioCacheBtn.dataset.bound = 'true';
    elements.clearAudioCacheBtn.addEventListener('click', async () => {
      await ipcRenderer.invoke('clear-audio-cache');
      refreshDeveloperModeUI();
      notificationSystem.success('Caché de audio vaciada');
    });
  }

  if (elements.internetAccessToggle && !elements.internetAccessToggle.dataset.bound) {
    elements.internetAccessToggle.dataset.bound = 'true';
    elements.internetAccessToggle.addEventListener('change', async (e) => {
      state.developerSettings.internetEnabled = e.target.checked;
      await ipcRenderer.invoke('set-network-access', e.target.checked);
      if (!e.target.checked) {
        state.searchResults = [];
        hideSuggestions();
        showErrorState('Modo offline de desarrollo activo. La busqueda remota esta bloqueada.');
      }
      refreshDeveloperModeUI();
      saveSettings();
      notificationSystem.info(e.target.checked ? 'Acceso a internet activado' : 'Acceso a internet desactivado');
    });
  }

  if (elements.verbosePlayerLogsToggle && !elements.verbosePlayerLogsToggle.dataset.bound) {
    elements.verbosePlayerLogsToggle.dataset.bound = 'true';
    elements.verbosePlayerLogsToggle.addEventListener('change', (e) => {
      state.developerSettings.verbosePlayerLogs = e.target.checked;
      localStorage.setItem('verbosePlayerLogs', String(e.target.checked));
      saveSettings();
    });
  }

  if (elements.openDevToolsBtn && !elements.openDevToolsBtn.dataset.bound) {
    elements.openDevToolsBtn.dataset.bound = 'true';
    elements.openDevToolsBtn.addEventListener('click', () => {
      ipcRenderer.invoke('open-devtools');
    });
  }

  const devTestNotificationBtn = document.getElementById('devTestNotificationBtn');
  if (devTestNotificationBtn && !devTestNotificationBtn.dataset.bound) {
    devTestNotificationBtn.dataset.bound = 'true';
    devTestNotificationBtn.addEventListener('click', () => {
      notificationSystem.success('Notificación de prueba');
    });
  }

  if (elements.copyDiagnosticsBtn && !elements.copyDiagnosticsBtn.dataset.bound) {
    elements.copyDiagnosticsBtn.dataset.bound = 'true';
    elements.copyDiagnosticsBtn.addEventListener('click', async () => {
      const diagnostics = {
        currentTrack: state.currentTrack ? {
          title: state.currentTrack.title,
          artist: state.currentTrack.artist,
          id: state.currentTrack.id || state.currentTrack.video_id
        } : null,
        isPlaying: state.isPlaying,
        volume: state.volume,
        playbackSettings: state.playbackSettings,
        developerSettings: state.developerSettings,
        streamingQuality: state.audioSettings.streamingQuality || 'medium',
        audioExtractor: state.developerSettings.audioExtractor || 'auto',
        lastStreamingProfile: state.audioSettings.lastStreamingProfile || null,
        audioCacheEnabled: localStorage.getItem('audioCache') === 'true'
      };
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      notificationSystem.success('Diagnóstico copiado al portapapeles');
    });
  }

  if (elements.clearSearchHistoryBtn && !elements.clearSearchHistoryBtn.dataset.bound) {
    elements.clearSearchHistoryBtn.dataset.bound = 'true';
    elements.clearSearchHistoryBtn.addEventListener('click', () => {
      clearSearchHistory();
      notificationSystem.success('Historial de busqueda vaciado');
    });
  }

  if (elements.clearRecentTracksBtn && !elements.clearRecentTracksBtn.dataset.bound) {
    elements.clearRecentTracksBtn.dataset.bound = 'true';
    elements.clearRecentTracksBtn.addEventListener('click', () => {
      state.recentlyPlayed = [];
      localStorage.setItem('recentlyPlayed', '[]');
      if (typeof loadRecommendations === 'function') {
        loadRecommendations();
      }
      notificationSystem.success('Canciones recientes vaciadas');
    });
  }

  if (elements.resetPlayerStateBtn && !elements.resetPlayerStateBtn.dataset.bound) {
    elements.resetPlayerStateBtn.dataset.bound = 'true';
    elements.resetPlayerStateBtn.addEventListener('click', () => {
      if (elements.audio) {
        elements.audio.pause();
        elements.audio.currentTime = 0;
      }
      state.isPlaying = false;
      state.queue = [];
      state.currentIndex = -1;
      stopSpectrogram();
      updatePlayingUI(false);
      updateQueueUI();
      state.audioSettings.lastStreamingProfile = null;
      updateStreamingQualityStatus(null);
      notificationSystem.success('Reproductor reseteado para pruebas');
    });
  }

  const themeOptions = document.querySelectorAll('.theme-option');
  themeOptions.forEach(option => {
    if (option.dataset.bound) return;
    option.dataset.bound = 'true';
    option.addEventListener('click', () => {
      themeOptions.forEach(opt => opt.classList.remove('active'));
      option.classList.add('active');
      const theme = option.getAttribute('data-theme');
      state.visualSettings.theme = theme;
      localStorage.setItem('theme', theme);
      applyTheme(theme);
      saveSettings();
    });
  });

  initializeInterfaceModeControls();

  initializeCustomThemeControls();

  colorPresets.forEach(preset => {
    if (preset.dataset.bound) return;
    preset.dataset.bound = 'true';
    preset.addEventListener('click', () => {
      updateAccentColor(preset.getAttribute('data-color'));
    });
  });

  if (colorPicker && !colorPicker.dataset.bound) {
    colorPicker.dataset.bound = 'true';
    colorPicker.addEventListener('input', (e) => updateAccentColor(e.target.value));
    colorPicker.addEventListener('change', (e) => updateAccentColor(e.target.value));
  }

  if (elements.randomAccentBtn && !elements.randomAccentBtn.dataset.bound) {
    elements.randomAccentBtn.dataset.bound = 'true';
    elements.randomAccentBtn.addEventListener('click', () => {
      const colors = ['#1db954', '#00c2ff', '#ff6b6b', '#f59e0b', '#8b5cf6', '#14b8a6'];
      updateAccentColor(colors[Math.floor(Math.random() * colors.length)]);
    });
  }

  initializePremiumSettingsControls();

  selects.forEach(select => {
    if (select.dataset.bound) return;
    select.dataset.bound = 'true';
    select.addEventListener('change', (e) => {
      const settingName = e.target.id.replace('Select', '');
      const value = e.target.value;
      localStorage.setItem(settingName, value);
      if (settingName === 'streamingQuality') {
        state.audioSettings.streamingQuality = value;
        refreshDeveloperModeUI();
        notificationSystem.info(`Calidad de streaming: ${getStreamingQualityLabel(value)}`);
      } else if (settingName === 'audioExtractor') {
        const extractor = normalizeAudioExtractor(value);
        state.developerSettings.audioExtractor = extractor;
        localStorage.setItem('audioExtractor', extractor);
        ipcRenderer.invoke('set-audio-extractor', extractor)
          .then((savedExtractor) => {
            state.developerSettings.audioExtractor = normalizeAudioExtractor(savedExtractor);
            refreshDeveloperModeUI();
            saveSettings();
          })
          .catch((error) => {
            console.error('No se pudo guardar el motor de extracción:', error);
            notificationSystem.error('No se pudo guardar el motor de extracción');
          });
        notificationSystem.info(`Motor de extracción: ${getAudioExtractorLabel(extractor)}`);
      } else if (settingName === 'language') {
        notificationSystem.info(`Idioma seleccionado: ${value.toUpperCase()}`);
      }
      saveSettings();
    });
  });

  ipcRenderer.invoke('get-cache-settings').then((cacheSettings) => {
    if (elements.audioCacheToggle) {
      elements.audioCacheToggle.checked = !!cacheSettings?.enabled;
      localStorage.setItem('audioCache', String(!!cacheSettings?.enabled));
      const maxSizeMB = parseInt(cacheSettings?.maxSizeMB || localStorage.getItem('audioCacheSizeMB') || '500', 10);
      state.developerSettings.cacheSizeMB = maxSizeMB;
      localStorage.setItem('audioCacheSizeMB', String(maxSizeMB));
      const cacheSizeSelect = document.getElementById('audioCacheSizeSelect');
      if (cacheSizeSelect) cacheSizeSelect.value = String(maxSizeMB);
      refreshDeveloperModeUI();
    }
  }).catch(() => {});

  ipcRenderer.invoke('get-network-access').then((enabled) => {
    state.developerSettings.internetEnabled = enabled !== false;
    if (elements.internetAccessToggle) {
      elements.internetAccessToggle.checked = state.developerSettings.internetEnabled;
    }
    refreshDeveloperModeUI();
    saveSettings();
  }).catch(() => {});

  ipcRenderer.invoke('get-audio-extractor').then((extractor) => {
    state.developerSettings.audioExtractor = normalizeAudioExtractor(extractor);
    localStorage.setItem('audioExtractor', state.developerSettings.audioExtractor);
    refreshDeveloperModeUI();
    saveSettings();
  }).catch(() => {});

  return;
  /*
  // Crossfade slider
  const crossfadeSlider = document.getElementById('crossfadeSlider');
  const crossfadeValue = document.getElementById('crossfadeValue');
  
  if (crossfadeSlider && crossfadeValue) {
    crossfadeSlider.addEventListener('input', (e) => {
      const value = parseInt(e.target.value);
      crossfadeValue.textContent = `${value}s`;
      state.audioSettings.crossfade = value;
      localStorage.setItem('crossfade', value);
      console.log('Crossfade actualizado a:', value);
    });
  }
  
  // Volumen por defecto slider
  const defaultVolumeSlider = document.getElementById('defaultVolumeSlider');
  const defaultVolumeValue = document.getElementById('defaultVolumeValue');
  
  if (defaultVolumeSlider && defaultVolumeValue) {
    defaultVolumeSlider.addEventListener('input', (e) => {
      const value = e.target.value;
      defaultVolumeValue.textContent = `${value}%`;
      localStorage.setItem('defaultVolume', value);
      state.volume = parseInt(value, 10) / 100;
      if (elements.audio) {
        elements.audio.volume = state.volume;
        updateVolumeUI();
      }
    });
  }
  
  // Toggle switches - inicializar individualmente para mejor control
  const autoplayToggle = document.getElementById('autoplayToggle');
  if (autoplayToggle) {
    autoplayToggle.addEventListener('change', (e) => {
      state.playbackSettings.autoplay = e.target.checked;
      localStorage.setItem('autoplay', e.target.checked);
      console.log('Autoplay:', e.target.checked);
    });
  }
  
  const autoQueueToggle = document.getElementById('autoQueueToggle');
  if (autoQueueToggle) {
    autoQueueToggle.addEventListener('change', (e) => {
      state.playbackSettings.autoQueue = e.target.checked;
      localStorage.setItem('autoQueue', e.target.checked);
      console.log('AutoQueue:', e.target.checked);
    });
  }
  
  const smartShuffleToggle = document.getElementById('smartShuffleToggle');
  if (smartShuffleToggle) {
    smartShuffleToggle.addEventListener('change', (e) => {
      state.playbackSettings.smartShuffle = e.target.checked;
      localStorage.setItem('smartShuffle', e.target.checked);
      console.log('SmartShuffle:', e.target.checked);
    });
  }
  
  const normalizeVolumeToggle = document.getElementById('normalizeVolumeToggle');
  if (normalizeVolumeToggle) {
    normalizeVolumeToggle.addEventListener('change', (e) => {
      state.audioSettings.normalizeVolume = e.target.checked;
      localStorage.setItem('normalizeVolume', e.target.checked);
      if (typeof applyVolumeNormalization === 'function') {
        applyVolumeNormalization();
      }
      console.log('NormalizeVolume:', e.target.checked);
    });
  }
  
  const visualizerToggle = document.getElementById('visualizerToggle');
  if (false && visualizerToggle) {
    visualizerToggle.addEventListener('change', (e) => {
      toggleVisualizer(e.target.checked);
      console.log('Visualizer:', e.target.checked);
    });
  }
  
  // Removed backgroundPulseToggle listener as the feature is deleted
  
  const developerModeToggle = document.getElementById('developerModeToggle');
  if (developerModeToggle) {
    developerModeToggle.addEventListener('change', (e) => {
      localStorage.setItem('developerMode', e.target.checked);
      console.log('DeveloperMode:', e.target.checked);
    });
  }
  
  const audioCacheToggle = document.getElementById('audioCacheToggle');
  if (audioCacheToggle) {
    audioCacheToggle.addEventListener('change', (e) => {
      localStorage.setItem('audioCache', e.target.checked);
      console.log('AudioCache:', e.target.checked);
      const size = parseInt(localStorage.getItem('audioCacheSizeMB') || '500', 10);
      ipcRenderer.invoke('set-cache-settings', { enabled: e.target.checked, maxSizeMB: size }).catch(() => {});
    });
  }
  // Slider de tamaño de caché eliminado: solo toggle on/off
  const clearAudioCacheBtn = document.getElementById('clearAudioCacheBtn');
  if (clearAudioCacheBtn) {
    clearAudioCacheBtn.addEventListener('click', async () => {
      await ipcRenderer.invoke('clear-audio-cache');
      notificationSystem.info('Caché de audio vaciada');
    });
  }

  
  // Selectores de tema
  const themeOptions = document.querySelectorAll('.theme-option');
  themeOptions.forEach(option => {
    option.addEventListener('click', () => {
      themeOptions.forEach(opt => opt.classList.remove('active'));
      option.classList.add('active');
      
      const theme = option.getAttribute('data-theme');
      state.visualSettings.theme = theme;
      localStorage.setItem('theme', theme);
      applyTheme(theme);
      console.log('Tema cambiado a:', theme);
    });
  });
  
  // Función para aplicar el tema (Moved to global scope)
  
  // Inicializar controles de tema personalizado
  initializeCustomThemeControls();

  // Presets de color
  const colorPresets = document.querySelectorAll('.color-preset');
  colorPresets.forEach(preset => {
    preset.addEventListener('click', () => {
      const color = preset.getAttribute('data-color');
      updateAccentColor(color);
    });
  });
  
  // Color picker
  const colorPicker = document.getElementById('accentColorPicker');
  if (colorPicker) {
    colorPicker.addEventListener('input', (e) => {
        updateAccentColor(e.target.value);
    });
    colorPicker.addEventListener('change', (e) => {
        updateAccentColor(e.target.value);
    });
  }
  
  // Selectores
  const selects = document.querySelectorAll('.modern-select');
  selects.forEach(select => {
    select.addEventListener('change', (e) => {
      const settingName = e.target.id.replace('Select', '');
      const value = e.target.value;
      localStorage.setItem(settingName, value);
      
      // Manejar calidad de streaming
      if (settingName === 'streamingQuality') {
        state.audioSettings.streamingQuality = value;
        console.log('Calidad de streaming cambiada a:', value);
        notificationSystem.info(`Calidad de streaming: ${getStreamingQualityLabel(value)}`);
      } else if (settingName === 'language') {
        // Lógica para cambiar idioma
        console.log('Idioma cambiado a:', value);
      }
      
      console.log(`Configuración ${settingName} cambiada a:`, value);
    });
  });
  
  */
  function getStreamingQualityLabel(value) {
    const labels = {
      'low': 'Baja (128kbps)',
      'medium': 'Media (256kbps)',
      'high': 'Alta (320kbps)',
      'lossless': 'Sin Pérdida (FLAC)'
    };
    return labels[value] || value;
  }
  
  // Inputs
  const inputs = document.querySelectorAll('.modern-input');
  inputs.forEach(input => {
    input.addEventListener('change', (e) => {
      const settingName = e.target.id.replace('Input', '');
      
      // Manejo especial para datos de cuenta
      if (settingName === 'username' || settingName === 'email') {
          const userData = localStorage.getItem('user');
          if (userData) {
              const user = JSON.parse(userData);
              user[settingName] = e.target.value;
              localStorage.setItem('user', JSON.stringify(user));
              if (state.account) state.account[settingName] = e.target.value;
              notificationSystem.success(`${settingName === 'username' ? 'Nombre de usuario' : 'Correo'} actualizado`);
          }
      } else {
          localStorage.setItem(settingName, e.target.value);
      }
      console.log(`Configuración ${settingName} cambiada a:`, e.target.value);
    });
  });
  
  // Botones de acción
  initializeSettingsButtons();
}

// Global helper functions
function updateAccentColor(color) {
  state.visualSettings.accentColor = color;
  const root = document.documentElement;
  root.style.setProperty('--primary-color', color);
  root.style.setProperty('--primary-dark', darkenColor(color, 0.8));
  localStorage.setItem('accentColor', color);
  
  // Update picker if exists
  const colorPicker = document.getElementById('accentColorPicker');
  if (colorPicker && colorPicker.value !== color) {
    colorPicker.value = color;
  }

  refreshAccentColorUI(color);
  updateProgressBarsColor(color);
  saveSettings();
  
  console.log('Color de acento cambiado a:', color);
}

function applyTheme(theme) {
    const root = document.documentElement;
    const customControls = document.getElementById('customThemeControls');
    
    // Hide custom controls by default
    if (customControls) customControls.style.display = 'none';

    if (theme === 'light') {
      root.style.setProperty('--background-dark', '#f5f5f5');
      root.style.setProperty('--background-light', '#ffffff');
      root.style.setProperty('--text-primary', '#1a1a1a');
      root.style.setProperty('--text-secondary', '#666666');
    } else if (theme === 'dark') {
      root.style.setProperty('--background-dark', '#121212');
      root.style.setProperty('--background-light', '#1a1a1a');
      root.style.setProperty('--text-primary', '#ffffff');
      root.style.setProperty('--text-secondary', '#b3b3b3');
    } else if (theme === 'custom') {
      // Show custom controls
      if (customControls) {
          customControls.style.display = 'grid';
          // Trigger animation
          customControls.style.animation = 'none';
          customControls.offsetHeight; /* trigger reflow */
          customControls.style.animation = 'slideDown 0.3s ease-out';
      }

      // Mantener los valores actuales o aplicar tema personalizado
      const customTheme = localStorage.getItem('customTheme');
      if (customTheme) {
        const themeData = JSON.parse(customTheme);
        Object.keys(themeData).forEach(key => {
          root.style.setProperty(key, themeData[key]);
          
          // Update inputs
          let inputId = '';
          if (key === '--background-dark') inputId = 'customBgDark';
          if (key === '--background-light') inputId = 'customBgLight';
          if (key === '--text-primary') inputId = 'customTextPrimary';
          if (key === '--text-secondary') inputId = 'customTextSecondary';
          
          const input = document.getElementById(inputId);
          if (input) {
              input.value = themeData[key];
              if (input.nextElementSibling) input.nextElementSibling.textContent = themeData[key];
          }
        });
      }
    }
}

function initializeCustomThemeControls() {
  const inputs = [
    'customBgDark', 'customBgLight', 'customTextPrimary', 'customTextSecondary'
  ];
  
  inputs.forEach(id => {
    const input = document.getElementById(id);
    if (input) {
      // Update text value when color changes
      input.addEventListener('input', (e) => {
        const value = e.target.value;
        if (input.nextElementSibling) {
            input.nextElementSibling.textContent = value;
        }
        
        // Update theme in real-time if custom is selected
        if (state.visualSettings.theme === 'custom') {
          updateCustomTheme();
        }
      });
      
      // Save when change is finished
      input.addEventListener('change', (e) => {
         updateCustomTheme();
      });
    }
  });
}

function updateCustomTheme() {
  const customTheme = {
    '--background-dark': document.getElementById('customBgDark').value,
    '--background-light': document.getElementById('customBgLight').value,
    '--text-primary': document.getElementById('customTextPrimary').value,
    '--text-secondary': document.getElementById('customTextSecondary').value
  };
  
  localStorage.setItem('customTheme', JSON.stringify(customTheme));
  
  // Apply styles
  const root = document.documentElement;
  Object.keys(customTheme).forEach(key => {
    root.style.setProperty(key, customTheme[key]);
  });
}

function initializeSettingsButtons() {
  // Botón de restablecer configuración
  const resetBtn = document.getElementById('resetSettingsBtn');
  if (resetBtn && !resetBtn.dataset.bound) {
    resetBtn.dataset.bound = 'true';
    resetBtn.addEventListener('click', () => {
      if (confirm('¿Estás seguro de que quieres restablecer todas las configuraciones a sus valores por defecto?')) {
        resetAllSettings();
      }
    });
  }
  
  // Botón de exportar configuración
  const exportBtn = document.getElementById('exportSettingsBtn');
  if (exportBtn && !exportBtn.dataset.bound) {
    exportBtn.dataset.bound = 'true';
    exportBtn.addEventListener('click', () => {
      exportSettings();
    });
  }
  

  
  // Botón de subir GIF
  const uploadGifBtn = document.getElementById('uploadGif');
  if (uploadGifBtn && !uploadGifBtn.dataset.bound) {
    uploadGifBtn.dataset.bound = 'true';
    uploadGifBtn.addEventListener('click', () => {
      document.getElementById('gifInput').click();
    });
  }
  
  // Botón de importar datos
  const importDataBtn = document.getElementById('importDataBtn');
  if (importDataBtn && !importDataBtn.dataset.bound) {
    importDataBtn.dataset.bound = 'true';
    importDataBtn.addEventListener('click', () => {
      document.getElementById('importDataInput').click();
    });
  }

  // Botón de importar playlists de Spotify
  const importSpotifyPlaylistBtn = document.getElementById('importSpotifyPlaylistBtn');
  if (importSpotifyPlaylistBtn && !importSpotifyPlaylistBtn.dataset.bound) {
    importSpotifyPlaylistBtn.dataset.bound = 'true';
    importSpotifyPlaylistBtn.addEventListener('click', openSpotifyImportPrompt);
  }
  
  // Botón de exportar datos
  const exportDataBtn = document.getElementById('exportDataBtn');
  if (exportDataBtn && !exportDataBtn.dataset.bound) {
    exportDataBtn.dataset.bound = 'true';
    exportDataBtn.addEventListener('click', () => {
      exportAllData();
    });
  }
  
  // Botón de borrar todo
  const deleteAllBtn = document.getElementById('deleteAllDataBtn');
  if (deleteAllBtn && !deleteAllBtn.dataset.bound) {
    deleteAllBtn.dataset.bound = 'true';
    deleteAllBtn.addEventListener('click', () => {
      if (confirm('¿ESTÁS SEGURO? Esta acción eliminará TODOS tus datos: playlists, canciones, configuraciones, etc. Esta acción NO se puede deshacer.')) {
        if (confirm('Última confirmación: ¿Realmente quieres borrar TODOS los datos?')) {
          deleteAllData();
        }
      }
    });
  }
  
  // Botón de ver estadísticas
  // Cargar estadísticas directamente en la tarjeta
  loadStatsContent();
  
  // Cargar información de la app directamente en la tarjeta
  loadAppInfoContent();
  attachCreditsButtonToAppInfoCard();
  
  // Botón de atajos de teclado
  const keyboardShortcutsBtn = document.getElementById('keyboardShortcutsBtn');
  if (keyboardShortcutsBtn && !keyboardShortcutsBtn.dataset.bound) {
    keyboardShortcutsBtn.dataset.bound = 'true';
    keyboardShortcutsBtn.addEventListener('click', () => {
      showKeyboardShortcutsModal();
    });
  }

}

// Función para cargar estadísticas en la tarjeta
function loadStatsContent() {
  const statsContent = document.getElementById('statsContent');
  if (!statsContent) return;
  
  // Calcular estadísticas
  const totalSongs = state.library.length;
  const totalFavorites = state.favorites.length;
  const totalPlaylists = state.playlists.length;
  const totalDuration = state.library.reduce((sum, song) => sum + (parseInt(song.duration) || 0), 0);
  const hours = Math.floor(totalDuration / 3600);
  const minutes = Math.floor((totalDuration % 3600) / 60);
  
  const recentCount = state.recentlyPlayed ? state.recentlyPlayed.length : 0;
  
  statsContent.innerHTML = `
    <div style="width: 100%;">
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 1rem; margin-bottom: 1.5rem;">
        <div style="text-align: center; padding: 1rem; background: rgba(29, 185, 84, 0.1); border-radius: 10px; border: 1px solid rgba(29, 185, 84, 0.3);">
          <div style="font-size: 2rem; font-weight: bold; color: var(--primary-color);">${totalSongs}</div>
          <div style="color: var(--text-secondary); font-size: 0.85rem; margin-top: 0.25rem;">Canciones</div>
        </div>
        <div style="text-align: center; padding: 1rem; background: rgba(255, 107, 107, 0.1); border-radius: 10px; border: 1px solid rgba(255, 107, 107, 0.3);">
          <div style="font-size: 2rem; font-weight: bold; color: #ff6b6b;">${totalFavorites}</div>
          <div style="color: var(--text-secondary); font-size: 0.85rem; margin-top: 0.25rem;">Favoritos</div>
        </div>
        <div style="text-align: center; padding: 1rem; background: rgba(0, 212, 255, 0.1); border-radius: 10px; border: 1px solid rgba(0, 212, 255, 0.3);">
          <div style="font-size: 2rem; font-weight: bold; color: #00d4ff;">${totalPlaylists}</div>
          <div style="color: var(--text-secondary); font-size: 0.85rem; margin-top: 0.25rem;">Playlists</div>
        </div>
      </div>
      
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem;">
        <div style="padding: 1rem; background: var(--background-light); border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.1);">
          <div style="color: var(--text-secondary); font-size: 0.85rem; margin-bottom: 0.5rem;">Tiempo Total</div>
          <div style="font-size: 1.5rem; font-weight: bold; color: var(--primary-color);">${hours}h ${minutes}m</div>
        </div>
        <div style="padding: 1rem; background: var(--background-light); border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.1);">
          <div style="color: var(--text-secondary); font-size: 0.85rem; margin-bottom: 0.5rem;">Reproducciones</div>
          <div style="font-size: 1.5rem; font-weight: bold; color: var(--primary-color);">${recentCount}</div>
        </div>
      </div>
      
    </div>
  `;
}

// Función para mostrar modal de estadísticas (mantener por compatibilidad)
function showStatsModal() {
  const modal = document.createElement('div');
  modal.className = 'stats-modal';
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    backdrop-filter: blur(10px);
  `;
  
  // Calcular estadísticas
  const totalSongs = state.library.length;
  const totalFavorites = state.favorites.length;
  const totalPlaylists = state.playlists.length;
  const totalDuration = state.library.reduce((sum, song) => sum + (parseInt(song.duration) || 0), 0);
  const hours = Math.floor(totalDuration / 3600);
  const minutes = Math.floor((totalDuration % 3600) / 60);
  
  // Canciones más reproducidas (simulado)
  const recentCount = state.recentlyPlayed ? state.recentlyPlayed.length : 0;
  
  modal.innerHTML = `
    <div class="stats-modal-content" style="
      background: var(--background-dark);
      border-radius: 20px;
      padding: 2rem;
      max-width: 900px;
      max-height: 90vh;
      overflow-y: auto;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      border: 2px solid var(--primary-color);
    ">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem;">
        <h2 style="color: var(--text-primary); font-size: 2rem; margin: 0;">
          <i class="fas fa-chart-bar" style="color: var(--primary-color);"></i> Estadísticas de Uso
        </h2>
        <button class="close-stats-btn" style="
          background: transparent;
          border: none;
          color: var(--text-secondary);
          font-size: 1.5rem;
          cursor: pointer;
          padding: 0.5rem;
          border-radius: 50%;
          transition: all 0.3s;
        "><i class="fas fa-times"></i></button>
      </div>
      
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1.5rem; margin-bottom: 2rem;">
        <div class="stat-card" style="
          background: linear-gradient(135deg, var(--background-light), rgba(29, 185, 84, 0.1));
          padding: 1.5rem;
          border-radius: 15px;
          border: 2px solid rgba(29, 185, 84, 0.3);
          text-align: center;
        ">
          <div style="font-size: 3rem; color: var(--primary-color); margin-bottom: 0.5rem;">
            <i class="fas fa-music"></i>
          </div>
          <div style="font-size: 2rem; font-weight: bold; color: var(--text-primary); margin-bottom: 0.25rem;">
            ${totalSongs}
          </div>
          <div style="color: var(--text-secondary);">Canciones Totales</div>
        </div>
        
        <div class="stat-card" style="
          background: linear-gradient(135deg, var(--background-light), rgba(255, 107, 107, 0.1));
          padding: 1.5rem;
          border-radius: 15px;
          border: 2px solid rgba(255, 107, 107, 0.3);
          text-align: center;
        ">
          <div style="font-size: 3rem; color: #ff6b6b; margin-bottom: 0.5rem;">
            <i class="fas fa-heart"></i>
          </div>
          <div style="font-size: 2rem; font-weight: bold; color: var(--text-primary); margin-bottom: 0.25rem;">
            ${totalFavorites}
          </div>
          <div style="color: var(--text-secondary);">Favoritos</div>
        </div>
        
        <div class="stat-card" style="
          background: linear-gradient(135deg, var(--background-light), rgba(0, 212, 255, 0.1));
          padding: 1.5rem;
          border-radius: 15px;
          border: 2px solid rgba(0, 212, 255, 0.3);
          text-align: center;
        ">
          <div style="font-size: 3rem; color: #00d4ff; margin-bottom: 0.5rem;">
            <i class="fas fa-list"></i>
          </div>
          <div style="font-size: 2rem; font-weight: bold; color: var(--text-primary); margin-bottom: 0.25rem;">
            ${totalPlaylists}
          </div>
          <div style="color: var(--text-secondary);">Playlists</div>
        </div>
      </div>
      
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1.5rem;">
        <div style="
          background: var(--background-light);
          padding: 1.5rem;
          border-radius: 15px;
          border: 2px solid rgba(255, 255, 255, 0.1);
        ">
          <h3 style="color: var(--text-primary); margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem;">
            <i class="fas fa-clock" style="color: var(--primary-color);"></i> Tiempo Total de Música
          </h3>
          <div style="font-size: 2.5rem; font-weight: bold; color: var(--primary-color);">
            ${hours}h ${minutes}m
          </div>
          <div style="color: var(--text-secondary); margin-top: 0.5rem;">
            ${totalDuration} segundos totales
          </div>
        </div>
        
        <div style="
          background: var(--background-light);
          padding: 1.5rem;
          border-radius: 15px;
          border: 2px solid rgba(255, 255, 255, 0.1);
        ">
          <h3 style="color: var(--text-primary); margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem;">
            <i class="fas fa-history" style="color: var(--primary-color);"></i> Reproducciones Recientes
          </h3>
          <div style="font-size: 2.5rem; font-weight: bold; color: var(--primary-color);">
            ${recentCount}
          </div>
          <div style="color: var(--text-secondary); margin-top: 0.5rem;">
            Canciones reproducidas recientemente
          </div>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  modal.querySelector('.close-stats-btn').addEventListener('click', () => {
    modal.remove();
  });
  
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove();
    }
  });
}

// Función para cargar información de la app en la tarjeta
function loadAppInfoContent() {
  const appInfoContent = document.getElementById('appInfoContent');
  if (!appInfoContent) return;
  
  const version = '1.2.0';
  const appName = 'Lunera';
  
  appInfoContent.innerHTML = `
    <div style="width: 100%;">
      <div style="text-align: center; margin-bottom: 1.5rem; padding: 1rem; background: linear-gradient(135deg, var(--background-light), rgba(29, 185, 84, 0.1)); border-radius: 10px; border: 1px solid var(--primary-color);">
        <div style="font-size: 2.5rem; color: var(--primary-color); margin-bottom: 0.5rem;">
          <i class="fas fa-music"></i>
        </div>
        <div style="font-size: 1.5rem; font-weight: bold; color: var(--text-primary); margin-bottom: 0.25rem;">${appName}</div>
        <div style="color: var(--text-secondary);">Versión ${version}</div>
      </div>
      
      <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.75rem; margin-bottom: 1rem;">
        <div style="padding: 0.75rem; background: var(--background-light); border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.1);">
          <div style="color: var(--text-secondary); font-size: 0.8rem; margin-bottom: 0.25rem;">Plataforma</div>
          <div style="color: var(--text-primary); font-weight: 600; font-size: 0.9rem;">
            ${process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'}
          </div>
        </div>
        <div style="padding: 0.75rem; background: var(--background-light); border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.1);">
          <div style="color: var(--text-secondary); font-size: 0.8rem; margin-bottom: 0.25rem;">Electron</div>
          <div style="color: var(--text-primary); font-weight: 600; font-size: 0.9rem;">${process.versions.electron || 'N/A'}</div>
        </div>
        <div style="padding: 0.75rem; background: var(--background-light); border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.1);">
          <div style="color: var(--text-secondary); font-size: 0.8rem; margin-bottom: 0.25rem;">Node.js</div>
          <div style="color: var(--text-primary); font-weight: 600; font-size: 0.9rem;">${process.versions.node || 'N/A'}</div>
        </div>
        <div style="padding: 0.75rem; background: var(--background-light); border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.1);">
          <div style="color: var(--text-secondary); font-size: 0.8rem; margin-bottom: 0.25rem;">Chrome</div>
          <div style="color: var(--text-primary); font-weight: 600; font-size: 0.9rem;">${process.versions.chrome || 'N/A'}</div>
        </div>
      </div>
      
      <div style="padding: 1rem; background: var(--background-light); border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.1); margin-bottom: 1rem;">
        <div style="color: var(--text-primary); font-weight: 600; margin-bottom: 0.75rem; font-size: 0.95rem;">
          <i class="fas fa-code" style="color: var(--primary-color);"></i> Dependencias
        </div>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem;">
          <div style="color: var(--text-secondary); font-size: 0.85rem;">@distube/ytdl-core</div>
          <div style="color: var(--text-secondary); font-size: 0.85rem;">usetube</div>
          <div style="color: var(--text-secondary); font-size: 0.85rem;">sqlite3</div>
          <div style="color: var(--text-secondary); font-size: 0.85rem;">electron-store</div>
        </div>
      </div>
      
      <div style="padding: 1rem; background: linear-gradient(135deg, var(--background-light), rgba(29, 185, 84, 0.1)); border-radius: 10px; border: 1px solid var(--primary-color); text-align: center;">
        <div style="color: var(--text-primary); font-size: 0.9rem; margin-bottom: 0.25rem;">
          <i class="fas fa-heart" style="color: #ff6b6b;"></i> Hecho con ❤️ por Mateo Luciano Luppoli
        </div>
        <div style="color: var(--text-secondary); font-size: 0.8rem;">
          © ${new Date().getFullYear()} Lunera - ISC License
        </div>
      </div>
    </div>
  `;
}

function attachCreditsButtonToAppInfoCard() {
  const appInfoContent = document.getElementById('appInfoContent');
  if (!appInfoContent) return;

  const commemorativeCard = appInfoContent.querySelector('div[style*="text-align: center;"]');
  if (!commemorativeCard || commemorativeCard.querySelector('#appInfoCreditsBtn')) return;

  commemorativeCard.insertAdjacentHTML('beforeend', `
    <button id="appInfoCreditsBtn" class="modern-btn secondary" type="button" style="margin-top: 0.85rem;">
      <i class="fas fa-award"></i>
      <span>Creditos</span>
    </button>
  `);

  const appInfoCreditsBtn = commemorativeCard.querySelector('#appInfoCreditsBtn');
  if (appInfoCreditsBtn) {
    appInfoCreditsBtn.addEventListener('click', () => {
      showIly4s0Credits();
    });
  }
}

// Función para mostrar modal de información (mantener por compatibilidad)
function showAppInfoModal() {
  const modal = document.createElement('div');
  modal.className = 'app-info-modal';
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    backdrop-filter: blur(10px);
  `;
  
  const version = '1.2.0';
  const appName = 'Lunera';
  
  modal.innerHTML = `
    <div class="app-info-modal-content" style="
      background: var(--background-dark);
      border-radius: 20px;
      padding: 2rem;
      max-width: 800px;
      max-height: 90vh;
      overflow-y: auto;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      border: 2px solid var(--primary-color);
    ">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem;">
        <h2 style="color: var(--text-primary); font-size: 2rem; margin: 0;">
          <i class="fas fa-info-circle" style="color: var(--primary-color);"></i> Información de la Aplicación
        </h2>
        <button class="close-app-info-btn" style="
          background: transparent;
          border: none;
          color: var(--text-secondary);
          font-size: 1.5rem;
          cursor: pointer;
          padding: 0.5rem;
          border-radius: 50%;
          transition: all 0.3s;
        "><i class="fas fa-times"></i></button>
      </div>
      
      <div style="text-align: center; margin-bottom: 2rem;">
        <div style="font-size: 4rem; color: var(--primary-color); margin-bottom: 1rem;">
          <i class="fas fa-music"></i>
        </div>
        <h1 style="color: var(--text-primary); font-size: 2.5rem; margin: 0 0 0.5rem 0;">${appName}</h1>
        <div style="color: var(--text-secondary); font-size: 1.2rem;">Versión ${version}</div>
      </div>
      
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1.5rem; margin-bottom: 2rem;">
        <div style="
          background: var(--background-light);
          padding: 1.5rem;
          border-radius: 15px;
          border: 2px solid rgba(255, 255, 255, 0.1);
        ">
          <div style="color: var(--text-secondary); margin-bottom: 0.5rem;">Plataforma</div>
          <div style="color: var(--text-primary); font-size: 1.2rem; font-weight: 600;">
            ${process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'}
          </div>
        </div>
        
        <div style="
          background: var(--background-light);
          padding: 1.5rem;
          border-radius: 15px;
          border: 2px solid rgba(255, 255, 255, 0.1);
        ">
          <div style="color: var(--text-secondary); margin-bottom: 0.5rem;">Electron</div>
          <div style="color: var(--text-primary); font-size: 1.2rem; font-weight: 600;">
            ${process.versions.electron || 'N/A'}
          </div>
        </div>
        
        <div style="
          background: var(--background-light);
          padding: 1.5rem;
          border-radius: 15px;
          border: 2px solid rgba(255, 255, 255, 0.1);
        ">
          <div style="color: var(--text-secondary); margin-bottom: 0.5rem;">Node.js</div>
          <div style="color: var(--text-primary); font-size: 1.2rem; font-weight: 600;">
            ${process.versions.node || 'N/A'}
          </div>
        </div>
        
        <div style="
          background: var(--background-light);
          padding: 1.5rem;
          border-radius: 15px;
          border: 2px solid rgba(255, 255, 255, 0.1);
        ">
          <div style="color: var(--text-secondary); margin-bottom: 0.5rem;">Chrome</div>
          <div style="color: var(--text-primary); font-size: 1.2rem; font-weight: 600;">
            ${process.versions.chrome || 'N/A'}
          </div>
        </div>
      </div>
      
      <div style="
        background: var(--background-light);
        padding: 1.5rem;
        border-radius: 15px;
        border: 2px solid rgba(255, 255, 255, 0.1);
        margin-bottom: 1.5rem;
      ">
        <h3 style="color: var(--text-primary); margin-bottom: 1rem;">
          <i class="fas fa-code" style="color: var(--primary-color);"></i> Dependencias Principales
        </h3>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem;">
          <div>
            <div style="color: var(--text-secondary); font-size: 0.9rem;">@distube/ytdl-core</div>
            <div style="color: var(--text-primary);">Streaming de audio</div>
          </div>
          <div>
            <div style="color: var(--text-secondary); font-size: 0.9rem;">usetube</div>
            <div style="color: var(--text-primary);">Búsqueda de YouTube</div>
          </div>
          <div>
            <div style="color: var(--text-secondary); font-size: 0.9rem;">sqlite3</div>
            <div style="color: var(--text-primary);">Base de datos</div>
          </div>
          <div>
            <div style="color: var(--text-secondary); font-size: 0.9rem;">electron-store</div>
            <div style="color: var(--text-primary);">Almacenamiento</div>
          </div>
        </div>
      </div>
      
      <div style="
        background: var(--background-light);
        padding: 1.5rem;
        border-radius: 15px;
        border: 2px solid rgba(255, 255, 255, 0.1);
        margin-bottom: 1.5rem;
      ">
        <h3 style="color: var(--text-primary); margin-bottom: 1rem;">
          <i class="fas fa-gavel" style="color: var(--primary-color);"></i> Licencia
        </h3>
        <div style="color: var(--text-secondary);">
          ISC License
        </div>
        <div style="color: var(--text-primary); margin-top: 0.5rem;">
          Reproductor de música
        </div>
      </div>
      
      <div style="
        background: linear-gradient(135deg, var(--background-light), rgba(29, 185, 84, 0.1));
        padding: 1.5rem;
        border-radius: 15px;
        border: 2px solid var(--primary-color);
        text-align: center;
      ">
        <div style="color: var(--text-primary); font-size: 1.1rem; margin-bottom: 0.5rem;">
          <i class="fas fa-heart" style="color: #ff6b6b;"></i> Hecho con ❤️ por Mateo Luciano Luppoli
        </div>
        <div style="color: var(--text-secondary); font-size: 0.9rem;">
          © ${new Date().getFullYear()} Lunera. Todos los derechos reservados.
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  modal.querySelector('.close-app-info-btn').addEventListener('click', () => {
    modal.remove();
  });
  
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove();
    }
  });
}

function readStoredBoolean(key, fallback = false) {
  const rawValue = localStorage.getItem(key);
  if (rawValue === null) return !!fallback;
  return rawValue === 'true';
}

function readStoredNumber(key, fallback, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  const rawValue = localStorage.getItem(key);
  const parsed = rawValue === null ? Number(fallback) : Number(rawValue);
  const value = Number.isFinite(parsed) ? parsed : Number(fallback);
  return Math.max(min, Math.min(max, value));
}

function applyPremiumUiPreferences() {
  const root = document.documentElement;
  const effectsIntensity = readStoredNumber('effectsIntensity', state.visualSettings.effectsIntensity ?? 70, 0, 100);
  const panelOpacity = readStoredNumber('panelOpacity', state.visualSettings.panelOpacity ?? 92, 70, 100);
  const animationQuality = state.visualSettings.animationQuality || localStorage.getItem('animationQuality') || 'balanced';
  const compactMode = !!state.visualSettings.compactMode;
  const reduceMotion = !!state.visualSettings.reduceMotion;
  const miniPlayer = !!state.playbackSettings.miniPlayer;
  const performanceMode = state.developerSettings.performanceMode || localStorage.getItem('performanceMode') || 'balanced';

  root.style.setProperty('--settings-effects-strength', String(effectsIntensity / 100));
  root.style.setProperty('--settings-panel-alpha', String(panelOpacity / 100));
  root.style.setProperty('--settings-motion-factor', reduceMotion ? '0' : animationQuality === 'high' ? '1.25' : animationQuality === 'reduced' ? '0.45' : '1');

  document.body.dataset.settingsAnimation = reduceMotion ? 'reduced' : animationQuality;
  document.body.dataset.settingsPerformance = performanceMode;
  document.body.classList.toggle('settings-compact-mode', compactMode);
  document.body.classList.toggle('settings-reduce-motion', reduceMotion);
  document.body.classList.toggle('mini-player-preference', miniPlayer);
}

function refreshPremiumSettingsUI() {
  const pairs = [
    ['effectsIntensitySlider', state.visualSettings.effectsIntensity ?? 70, 'effectsIntensityValue', '%'],
    ['panelOpacitySlider', state.visualSettings.panelOpacity ?? 92, 'panelOpacityValue', '%']
  ];

  pairs.forEach(([sliderId, value, labelId, suffix]) => {
    const slider = document.getElementById(sliderId);
    const label = document.getElementById(labelId);
    if (slider) {
      slider.value = String(value);
      updateSliderProgress(slider);
    }
    if (label) label.textContent = `${value}${suffix}`;
  });

  const controls = {
    animationQualitySelect: state.visualSettings.animationQuality || 'balanced',
    performanceModeSelect: state.developerSettings.performanceMode || 'balanced',
    audioCacheSizeSelect: String(state.developerSettings.cacheSizeMB || localStorage.getItem('audioCacheSizeMB') || '500')
  };

  Object.entries(controls).forEach(([id, value]) => {
    const control = document.getElementById(id);
    if (control) control.value = value;
  });

  const toggles = {
    compactModeToggle: !!state.visualSettings.compactMode,
    reduceMotionToggle: !!state.visualSettings.reduceMotion,
    notificationsToggle: state.playbackSettings.notificationsEnabled !== false,
    saveHistoryToggle: state.privacySettings.saveListeningHistory !== false,
    startupLaunchToggle: !!state.developerSettings.startAtLogin
  };

  Object.entries(toggles).forEach(([id, checked]) => {
    const control = document.getElementById(id);
    if (control) control.checked = checked;
  });

  updateMiniPlayerButtonState(!!state.playbackSettings.miniPlayer);

  const startupStatus = document.getElementById('startupLaunchStatus');
  if (startupStatus) {
    startupStatus.textContent = state.developerSettings.startAtLogin ? 'Activado' : 'Manual';
  }

  document.querySelectorAll('.modern-slider').forEach(updateSliderProgress);
  initializeModernRangeSliderInteractions();
  applyPremiumUiPreferences();
}

function loadPremiumSettingsValues() {
  state.visualSettings.effectsIntensity = readStoredNumber('effectsIntensity', state.visualSettings.effectsIntensity ?? 70, 0, 100);
  state.visualSettings.panelOpacity = readStoredNumber('panelOpacity', state.visualSettings.panelOpacity ?? 92, 70, 100);
  state.visualSettings.animationQuality = localStorage.getItem('animationQuality') || state.visualSettings.animationQuality || 'balanced';
  state.visualSettings.compactMode = readStoredBoolean('compactMode', state.visualSettings.compactMode);
  state.visualSettings.reduceMotion = readStoredBoolean('reduceMotion', state.visualSettings.reduceMotion);
  state.playbackSettings.notificationsEnabled = readStoredBoolean('notificationsEnabled', state.playbackSettings.notificationsEnabled !== false);
  state.playbackSettings.miniPlayer = readStoredBoolean('miniPlayer', state.playbackSettings.miniPlayer);
  state.privacySettings.saveListeningHistory = readStoredBoolean('saveListeningHistory', state.privacySettings.saveListeningHistory !== false);
  state.developerSettings.performanceMode = localStorage.getItem('performanceMode') || state.developerSettings.performanceMode || 'balanced';
  state.developerSettings.cacheSizeMB = parseInt(localStorage.getItem('audioCacheSizeMB') || state.developerSettings.cacheSizeMB || '500', 10);
  state.developerSettings.startAtLogin = readStoredBoolean('startAtLogin', state.developerSettings.startAtLogin);

  refreshPremiumSettingsUI();
  syncMiniPlayerWindowWithPreference();
}

function initializePremiumSettingsControls() {
  const bindRange = (id, valueId, storageKey, stateBucket, stateKey, options = {}) => {
    const slider = document.getElementById(id);
    const valueLabel = document.getElementById(valueId);
    if (!slider || slider.dataset.bound) return;
    slider.dataset.bound = 'true';

    const sync = (rawValue, persist = true) => {
      const value = Math.max(Number(slider.min || 0), Math.min(Number(slider.max || 100), Number(rawValue) || 0));
      stateBucket[stateKey] = value;
      slider.value = String(value);
      if (valueLabel) valueLabel.textContent = `${value}${options.suffix || '%'}`;
      updateSliderProgress(slider);
      applyPremiumUiPreferences();
      if (persist) {
        localStorage.setItem(storageKey, String(value));
        saveSettings();
      }
    };

    slider.addEventListener('input', (event) => sync(event.target.value, false));
    slider.addEventListener('change', (event) => sync(event.target.value, true));
    sync(slider.value, false);
  };

  const bindToggle = (id, storageKey, stateBucket, stateKey, onChange) => {
    const toggle = document.getElementById(id);
    if (!toggle || toggle.dataset.bound) return;
    toggle.dataset.bound = 'true';
    toggle.addEventListener('change', async (event) => {
      stateBucket[stateKey] = event.target.checked;
      localStorage.setItem(storageKey, String(event.target.checked));
      await onChange?.(event.target.checked);
      applyPremiumUiPreferences();
      refreshPremiumSettingsUI();
      saveSettings();
    });
  };

  const bindSelect = (id, storageKey, stateBucket, stateKey, onChange) => {
    const select = document.getElementById(id);
    if (!select || select.dataset.bound) return;
    select.dataset.bound = 'true';
    select.addEventListener('change', async (event) => {
      stateBucket[stateKey] = event.target.value;
      localStorage.setItem(storageKey, event.target.value);
      await onChange?.(event.target.value);
      applyPremiumUiPreferences();
      saveSettings();
    });
  };

  bindRange('effectsIntensitySlider', 'effectsIntensityValue', 'effectsIntensity', state.visualSettings, 'effectsIntensity');
  bindRange('panelOpacitySlider', 'panelOpacityValue', 'panelOpacity', state.visualSettings, 'panelOpacity');
  initializeModernRangeSliderInteractions();
  bindSelect('animationQualitySelect', 'animationQuality', state.visualSettings, 'animationQuality');
  bindSelect('performanceModeSelect', 'performanceMode', state.developerSettings, 'performanceMode');
  bindToggle('compactModeToggle', 'compactMode', state.visualSettings, 'compactMode');
  bindToggle('reduceMotionToggle', 'reduceMotion', state.visualSettings, 'reduceMotion');
  bindToggle('notificationsToggle', 'notificationsEnabled', state.playbackSettings, 'notificationsEnabled');
  bindToggle('saveHistoryToggle', 'saveListeningHistory', state.privacySettings, 'saveListeningHistory', (enabled) => {
    if (!enabled) {
      state.recentlyPlayed = [];
      localStorage.setItem('recentlyPlayed', '[]');
      displayRecentlyPlayed(state.recentlyPlayed);
    }
  });
  bindToggle('startupLaunchToggle', 'startAtLogin', state.developerSettings, 'startAtLogin', async (enabled) => {
    const startupStatus = document.getElementById('startupLaunchStatus');
    if (startupStatus) startupStatus.textContent = enabled ? 'Activado' : 'Manual';
    await ipcRenderer.invoke('set-startup-enabled', enabled).catch(() => {});
  });

  const cacheSizeSelect = document.getElementById('audioCacheSizeSelect');
  if (cacheSizeSelect && !cacheSizeSelect.dataset.bound) {
    cacheSizeSelect.dataset.bound = 'true';
    cacheSizeSelect.addEventListener('change', async (event) => {
      const size = parseInt(event.target.value || '500', 10);
      state.developerSettings.cacheSizeMB = size;
      localStorage.setItem('audioCacheSizeMB', String(size));
      await ipcRenderer.invoke('set-cache-settings', {
        enabled: localStorage.getItem('audioCache') === 'true',
        maxSizeMB: size
      }).catch(() => {});
      saveSettings();
    });
  }

  const importSettingsBtn = document.getElementById('importSettingsBtn');
  const importSettingsInput = document.getElementById('importSettingsInput');
  if (importSettingsBtn && importSettingsInput && !importSettingsBtn.dataset.bound) {
    importSettingsBtn.dataset.bound = 'true';
    importSettingsBtn.addEventListener('click', () => importSettingsInput.click());
    importSettingsInput.addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsedSettingsFile = JSON.parse(reader.result);
          const importedSettings = parsedSettingsFile.settings && typeof parsedSettingsFile.settings === 'object'
            ? parsedSettingsFile.settings
            : parsedSettingsFile;
          Object.entries(importedSettings).forEach(([key, value]) => {
            if (['string', 'number', 'boolean'].includes(typeof value)) {
              localStorage.setItem(key, String(value));
            }
          });
          loadSettingsValues();
          updateSettingsUI();
          notificationSystem.success('Configuraciones importadas correctamente');
        } catch (error) {
          console.error('Error al importar configuraciones:', error);
          notificationSystem.error('No se pudieron importar las configuraciones');
        } finally {
          importSettingsInput.value = '';
        }
      };
      reader.readAsText(file);
    });
  }

  ipcRenderer.invoke('get-startup-enabled').then((enabled) => {
    state.developerSettings.startAtLogin = !!enabled;
    localStorage.setItem('startAtLogin', String(!!enabled));
    refreshPremiumSettingsUI();
    saveSettings();
  }).catch(() => {});
}

function loadSettingsValues() {
  // Cargar valores guardados
  const defaultVolume = localStorage.getItem('defaultVolume') || String(state.playbackSettings.defaultVolume || 50);
  const theme = localStorage.getItem('theme') || state.visualSettings.theme || 'dark';
  const interfaceMode = getSavedInterfaceMode();
  const accentColor = localStorage.getItem('accentColor') || state.visualSettings.accentColor || '#1db954';
  state.visualSettings.theme = theme;
  state.visualSettings.interfaceMode = interfaceMode;
  setDefaultVolume(defaultVolume, { skipSave: true });
  applyInterfaceMode(interfaceMode);
  
  const colorPicker = document.getElementById('accentColorPicker');
  if (colorPicker) {
    colorPicker.value = accentColor;
    updateAccentColor(accentColor);
  }
  
  const themeOption = document.querySelector(`[data-theme="${theme}"]`);
  if (themeOption) {
    document.querySelectorAll('.theme-option').forEach(opt => opt.classList.remove('active'));
    themeOption.classList.add('active');
    // Aplicar tema al cargar
    applyTheme(theme);
  }
  
  // Cargar valores de toggles
  const autoplayToggle = document.getElementById('autoplayToggle');
  if (autoplayToggle) {
    autoplayToggle.checked = readStoredBoolean('autoplay', state.playbackSettings.autoplay);
    state.playbackSettings.autoplay = autoplayToggle.checked;
  }
  
  const autoQueueToggle = document.getElementById('autoQueueToggle');
  if (autoQueueToggle) {
    autoQueueToggle.checked = readStoredBoolean('autoQueue', state.playbackSettings.autoQueue);
    state.playbackSettings.autoQueue = autoQueueToggle.checked;
  }
  
  const smartShuffleToggle = document.getElementById('smartShuffleToggle');
  if (smartShuffleToggle) {
    smartShuffleToggle.checked = readStoredBoolean('smartShuffle', state.playbackSettings.smartShuffle);
    state.playbackSettings.smartShuffle = smartShuffleToggle.checked;
  }
  
  const normalizeVolumeToggle = document.getElementById('normalizeVolumeToggle');
  if (normalizeVolumeToggle) {
    normalizeVolumeToggle.checked = readStoredBoolean('normalizeVolume', state.audioSettings.normalizeVolume);
    state.audioSettings.normalizeVolume = normalizeVolumeToggle.checked;
  }
  
  const visualizerToggle = document.getElementById('visualizerToggle');
  if (visualizerToggle) {
    visualizerToggle.checked = localStorage.getItem('visualizer') !== 'false';
    state.visualSettings.showVisualizer = visualizerToggle.checked;
  }

  state.visualSettings.spectrogramOpacity = clampSpectrogramOpacity(
    state.visualSettings.spectrogramOpacity ?? 0.4
  );
  applySpectrogramOpacity(state.visualSettings.spectrogramOpacity, { persist: false });

  if (elements.developerModeToggle) {
    elements.developerModeToggle.checked = localStorage.getItem('developerMode') === 'true';
    state.developerSettings.enabled = elements.developerModeToggle.checked;
  }

  if (elements.verbosePlayerLogsToggle) {
    elements.verbosePlayerLogsToggle.checked = localStorage.getItem('verbosePlayerLogs') === 'true';
    state.developerSettings.verbosePlayerLogs = elements.verbosePlayerLogsToggle.checked;
  }
  
  // Removed backgroundPulseToggle state loading
  
  const streamingQualitySelect = document.getElementById('streamingQualitySelect');
  if (streamingQualitySelect) {
    const savedQuality = localStorage.getItem('streamingQuality') || 'medium';
    streamingQualitySelect.value = savedQuality;
    if (!state.audioSettings) state.audioSettings = {};
    state.audioSettings.streamingQuality = savedQuality;
  }

  if (elements.audioExtractorSelect) {
    const savedExtractor = normalizeAudioExtractor(localStorage.getItem('audioExtractor') || state.developerSettings.audioExtractor);
    elements.audioExtractorSelect.value = savedExtractor;
    state.developerSettings.audioExtractor = savedExtractor;
  }

  refreshAccentColorUI(accentColor);
  refreshDeveloperModeUI();
  loadPremiumSettingsValues();
  updateSettingsSummary();

  // Cargar datos de usuario
  const usernameInput = document.getElementById('usernameInput');
  const emailInput = document.getElementById('emailInput');
  const userData = localStorage.getItem('user');
  if (userData) {
    const user = JSON.parse(userData);
    if (usernameInput) usernameInput.value = user.username || '';
    if (emailInput) emailInput.value = user.email || '';
  }
}

function applyThemeOnLoad(theme) {
  applyTheme(theme);
}

function resetAllSettings() {
  // Limpiar localStorage
  const settingsKeys = [
    'defaultVolume', 'theme', 'accentColor', 'normalizeVolume',
    'visualizer', 'gif', 'autoplay', 'autoQueue', 'smartShuffle',
    'developerMode', 'audioCache', 'streamingQuality', 'audioExtractor', 'language',
    'effectsIntensity', 'panelOpacity', 'animationQuality', 'compactMode', 'reduceMotion',
    'notificationsEnabled', 'saveListeningHistory', 'miniPlayer', 'startAtLogin',
    'performanceMode', 'audioCacheSizeMB',
    INTERFACE_MODE_STORAGE_KEY
  ];
  
  settingsKeys.forEach(key => {
    localStorage.removeItem(key);
  });
  localStorage.removeItem('appSettings');

  state.playbackSettings = { autoplay: false, autoQueue: false, smartShuffle: false, defaultVolume: 50 };
  state.audioSettings.normalizeVolume = false;
  state.audioSettings.streamingQuality = 'medium';
  state.visualSettings.theme = 'dark';
  state.visualSettings.accentColor = '#1db954';
  state.visualSettings.effectsIntensity = 70;
  state.visualSettings.panelOpacity = 92;
  state.visualSettings.animationQuality = 'balanced';
  state.visualSettings.compactMode = false;
  state.visualSettings.reduceMotion = false;
  state.playbackSettings.notificationsEnabled = true;
  state.playbackSettings.miniPlayer = false;
  state.privacySettings.saveListeningHistory = true;
  state.developerSettings.performanceMode = 'balanced';
  state.developerSettings.cacheSizeMB = 500;
  state.developerSettings.startAtLogin = false;
  
  // Recargar valores por defecto
  loadSettingsValues();
  updateSettingsUI();
  saveSettings();
  
  // Mostrar notificación
  notificationSystem.success('Configuraciones restablecidas a valores por defecto');
}

function exportSettings() {
  const settings = {};
  const settingsKeys = [
    'defaultVolume', 'theme', 'accentColor', 'normalizeVolume',
    'visualizer', 'gif', 'autoplay', 'autoQueue', 'smartShuffle',
    'developerMode', 'audioCache', 'streamingQuality', 'audioExtractor', 'language',
    'effectsIntensity', 'panelOpacity', 'animationQuality', 'compactMode', 'reduceMotion',
    'notificationsEnabled', 'saveListeningHistory', 'miniPlayer', 'startAtLogin',
    'performanceMode', 'audioCacheSizeMB',
    INTERFACE_MODE_STORAGE_KEY
  ];
  
  settingsKeys.forEach(key => {
    const value = localStorage.getItem(key);
    if (value !== null) {
      settings[key] = value;
    }
  });
  
  const dataStr = JSON.stringify(settings, null, 2);
  const dataBlob = new Blob([dataStr], {type: 'application/json'});
  
  const link = document.createElement('a');
  link.href = URL.createObjectURL(dataBlob);
  link.download = 'rokmusic-settings.json';
  link.click();
  
  notificationSystem.success('Configuraciones exportadas correctamente');
}

function exportAllData() {
  const allData = {
    settings: {},
    library: state.library,
    playlists: state.playlists,
    favorites: state.favorites
  };
  
  const settingsKeys = [
    'defaultVolume', 'theme', 'accentColor', 'normalizeVolume',
    'visualizer', 'gif', 'autoplay', 'autoQueue', 'smartShuffle',
    'developerMode', 'audioCache', 'streamingQuality', 'audioExtractor', 'language',
    'effectsIntensity', 'panelOpacity', 'animationQuality', 'compactMode', 'reduceMotion',
    'notificationsEnabled', 'saveListeningHistory', 'miniPlayer', 'startAtLogin',
    'performanceMode', 'audioCacheSizeMB',
    INTERFACE_MODE_STORAGE_KEY
  ];
  
  settingsKeys.forEach(key => {
    const value = localStorage.getItem(key);
    if (value !== null) {
      allData.settings[key] = value;
    }
  });
  
  const dataStr = JSON.stringify(allData, null, 2);
  const dataBlob = new Blob([dataStr], {type: 'application/json'});
  
  const link = document.createElement('a');
  link.href = URL.createObjectURL(dataBlob);
  link.download = 'rokmusic-data.json';
  link.click();
  
  notificationSystem.success('Datos exportados correctamente');
}

function deleteAllData() {
  // Limpiar estado
  state.library = [];
  state.playlists = [];
  state.favorites = [];
  
  // Limpiar localStorage
  localStorage.clear();
  
  // Recargar página
  location.reload();
}

function showKeyboardShortcutsModal() {
  document.querySelector('.keyboard-shortcuts-modal')?.remove();

  const shortcuts = [
    ['Espacio / K', 'Reproducir o pausar'],
    ['N', 'Siguiente canción'],
    ['P', 'Canción anterior'],
    ['← / →', 'Retroceder o avanzar 5 segundos'],
    ['Ctrl/Cmd + ← / →', 'Anterior o siguiente'],
    ['M', 'Silenciar'],
    ['S', 'Aleatorio'],
    ['R', 'Repetición'],
    ['Q', 'Mostrar u ocultar cola'],
    ['L', 'Letra de la canción'],
    ['? / F1', 'Ver atajos']
  ];

  const modal = document.createElement('div');
  modal.className = 'keyboard-shortcuts-modal';
  modal.innerHTML = `
    <div class="keyboard-shortcuts-backdrop"></div>
    <div class="keyboard-shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby="keyboardShortcutsTitle">
      <div class="keyboard-shortcuts-header">
        <div>
          <span class="keyboard-shortcuts-kicker">Control rápido</span>
          <h3 id="keyboardShortcutsTitle">Atajos de teclado</h3>
        </div>
        <button class="keyboard-shortcuts-close" type="button" aria-label="Cerrar">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <div class="keyboard-shortcuts-list">
        ${shortcuts.map(([keys, label]) => `
          <div class="keyboard-shortcut-row">
            <kbd>${keys}</kbd>
            <span>${label}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  const closeModal = () => {
    document.removeEventListener('keydown', handleEscape);
    modal.remove();
  };
  const handleEscape = (event) => {
    if (event.key === 'Escape') closeModal();
  };

  modal.querySelector('.keyboard-shortcuts-backdrop')?.addEventListener('click', closeModal);
  modal.querySelector('.keyboard-shortcuts-close')?.addEventListener('click', closeModal);
  document.addEventListener('keydown', handleEscape);
  document.body.appendChild(modal);
}

// Función showNotification removida - se usa notificationSystem directamente
