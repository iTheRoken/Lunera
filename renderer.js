const { ipcRenderer } = require('electron');

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
    playlists: [],
    searchResults: [],
    settings: {
        showGif: false,
        gifUrl: null,
    },
    visualSettings: {
        showVisualizer: true // Valor predeterminado
    }
};

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
    visualizerToggle: document.getElementById('visualizerToggle')
};

console.log('Inicializando renderer.js...');

// Cargar configuración guardada
const savedSettings = JSON.parse(localStorage.getItem('appSettings') || '{}');
state.settings = { ...state.settings, ...savedSettings };

async function loadVisualSettings() {
    try {
        const visualSettings = await ipcRenderer.invoke('get-visual-settings');
        state.visualSettings = visualSettings || { showVisualizer: true };
        console.log('Configuraciones visuales cargadas:', state.visualSettings);
        updateVisualizerState(state.visualSettings.showVisualizer); // Llamamos una sola vez
    } catch (error) {
        console.error('Error al cargar configuraciones visuales:', error);
    }
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

function saveSettings() {
    localStorage.setItem('appSettings', JSON.stringify(state.settings));
    console.log('Configuraciones guardadas:', state.settings);
}

// Consolidar eventos de audio
if (elements.audio) {
    elements.audio.addEventListener('play', () => {
        console.log('Audio reproduciéndose');
        state.isPlaying = true;
        updatePlayingUI(true);
        showPlayingGif();
        updateVisualizerState(state.visualSettings.showVisualizer); // Llamamos una sola vez
    });

    elements.audio.addEventListener('pause', () => {
        console.log('Audio pausado');
        state.isPlaying = false;
        updatePlayingUI(false);
        hidePlayingGif();
    });

    elements.audio.addEventListener('ended', () => {
        console.log('Audio terminado');
        state.isPlaying = false;
        updatePlayingUI(false);
        hidePlayingGif();
        
        if (state.queue.length > 0) {
            playNext();
        } else {
            switch(state.repeat) {
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
    });

    elements.audio.addEventListener('loadedmetadata', () => {
        elements.totalTime.textContent = formatTime(elements.audio.duration);
        console.log('Metadatos cargados, duración:', elements.audio.duration);
    });

    elements.audio.addEventListener('loadeddata', () => {
        elements.audio.volume = state.volume;
        updateVolumeUI();
        console.log('Datos de audio cargados, volumen:', state.volume);
    });

    elements.audio.addEventListener('volumechange', updateVolumeUI);
}

function updateVisualizerState(shouldShow) {
    if (window.updateVisualizerState) {
        window.updateVisualizerState(shouldShow); // Llamamos directamente, sin recursión
        console.log('Estado del visualizador actualizado en background.js:', shouldShow);
    } else {
        console.error('Función updateVisualizerState no disponible en background.js');
    }
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
            alert('Error al reproducir la canción');
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
        if (!track) return;

        elements.currentTrackTitle.textContent = 'Cargando...';
        const streamData = await ipcRenderer.invoke('stream-song', track.url);
        
        state.currentTrack = {
            ...track,
            ...streamData.metadata,
            path: streamData.path
        };

        elements.audio.src = streamData.path;
        await elements.audio.play();
        state.isPlaying = true;
        updatePlayingUI(true);
        updateTrackInfo();
        showPlayingGif();
    } catch (error) {
        console.error('Error al reproducir canción:', error);
        alert('Error al reproducir la canción');
        state.isPlaying = false;
        updatePlayingUI(false);
        updateTrackInfo(); // Restaurar UI a estado inicial en caso de error
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
    if (state.queue.length === 0) {
        console.log('No hay canciones en la cola');
        return;
    }
    
    if (state.shuffle) {
        const randomIndex = Math.floor(Math.random() * state.queue.length);
        state.currentIndex = randomIndex;
        console.log(`Reproduciendo canción aleatoria en índice: ${randomIndex}`);
    } else if (state.queueLoop) {
        const nextTrack = state.queue[0];
        state.queue.push(state.queue.shift()); // Mueve la primera al final
        state.currentIndex = 0; // Reinicia el índice para el bucle
        console.log(`Reproduciendo en bucle: ${nextTrack.title}`);
        playSong(nextTrack);
    } else {
        state.currentIndex = (state.currentIndex + 1) % state.queue.length;
        console.log(`Reproduciendo siguiente canción en índice: ${state.currentIndex}`);
        playSong(state.queue[state.currentIndex]);
    }
    
    updateQueueUI();
}

function playPrevious() {
    if (state.queue.length === 0) {
        console.log('No hay canciones en la cola');
        return;
    }
    
    if (elements.audio.currentTime > 3) {
        elements.audio.currentTime = 0;
        console.log('Reiniciando canción actual');
    } else {
        state.currentIndex = (state.currentIndex - 1 + state.queue.length) % state.queue.length;
        console.log(`Reproduciendo canción anterior en índice: ${state.currentIndex}`);
        playSong(state.queue[state.currentIndex]);
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
    
    elements.audio.volume = volumeLevel;
    state.volume = volumeLevel;
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

    if (pageId === 'home') {
        loadHomeContent();
    }
    console.log(`Página activa: ${pageId}`);
}

// Cargar contenido de inicio
async function loadHomeContent() {
    try {
        console.log('Cargando contenido de inicio');
        const homeData = await ipcRenderer.invoke('get-home-data');
        displayRecentlyPlayed(homeData.recentlyPlayed);
        displayRecommendations(homeData.recommendations);
    } catch (error) {
        console.error('Error al cargar contenido de inicio:', error);
    }
}

function displayRecentlyPlayed(tracks) {
    const recentContainer = document.getElementById('recentTracks');
    recentContainer.innerHTML = '<h2>Reproducido recientemente</h2>';
    
    const tracksGrid = document.createElement('div');
    tracksGrid.className = 'tracks-grid';
    
    tracks.forEach(track => {
        const trackCard = createTrackCard(track);
        tracksGrid.appendChild(trackCard);
    });
    
    recentContainer.appendChild(tracksGrid);
    console.log('Mostrando canciones recientes:', tracks.length);
}

function displayRecommendations(tracks) {
    const recommendationsContainer = document.createElement('div');
    recommendationsContainer.className = 'recommendations-section';
    recommendationsContainer.innerHTML = '<h2>Recomendado para ti</h2>';
    
    const tracksGrid = document.createElement('div');
    tracksGrid.className = 'tracks-grid';
    
    tracks.forEach(track => {
        const trackCard = createTrackCard(track);
        tracksGrid.appendChild(trackCard);
    });
    
    recommendationsContainer.appendChild(tracksGrid);
    document.getElementById('home').appendChild(recommendationsContainer);
    console.log('Mostrando recomendaciones:', tracks.length);
}

// Búsqueda
let searchTimeout;
if (elements.searchInput) {
    elements.searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        const query = e.target.value.trim(); // Corrección: definimos query aquí
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
    card.innerHTML = `
        <img src="${track.thumbnail}" alt="${track.title}">
        <h3>${track.title}</h3>
        <p>${track.artist}</p>
        <div class="card-controls">
            <button class="play-button"><i class="fas fa-play"></i></button>
            <button class="add-to-library"><i class="fas fa-plus"></i></button>
            <button class="queue-button" title="Añadir a la cola"><i class="fas fa-list"></i></button>
        </div>
    `;

    const playButton = card.querySelector('.play-button');
    const addToLibraryButton = card.querySelector('.add-to-library');
    const queueButton = card.querySelector('.queue-button');

    playButton.addEventListener('click', () => {
        playSong(track);
        console.log(`Reproduciendo desde tarjeta: ${track.title}`);
    });

    addToLibraryButton.addEventListener('click', async () => {
        await addToLibrary(track);
        console.log(`Añadido a biblioteca: ${track.title}`);
    });

    queueButton.addEventListener('click', () => {
        addToQueue({ ...track });
        console.log(`Añadido a cola: ${track.title}`);
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
    } catch (error) {
        console.error('Error al agregar a biblioteca:', error);
        alert('Error al agregar a la biblioteca');
    }
}

async function loadLibrary() {
    try {
        console.log('Cargando biblioteca');
        state.library = await ipcRenderer.invoke('get-library');
        updateLibraryUI();
    } catch (error) {
        console.error('Error al cargar biblioteca:', error);
    }
}

function updateLibraryUI() {
    if (elements.libraryContent) {
        elements.libraryContent.innerHTML = '';
        state.library.forEach(track => {
            const trackCard = createTrackCard(track);
            elements.libraryContent.appendChild(trackCard);
        });
        console.log('Interfaz de biblioteca actualizada:', state.library.length, 'canciones');
    }
}

// Configuración visual en "Configuración"
async function toggleVisualizer() {
    state.visualSettings.showVisualizer = !state.visualSettings.showVisualizer;
    await ipcRenderer.invoke('set-visual-settings', state.visualSettings);
    updateVisualizerState(state.visualSettings.showVisualizer);
    console.log('Visualizador cambiado:', state.visualSettings.showVisualizer);
}

// Inicialización
document.addEventListener('DOMContentLoaded', async () => {
    console.log('DOM cargado');
    await loadLibrary();
    await loadVisualSettings();
    initializeSettings();
    initializeQueueControls();
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
    // Añadir toggle para GIF y visualizador en Configuración
    const settingsSection = document.querySelector('.settings-section');
    
    // Toggle para GIF (único)
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

    // Toggle para visualizador
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

    if (elements.visualizerToggle) {
        elements.visualizerToggle.addEventListener('change', toggleVisualizer);
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
