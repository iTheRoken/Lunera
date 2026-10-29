const { ipcRenderer } = require('electron');

const BIRTHDAY_VIDEO_SEQUENCE = '29052026';

const elements = {
  shell: document.querySelector('.mini-shell'),
  canvas: document.getElementById('spectrumCanvas'),
  artwork: document.getElementById('artwork'),
  artworkShell: document.querySelector('.mini-art-shell'),
  emptyArtwork: document.getElementById('emptyArtwork'),
  title: document.getElementById('trackTitle'),
  artist: document.getElementById('trackArtist'),
  stateLabel: document.getElementById('stateLabel'),
  playPauseBtn: document.getElementById('playPauseBtn'),
  playPauseIcon: document.getElementById('playPauseIcon'),
  previousBtn: document.getElementById('previousBtn'),
  nextBtn: document.getElementById('nextBtn'),
  closeBtn: document.getElementById('closeBtn'),
  showMainBtn: document.getElementById('showMainBtn'),
  progressRange: document.getElementById('progressRange'),
  volumeRange: document.getElementById('volumeRange'),
  currentTime: document.getElementById('currentTime'),
  duration: document.getElementById('duration')
};

const canvasContext = elements.canvas.getContext('2d');
const visualState = {
  values: [],
  smoothed: [],
  hue: 145,
  idlePhase: 0
};

const playerState = {
  isPlaying: false,
  playerUiState: 'empty',
  title: 'No hay canción seleccionada',
  artist: 'Abre una pista en Lunera',
  thumbnail: null,
  volume: 1,
  muted: false,
  currentTime: 0,
  duration: 0,
  accentColor: '#1db954',
  interfaceMode: 'classic'
};

let isSeeking = false;
let lastProgressInputAt = 0;
let birthdayVideoBuffer = '';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hexToRgb(hex) {
  const normalized = String(hex || '').replace('#', '').trim();
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return [29, 185, 84];
  return [
    parseInt(normalized.slice(0, 2), 16),
    parseInt(normalized.slice(2, 4), 16),
    parseInt(normalized.slice(4, 6), 16)
  ];
}

function formatTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const mins = Math.floor(value / 60);
  const secs = Math.floor(value % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function setRangeFill(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value || 0);
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--range-fill', `${clamp(percent, 0, 100)}%`);
}

function sendControl(action, value) {
  ipcRenderer.send('mini-player:control', action, value);
}

function handleBirthdayVideoShortcut(event) {
  const key = event.key;

  if (/^\d$/.test(key)) {
    birthdayVideoBuffer = (birthdayVideoBuffer + key).slice(-BIRTHDAY_VIDEO_SEQUENCE.length);
    if (birthdayVideoBuffer === BIRTHDAY_VIDEO_SEQUENCE) {
      birthdayVideoBuffer = '';
      ipcRenderer.send('birthday-video:show');
    }
    return;
  }

  if (key.length === 1) {
    birthdayVideoBuffer = '';
  }
}

function getStateLabel() {
  if (playerState.playerUiState === 'loading') return 'Cargando';
  if (playerState.playerUiState === 'error') return 'Error';
  if (!playerState.title || playerState.playerUiState === 'empty') return 'Listo';
  return playerState.isPlaying ? 'Reproduciendo' : 'Pausado';
}

function isDefaultTrackArtwork(artworkUrl = '') {
  return /(^|\/)default-track\.png($|\?)/i.test(String(artworkUrl));
}

function updateArtwork() {
  const thumbnail = typeof playerState.thumbnail === 'string' ? playerState.thumbnail.trim() : '';
  const hasArtwork = thumbnail.length > 0 && !isDefaultTrackArtwork(thumbnail);

  if (elements.artwork) {
    if (hasArtwork) {
      elements.artwork.onerror = () => {
        playerState.thumbnail = null;
        updateArtwork();
      };
      elements.artwork.src = thumbnail;
      elements.artwork.hidden = false;
    } else {
      elements.artwork.onerror = null;
      elements.artwork.removeAttribute('src');
      elements.artwork.hidden = true;
    }
  }

  elements.artworkShell?.classList.toggle('has-image', hasArtwork);
}

