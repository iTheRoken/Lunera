const { app, BrowserWindow, ipcMain } = require('electron');
const ytdl = require('@distube/ytdl-core');
const usetube = require ('usetube')
const Store = require('electron-store');
const path = require('path');
const fs = require('fs');

const store = new Store();
const userDataPath = path.join(app.getPath('userData'), 'userData.json');
let mainWindow;
let currentStream = null;

// Cargar o crear datos de usuario
function loadUserData() {
    if (!fs.existsSync(userDataPath)) {
        const initialData = {
            recentlyPlayed: [],
            recommendations: [],
            playbackHistory: [],
            userPreferences: {
                favoriteArtists: [],
                favoriteGenres: [],
                skipHistory: []
            }
        };
        fs.writeFileSync(userDataPath, JSON.stringify(initialData, null, 2));
        return initialData;
    }
    return JSON.parse(fs.readFileSync(userDataPath, 'utf8'));
}

// Guardar datos de usuario
function saveUserData(data) {
    fs.writeFileSync(userDataPath, JSON.stringify(data, null, 2));
}

// Actualizar historial de reproducción
function updatePlaybackHistory(track) {
    const userData = loadUserData();
    userData.recentlyPlayed.unshift(track);
    userData.recentlyPlayed = userData.recentlyPlayed.slice(0, 20); // Mantener solo los últimos 20
    saveUserData(userData);
}

// Generar recomendaciones basadas en el historial
async function generateRecommendations(artist) {
    try {
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(artist + ' similar songs')}`;
        const html = await fetch(searchUrl).then(res => res.text());
        
        const videoPattern = /videoId":"([^"]+)"/g;
        const videoIds = [...new Set([...html.matchAll(videoPattern)].map(match => match[1]))];
        
        const results = await Promise.all(
            videoIds.slice(0, 10).map(async (id) => {
                try {
                    const info = await ytdl.getBasicInfo(`https://www.youtube.com/watch?v=${id}`);
                    return {
                        id: id,
                        title: info.videoDetails.title,
                        artist: info.videoDetails.author.name,
                        duration: info.videoDetails.lengthSeconds,
                        thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
                        url: `https://www.youtube.com/watch?v=${id}`
                    };
                } catch (err) {
                    console.error(`Error getting info for video ${id}:`, err);
                    return null;
                }
            })
        );

        return results.filter(result => result !== null);
    } catch (error) {
        console.error('Recommendations error:', error);
        return [];
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        frame: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
        backgroundColor: '#121212',
    });

    mainWindow.loadFile('index.html');
}

// Manejo de controles de ventana
ipcMain.on('minimize-window', () => {
    mainWindow.minimize();
});

ipcMain.on('maximize-window', () => {
    if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow.maximize();
    }
});

ipcMain.on('close-window', () => {
    mainWindow.close();
});

// Implementación de búsqueda
ipcMain.handle('search-songs', async (event, query) => {
    try {
        const results = (await usetube.searchVideo(query)).videos;
        if (results.length === 0) return [];

        return await Promise.all(
            results.slice(0, 10).map(async (result) => {
                try {
                    const info = await ytdl.getBasicInfo(result.id);
                    return {
                        id: result.id,
                        title: info.videoDetails.title || "Sin título",
                        artist: info.videoDetails.author.name || "Sin autor",
                        duration: info.videoDetails.lengthSeconds || 0,
                        thumbnail: `https://i.ytimg.com/vi/${result.id}/mqdefault.jpg`,
                        url: `https://www.youtube.com/watch?v=${result.id}`
                    };
                } catch (error) {
                    console.error(`Error obteniendo información del video ${result.id}:`, error);
                    return null;
                }
            })
        ).then(videos => videos.filter(video => video !== null));

    } catch (error) {
        console.error('Error en la búsqueda:', error);
        throw new Error('No se pudo buscar canciones');
    }
});

// Streaming mejorado
ipcMain.handle('stream-song', async (event, videoUrl) => {
    try {
        if (currentStream) {
            currentStream.destroy();
        }

        const info = await ytdl.getInfo(videoUrl);
        const audioFormat = ytdl.chooseFormat(info.formats, { 
            quality: 'highestaudio',
            filter: 'audioonly' 
        });

        const tempPath = path.join(app.getPath('temp'), `${info.videoDetails.videoId}.mp3`);
        currentStream = ytdl(videoUrl, { format: audioFormat });
        
        const trackData = {
            id: info.videoDetails.videoId,
            title: info.videoDetails.title,
            artist: info.videoDetails.author.name,
            thumbnail: info.videoDetails.thumbnails[0].url,
            duration: info.videoDetails.lengthSeconds,
            url: videoUrl
        };

        // Actualizar historial
        updatePlaybackHistory(trackData);

        // Generar recomendaciones
        const recommendations = await generateRecommendations(trackData.artist);
        const userData = loadUserData();
        userData.recommendations = recommendations;
        saveUserData(userData);

        return new Promise((resolve, reject) => {
            const writeStream = fs.createWriteStream(tempPath);
            currentStream.pipe(writeStream);

            writeStream.on('finish', () => {
                resolve({
                    path: tempPath,
                    metadata: trackData
                });
            });

            writeStream.on('error', (error) => {
                reject(new Error('Failed to save audio stream'));
            });
        });
    } catch (error) {
        console.error('Streaming error:', error);
        throw new Error('Failed to stream song');
    }
});

// Obtener datos para la página de inicio
ipcMain.handle('get-home-data', async () => {
    const userData = loadUserData();
    return {
        recentlyPlayed: userData.recentlyPlayed,
        recommendations: userData.recommendations
    };
});

// Manejo de biblioteca
ipcMain.handle('add-to-library', async (event, song) => {
    try {
        const library = store.get('library', []);
        if (!library.some(s => s.id === song.id)) {
            library.push(song);
            store.set('library', library);
        }
        return library;
    } catch (error) {
        console.error('Library error:', error);
        throw new Error('Failed to add song to library');
    }
});

ipcMain.handle('get-library', () => {
    return store.get('library', []);
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
