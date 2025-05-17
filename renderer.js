const { ipcRenderer } = require('electron');
const bcrypt = require('bcrypt');
const saltRounds = 10;
const fs = require('fs');

console.log('Renderer.js cargado - Verificando elementos del DOM');

let audioContext = null;
let sourceNode = null;
let gainNode = null;
let bassFilter = null;
let midFilter = null;
let trebleFilter = null;
let presenceFilter = null;
let brillianceFilter = null;

// Estado global de la aplicación
const state = {
  currentTrack: null,
  isPlaying: false,
  queue: [],
  queueLoop: false,
  currentIndex: -1,
  volume: 1,
  shuffle: false,
  repeat: 'none',
  library: [],
  favorites: [],
  playlists: [],
  searchResults: [],
  settings: {
    showGif: false,
    gifUrl: null,
  },
  visualSettings: {
    showVisualizer: true,
    theme: 'dark',
    accentColor: '#1db954'
  },
  currentPlaylist: null,
  currentPlaylistId: null,
  isNewUser: true, // Valor temporal, se actualizará después
  audioSettings: {
    crossfade: 0,
    normalizeVolume: false,
    equalizer: {
      bass: 0,
      mid: 0,
      treble: 0,
      presence: 0,
      brilliance: 0
    }
  },
  playbackSettings: {
    autoplay: false,
    autoQueue: false
  },
  account: {
    username: '',
    email: ''
  },
  search: {
    query: '',
    activeFilter: 'all',
    isLoading: false,
    results: {
      top: [],
      songs: [],
      artists: [],
      albums: [],
      playlists: []
    }
  }
};

state.isNewUser = (() => {
  const userData = localStorage.getItem('user');
  if (!userData) return true;
  const user = JSON.parse(userData);
  return !(user.username && user.email && user.password);
})();

console.log('Renderer.js cargado - Verificando elementos del DOM');
const criticalElements = ['loadingScreen', 'welcomeScreen', 'signupScreen', 'loadingMessage'];
criticalElements.forEach(id => {
  if (!document.getElementById(id)) {
    console.error(`Elemento crítico no encontrado: ${id}`);
  }
});

function initializeAudioContext() {
  // Si ya existe un contexto y no está cerrado, devuélvelo
  if (audioContext && audioContext.state !== 'closed') {
    return audioContext;
  }

    audioContext = new (window.AudioContext || window.webkitAudioContext)({
    latencyHint: 'interactive'
  });
  
  // Crea un nuevo contexto
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  
  // Recrea todos los nodos de audio
  gainNode = audioContext.createGain();
  
  // Configura los filtros
  bassFilter = audioContext.createBiquadFilter();
  bassFilter.type = 'lowshelf';
  bassFilter.frequency.value = 200;
  
  midFilter = audioContext.createBiquadFilter();
  midFilter.type = 'peaking';
  midFilter.frequency.value = 1000;
  
  trebleFilter = audioContext.createBiquadFilter();
  trebleFilter.type = 'highshelf';
  trebleFilter.frequency.value = 3000;
  
  presenceFilter = audioContext.createBiquadFilter();
  presenceFilter.type = 'peaking';
  presenceFilter.frequency.value = 6000;
  
  brillianceFilter = audioContext.createBiquadFilter();
  brillianceFilter.type = 'highshelf';
  brillianceFilter.frequency.value = 12000;

  // Conecta la cadena de audio
  bassFilter.connect(midFilter);
  midFilter.connect(trebleFilter);
  trebleFilter.connect(presenceFilter);
  presenceFilter.connect(brillianceFilter);
  brillianceFilter.connect(gainNode);
  gainNode.connect(audioContext.destination);
  
  return audioContext;
}

function applyEqualizerSettings() {
  if (!audioContext) return;
  bassFilter.gain.value = state.audioSettings.equalizer.bass;
  midFilter.gain.value = state.audioSettings.equalizer.mid;
  trebleFilter.gain.value = state.audioSettings.equalizer.treble;
  presenceFilter.gain.value = state.audioSettings.equalizer.presence;
  brillianceFilter.gain.value = state.audioSettings.equalizer.brilliance;
  console.log('Ajustes de ecualizador aplicados:', state.audioSettings.equalizer);
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
  // Guardar el estado actual del volumen antes de limpiar
  const currentVolume = state.volume;
  const wasMuted = elements.audio.muted;

  // 1. Detener y desconectar cualquier fuente existente
  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch (e) {
      console.warn('Error al desconectar sourceNode:', e);
    }
    sourceNode = null;
  }

  // 2. Cerrar el contexto de audio si existe
  if (audioContext) {
    try {
      await audioContext.close();
    } catch (e) {
      console.warn('Error al cerrar audioContext:', e);
    }
    audioContext = null;
  }

  // 3. Crear un NUEVO elemento de audio (esto es clave)
  const oldAudio = elements.audio;
  const newAudio = document.createElement('audio');
  newAudio.id = 'audioPlayer';
  oldAudio.parentNode.replaceChild(newAudio, oldAudio);
  elements.audio = newAudio;

  // Restaurar el volumen y estado de mute
  elements.audio.volume = currentVolume;
  elements.audio.muted = wasMuted;

  // 4. Volver a agregar los event listeners al nuevo elemento audio
  setupAudioEventListeners();
  
  // 5. Resetear todos los filtros
  bassFilter = null;
  midFilter = null;
  trebleFilter = null;
  presenceFilter = null;
  brillianceFilter = null;
  gainNode = null;
}

// Nueva función para configurar los event listeners del audio
function setupAudioEventListeners() {
  if (!elements.audio) return;

  let lastUpdate = 0;
  elements.audio.addEventListener('timeupdate', () => {
    const now = Date.now();
    if (now - lastUpdate < 33) return;
    lastUpdate = now;

    if (!state.currentTrack || !elements.audio.duration || isNaN(elements.audio.duration)) return;
    
    const progress = (elements.audio.currentTime / elements.audio.duration) * 100;
    elements.progressBar.style.width = `${progress}%`;
    elements.currentTime.textContent = formatTime(elements.audio.currentTime);
    applyCrossfade();
  });

  elements.audio.addEventListener('durationchange', () => {
    if (!isNaN(elements.audio.duration)) {
      elements.totalTime.textContent = formatTime(elements.audio.duration);
    }
  });

  elements.audio.addEventListener('volumechange', updateVolumeUI);

  elements.audio.addEventListener('play', () => {
    state.isPlaying = true;
    updatePlayingUI(true);
    showPlayingGif();
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
      showNotification('Error al manejar el fin de la canción');
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
  searchInput: document.getElementById('searchInput'),
  searchResults: document.getElementById('searchResults'),
  libraryContent: document.getElementById('libraryContent'),
  likeButton: document.getElementById('likeButton'),
  volumeButton: document.getElementById('volumeButton'),
  gifToggle: document.getElementById('gifToggle'),
  uploadGifBtn: document.getElementById('uploadGif'),
  gifInput: document.getElementById('gifInput'),
  removeGifBtn: document.querySelector('.remove-gif'),
  closeGifBtn: document.querySelector('.close-gif'),
  visualizerToggle: document.getElementById('visualizerToggle'),
  dedicationLink: document.getElementById('dedicationLink'),
  // Elementos adicionales para la pantalla de carga y el menú de creación de cuenta
  loadingScreen: document.getElementById('loadingScreen'),
  loadingMessage: document.getElementById('loadingMessage'),
  signupScreen: document.getElementById('signupScreen'),
  signupForm: document.getElementById('authForm'), // Cambiado de signupForm a authForm
  skipSignup: document.getElementById('skipSignup'),
  welcomeScreen: document.getElementById('welcomeScreen'), // Nuevo elemento
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
  deleteAllDataBtn: document.getElementById('deleteAllDataBtn'),
  openEqualizerBtn: document.getElementById('openEqualizerBtn')
};

console.log('Inicializando renderer.js...');

// Cargar configuración guardada
const savedSettings = JSON.parse(localStorage.getItem('appSettings') || '{}');
state.settings = { ...state.settings, ...savedSettings };
state.audioSettings = { ...state.audioSettings, ...savedSettings.audioSettings };
state.visualSettings = { ...state.visualSettings, ...savedSettings.visualSettings };
state.playbackSettings = { ...state.playbackSettings, ...savedSettings.playbackSettings };
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
  if (elements.crossfadeSlider) elements.crossfadeSlider.value = state.audioSettings.crossfade;
  if (elements.crossfadeValue) elements.crossfadeValue.textContent = `${state.audioSettings.crossfade}s`;
  if (elements.normalizeVolumeToggle) elements.normalizeVolumeToggle.checked = state.audioSettings.normalizeVolume;
  if (elements.visualizerToggle) elements.visualizerToggle.checked = state.visualSettings.showVisualizer;
  if (elements.gifToggle) elements.gifToggle.checked = state.settings.showGif;
  if (elements.themeSelector) elements.themeSelector.value = state.visualSettings.theme;
  if (elements.accentColorPicker) elements.accentColorPicker.value = state.visualSettings.accentColor;
  if (elements.autoplayToggle) elements.autoplayToggle.checked = state.playbackSettings.autoplay;
  if (elements.autoQueueToggle) elements.autoQueueToggle.checked = state.playbackSettings.autoQueue;
  if (elements.usernameInput) elements.usernameInput.value = state.account.username;
  if (elements.emailInput) elements.emailInput.value = state.account.email;

  document.documentElement.style.setProperty('--primary-color', state.visualSettings.accentColor);
  document.documentElement.style.setProperty('--primary-dark', darkenColor(state.visualSettings.accentColor, 0.8));
  applyTheme(state.visualSettings.theme);
  if (document.querySelector('.gif-settings')) {
    document.querySelector('.gif-settings').style.display = state.settings.showGif ? 'block' : 'none';
  }
}

// Aplicar tema
function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.style.setProperty('--background-dark', '#f5f5f5');
    document.documentElement.style.setProperty('--background-darker', '#e0e0e0');
    document.documentElement.style.setProperty('--background-light', '#ffffff');
    document.documentElement.style.setProperty('--text-primary', '#121212');
    document.documentElement.style.setProperty('--text-secondary', '#666666');
  } else if (theme === 'dark') {
    document.documentElement.style.setProperty('--background-dark', '#121212');
    document.documentElement.style.setProperty('--background-darker', '#000000');
    document.documentElement.style.setProperty('--background-light', '#282828');
    document.documentElement.style.setProperty('--text-primary', '#ffffff');
    document.documentElement.style.setProperty('--text-secondary', '#b3b3b3');
  }
}

