const { ipcRenderer } = require('electron');
const audio = document.getElementById('audioPlayer');

// Estado global de la aplicación
const state = {
    currentTrack: null,
    isPlaying: false,
    queue: [],
    currentIndex: -1,
    volume: 1,
    shuffle: false,
    repeat: 'none', // none, one, all
    library: [],
    playlists: []
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
    volumeButton: document.getElementById('volumeButton')
};

// Event Listeners para el audio
elements.audio.addEventListener('play', () => {
    state.isPlaying = true;
    updatePlayingUI(true);
});

elements.audio.addEventListener('pause', () => {
    state.isPlaying = false;
    updatePlayingUI(false);
});

// Función mejorada de reproducción/pausa
function togglePlayPause() {
    if (!state.currentTrack) return;
    
    if (state.isPlaying) {
        elements.audio.pause();
    } else {
        elements.audio.play().catch(error => {
            console.error('Error al reproducir:', error);
            state.isPlaying = false;
            updatePlayingUI(false);
        });
    }
}

// Función mejorada para actualizar la UI
function updatePlayingUI(isPlaying) {
    state.isPlaying = isPlaying;
    if (elements.playPauseButton) {
        elements.playPauseButton.innerHTML = `<i class="fas fa-${isPlaying ? 'pause' : 'play'}"></i>`;
    }
}

// Función mejorada para reproducir una canción
async function playSong(track) {
    try {
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
    } catch (error) {
        console.error('Error al reproducir:', error);
        alert('Error al reproducir la canción');
        state.isPlaying = false;
        updatePlayingUI(false);
    }
}

// Event listeners mejorados
elements.playPauseButton.addEventListener('click', (e) => {
    e.preventDefault();
    togglePlayPause();
});

elements.audio.addEventListener('ended', () => {
    state.isPlaying = false;
    updatePlayingUI(false);
    
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
});

// Control de reproducción
elements.playPauseButton.addEventListener('click', togglePlayPause);
elements.nextButton.addEventListener('click', playNext);
elements.previousButton.addEventListener('click', playPrevious);
elements.shuffleButton.addEventListener('click', toggleShuffle);
elements.repeatButton.addEventListener('click', toggleRepeat);

// Controles de volumen
elements.volumeButton.addEventListener('click', toggleMute);
const volumeBar = document.querySelector('.volume-bar');
volumeBar.addEventListener('click', handleVolumeChange);

// Barra de progreso
const progressContainer = document.querySelector('.progress-bar');
progressContainer.addEventListener('click', handleProgressBarClick);

function togglePlayPause() {
    if (!state.currentTrack) return;
    
    if (elements.audio.paused) {
        elements.audio.play();
    } else {
        elements.audio.pause();
    }
    updatePlayingUI(!elements.audio.paused);
}

function playNext() {
    if (state.queue.length === 0) return;
    
    if (state.shuffle) {
        const randomIndex = Math.floor(Math.random() * state.queue.length);
        state.currentIndex = randomIndex;
    } else {
        state.currentIndex = (state.currentIndex + 1) % state.queue.length;
    }
    
    playSong(state.queue[state.currentIndex]);
}

function playPrevious() {
    if (state.queue.length === 0) return;
    
    if (elements.audio.currentTime > 3) {
        elements.audio.currentTime = 0;
    } else {
        state.currentIndex = (state.currentIndex - 1 + state.queue.length) % state.queue.length;
        playSong(state.queue[state.currentIndex]);
    }
}

function toggleShuffle() {
    state.shuffle = !state.shuffle;
    elements.shuffleButton.classList.toggle('active');
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
}

function toggleMute() {
    elements.audio.muted = !elements.audio.muted;
    elements.volumeButton.innerHTML = `<i class="fas fa-volume-${elements.audio.muted ? 'mute' : 'up'}"></i>`;
    updateVolumeUI();
}

function handleVolumeChange(e) {
    const rect = volumeBar.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const volumeLevel = Math.min(Math.max(x / rect.width, 0), 1);
    
    elements.audio.volume = volumeLevel;
    state.volume = volumeLevel;
    updateVolumeUI();
}

function updateVolumeUI() {
    const volumeProgress = document.querySelector('.volume-progress');
    volumeProgress.style.width = `${elements.audio.muted ? 0 : elements.audio.volume * 100}%`;
    
    const icon = elements.audio.muted || elements.audio.volume === 0 ? 'mute' :
                elements.audio.volume < 0.5 ? 'down' : 'up';
    elements.volumeButton.innerHTML = `<i class="fas fa-volume-${icon}"></i>`;
}

function handleProgressBarClick(e) {
    if (!state.currentTrack) return;
    
    const rect = progressContainer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const clickedTime = (x / rect.width) * elements.audio.duration;
    elements.audio.currentTime = clickedTime;
}

elements.audio.addEventListener('ended', () => {
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
});

elements.audio.addEventListener('timeupdate', () => {
    if (!state.currentTrack) return;
    const progress = (elements.audio.currentTime / elements.audio.duration) * 100;
    elements.progressBar.style.width = `${progress}%`;
    elements.currentTime.textContent = formatTime(elements.audio.currentTime);
});

elements.audio.addEventListener('loadedmetadata', () => {
    elements.totalTime.textContent = formatTime(elements.audio.duration);
});

elements.audio.addEventListener('loadeddata', () => {
    elements.audio.volume = state.volume;
    updateVolumeUI();
});

