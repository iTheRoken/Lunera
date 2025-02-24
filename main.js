const { app, BrowserWindow, ipcMain } = require('electron');
const ytdl = require('@distube/ytdl-core');
const usetube = require('usetube');
const Store = require('electron-store');
const path = require('path');
const fs = require('fs');

const store = new Store();
const userDataPath = path.join(app.getPath('userData'), 'userData.json');
let mainWindow;
let currentStream = null;

console.log('Inicializando aplicación Electron...');

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
            },
            visualSettings: {
                showVisualizer: true // Nueva configuración para el fondo brillante
            }
        };
        fs.writeFileSync(userDataPath, JSON.stringify(initialData, null, 2));
        console.log('Datos de usuario iniciales creados');
        return initialData;
    }
    const data = JSON.parse(fs.readFileSync(userDataPath, 'utf8'));
    console.log('Datos de usuario cargados');
    return data;
}

// Guardar datos de usuario
function saveUserData(data) {
    fs.writeFileSync(userDataPath, JSON.stringify(data, null, 2));
    console.log('Datos de usuario guardados');
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
        console.log(`Generando recomendaciones para el artista: ${artist}`);
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
                    console.error(`Error obteniendo info para video ${id}:`, err);
                    return null;
                }
            })
        );

        return results.filter(result => result !== null);
    } catch (error) {
        console.error('Error en recomendaciones:', error);
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
    console.log('Ventana principal creada');

    mainWindow.loadFile('index.html');

    mainWindow.on('closed', () => {
        mainWindow = null;
        console.log('Ventana principal cerrada');
    });
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

// Implementación de búsqueda
ipcMain.handle('search-songs', async (event, query) => {
    console.log(`Buscando canciones con query: ${query}`);
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
                    console.error(`Error obteniendo info del video ${result.id}:`, error);
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
    console.log(`Transmitiendo canción desde: ${videoUrl}`);
    try {
        if (currentStream) {
            currentStream.destroy();
            console.log('Flujo anterior destruido');
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

        updatePlaybackHistory(trackData);

        const recommendations = await generateRecommendations(trackData.artist);
        const userData = loadUserData();
        userData.recommendations = recommendations;
        saveUserData(userData);

        return new Promise((resolve, reject) => {
            const writeStream = fs.createWriteStream(tempPath);
            currentStream.pipe(writeStream);

            writeStream.on('finish', () => {
                console.log('Flujo de audio guardado en:', tempPath);
                resolve({
                    path: tempPath,
                    metadata: trackData
                });
            });

            writeStream.on('error', (error) => {
                console.error('Error al guardar el flujo de audio:', error);
                reject(new Error('No se pudo guardar el flujo de audio'));
            });
        });
    } catch (error) {
        console.error('Error en streaming:', error);
        throw new Error('No se pudo transmitir la canción');
    }
});

// Obtener datos para la página de inicio
ipcMain.handle('get-home-data', async () => {
    console.log('Obteniendo datos de la página de inicio');
    const userData = loadUserData();
    return {
        recentlyPlayed: userData.recentlyPlayed,
        recommendations: userData.recommendations
    };
});

// Manejo de biblioteca
ipcMain.handle('add-to-library', async (event, song) => {
    console.log(`Añadiendo a la biblioteca: ${song.title}`);
    try {
        const library = store.get('library', []);
        if (!library.some(s => s.id === song.id)) {
            library.push(song);
            store.set('library', library);
        }
        return library;
    } catch (error) {
        console.error('Error al agregar a la biblioteca:', error);
        throw new Error('No se pudo agregar a la biblioteca');
    }
});

ipcMain.handle('get-library', () => {
    console.log('Obteniendo biblioteca');
    return store.get('library', []);
});

// Nueva funcionalidad: obtener/guardar configuración visual
ipcMain.handle('get-visual-settings', () => {
    console.log('Obteniendo configuraciones visuales');
    const userData = loadUserData();
    return userData.visualSettings;
});

ipcMain.handle('set-visual-settings', (event, settings) => {
    console.log('Guardando configuraciones visuales:', settings);
    const userData = loadUserData();
    userData.visualSettings = { ...userData.visualSettings, ...settings };
    saveUserData(userData);
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    console.log('Cerrando aplicación (plataforma no macOS)');
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    console.log('Reactivando aplicación');
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