// Oscurecer color
function darkenColor(hex, factor) {
  const r = parseInt(hex.slice(1, 3), 16) * factor;
  const g = parseInt(hex.slice(3, 5), 16) * factor;
  const b = parseInt(hex.slice(5, 7), 16) * factor;
  return `#${Math.round(r).toString(16).padStart(2, '0')}${Math.round(g).toString(16).padStart(2, '0')}${Math.round(b).toString(16).padStart(2, '0')}`;
}

// Guardar configuraciones
function saveSettings() {
  const settings = {
    settings: state.settings,
    audioSettings: state.audioSettings,
    visualSettings: state.visualSettings,
    playbackSettings: state.playbackSettings
  };
  localStorage.setItem('appSettings', JSON.stringify(settings));
  console.log('Configuraciones guardadas:', settings);
}

// Inicializar estados
if (elements.gifToggle) {
  elements.gifToggle.checked = state.settings.showGif;
  const gifSettings = document.querySelector('.gif-settings');
  gifSettings.style.display = state.settings.showGif ? 'block' : 'none';
  if (state.settings.gifUrl) {
    document.querySelector('.gif-preview img').src = state.settings.gifUrl;
    document.querySelector('.gif-preview img').style.display = 'block';
  }
  console.log('Estado GIF inicializado:', state.settings.showGif, state.settings.gifUrl);
}

// Event Listeners para GIFs y configuración
if (elements.gifToggle) {
  elements.gifToggle.addEventListener('change', (e) => {
    state.settings.showGif = e.target.checked;
    const gifSettings = document.querySelector('.gif-settings');
    gifSettings.style.display = e.target.checked ? 'block' : 'none';
    if (!e.target.checked) {
      hidePlayingGif();
    } else if (state.isPlaying && state.settings.gifUrl) {
      showPlayingGif();
    }
    saveSettings();
    console.log('Cambio en toggle GIF:', state.settings.showGif);
  });
}

if (elements.uploadGifBtn) {
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
        document.querySelector('.gif-preview img').src = e.target.result;
        document.querySelector('.gif-preview img').style.display = 'block';
        saveSettings();
        console.log('GIF cargado:', state.settings.gifUrl);
      };
      reader.readAsDataURL(file);
    } else {
      console.warn('Archivo no es un GIF válido');
    }
  });
}

if (elements.removeGifBtn) {
  elements.removeGifBtn.addEventListener('click', () => {
    state.settings.gifUrl = null;
    document.querySelector('.gif-preview img').src = '';
    document.querySelector('.gif-preview img').style.display = 'none';
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

// Función para mostrar mensajes de carga con retraso
function showLoadingMessages() {
  try {
    console.log('Mostrando mensajes de carga...');
    
    const messages = [
      "Inicializando...",
      "Cargando lista de reproducción...",
      "Obteniendo recomendaciones...",
      "Preparando tu experiencia musical..."
    ];
    
    let index = 0;
    const maxIndex = messages.length;
    
    // Mostrar el primer mensaje inmediatamente
    if (elements.loadingMessage) {
      elements.loadingMessage.textContent = messages[index];
      index++;
    }

    const interval = setInterval(() => {
      if (index < maxIndex) {
        if (elements.loadingMessage) {
          elements.loadingMessage.textContent = messages[index];
        }
        index++;
      } else {
        clearInterval(interval);
        console.log('Mensajes de carga completados');
        
        // Ocultar pantalla de carga y mostrar pantalla intermedia
        if (elements.loadingScreen) {
          elements.loadingScreen.style.display = 'none';
        }
        
        if (elements.welcomeScreen) {
          elements.welcomeScreen.style.display = 'flex';
        }

        // Después de 5 segundos, pasar a la siguiente pantalla
        setTimeout(() => {
          if (elements.welcomeScreen) {
            elements.welcomeScreen.style.display = 'none';
          }
          
          if (state.isNewUser) {
            if (elements.signupScreen) {
              elements.signupScreen.classList.add('active');
            }
          } else {
            showPage('home');
          }
        }, 5000);
      }
    }, 1000);
  } catch (error) {
    console.error('Error en showLoadingMessages:', error);
    // Asegurarse de que la pantalla de carga se oculte incluso si hay un error
    if (elements.loadingScreen) {
      elements.loadingScreen.style.display = 'none';
    }
    showPage('home');
  }
}

// Manejar el formulario de creación de cuenta
function handleSignup() {
  let isSignupMode = true;

  elements.signupTab.addEventListener('click', () => {
    isSignupMode = true;
    elements.signupTab.classList.add('active');
    elements.loginTab.classList.remove('active');
    elements.signupMessage.textContent = 'Crear una cuenta te permite guardar playlists y personalizar tu experiencia.';
    elements.authSubmitBtn.textContent = 'Crear cuenta';
    elements.username.parentElement.style.display = 'block';
    elements.email.parentElement.style.display = 'block';
    console.log('Modo: Crear cuenta');
  });

  elements.loginTab.addEventListener('click', () => {
    isSignupMode = false;
    elements.loginTab.classList.add('active');
    elements.signupTab.classList.remove('active');
    elements.signupMessage.textContent = 'Inicia sesión para acceder a tus playlists y configuraciones.';
    elements.authSubmitBtn.textContent = 'Iniciar sesión';
    elements.username.parentElement.style.display = 'none';
    elements.email.parentElement.style.display = 'block';
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
        showNotification('¡Cuenta creada con éxito!');
        elements.signupScreen.classList.remove('active');
        showPage('home');
      } catch (error) {
        console.error('Error al crear cuenta:', error);
        showNotification('Error al crear la cuenta');
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
            showNotification('¡Inicio de sesión exitoso!');
            elements.signupScreen.classList.remove('active');
            showPage('home');
          } else {
            showNotification('Correo o contraseña incorrectos');
          }
        } catch (error) {
          console.error('Error al iniciar sesión:', error);
          showNotification('Error al iniciar sesión');
        }
      } else {
        showNotification('Correo o contraseña incorrectos');
      }
    }
  });

  elements.skipSignup.addEventListener('click', () => {
    elements.signupScreen.classList.remove('active');
    showPage('home');
  });
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

  elements.audio.addEventListener('ended', async () => {
    console.log('Audio terminado');
    state.isPlaying = false;
    updatePlayingUI(false);
    hidePlayingGif();
  
    // Eliminar archivo temporal
    if (state.currentTrack && state.currentTrack.path) {
      try {
        fs.unlinkSync(state.currentTrack.path);
        console.log('Archivo temporal eliminado:', state.currentTrack.path);
      } catch (error) {
        console.error('Error al eliminar archivo temporal:', error);
      }
    }
  
    // Limpiar el contexto de audio
    if (audioContext) {
      await audioContext.close();
      audioContext = null;
    }
    sourceNode = null;
  
    // Si estamos reproduciendo desde una playlist
    if (state.currentPlaylist && state.currentPlaylist.length > 0) {
      state.currentIndex = (state.currentIndex + 1) % state.currentPlaylist.length;
      if (state.currentIndex === 0 && state.repeat !== 'all') {
        state.currentTrack = null;
        updateTrackInfo();
        return;
      }
      const nextTrack = state.currentPlaylist[state.currentIndex];
      console.log(`Reproduciendo siguiente canción de la playlist: ${nextTrack.title}`);
      playSong(nextTrack);
      return;
    }
  
    // Si hay canciones en la cola
    if (state.queue.length > 0) {
      playNext();
    } else {
      switch (state.repeat) {
        case 'one':
          elements.audio.currentTime = 0;
          elements.audio.play();
          break;
        case 'all':
          playNext();
          break;
        case 'none':
          if (state.currentIndex < state.queue.length - 1) {
            playNext();
          }
          break;
      }
    }
  });

 if (elements.audio) {
  let lastUpdate = 0;
  elements.audio.addEventListener('timeupdate', () => {
    const now = Date.now();
    // Limitar actualizaciones a 30 FPS para mejor rendimiento
    if (now - lastUpdate < 33) return;
    lastUpdate = now;

    if (!state.currentTrack || !elements.audio.duration || isNaN(elements.audio.duration)) {
      return;
    }
    
    const progress = (elements.audio.currentTime / elements.audio.duration) * 100;
    if (elements.progressBar) {
      elements.progressBar.style.width = `${progress}%`;
    }
    if (elements.currentTime) {
      elements.currentTime.textContent = formatTime(elements.audio.currentTime);
    }
    if (elements.totalTime) {
      elements.totalTime.textContent = formatTime(elements.audio.duration);
    }
    applyCrossfade();
  });

  // Añadir este listener adicional para asegurar que la duración se actualice
  elements.audio.addEventListener('durationchange', () => {
    if (elements.totalTime && !isNaN(elements.audio.duration)) {
      elements.totalTime.textContent = formatTime(elements.audio.duration);
    }
  });
}

  elements.audio.addEventListener('loadedmetadata', () => {
    elements.totalTime.textContent = formatTime(elements.audio.duration);
    console.log('Metadatos cargados, duración:', elements.audio.duration);
  });

  elements.audio.addEventListener('loadeddata', () => {
    elements.audio.volume = state.audioSettings.normalizeVolume ? Math.min(state.volume, 0.8) : state.volume;
    updateVolumeUI();
    console.log('Datos de audio cargados, volumen:', state.volume);
  });

  elements.audio.addEventListener('volumechange', updateVolumeUI);
}