elements.audio.addEventListener('volumechange', updateVolumeUI);

// Controles de ventana
document.getElementById('minimizeBtn').addEventListener('click', () => {
    ipcRenderer.send('minimize-window');
});

document.getElementById('maximizeBtn').addEventListener('click', () => {
    ipcRenderer.send('maximize-window');
});

document.getElementById('closeBtn').addEventListener('click', () => {
    ipcRenderer.send('close-window');
});

// Navegación
document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        const page = e.currentTarget.dataset.page;
        showPage(page);
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
}

// Cargar contenido de inicio
async function loadHomeContent() {
    try {
        const homeData = await ipcRenderer.invoke('get-home-data');
        displayRecentlyPlayed(homeData.recentlyPlayed);
        displayRecommendations(homeData.recommendations);
    } catch (error) {
        console.error('Error loading home content:', error);
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
}

// Búsqueda
let searchTimeout;
elements.searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        const query = e.target.value.trim();
        if (query) {
            performSearch(query);
        }
    }, 500);
});

async function performSearch(query) {
    try {
        elements.searchResults.innerHTML = '<div class="loading">Buscando...</div>';
        const results = await ipcRenderer.invoke('search-songs', query);
        state.queue = results;
        state.currentIndex = -1;
        displaySearchResults(results);
    } catch (error) {
        elements.searchResults.innerHTML = '<div class="error">Error al buscar canciones</div>';
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
}

function createTrackCard(track) {
    const card = document.createElement('div');
    card.className = 'track-card';
    card.innerHTML = `
        <img src="${track.thumbnail}" alt="${track.title}">
        <h3>${track.title}</h3>
        <p>${track.artist}</p>
        <div class="card-controls">
            <button class="play-button">
                <i class="fas fa-play"></i>
            </button>
            <button class="add-to-library">
                <i class="fas fa-plus"></i>
            </button>
        </div>
    `;

    card.querySelector('.play-button').addEventListener('click', () => {
        playSong(track);
    });

    card.querySelector('.add-to-library').addEventListener('click', async () => {
        await addToLibrary(track);
    });

    return card;
}

// Reproducción
async function playSong(track) {
    try {
        elements.currentTrackTitle.textContent = 'Cargando...';
        const streamData = await ipcRenderer.invoke('stream-song', track.url);
        
        state.currentTrack = {
            ...track,
            ...streamData.metadata,
            path: streamData.path
        };

        elements.audio.src = streamData.path;
        elements.audio.play();
        updatePlayingUI(true);
        updateTrackInfo();
    } catch (error) {
        console.error('Error al reproducir:', error);
        alert('Error al reproducir la canción');
    }
}

function updatePlayingUI(isPlaying) {
    state.isPlaying = isPlaying;
    elements.playPauseButton.innerHTML = `<i class="fas fa-${isPlaying ? 'pause' : 'play'}"></i>`;
}

function updateTrackInfo() {
    if (state.currentTrack) {
        elements.currentTrackTitle.textContent = state.currentTrack.title;
        elements.currentTrackArtist.textContent = state.currentTrack.artist;
        elements.currentTrackImg.src = state.currentTrack.thumbnail;
    }
}

// Control de reproducción
elements.playPauseButton.addEventListener('click', () => {
    if (state.isPlaying) {
        elements.audio.pause();
    } else {
        elements.audio.play();
    }
});

elements.nextButton.addEventListener('click', () => {
    if (state.queue.length > 0) {
        state.currentIndex = (state.currentIndex + 1) % state.queue.length;
        playSong(state.queue[state.currentIndex]);
    }
});

elements.previousButton.addEventListener('click', () => {
    if (state.queue.length > 0) {
        state.currentIndex = (state.currentIndex - 1 + state.queue.length) % state.queue.length;
        playSong(state.queue[state.currentIndex]);
    }
});

elements.audio.addEventListener('play', () => updatePlayingUI(true));
elements.audio.addEventListener('pause', () => updatePlayingUI(false));

// Progreso
elements.audio.addEventListener('timeupdate', () => {
    const progress = (elements.audio.currentTime / elements.audio.duration) * 100;
    elements.progressBar.style.width = `${progress}%`;
    elements.currentTime.textContent = formatTime(elements.audio.currentTime);
});

elements.audio.addEventListener('loadedmetadata', () => {
    elements.totalTime.textContent = formatTime(elements.audio.duration);
});

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Biblioteca
async function addToLibrary(track) {
    try {
        const updatedLibrary = await ipcRenderer.invoke('add-to-library', track);
        state.library = updatedLibrary;
        updateLibraryUI();
    } catch (error) {
        console.error('Error al agregar a la biblioteca:', error);
        alert('Error al agregar a la biblioteca');
    }
}

async function loadLibrary() {
    try {
        state.library = await ipcRenderer.invoke('get-library');
        updateLibraryUI();
    } catch (error) {
        console.error('Error al cargar la biblioteca:', error);
    }
}

function updateLibraryUI() {
    if (elements.libraryContent) {
        elements.libraryContent.innerHTML = '';
        state.library.forEach(track => {
            const trackCard = createTrackCard(track);
            elements.libraryContent.appendChild(trackCard);
        });
    }
}

// Inicialización
document.addEventListener('DOMContentLoaded', () => {
    loadLibrary();
});

// Atajos de teclado
document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
        e.preventDefault();
        elements.playPauseButton.click();
    }
});
