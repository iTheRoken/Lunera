const { ipcRenderer } = require('electron');
const bcrypt = require('bcrypt');
const saltRounds = 10;
const fs = require('fs');

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
  repeat: 'none', // none, one, all
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
  }
};

function initializeAudioContext() {
  // Si ya existe un contexto y no está cerrado, devuélvelo
  if (audioContext && audioContext.state !== 'closed') {
    return audioContext;
  }
  
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

  // 4. Resetear todos los filtros
  bassFilter = null;
  midFilter = null;
  trebleFilter = null;
  presenceFilter = null;
  brillianceFilter = null;
  gainNode = null;
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
  const messages = [
      "Inicializando...",
      "Cargando lista de reproducción...",
      "Obteniendo recomendaciones...",
      "Preparando tu experiencia musical..."
  ];
  let index = 0;

  const interval = setInterval(() => {
      if (index < messages.length) {
          elements.loadingMessage.textContent = messages[index];
          index++;
      } else {
          clearInterval(interval);
          // Ocultar pantalla de carga y mostrar pantalla intermedia
          elements.loadingScreen.style.display = 'none';
          elements.welcomeScreen.style.display = 'flex';

          // Después de 5 segundos, pasar a la siguiente pantalla
          setTimeout(() => {
              elements.welcomeScreen.style.display = 'none';
              if (state.isNewUser) {
                  elements.signupScreen.classList.add('active');
              } else {
                  showPage('home');
              }
          }, 5000); // 5 segundos
      }
  }, 1000); // Cambia el mensaje cada segundo
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

  elements.audio.addEventListener('timeupdate', () => {
    if (!state.currentTrack) return;
    const progress = (elements.audio.currentTime / elements.audio.duration) * 100;
    elements.progressBar.style.width = `${progress}%`;
    elements.currentTime.textContent = formatTime(elements.audio.currentTime);
    applyCrossfade();
  });

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
  } else {
    elements.audio.play().catch(error => {
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

    // Limpiar recursos existentes (incluyendo crear nuevo elemento audio)
    await cleanAudioResources();
    
    // Configurar nueva canción
    elements.currentTrackTitle.textContent = 'Cargando...';
    const streamData = await ipcRenderer.invoke('stream-song', track.url);
    
    state.currentTrack = {
      ...track,
      ...streamData.metadata,
      path: streamData.path
    };

    // Configurar nueva fuente de audio
    elements.audio.src = streamData.path;
    
    // Esperar a que el audio esté listo
    await new Promise((resolve, reject) => {
      elements.audio.oncanplay = resolve;
      elements.audio.onerror = reject;
      setTimeout(() => reject(new Error('Timeout al cargar audio')), 10000);
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
  } catch (error) {
    console.error('Error al reproducir canción:', error);
    let errorMessage = 'Error al reproducir la canción';
    if (error.message.includes('Status code: 403')) {
      errorMessage += ': No se puede reproducir este video (bloqueado por YouTube). Prueba con otra canción.';
    } else {
      errorMessage += ': ' + error.message;
    }
    showNotification(errorMessage);
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
  const volumeProgress = elements.volumeProgress;
  volumeProgress.style.width = `${elements.audio.muted ? 0 : elements.audio.volume * 100}%`;
  
  const icon = elements.audio.muted || elements.audio.volume === 0 ? 'mute' :
              elements.audio.volume < 0.5 ? 'down' : 'up';
  elements.volumeButton.innerHTML = `<i class="fas fa-volume-${icon}"></i>`;
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
  document.querySelectorAll('.page').forEach(page => {
    page.classList.remove('active');
  });
  document.getElementById(pageId).classList.add('active');
  
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.remove('active');
  });
  document.querySelector(`[data-page="${pageId}"]`).classList.add('active');

  // Limpiar currentPlaylist si no estamos en la página de biblioteca
  if (pageId !== 'library') {
    state.currentPlaylist = null;
    state.currentPlaylistId = null;
    state.currentIndex = -1;
  }

  if (pageId === 'home') {
    loadHomeContent();
  } else if (pageId === 'library') {
    loadLibrary();
  }
  console.log(`Página activa: ${pageId}`);
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
    console.log(`Realizando búsqueda con: ${query}`);
    elements.searchResults.innerHTML = '<div class="loading">Buscando...</div>';
    const results = await ipcRenderer.invoke('search-songs', query);
    
    state.searchResults = results;
    displaySearchResults(results);
  } catch (error) {
    console.error('Error en la búsqueda:', error);
    elements.searchResults.innerHTML = '<div class="error">Error al buscar canciones</div>';
    state.searchResults = [];
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
    queueItems.innerHTML = state.queue.map((track, index) => `
      <div class="queue-item">
        <img src="${track.thumbnail}" alt="${track.title}">
        <div class="queue-item-info">
          <div class="queue-item-title">${track.title}</div>
          <div class="queue-item-artist">${track.artist}</div>
        </div>
        <button class="queue-item-remove" data-index="${index}"><i class="fas fa-times"></i></button>
      </div>
    `).join('');

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
    showNotification(`${track.title} añadida a la biblioteca`);
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
    
    // Guardamos las canciones de la playlist en el estado para usarlas en la reproducción
    state.currentPlaylist = songs;
    state.currentPlaylistId = playlistId;

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
    console.log('DOM cargado');
    // Mostrar pantalla de carga con mensajes
    showLoadingMessages();

    // Inicializar el resto de la app
    await loadLibrary();
    await loadVisualSettings();
    initializeSettings();
    initializeQueueControls();
    handleSignup(); // Manejar el formulario de creación de cuenta
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