function updateVisualizerState(shouldShow) {
  ipcRenderer.invoke('set-visual-settings', { showVisualizer: shouldShow })
    .then(() => {
      console.log('Estado del visualizador actualizado:', shouldShow);
    })
    .catch(error => {
      console.error('Error al actualizar estado del visualizador:', error);
    });
}

// Función mejorada de reproducción/pausa
function togglePlayPause() {
  if (!state.currentTrack) {
    console.warn('No hay canción seleccionada para reproducir');
    return;
  }
  
  if (state.isPlaying) {
    elements.audio.pause();
    state.isPlaying = false; // Asegurar que el estado se actualice
    updatePlayingUI(false); // Forzar actualización de UI
  } else {
    elements.audio.play().then(() => {
      state.isPlaying = true; // Asegurar que el estado se actualice
      updatePlayingUI(true); // Forzar actualización de UI
    }).catch(error => {
      console.error('Error al reproducir:', error);
      state.isPlaying = false;
      updatePlayingUI(false);
      alert('Error al reproducir la canción: ' + error.message);
    });
  }
}

// Función para actualizar la UI
function updatePlayingUI(isPlaying) {
  state.isPlaying = isPlaying;
  if (elements.playPauseButton) {
    elements.playPauseButton.innerHTML = `<i class="fas fa-${isPlaying ? 'pause' : 'play'}"></i>`;
    console.log('Actualizando UI de reproducción:', isPlaying);
  }
}

// Función para reproducir una canción
async function playSong(track) {
  try {
    console.log(`Reproduciendo canción: ${track.title}`);
    if (!track || !track.url) {
      throw new Error('Track inválido o sin URL');
    }

    // Actualizar el estado de la canción actual
    state.currentTrack = track;
    updateTrackInfo();

    // Guardar el volumen actual antes de limpiar
    const currentVolume = state.volume;
    const wasMuted = elements.audio.muted;

    // Limpiar recursos existentes
    await cleanAudioResources();
    
    // Configurar nueva canción
    elements.currentTrackTitle.textContent = 'Cargando...';
    elements.currentTrackArtist.textContent = '';
    
    const streamData = await ipcRenderer.invoke('stream-song', track.url);
    
    state.currentTrack = {
      ...track,
      ...streamData.metadata,
      path: streamData.path
    };

    // Configurar nueva fuente de audio
    elements.audio.src = streamData.path;
    
    // Restaurar el volumen y mute
    elements.audio.volume = currentVolume;
    elements.audio.muted = wasMuted;
    
    // Esperar a que el audio esté listo
    await new Promise((resolve, reject) => {
      const onCanPlay = () => {
        elements.audio.removeEventListener('canplay', onCanPlay);
        elements.audio.removeEventListener('error', onError);
        resolve();
      };
      
      const onError = (error) => {
        elements.audio.removeEventListener('canplay', onCanPlay);
        elements.audio.removeEventListener('error', onError);
        reject(error);
      };
      
      elements.audio.addEventListener('canplay', onCanPlay);
      elements.audio.addEventListener('error', onError);
      
      setTimeout(() => {
        elements.audio.removeEventListener('canplay', onCanPlay);
        elements.audio.removeEventListener('error', onError);
        reject(new Error('Timeout al cargar audio'));
      }, 30000);
    });

    // Crear nuevo contexto de audio
    initializeAudioContext();
    
    // Crear nueva fuente de audio
    sourceNode = audioContext.createMediaElementSource(elements.audio);
    sourceNode.connect(bassFilter);
    
    applyEqualizerSettings();
    applyVolumeNormalization();
    
    // Iniciar reproducción
    await elements.audio.play();
    state.isPlaying = true;
    updatePlayingUI(true);
    updateTrackInfo();
    showPlayingGif();
    updateVolumeUI(); // Asegurar que la UI de volumen se actualice
  } catch (error) {
    console.error('Error al reproducir canción:', error);
    showNotification('Error al reproducir la canción: ' + error.message);
    state.isPlaying = false;
    state.currentTrack = null;
    updatePlayingUI(false);
    updateTrackInfo();
  }
}

function updateTrackInfo() {
  if (state.currentTrack) {
    elements.currentTrackTitle.textContent = state.currentTrack.title || 'Sin título';
    elements.currentTrackArtist.textContent = state.currentTrack.artist || 'Sin artista';
    elements.currentTrackImg.src = state.currentTrack.thumbnail || 'assets/default-track.png';
    console.log('Información de pista actualizada:', state.currentTrack.title, state.currentTrack.artist);
  } else {
    elements.currentTrackTitle.textContent = 'No hay canción seleccionada';
    elements.currentTrackArtist.textContent = '-';
    elements.currentTrackImg.src = 'assets/default-track.png';
    console.log('Sin pista actual, reiniciando UI');
  }
}

function playNext() {
  if (state.currentPlaylist && state.currentPlaylist.length > 0) {
    // Reproduciendo desde una playlist
    if (state.shuffle) {
      state.currentIndex = Math.floor(Math.random() * state.currentPlaylist.length);
    } else {
      state.currentIndex = (state.currentIndex + 1) % state.currentPlaylist.length;
    }
    if (state.currentIndex === 0 && state.repeat !== 'all' && !state.shuffle) {
      state.currentTrack = null;
      updateTrackInfo();
      updatePlayingUI(false);
      console.log('Fin de la playlist, deteniendo reproducción');
      return;
    }
    const nextTrack = state.currentPlaylist[state.currentIndex];
    console.log(`Reproduciendo siguiente canción de la playlist: ${nextTrack.title}`);
    playSong(nextTrack);
  } else if (state.queue.length > 0) {
    // Reproduciendo desde la cola
    if (state.shuffle) {
      state.currentIndex = Math.floor(Math.random() * state.queue.length);
    } else {
      state.currentIndex = (state.currentIndex + 1) % state.queue.length;
    }
    const nextTrack = state.queue[state.currentIndex];
    console.log(`Reproduciendo siguiente canción de la cola: ${nextTrack.title}`);
    playSong(nextTrack);
  } else if (state.playbackSettings.autoplay) {
    // Autoplay con recomendaciones
    ipcRenderer.invoke('get-home-data').then(data => {
      if (data.recommendations.length > 0) {
        const randomTrack = data.recommendations[Math.floor(Math.random() * data.recommendations.length)];
        addToQueue(randomTrack);
        playNext();
      } else {
        console.log('No hay recomendaciones disponibles para autoplay');
      }
    });
  } else {
    console.log('No hay canciones en la cola ni en la playlist');
    state.currentTrack = null;
    updateTrackInfo();
    updatePlayingUI(false);
  }
  updateQueueUI();
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
      state.repeat = 'one';
      elements.repeatButton.classList.add('active');
      elements.repeatButton.innerHTML = '<i class="fas fa-repeat-1"></i>';
      break;
    case 'one':
      state.repeat = 'all';
      elements.repeatButton.innerHTML = '<i class="fas fa-repeat"></i>';
      break;
    case 'all':
      state.repeat = 'none';
      elements.repeatButton.classList.remove('active');
      elements.repeatButton.innerHTML = '<i class="fas fa-repeat"></i>';
      break;
  }
  console.log('Modo de repetición cambiado:', state.repeat);
}

function toggleMute() {
  elements.audio.muted = !elements.audio.muted;
  elements.volumeButton.innerHTML = `<i class="fas fa-volume-${elements.audio.muted ? 'mute' : 'up'}"></i>`;
  updateVolumeUI();
  console.log('Estado de mute cambiado:', elements.audio.muted);
}

function handleVolumeChange(e) {
  const rect = elements.volumeProgress.parentElement.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const volumeLevel = Math.min(Math.max(x / rect.width, 0), 1);
  
  state.volume = volumeLevel;
  elements.audio.volume = state.audioSettings.normalizeVolume ? Math.min(volumeLevel, 0.8) : volumeLevel;
  updateVolumeUI();
  console.log('Volumen cambiado a:', volumeLevel);
}

function updateVolumeUI() {
  if (!elements.volumeProgress || !elements.volumeButton) return;
  
  // Actualizar la barra de volumen
  const volumePercentage = elements.audio.muted ? 0 : elements.audio.volume * 100;
  elements.volumeProgress.style.width = `${volumePercentage}%`;
  
  // Actualizar el icono del botón de volumen
  let volumeIcon;
  if (elements.audio.muted || elements.audio.volume === 0) {
    volumeIcon = 'volume-mute';
  } else if (elements.audio.volume < 0.33) {
    volumeIcon = 'volume-down';
  } else if (elements.audio.volume < 0.66) {
    volumeIcon = 'volume';
  } else {
    volumeIcon = 'volume-up';
  }
  
  elements.volumeButton.innerHTML = `<i class="fas fa-${volumeIcon}"></i>`;
  
  // Asegurarse de que el estado global esté actualizado
  state.volume = elements.audio.volume;
}

function handleProgressBarClick(e) {
  if (!state.currentTrack) {
    console.warn('No hay canción seleccionada para avanzar');
    return;
  }
  
  const rect = elements.progressBar.parentElement.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const clickedTime = (x / rect.width) * elements.audio.duration;
  elements.audio.currentTime = clickedTime;
  console.log('Progreso cambiado a:', clickedTime);
}

// Aplicar crossfade
function applyCrossfade() {
  if (state.audioSettings.crossfade > 0 && state.queue.length > 1 && state.currentTrack) {
    const timeLeft = elements.audio.duration - elements.audio.currentTime;
    if (timeLeft <= state.audioSettings.crossfade) {
      const nextTrack = state.queue[(state.currentIndex + 1) % state.queue.length];
      const fadeOut = setInterval(() => {
        elements.audio.volume = Math.max(0, elements.audio.volume - 0.05);
      }, 50);
      setTimeout(() => {
        clearInterval(fadeOut);
        playSong(nextTrack);
        elements.audio.volume = state.audioSettings.normalizeVolume ? Math.min(state.volume, 0.8) : state.volume;
      }, state.audioSettings.crossfade * 1000);
    }
  }
}