function updateControls() {
  const duration = Math.max(0, Number(playerState.duration) || 0);
  const currentTime = clamp(Number(playerState.currentTime) || 0, 0, duration || Number.MAX_SAFE_INTEGER);
  const volumePercent = playerState.muted ? 0 : Math.round(clamp(Number(playerState.volume) || 0, 0, 1) * 100);

  elements.playPauseIcon.src = playerState.isPlaying ? 'assets/pause.png' : 'assets/play.png';
  elements.playPauseBtn.setAttribute('aria-label', playerState.isPlaying ? 'Pausar' : 'Reproducir');
  elements.stateLabel.textContent = getStateLabel();

  elements.title.textContent = playerState.title || 'No hay canción seleccionada';
  elements.artist.textContent = playerState.artist || 'Abre una pista en Lunera';
  updateArtwork();

  if (!isSeeking) {
    elements.progressRange.max = String(Math.max(0, Math.floor(duration)));
    elements.progressRange.value = String(Math.floor(currentTime));
    elements.currentTime.textContent = formatTime(currentTime);
    elements.duration.textContent = duration > 0 ? formatTime(duration) : '0:00';
    setRangeFill(elements.progressRange);
  }

  elements.volumeRange.value = String(volumePercent);
  setRangeFill(elements.volumeRange);
}

function applyAccent(color) {
  const [r, g, b] = hexToRgb(color);
  document.documentElement.style.setProperty('--accent', color || '#1db954');
  document.documentElement.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
  visualState.hue = Math.round((Math.atan2(Math.sqrt(3) * (g - b), (2 * r) - g - b) * 180 / Math.PI + 360) % 360);
}

function updateState(payload = {}) {
  Object.assign(playerState, payload);
  if (playerState.interfaceMode === 'halloween') {
    document.body.dataset.interfaceMode = 'halloween';
  } else {
    delete document.body.dataset.interfaceMode;
  }
  applyAccent(playerState.accentColor);
  updateControls();
}

function resizeCanvas() {
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.floor(elements.canvas.clientWidth * ratio));
  const height = Math.max(1, Math.floor(elements.canvas.clientHeight * ratio));
  if (elements.canvas.width === width && elements.canvas.height === height) return;
  elements.canvas.width = width;
  elements.canvas.height = height;
}