// Navegación
document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const page = e.currentTarget.dataset.page;
    showPage(page);
    console.log(`Navegando a página: ${page}`);
  });
});

function showPage(pageId) {
  console.log(`Intentando mostrar página: ${pageId}`);
  
  try {
    // Ocultar todas las páginas
    document.querySelectorAll('.page').forEach(page => {
      page.classList.remove('active');
    });
    
    // Mostrar la página solicitada
    const pageToShow = document.getElementById(pageId);
    if (pageToShow) {
      pageToShow.classList.add('active');
      console.log(`Página ${pageId} mostrada correctamente`);
      
      // Actualizar navegación
      document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.remove('active');
      });
      
      const activeLink = document.querySelector(`[data-page="${pageId}"]`);
      if (activeLink) {
        activeLink.classList.add('active');
      }
      
      // Actualizar contenido específico de la página
      if (pageId === 'home') {
        loadHomeContent();
      } else if (pageId === 'library') {
        loadLibrary();
      } else if (pageId === 'search') {
        updateSearchUI(); // Asegurar que la UI de búsqueda esté actualizada
      }
    } else {
      console.error(`Página con ID ${pageId} no encontrada`);
    }
    
    // Limpiar currentPlaylist si no estamos en la biblioteca
    if (pageId !== 'library') {
      state.currentPlaylist = null;
      state.currentPlaylistId = null;
      state.currentIndex = -1;
    }
  } catch (error) {
    console.error(`Error al mostrar página ${pageId}:`, error);
  }
}

// Cargar contenido de inicio
async function loadHomeContent() {
  try {
    console.log('Cargando contenido de inicio desde SQLite');
    const homeData = await ipcRenderer.invoke('get-home-data');
    
    // Limpiar el contenedor #home antes de añadir nuevo contenido
    const homeContainer = document.getElementById('home');
    homeContainer.innerHTML = ''; // Limpia todo el contenido previo

    displayRecentlyPlayed(homeData.recentlyPlayed || []);
    displayRecommendations(homeData.recommendations || []);
  } catch (error) {
    console.error('Error al cargar contenido de inicio:', error);
    displayRecentlyPlayed([]);
    displayRecommendations([]);
  }
}

function displayRecentlyPlayed(tracks) {
  const homeContainer = document.getElementById('home');
  
  // Verificar si ya existe una sección "Reproducido recientemente"
  let recentContainer = document.getElementById('recentTracks');
  if (!recentContainer) {
    recentContainer = document.createElement('div');
    recentContainer.id = 'recentTracks';
    homeContainer.appendChild(recentContainer);
  } else {
    recentContainer.innerHTML = ''; // Limpiar el contenido existente
  }

  recentContainer.innerHTML = '<h2>Reproducido recientemente</h2>';
  
  const tracksGrid = document.createElement('div');
  tracksGrid.className = 'tracks-grid';
  
  if (tracks.length === 0) {
    const noData = document.createElement('p');
    noData.textContent = 'No hay canciones reproducidas recientemente.';
    noData.style.color = 'var(--text-secondary)';
    noData.style.textAlign = 'center';
    tracksGrid.appendChild(noData);
  } else {
    tracks.forEach(track => {
      const trackCard = createTrackCard(track);
      tracksGrid.appendChild(trackCard);
    });
  }
  
  recentContainer.appendChild(tracksGrid);
  console.log('Mostrando canciones recientes:', tracks.length);
}

function displayRecommendations(tracks) {
  const homeContainer = document.getElementById('home');
  
  // Verificar si ya existe una sección de recomendaciones
  let recommendationsContainer = document.querySelector('.recommendations-section');
  if (!recommendationsContainer) {
    recommendationsContainer = document.createElement('div');
    recommendationsContainer.className = 'recommendations-section';
    homeContainer.appendChild(recommendationsContainer);
  } else {
    recommendationsContainer.innerHTML = ''; // Limpiar el contenido existente
  }
  
  recommendationsContainer.innerHTML = '<h2>Recomendado para ti</h2>';
  
  const tracksGrid = document.createElement('div');
  tracksGrid.className = 'tracks-grid';
  
  if (tracks.length === 0) {
    const noData = document.createElement('p');
    noData.textContent = 'No hay recomendaciones disponibles.';
    noData.style.color = 'var(--text-secondary)';
    noData.style.textAlign = 'center';
    tracksGrid.appendChild(noData);
  } else {
    tracks.forEach(track => {
      const trackCard = createTrackCard(track);
      tracksGrid.appendChild(trackCard);
    });
  }
  
  recommendationsContainer.appendChild(tracksGrid);
  console.log('Mostrando recomendaciones:', tracks.length);
}

// Búsqueda
let searchTimeout;
if (elements.searchInput) {
  elements.searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const query = e.target.value.trim();
    searchTimeout = setTimeout(() => {
      if (query) {
        performSearch(query);
      }
    }, 500);
    console.log('Input de búsqueda cambiado:', query);
  });
}

async function performSearch(query) {
  try {
    if (!query || typeof query !== 'string' || query.trim() === '') {
      console.log('Búsqueda vacía - limpiando resultados');
      clearSearchResults();
      return;
    }

    console.log(`Realizando búsqueda: "${query}"`);
    
    // Verificar que los elementos del DOM existan
    const searchLoading = document.getElementById('searchLoading');
    const noResults = document.getElementById('noResults');
    const searchSections = document.querySelector('.search-sections');
    
    if (!searchLoading || !noResults || !searchSections) {
      throw new Error('Elementos del DOM para búsqueda no encontrados');
    }

    state.search.query = query.trim();
    state.search.isLoading = true;
    
    // Actualizar UI de forma segura
    if (searchLoading) searchLoading.style.display = 'flex';
    if (noResults) noResults.style.display = 'none';
    if (searchSections) searchSections.style.display = 'none';
    
    // Mostrar skeleton loading
    showSkeletonLoading();

    // Realizar búsqueda
    const searchResults = await ipcRenderer.invoke('search-songs', query);
    
    // Procesar resultados
    processSearchResults(searchResults);
    
    state.search.isLoading = false;
    
    // Actualizar UI solo si todavía estamos en la página de búsqueda
    if (document.getElementById('search').classList.contains('active')) {
      updateSearchUI();
    }
    
  } catch (error) {
    console.error('Error en performSearch:', error);
    state.search.isLoading = false;
    
    // Mostrar estado de error solo si estamos en la página de búsqueda
    if (document.getElementById('search').classList.contains('active')) {
      showNoResults();
    }
    
    // Mostrar notificación al usuario
    showNotification('Error al realizar la búsqueda');
  }
}

function processSearchResults(results) {
  // Limpiar resultados anteriores
  state.search.results = {
    top: [],
    songs: [],
    artists: [],
    albums: [],
    playlists: []
  };

  if (!results || results.length === 0) {
    showNoResults();
    return;
  }

  // Simular diferentes tipos de resultados (en una app real esto vendría de la API)
  state.search.results.top = results.slice(0, 3).map(item => ({
    ...item,
    type: ['song', 'artist', 'album'][Math.floor(Math.random() * 3)],
    description: item.artist || 'Artista desconocido'
  }));

  state.search.results.songs = results.slice(0, 10);
  
  // Simular artistas (agrupando por nombre de artista)
  const artistMap = new Map();
  results.forEach(track => {
    if (!artistMap.has(track.artist)) {
      artistMap.set(track.artist, {
        id: `artist_${track.artist.replace(/\s+/g, '_')}`,
        name: track.artist,
        image: track.thumbnail || 'assets/default-artist.png',
        type: 'artist'
      });
    }
  });
  state.search.results.artists = Array.from(artistMap.values()).slice(0, 6);
  
  // Simular álbumes (agrupando por título similar)
  const albumMap = new Map();
  results.forEach((track, index) => {
    const albumName = track.title.split(' ')[0] + ' Album';
    if (!albumMap.has(albumName)) {
      albumMap.set(albumName, {
        id: `album_${index}`,
        name: albumName,
        artist: track.artist,
        image: track.thumbnail || 'assets/default-album.png',
        type: 'album'
      });
    }
  });
  state.search.results.albums = Array.from(albumMap.values()).slice(0, 6);
  
  // Simular playlists (basadas en búsquedas populares)
  state.search.results.playlists = [
    {
      id: 'playlist_1',
      name: `Playlist: ${state.search.query}`,
      owner: 'RokMusic',
      image: 'assets/default-playlist.png',
      type: 'playlist'
    },
    {
      id: 'playlist_2',
      name: `${state.search.query} Mix`,
      owner: 'RokMusic',
      image: 'assets/default-playlist.png',
      type: 'playlist'
    }
  ];
}

function updateSearchUI() {
  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearch');
  const searchLoading = document.getElementById('searchLoading');
  const noResults = document.getElementById('noResults');
  const searchSections = document.querySelector('.search-sections');
  
  // Actualizar campo de búsqueda
  if (searchInput) {
    searchInput.value = state.search.query;
    clearSearchBtn.style.display = state.search.query ? 'block' : 'none';
  }
  
  // Mostrar/ocultar estados
  if (state.search.isLoading) {
    searchLoading.style.display = 'flex';
    noResults.style.display = 'none';
    searchSections.style.display = 'none';
  } else if (state.search.results.top.length === 0 && state.search.query) {
    searchLoading.style.display = 'none';
    noResults.style.display = 'flex';
    searchSections.style.display = 'none';
  } else {
    searchLoading.style.display = 'none';
    noResults.style.display = 'none';
    searchSections.style.display = 'flex';
    
    // Renderizar resultados
    renderSearchResults();
  }
}