function drawRoundedBar(ctx, x, y, width, height, radius) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  if (ctx.roundRect) {
    ctx.roundRect(x, y, width, height, safeRadius);
    return;
  }
  ctx.moveTo(x + safeRadius, y);
  ctx.lineTo(x + width - safeRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  ctx.lineTo(x + width, y + height - safeRadius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  ctx.lineTo(x + safeRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  ctx.lineTo(x, y + safeRadius);
  ctx.quadraticCurveTo(x, y, x + safeRadius, y);
}

function getVisualValue(index, total) {
  if (!visualState.values.length) {
    const wave = Math.sin(visualState.idlePhase + index * 0.44) * 0.5 + 0.5;
    return playerState.isPlaying ? 0.08 + wave * 0.18 : 0.035 + wave * 0.05;
  }

  const sourceIndex = Math.floor(Math.pow(index / Math.max(1, total - 1), 0.72) * (visualState.values.length - 1));
  return clamp((Number(visualState.values[sourceIndex]) || 0) / 255, 0.025, 1);
}

function drawSpectrum() {
  resizeCanvas();
  const ctx = canvasContext;
  const width = elements.canvas.width;
  const height = elements.canvas.height;
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const barCount = Math.max(38, Math.floor(width / (7 * ratio)));
  const gap = Math.max(2 * ratio, width / barCount * 0.28);
  const barWidth = Math.max(2 * ratio, (width - gap * (barCount - 1)) / barCount);
  const baseline = height * 0.8;

  visualState.idlePhase += playerState.isPlaying ? 0.04 : 0.018;
  ctx.clearRect(0, 0, width, height);

  const backdrop = ctx.createLinearGradient(0, 0, width, height);
  backdrop.addColorStop(0, 'rgba(6, 8, 12, 0.86)');
  backdrop.addColorStop(0.56, 'rgba(10, 13, 19, 0.62)');
  backdrop.addColorStop(1, 'rgba(3, 5, 8, 0.88)');
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createLinearGradient(0, height, width, 0);
  glow.addColorStop(0, `hsla(${visualState.hue}, 92%, 52%, 0.08)`);
  glow.addColorStop(0.58, `hsla(${visualState.hue + 44}, 90%, 64%, 0.18)`);
  glow.addColorStop(1, 'rgba(255, 255, 255, 0.06)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  if (visualState.smoothed.length !== barCount) {
    visualState.smoothed = Array.from({ length: barCount }, () => 0);
  }

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.shadowBlur = 16 * ratio;
  ctx.shadowColor = `hsla(${visualState.hue}, 86%, 58%, 0.55)`;

  for (let i = 0; i < barCount; i++) {
    const raw = getVisualValue(i, barCount);
    const attack = raw > visualState.smoothed[i] ? 0.42 : 0.13;
    visualState.smoothed[i] += (raw - visualState.smoothed[i]) * attack;
    const value = visualState.smoothed[i];
    const barHeight = Math.max(5 * ratio, Math.pow(value, 1.22) * height * 0.74);
    const x = i * (barWidth + gap);
    const y = baseline - barHeight;
    const gradient = ctx.createLinearGradient(0, y, 0, baseline);
    gradient.addColorStop(0, `hsla(${visualState.hue + 72}, 96%, 76%, 0.92)`);
    gradient.addColorStop(0.42, `hsla(${visualState.hue + 30}, 96%, 58%, 0.86)`);
    gradient.addColorStop(1, `hsla(${visualState.hue}, 88%, 45%, 0.54)`);

    ctx.beginPath();
    drawRoundedBar(ctx, x, y, barWidth, barHeight, barWidth / 2);
    ctx.fillStyle = gradient;
    ctx.fill();
  }
  ctx.restore();

  requestAnimationFrame(drawSpectrum);
}

elements.playPauseBtn.addEventListener('click', () => sendControl('toggle'));
elements.previousBtn.addEventListener('click', () => sendControl('previous'));
elements.nextBtn.addEventListener('click', () => sendControl('next'));
elements.closeBtn.addEventListener('click', () => sendControl('close'));
elements.showMainBtn.addEventListener('click', () => sendControl('show-main'));
document.addEventListener('keydown', handleBirthdayVideoShortcut);

elements.volumeRange.addEventListener('input', (event) => {
  setRangeFill(event.target);
  sendControl('volume', Number(event.target.value) / 100);
});

elements.progressRange.addEventListener('input', (event) => {
  isSeeking = true;
  lastProgressInputAt = Date.now();
  elements.currentTime.textContent = formatTime(event.target.value);
  setRangeFill(event.target);
});

elements.progressRange.addEventListener('change', (event) => {
  sendControl('seek', Number(event.target.value) || 0);
  window.setTimeout(() => {
    if (Date.now() - lastProgressInputAt >= 120) {
      isSeeking = false;
    }
  }, 140);
});

window.addEventListener('resize', resizeCanvas);

ipcRenderer.on('mini-player:state', (event, payload) => {
  updateState(payload || {});
});

ipcRenderer.on('mini-player:spectrum', (event, payload = {}) => {
  visualState.values = Array.isArray(payload.values) ? payload.values : [];
});

updateState();
drawSpectrum();