function renderSearchResults() {
    // Resultados principales (Top Results)
    const topResultsContainer = document.getElementById('topResults');
    if (topResultsContainer) {
        topResultsContainer.innerHTML = state.search.results.top.map(result => {
            const isFavorite = state.favorites.some(fav => fav.id === result.id);
            const isInLibrary = state.library.some(item => item.id === result.id);
            
            return `
                <div class="top-result-card" data-id="${result.id}" data-type="${result.type}">
                    ${result.type === 'artist' ? `
                        <div class="artist-image-container">
                            <img src="${result.image || 'assets/default-artist.png'}" alt="${result.name}" class="top-result-image">
                        </div>
                    ` : `
                        <img src="${result.thumbnail || (result.type === 'album' ? 'assets/default-album.png' : 'assets/default-track.png')}" 
                             alt="${result.title || result.name}" 
                             class="top-result-image">
                    `}
                    <div class="top-result-info">
                        <div class="top-result-type">${getTypeName(result.type)}</div>
                        <h3 class="top-result-title">${result.title || result.name}</h3>
                        <p class="top-result-subtitle">${result.artist || result.description || ''}</p>
                    </div>
                    <div class="card-controls-overlay">
                        ${result.type === 'song' ? `
                            <button class="card-control-btn play-btn" title="Reproducir">
                                <i class="fas fa-play"></i>
                            </button>
                            <button class="card-control-btn like-btn ${isFavorite ? 'active' : ''}" 
                                    title="${isFavorite ? 'Quitar de favoritos' : 'Añadir a favoritos'}">
                                <i class="fas fa-heart"></i>
                            </button>
                            <button class="card-control-btn queue-btn" title="Añadir a la cola">
                                <i class="fas fa-list"></i>
                            </button>
                            <button class="card-control-btn playlist-btn" title="Añadir a playlist">
                                <i class="fas fa-folder-plus"></i>
                            </button>
                        ` : `
                            <button class="card-control-btn view-btn" title="Ver ${getTypeName(result.type)}">
                                <i class="fas fa-eye"></i>
                            </button>
                            ${(result.type === 'playlist' || result.type === 'album') ? `
                                <button class="card-control-btn add-btn ${isInLibrary ? 'active' : ''}" 
                                        title="${isInLibrary ? 'En tu biblioteca' : 'Añadir a biblioteca'}">
                                    <i class="fas fa-${isInLibrary ? 'check' : 'plus'}"></i>
                                </button>
                            ` : ''}
                        `}
                    </div>
                </div>
            `;
        }).join('');

        // Event listeners para los resultados principales
        topResultsContainer.querySelectorAll('.play-btn').forEach((btn, index) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                playSong(state.search.results.top[index]);
            });
        });

        topResultsContainer.querySelectorAll('.like-btn').forEach((btn, index) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const track = state.search.results.top[index];
                if (btn.classList.contains('active')) {
                    await removeFromFavorites(track.id);
                    btn.classList.remove('active');
                    btn.title = 'Añadir a favoritos';
                    btn.innerHTML = '<i class="fas fa-heart"></i>';
                } else {
                    await addToFavorites(track);
                    btn.classList.add('active');
                    btn.title = 'Quitar de favoritos';
                    btn.innerHTML = '<i class="fas fa-heart"></i>';
                }
            });
        });

        topResultsContainer.querySelectorAll('.queue-btn').forEach((btn, index) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                addToQueue(state.search.results.top[index]);
                showNotification(`${state.search.results.top[index].title} añadido a la cola`);
            });
        });

        topResultsContainer.querySelectorAll('.playlist-btn').forEach((btn, index) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                showPlaylistSelector(state.search.results.top[index]);
            });
        });

        topResultsContainer.querySelectorAll('.add-btn').forEach((btn, index) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const item = state.search.results.top[index];
                if (btn.classList.contains('active')) return;
                
                try {
                    if (item.type === 'playlist') {
                        const newPlaylist = await ipcRenderer.invoke('create-playlist', item.name);
                        // Aquí podrías añadir canciones a la playlist si las tienes disponibles
                        btn.classList.add('active');
                        btn.title = 'En tu biblioteca';
                        btn.innerHTML = '<i class="fas fa-check"></i>';
                        showNotification(`Playlist "${item.name}" añadida a tu biblioteca`);
                    } else if (item.type === 'album') {
                        // Implementar lógica para añadir álbumes completos
                        await ipcRenderer.invoke('add-album-to-library', item);
                        btn.classList.add('active');
                        btn.title = 'En tu biblioteca';
                        btn.innerHTML = '<i class="fas fa-check"></i>';
                        showNotification(`Álbum "${item.name}" añadido a tu biblioteca`);
                    }
                    await loadLibrary();
                } catch (error) {
                    console.error('Error al añadir a biblioteca:', error);
                    showNotification('Error al añadir a la biblioteca');
                }
            });
        });

        topResultsContainer.querySelectorAll('.view-btn').forEach((btn, index) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const item = state.search.results.top[index];
                if (item.type === 'artist') {
                    // Implementar vista de artista
                    showNotification(`Mostrando artista: ${item.name}`);
                } else if (item.type === 'playlist') {
                    // Implementar vista de playlist
                    showNotification(`Mostrando playlist: ${item.name}`);
                } else if (item.type === 'album') {
                    // Implementar vista de álbum
                    showNotification(`Mostrando álbum: ${item.name}`);
                }
            });
        });
    }

    // Resultados de canciones
    const songsContainer = document.getElementById('songsResults');
    if (songsContainer) {
        songsContainer.innerHTML = state.search.results.songs.map(song => {
            const isFavorite = state.favorites.some(fav => fav.id === song.id);
            
            return `
                <div class="track-card">
                    <img src="${song.thumbnail || 'assets/default-track.png'}" alt="${song.title}">
                    <div class="track-info">
                        <h3>${song.title}</h3>
                        <p>${song.artist}</p>
                    </div>
                    <div class="card-controls">
                        <button class="play-button" title="Reproducir">
                            <i class="fas fa-play"></i>
                        </button>
                        <button class="like-button ${isFavorite ? 'active' : ''}" 
                                title="${isFavorite ? 'Quitar de favoritos' : 'Añadir a favoritos'}">
                            <i class="fas fa-heart"></i>
                        </button>
                        <button class="queue-button" title="Añadir a la cola">
                            <i class="fas fa-list"></i>
                        </button>
                        <button class="add-to-playlist" title="Añadir a playlist">
                            <i class="fas fa-folder-plus"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        // Event listeners para las canciones
        songsContainer.querySelectorAll('.play-button').forEach((btn, index) => {
            btn.addEventListener('click', () => {
                playSong(state.search.results.songs[index]);
            });
        });

        songsContainer.querySelectorAll('.like-button').forEach((btn, index) => {
            btn.addEventListener('click', async () => {
                const song = state.search.results.songs[index];
                if (btn.classList.contains('active')) {
                    await removeFromFavorites(song.id);
                    btn.classList.remove('active');
                    btn.title = 'Añadir a favoritos';
                } else {
                    await addToFavorites(song);
                    btn.classList.add('active');
                    btn.title = 'Quitar de favoritos';
                }
            });
        });

        songsContainer.querySelectorAll('.queue-button').forEach((btn, index) => {
            btn.addEventListener('click', () => {
                addToQueue(state.search.results.songs[index]);
                showNotification(`${state.search.results.songs[index].title} añadido a la cola`);
            });
        });

        songsContainer.querySelectorAll('.add-to-playlist').forEach((btn, index) => {
            btn.addEventListener('click', () => {
                showPlaylistSelector(state.search.results.songs[index]);
            });
        });
    }

    // Resultados de artistas
    const artistsContainer = document.getElementById('artistsResults');
    if (artistsContainer) {
        artistsContainer.innerHTML = state.search.results.artists.map(artist => {
            return `
                <div class="artist-card" data-id="${artist.id}">
                    <div class="artist-image-container">
                        <img src="${artist.image || 'assets/default-artist.png'}" alt="${artist.name}" class="artist-image">
                    </div>
                    <h3 class="artist-name">${artist.name}</h3>
                    <p class="artist-type">Artista</p>
                    <div class="card-controls-overlay">
                        <button class="card-control-btn view-btn" title="Ver artista">
                            <i class="fas fa-eye"></i>
                        </button>
                        <button class="card-control-btn follow-btn" title="Seguir artista">
                            <i class="fas fa-user-plus"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        // Event listeners para artistas
        artistsContainer.querySelectorAll('.view-btn').forEach((btn, index) => {
            btn.addEventListener('click', () => {
                // Implementar vista de artista
                showNotification(`Mostrando artista: ${state.search.results.artists[index].name}`);
            });
        });

        artistsContainer.querySelectorAll('.follow-btn').forEach((btn, index) => {
            btn.addEventListener('click', async () => {
                // Implementar lógica para seguir artistas
                showNotification(`Ahora sigues a ${state.search.results.artists[index].name}`);
            });
        });
    }

    // Resultados de álbumes
    const albumsContainer = document.getElementById('albumsResults');
    if (albumsContainer) {
        albumsContainer.innerHTML = state.search.results.albums.map(album => {
            const isInLibrary = state.library.some(item => item.id === album.id);
            
            return `
                <div class="album-card" data-id="${album.id}">
                    <img src="${album.image || 'assets/default-album.png'}" alt="${album.name}" class="album-image">
                    <h3 class="album-name">${album.name}</h3>
                    <p class="album-artist">${album.artist}</p>
                    <div class="card-controls-overlay">
                        <button class="card-control-btn view-btn" title="Ver álbum">
                            <i class="fas fa-eye"></i>
                        </button>
                        <button class="card-control-btn play-btn" title="Reproducir álbum">
                            <i class="fas fa-play"></i>
                        </button>
                        <button class="card-control-btn add-btn ${isInLibrary ? 'active' : ''}" 
                                title="${isInLibrary ? 'En tu biblioteca' : 'Añadir a biblioteca'}">
                            <i class="fas fa-${isInLibrary ? 'check' : 'plus'}"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        // Event listeners para álbumes
        albumsContainer.querySelectorAll('.view-btn').forEach((btn, index) => {
            btn.addEventListener('click', () => {
                // Implementar vista de álbum
                showNotification(`Mostrando álbum: ${state.search.results.albums[index].name}`);
            });
        });

        albumsContainer.querySelectorAll('.play-btn').forEach((btn, index) => {
            btn.addEventListener('click', async () => {
                // Implementar reproducción de álbum completo
                const album = state.search.results.albums[index];
                const albumTracks = await ipcRenderer.invoke('get-album-tracks', album.id);
                if (albumTracks && albumTracks.length > 0) {
                    state.currentPlaylist = albumTracks;
                    state.currentIndex = 0;
                    playSong(albumTracks[0]);
                    showNotification(`Reproduciendo álbum: ${album.name}`);
                } else {
                    showNotification('No se encontraron canciones para este álbum');
                }
            });
        });

        albumsContainer.querySelectorAll('.add-btn').forEach((btn, index) => {
            btn.addEventListener('click', async () => {
                if (btn.classList.contains('active')) return;
                
                const album = state.search.results.albums[index];
                try {
                    await ipcRenderer.invoke('add-album-to-library', album);
                    btn.classList.add('active');
                    btn.title = 'En tu biblioteca';
                    btn.innerHTML = '<i class="fas fa-check"></i>';
                    showNotification(`Álbum "${album.name}" añadido a tu biblioteca`);
                    await loadLibrary();
                } catch (error) {
                    console.error('Error al añadir álbum:', error);
                    showNotification('Error al añadir el álbum');
                }
            });
        });
    }

    // Resultados de playlists
    const playlistsContainer = document.getElementById('playlistsResults');
    if (playlistsContainer) {
        playlistsContainer.innerHTML = state.search.results.playlists.map(playlist => {
            const isInLibrary = state.playlists.some(item => item.name === playlist.name);
            
            return `
                <div class="playlist-card" data-id="${playlist.id}">
                    <img src="${playlist.image || 'assets/default-playlist.png'}" alt="${playlist.name}" class="playlist-image">
                    <h3 class="playlist-name">${playlist.name}</h3>
                    <p class="playlist-owner">Por ${playlist.owner}</p>
                    <div class="card-controls-overlay">
                        <button class="card-control-btn view-btn" title="Ver playlist">
                            <i class="fas fa-eye"></i>
                        </button>
                        <button class="card-control-btn play-btn" title="Reproducir playlist">
                            <i class="fas fa-play"></i>
                        </button>
                        <button class="card-control-btn add-btn ${isInLibrary ? 'active' : ''}" 
                                title="${isInLibrary ? 'En tu biblioteca' : 'Añadir a biblioteca'}">
                            <i class="fas fa-${isInLibrary ? 'check' : 'plus'}"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        // Event listeners para playlists
        playlistsContainer.querySelectorAll('.view-btn').forEach((btn, index) => {
            btn.addEventListener('click', () => {
                // Implementar vista de playlist
                showNotification(`Mostrando playlist: ${state.search.results.playlists[index].name}`);
            });
        });

        playlistsContainer.querySelectorAll('.play-btn').forEach((btn, index) => {
            btn.addEventListener('click', async () => {
                // Implementar reproducción de playlist completa
                const playlist = state.search.results.playlists[index];
                const playlistTracks = await ipcRenderer.invoke('get-playlist-tracks', playlist.id);
                if (playlistTracks && playlistTracks.length > 0) {
                    state.currentPlaylist = playlistTracks;
                    state.currentIndex = 0;
                    playSong(playlistTracks[0]);
                    showNotification(`Reproduciendo playlist: ${playlist.name}`);
                } else {
                    showNotification('No se encontraron canciones para esta playlist');
                }
            });
        });

        playlistsContainer.querySelectorAll('.add-btn').forEach((btn, index) => {
            btn.addEventListener('click', async () => {
                if (btn.classList.contains('active')) return;
                
                const playlist = state.search.results.playlists[index];
                try {
                    const newPlaylist = await ipcRenderer.invoke('create-playlist', playlist.name);
                    // Aquí podrías añadir canciones a la playlist si las tienes disponibles
                    btn.classList.add('active');
                    btn.title = 'En tu biblioteca';
                    btn.innerHTML = '<i class="fas fa-check"></i>';
                    showNotification(`Playlist "${playlist.name}" añadida a tu biblioteca`);
                    await loadLibrary();
                } catch (error) {
                    console.error('Error al añadir playlist:', error);
                    showNotification('Error al añadir la playlist');
                }
            });
        });
    }
}

function getTypeName(type) {
  const types = {
    song: 'Canción',
    artist: 'Artista',
    album: 'Álbum',
    playlist: 'Playlist'
  };
  return types[type] || type;
}

function applyActiveFilter() {
  // Ocultar todas las secciones si el filtro no es "all"
  const showAll = state.search.activeFilter === 'all';
  
  document.getElementById('topResultsSection').style.display = 
    showAll ? 'block' : 'none';
  
  document.getElementById('songsSection').style.display = 
    (showAll || state.search.activeFilter === 'songs') ? 'block' : 'none';
  
  document.getElementById('artistsSection').style.display = 
    (showAll || state.search.activeFilter === 'artists') ? 'block' : 'none';
  
  document.getElementById('albumsSection').style.display = 
    (showAll || state.search.activeFilter === 'albums') ? 'block' : 'none';
  
  document.getElementById('playlistsSection').style.display = 
    (showAll || state.search.activeFilter === 'playlists') ? 'block' : 'none';
}

function clearSearchResults() {
  state.search = {
    query: '',
    activeFilter: 'all',
    isLoading: false,
    results: {
      top: [],
      songs: [],
      artists: [],
      albums: [],
      playlists: []
    }
  };
  updateSearchUI();
}

function showNoResults() {
  const searchLoading = document.getElementById('searchLoading');
  const noResults = document.getElementById('noResults');
  const searchSections = document.querySelector('.search-sections');
  
  searchLoading.style.display = 'none';
  noResults.style.display = 'flex';
  searchSections.style.display = 'none';
}

function showSkeletonLoading() {
  const searchLoading = document.getElementById('searchLoading');
  const noResults = document.getElementById('noResults');
  const searchSections = document.querySelector('.search-sections');
  
  searchLoading.style.display = 'flex';
  noResults.style.display = 'none';
  searchSections.style.display = 'none';
  
  // Rellenar con skeleton loading
  const topResultsContainer = document.getElementById('topResults');
  if (topResultsContainer) {
    topResultsContainer.innerHTML = `
      <div class="top-result-card skeleton">
        <div class="skeleton-image"></div>
        <div class="top-result-info">
          <div class="skeleton-text very-short"></div>
          <div class="skeleton-text"></div>
          <div class="skeleton-text short"></div>
        </div>
      </div>
      <div class="top-result-card skeleton">
        <div class="skeleton-image"></div>
        <div class="top-result-info">
          <div class="skeleton-text very-short"></div>
          <div class="skeleton-text"></div>
          <div class="skeleton-text short"></div>
        </div>
      </div>
    `;
  }
  
  const songsContainer = document.getElementById('songsResults');
  if (songsContainer) {
    songsContainer.innerHTML = Array(6).fill(`
      <div class="track-card skeleton">
        <div class="skeleton-image"></div>
        <div class="skeleton-text"></div>
        <div class="skeleton-text short"></div>
      </div>
    `).join('');
  }
  
  // ... similar para otras secciones
}

// Inicializar eventos de búsqueda
function initializeSearch() {
  try {
    console.log('Inicializando sistema de búsqueda...');
    
    const searchInput = document.getElementById('searchInput');
    const clearSearchBtn = document.getElementById('clearSearch');
    const filterButtons = document.querySelectorAll('.search-filters .filter-btn');
    
    if (!searchInput) {
      console.error('Elemento searchInput no encontrado');
      return;
    }

    // Evento de búsqueda con debounce
    let searchTimeout;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      const query = e.target.value.trim();
      
      if (query) {
        searchTimeout = setTimeout(() => {
          performSearch(query);
        }, 500);
      } else {
        clearSearchResults();
      }
    });
    
    // Permitir búsqueda al presionar Enter
    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(searchTimeout);
        performSearch(e.target.value.trim());
      }
    });
    
    // Botón para limpiar búsqueda
    if (clearSearchBtn) {
      clearSearchBtn.addEventListener('click', () => {
        searchInput.value = '';
        searchInput.focus();
        clearSearchResults();
      });
    } else {
      console.warn('Botón clearSearch no encontrado');
    }
    
    // Filtros de búsqueda
    if (filterButtons.length > 0) {
      filterButtons.forEach(button => {
        button.addEventListener('click', () => {
          filterButtons.forEach(btn => btn.classList.remove('active'));
          button.classList.add('active');
          state.search.activeFilter = button.dataset.filter;
          applyActiveFilter();
        });
      });
    } else {
      console.warn('Botones de filtro no encontrados');
    }
    
    console.log('Sistema de búsqueda inicializado correctamente');
  } catch (error) {
    console.error('Error al inicializar el sistema de búsqueda:', error);
  }
}

function displaySearchResults(results) {
  elements.searchResults.innerHTML = '';
  const resultsGrid = document.createElement('div');
  resultsGrid.className = 'search-results-grid';
  
  results.forEach(track => {
    const trackCard = createTrackCard(track);
    resultsGrid.appendChild(trackCard);
  });
  
  elements.searchResults.appendChild(resultsGrid);
  console.log('Resultados de búsqueda mostrados:', results.length);
}

function createTrackCard(track) {
  const card = document.createElement('div');
  card.className = 'track-card';
  const isFavorite = state.favorites.some(fav => fav.video_id === track.id);
  card.innerHTML = `
    <img src="${track.thumbnail}" alt="${track.title}">
    <h3>${track.title}</h3>
    <p>${track.artist}</p>
    <div class="card-controls">
      <button class="play-button"><i class="fas fa-play"></i></button>
      <button class="like-button ${isFavorite ? 'active' : ''}" title="${isFavorite ? 'Quitar de favoritos' : 'Añadir a favoritos'}">
        <i class="fas fa-heart"></i>
      </button>
      <button class="queue-button" title="Añadir a la cola"><i class="fas fa-list"></i></button>
      <button class="add-to-playlist" title="Añadir a playlist"><i class="fas fa-folder-plus"></i></button>
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
    if (isFavorite) {
      await removeFromFavorites(track.id);
      likeButton.classList.remove('active');
      likeButton.title = 'Añadir a favoritos';
      showNotification(`${track.title} eliminado de favoritos`);
    } else {
      await addToFavorites(track);
      likeButton.classList.add('active');
      likeButton.title = 'Quitar de favoritos';
      showNotification(`${track.title} añadido a favoritos`);
    }
  });

  queueButton.addEventListener('click', () => {
    addToQueue({ ...track });
    console.log(`Añadido a cola: ${track.title}`);
  });

  addToPlaylistButton.addEventListener('click', () => {
    showPlaylistSelector(track);
  });

  return card;
}

function addToQueue(track) {
  if (!track) return;

  const isDuplicate = state.queue.some(queuedTrack => 
    queuedTrack.url === track.url || 
    (queuedTrack.title === track.title && queuedTrack.artist === track.artist)
  );

  if (!isDuplicate) {
    state.queue.push(track);
    updateQueueUI();
    showNotification(`${track.title} agregada a la cola`);
    console.log(`Canción añadida a cola: ${track.title}`);
  } else {
    showNotification(`${track.title} ya está en la cola`);
    console.log(`Canción duplicada en cola: ${track.title}`);
  }
}

function showNotification(message) {
  const notification = document.createElement('div');
  notification.className = 'notification';
  notification.textContent = message;
  document.body.appendChild(notification);
  
  setTimeout(() => notification.remove(), 3000);
  console.log('Notificación mostrada:', message);
}

function removeFromQueue(index) {
  if (index >= 0 && index < state.queue.length) {
    const removedTrack = state.queue[index];
    state.queue.splice(index, 1);
    updateQueueUI();
    showNotification(`${removedTrack.title} eliminada de la cola`);
    console.log(`Canción eliminada de cola: ${removedTrack.title}`);
  }
}

function clearQueue() {
  state.queue = [];
  updateQueueUI();
  console.log('Cola limpiada');
}

function toggleQueueLoop() {
  state.queueLoop = !state.queueLoop;
  const queueLoopButton = document.getElementById('queueLoopButton');
  if (queueLoopButton) {
    queueLoopButton.classList.toggle('active');
  }
  console.log('Modo bucle de cola cambiado:', state.queueLoop);
}

function updateQueueUI() {
  const queueContainer = document.querySelector('.queue-container');
  const queueItems = document.querySelector('.queue-items');
  
  if (state.queue.length > 0) {
    queueContainer.classList.add('active');
    queueItems.innerHTML = state.queue.map((track, index) => {
      // Truncar título y artista si son muy largos
      const truncatedTitle = track.title.length > 25 ? 
        track.title.substring(0, 22) + '...' : track.title;
      const truncatedArtist = track.artist.length > 25 ? 
        track.artist.substring(0, 22) + '...' : track.artist;
      
      return `
      <div class="queue-item">
        <img src="${track.thumbnail}" alt="${track.title}">
        <div class="queue-item-info">
          <div class="queue-item-title" title="${track.title}">${truncatedTitle}</div>
          <div class="queue-item-artist" title="${track.artist}">${truncatedArtist}</div>
        </div>
        <button class="queue-item-remove" data-index="${index}"><i class="fas fa-times"></i></button>
      </div>
    `}).join('');

    queueItems.querySelectorAll('.queue-item-remove').forEach(button => {
      button.addEventListener('click', (e) => {
        const index = parseInt(e.currentTarget.dataset.index);
        removeFromQueue(index);
      });
    });
    console.log('Interfaz de cola actualizada:', state.queue.length, 'canciones');
  } else {
    queueContainer.classList.remove('active');
    console.log('Cola vacía, interfaz oculta');
  }
}

async function handleTrackEnded() {
  console.log('Audio terminado');
  state.isPlaying = false;
  updatePlayingUI(false);
  hidePlayingGif();

  // Eliminar archivo temporal
  if (state.currentTrack && state.currentTrack.path) {
    try {
      fs.unlinkSync(state.currentTrack.path);
      console.log('Archivo temporal eliminado:', state.currentTrack.path);
    } catch (error) {
      console.error('Error al eliminar archivo temporal:', error);
    }
  }

  // Limpiar el contexto de audio
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }
  sourceNode = null;

  // Manejar reproducción de playlist
  if (state.currentPlaylist && state.currentPlaylist.length > 0) {
    let nextIndex = state.currentIndex;
    
    if (state.shuffle) {
      // Modo aleatorio
      nextIndex = Math.floor(Math.random() * state.currentPlaylist.length);
    } else {
      // Modo normal
      nextIndex = (state.currentIndex + 1) % state.currentPlaylist.length;
    }

    // Verificar si debemos continuar reproduciendo
    if (nextIndex === 0 && state.repeat !== 'all' && !state.shuffle) {
      console.log('Fin de la playlist, deteniendo reproducción');
      state.currentTrack = null;
      updateTrackInfo();
      return;
    }

    const nextTrack = state.currentPlaylist[nextIndex];
    console.log(`Reproduciendo siguiente canción de la playlist (índice ${nextIndex}): ${nextTrack.title}`);
    state.currentIndex = nextIndex;
    playSong(nextTrack);
    return;
  }

  // Manejar cola de reproducción normal
  if (state.queue.length > 0) {
    playNext();
  } else if (state.repeat === 'one' && state.currentTrack) {
    // Repetir la misma canción
    elements.audio.currentTime = 0;
    elements.audio.play();
  } else if (state.repeat === 'all' && state.currentPlaylist?.length > 0) {
    // Repetir toda la playlist desde el inicio
    state.currentIndex = 0;
    playSong(state.currentPlaylist[0]);
  }
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
async function addToLibrary(item) {
  try {
    if (item.type === 'song') {
      await ipcRenderer.invoke('add-to-library', item);
      showNotification(`${item.title} añadida a la biblioteca`);
    } 
    else if (item.type === 'playlist') {
      const newPlaylist = await ipcRenderer.invoke('create-playlist', item.name);
      // Aquí podrías añadir todas las canciones de la playlist si las tienes
      showNotification(`Playlist "${item.name}" creada`);
    }
    else if (item.type === 'album') {
      // Implementar lógica para álbumes
      showNotification(`Álbum "${item.name}" añadido`);
    }
    
    await loadLibrary();
  } catch (error) {
    console.error('Error al agregar a biblioteca:', error);
    showNotification('Error al agregar a la biblioteca');
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
    showNotification('Error al agregar a favoritos');
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
    showNotification('Error al eliminar de favoritos');
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
  } catch (error) {
    console.error('Error al cargar biblioteca:', error);
    state.library = [];
    state.favorites = [];
    state.playlists = [];
    updateLibraryUI();
  }
}

function updateLibraryUI() {
  if (elements.libraryContent) {
    const playlistsSection = document.getElementById('playlistsSection');
    const favoritesSection = document.getElementById('favoritesSection');
    const playlistsContainer = document.getElementById('playlistsContainer');
    const favoritesContainer = document.getElementById('favoritesContainer');

    if (!playlistsSection || !favoritesSection) {
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
        } else if (filter === 'favoritos') {
          document.getElementById('playlistsSection').style.display = 'none';
          document.getElementById('favoritesSection').style.display = 'block';
        }
      });
    });

    console.log('Interfaz de biblioteca actualizada:', state.favorites.length, 'favoritos');
  }
}

async function createPlaylist() {
  // Crear un modal para ingresar el nombre de la playlist
  const modal = document.createElement('div');
  modal.className = 'playlist-modal';
  modal.innerHTML = `
    <div class="modal-content">
      <h3>Crear nueva playlist</h3>
      <input type="text" id="playlistNameInput" placeholder="Nombre de la playlist" class="search-input">
      <button id="createPlaylistConfirmBtn">Crear</button>
      <button class="close-modal">Cancelar</button>
    </div>
  `;
  document.body.appendChild(modal);

  const confirmBtn = document.getElementById('createPlaylistConfirmBtn');
  const input = document.getElementById('playlistNameInput');
  const closeBtn = modal.querySelector('.close-modal');

  confirmBtn.addEventListener('click', async () => {
    const name = input.value.trim();
    if (name !== '') {
      try {
        const newPlaylist = await ipcRenderer.invoke('create-playlist', name);
        state.playlists.push(newPlaylist);
        updateLibraryUI();
        showNotification(`Playlist "${name}" creada`);
      } catch (error) {
        console.error('Error al crear playlist:', error);
        showNotification('Error al crear la playlist: ' + error.message);
      }
    } else {
      showNotification('El nombre de la playlist no puede estar vacío');
    }
    modal.remove();
  });

  closeBtn.addEventListener('click', () => modal.remove());
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
          <div class="table-column album-column">Álbum</div>
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
            <img src="${track.thumbnail || 'assets/default-track.png'}" alt="${track.title}">
            <div class="track-info">
              <span class="track-title">${track.title || 'Sin título'}</span>
              <span class="track-artist">${track.artist || 'Sin artista'}</span>
            </div>
          </div>
          <div class="table-column album-column">${track.album || 'Desconocido'}</div>
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
  if (!state.playlists || state.playlists.length === 0) {
    showNotification('No hay playlists disponibles. Crea una primero.');
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
      try {
        const result = await ipcRenderer.invoke('add-to-playlist', playlistId, track);
        if (result) {
          showNotification(`Añadido a ${btn.textContent}`);
          await loadLibrary();
        } else {
          showNotification('Error al añadir a la playlist');
        }
      } catch (error) {
        console.error('Error al añadir a la playlist:', error);
        showNotification('Error al añadir a la playlist');
      }
      modal.remove();
    }
  });

  modal.querySelector('.close-modal').addEventListener('click', () => modal.remove());
}

// Configuración visual en "Configuración"
async function toggleVisualizer() {
  state.visualSettings.showVisualizer = !state.visualSettings.showVisualizer;
  await ipcRenderer.invoke('set-visual-settings', state.visualSettings);
  updateVisualizerState(state.visualSettings.showVisualizer);
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
            state.visualSettings = { showVisualizer: true, theme: 'dark', accentColor: '#1db954' };
            state.audioSettings = {
              crossfade: 0,
              normalizeVolume: false,
              equalizer: { bass: 0, mid: 0, treble: 0, presence: 0, brilliance: 0 }
            };
            state.playbackSettings = { autoplay: false, autoQueue: false };
            state.account = { username: '', email: '' };
            state.isNewUser = true;
            localStorage.removeItem('appSettings');
            localStorage.removeItem('user');
            updateLibraryUI();
            updateQueueUI();
            updateTrackInfo();
            updateSettingsUI();
            showNotification('Todos los datos han sido eliminados');
            elements.signupScreen.classList.add('active'); // Volver a la pantalla de registro
        } catch (error) {
            console.error('Error al borrar datos:', error);
            showNotification('Error al borrar los datos');
        }
        modal.remove();
    });

    closeBtn.addEventListener('click', () => modal.remove());
}

// Inicialización
document.addEventListener('DOMContentLoaded', async () => {
  console.log('DOM cargado - Iniciando aplicación');
  
  try {
    // Verificar que los elementos críticos existan
    if (!elements.loadingScreen || !elements.welcomeScreen || !elements.signupScreen) {
      console.error('Elementos críticos no encontrados');
      // Mostrar la página principal directamente
      showPage('home');
      return;
    }
    
    showLoadingMessages();
    
    // Inicializar componentes
    await loadLibrary();
    await loadVisualSettings();
    
    // Inicializar búsqueda después de que todo lo demás esté listo
    setTimeout(() => {
      try {
        initializeSearch();
        initializeSettings();
        initializeQueueControls();
        console.log('Todos los componentes inicializados');
      } catch (error) {
        console.error('Error al inicializar componentes:', error);
      }
    }, 500);
    
  } catch (error) {
    console.error('Error durante la inicialización:', error);
    if (elements.loadingMessage) {
      elements.loadingMessage.textContent = 'Error al cargar la aplicación';
    }
    // Ocultar pantalla de carga después de 3 segundos
    setTimeout(() => {
      if (elements.loadingScreen) {
        elements.loadingScreen.style.display = 'none';
      }
      showPage('home');
    }, 3000);
  }
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
if (elements.volumeButton) {
  elements.volumeButton.addEventListener('click', toggleMute);
}
if (elements.volumeProgress) {
  elements.volumeProgress.parentElement.addEventListener('click', handleVolumeChange);
}
if (elements.progressBar) {
  elements.progressBar.parentElement.addEventListener('click', handleProgressBarClick);
}

function initializeSettings() {
  const settingsSection = document.querySelector('.settings-section');
  
  const gifToggleItem = document.createElement('div');
  gifToggleItem.className = 'setting-item';
  gifToggleItem.innerHTML = `
    <div class="setting-info">
      <span class="setting-title">GIF de reproducción</span>
      <span class="setting-description">Mostrar un GIF animado durante la reproducción</span>
    </div>
    <div class="setting-control">
      <label class="switch">
        <input type="checkbox" id="gifToggle" ${state.settings.showGif ? 'checked' : ''}>
        <span class="slider round"></span>
      </label>
    </div>
  `;
  settingsSection.appendChild(gifToggleItem);

  const visualizerToggleItem = document.createElement('div');
  visualizerToggleItem.className = 'setting-item';
  visualizerToggleItem.innerHTML = `
    <div class="setting-info">
      <span class="setting-title">Fondo brillante</span>
      <span class="setting-description">Mostrar fondo animado que brilla al ritmo de la música</span>
    </div>
    <div class="setting-control">
      <label class="switch">
        <input type="checkbox" id="visualizerToggle" ${state.visualSettings.showVisualizer ? 'checked' : ''}>
        <span class="slider round"></span>
      </label>
    </div>
  `;
  settingsSection.appendChild(visualizerToggleItem);

  // Configuración de eventos para la sección avanzada
  if (elements.crossfadeSlider) {
    elements.crossfadeSlider.addEventListener('input', () => {
      state.audioSettings.crossfade = parseInt(elements.crossfadeSlider.value);
      elements.crossfadeValue.textContent = `${state.audioSettings.crossfade}s`;
      saveSettings();
    });
  }

  if (elements.normalizeVolumeToggle) {
    elements.normalizeVolumeToggle.addEventListener('change', () => {
      state.audioSettings.normalizeVolume = elements.normalizeVolumeToggle.checked;
      applyVolumeNormalization();
      saveSettings();
    });
  }

  if (elements.visualizerToggle) {
    elements.visualizerToggle.addEventListener('change', toggleVisualizer);
  }

  if (elements.gifToggle) {
    elements.gifToggle.addEventListener('change', (e) => {
      state.settings.showGif = e.target.checked;
      const gifSettings = document.querySelector('.gif-settings');
      gifSettings.style.display = e.target.checked ? 'block' : 'none';
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

  if (elements.accentColorPicker) {
    elements.accentColorPicker.addEventListener('input', () => {
      state.visualSettings.accentColor = elements.accentColorPicker.value;
      document.documentElement.style.setProperty('--primary-color', state.visualSettings.accentColor);
      document.documentElement.style.setProperty('--primary-dark', darkenColor(state.visualSettings.accentColor, 0.8));
      saveSettings();
    });
  }

  if (elements.autoplayToggle) {
    elements.autoplayToggle.addEventListener('change', () => {
      state.playbackSettings.autoplay = elements.autoplayToggle.checked;
      saveSettings();
    });
  }

  if (elements.autoQueueToggle) {
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

  if (elements.changePasswordBtn) {
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
          showNotification('Contraseña actualizada');
          modal.remove();
        } catch (error) {
          console.error('Error al cambiar contraseña:', error);
          showNotification('Error al cambiar la contraseña');
        }
      } else {
        showNotification('Las contraseñas no coinciden o están vacías');
      }
    });

    modal.querySelector('.close-modal').addEventListener('click', () => modal.remove());
  });
}

  if (elements.exportDataBtn) {
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
        showNotification('Datos exportados correctamente');
      } catch (error) {
        console.error('Error al exportar datos:', error);
        showNotification('Error al exportar datos');
      }
    });
  }

  if (elements.importDataBtn) {
    elements.importDataBtn.addEventListener('click', () => {
      elements.importDataInput.click();
    });
  }

  if (elements.likeButton) {
    elements.likeButton.addEventListener('click', async () => {
      if (!state.currentTrack) return;
      const isFavorite = state.favorites.some(fav => fav.video_id === state.currentTrack.id);
      if (isFavorite) {
        await removeFromFavorites(state.currentTrack.id);
        elements.likeButton.classList.remove('active');
        elements.likeButton.innerHTML = '<i class="far fa-heart"></i>';
        showNotification(`${state.currentTrack.title} eliminado de favoritos`);
      } else {
        await addToFavorites(state.currentTrack);
        elements.likeButton.classList.add('active');
        elements.likeButton.innerHTML = '<i class="fas fa-heart"></i>';
        showNotification(`${state.currentTrack.title} añadido a favoritos`);
      }
    });
  }

  if (elements.importDataInput) {
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
            showNotification('Datos importados correctamente');
          } catch (error) {
            console.error('Error al importar datos:', error);
            showNotification('Error al importar datos');
          }
        };
        reader.readAsText(file);
      }
    });
  }

  if (elements.deleteAllDataBtn) {
      elements.deleteAllDataBtn.addEventListener('click', () => {
          showDeleteConfirmationModal();
      });
  }

  if (elements.openEqualizerBtn) {
    elements.openEqualizerBtn.addEventListener('click', () => {
      const modal = document.createElement('div');
      modal.className = 'equalizer-modal';
      modal.innerHTML = `
        <div class="equalizer-content">
          <h3>Ecualizador</h3>
          <div class="equalizer-sliders">
            <div class="equalizer-slider">
              <input type="range" min="-12" max="12" value="${state.audioSettings.equalizer.bass}" data-band="bass">
              <label>Bass</label>
            </div>
            <div class="equalizer-slider">
              <input type="range" min="-12" max="12" value="${state.audioSettings.equalizer.mid}" data-band="mid">
              <label>Mid</label>
            </div>
            <div class="equalizer-slider">
              <input type="range" min="-12" max="12" value="${state.audioSettings.equalizer.treble}" data-band="treble">
              <label>Treble</label>
            </div>
            <div class="equalizer-slider">
              <input type="range" min="-12" max="12" value="${state.audioSettings.equalizer.presence}" data-band="presence">
              <label>Presence</label>
            </div>
            <div class="equalizer-slider">
              <input type="range" min="-12" max="12" value="${state.audioSettings.equalizer.brilliance}" data-band="brilliance">
              <label>Brilliance</label>
            </div>
          </div>
          <button class="close-modal">Cerrar</button>
        </div>
      `;
      document.body.appendChild(modal);
  
      modal.querySelectorAll('input[type="range"]').forEach(slider => {
        slider.addEventListener('input', (e) => {
          state.audioSettings.equalizer[e.target.dataset.band] = parseInt(e.target.value);
          applyEqualizerSettings();
          saveSettings();
        });
      });
  
      modal.querySelector('.close-modal').addEventListener('click', () => modal.remove());
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
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Atajos de teclado
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    elements.playPauseButton.click();
    console.log('Atajo de teclado (Espacio) activado');
  }
});
