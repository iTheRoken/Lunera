const { app, BrowserWindow, ipcMain } = require('electron');
const ytdl = require('@distube/ytdl-core');
const usetube = require('usetube');
const Store = require('electron-store');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

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
let currentStream = null;

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
});

// Migrar datos de userData.json si existe
function migrateUserData() {
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
}

// Actualizar historial de reproducción
function updatePlaybackHistory(track) {
  db.run(`
    INSERT OR REPLACE INTO recently_played (video_id, title, artist, thumbnail, url, duration)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [track.id, track.title, track.artist, track.thumbnail, track.url, track.duration], (err) => {
    if (err) console.error('Error al guardar en recently_played:', err);
    else console.log('Historial actualizado:', track.title);
  });
}

// Generar y guardar recomendaciones basadas en el historial
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

    const validResults = results.filter(result => result !== null);
    
    validResults.forEach(track => {
      db.run(`
        INSERT OR REPLACE INTO recommendations (video_id, title, artist, thumbnail, url, duration)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [track.id, track.title, track.artist, track.thumbnail, track.url, track.duration], (err) => {
        if (err) console.error('Error al guardar recomendación:', err);
      });
    });

    return validResults;
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

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.webContents.openDevTools();

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
          console.error(`Error obteniendo info del video ${result.id}:`, error.stack);
          return null;
        }
      })
    ).then(videos => videos.filter(video => video !== null));
  } catch (error) {
    console.error('Error detallado en la búsqueda:', error.stack);
    throw new Error(`No se pudo buscar canciones: ${error.message}`);
  }
});

// Streaming mejorado
ipcMain.handle('stream-song', async (event, videoUrl) => {
  console.log(`Transmitiendo canción desde: ${videoUrl}`);
  try {
    if (!videoUrl) {
      throw new Error('URL de video no proporcionada');
    }

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
    }

    console.log('Obteniendo información del video...');
    const info = await ytdl.getInfo(videoUrl);
    const audioFormat = ytdl.chooseFormat(info.formats, { 
      quality: 'highestaudio',
      filter: 'audioonly' 
    });

    const tempPath = path.join(
      app.getPath('temp'),
      `${info.videoDetails.videoId}-${Date.now()}.mp3`
    );    
    console.log('Iniciando flujo de ytdl-core hacia:', tempPath);
    currentStream = ytdl(videoUrl, { format: audioFormat });
    currentStream.path = tempPath; // Guardar la ruta para eliminación posterior
    
    // Seleccionar la miniatura de mayor resolución
const thumbnails = info.videoDetails.thumbnails;
let thumbnailUrl = thumbnails[0].url; // Valor por defecto

// Buscar la miniatura de mayor calidad (maxres o high)
for (const thumb of thumbnails) {
  if (thumb.width >= 1280 || thumb.url.includes('maxres')) {
    thumbnailUrl = thumb.url;
    break;
  } else if (thumb.width >= 480 && !thumbnailUrl.includes('maxres')) {
    thumbnailUrl = thumb.url;
  }
}

const trackData = {
  id: info.videoDetails.videoId,
  title: info.videoDetails.title,
  artist: info.videoDetails.author.name,
  thumbnail: thumbnailUrl,
  duration: info.videoDetails.lengthSeconds,
  url: videoUrl
};

    console.log('Actualizando historial de reproducción...');
    updatePlaybackHistory(trackData);

    console.log('Generando recomendaciones...');
    const recommendations = await generateRecommendations(trackData.artist);

    return new Promise((resolve, reject) => {
      console.log('Creando writeStream...');
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
        reject(new Error('No se pudo guardar el flujo de audio: ' + error.message));
      });

      currentStream.on('error', (error) => {
        console.error('Error en el flujo de ytdl:', error);
        reject(new Error('Error en el streaming: ' + error.message));
      });

      currentStream.on('end', () => {
        console.log('Flujo de ytdl-core finalizado');
      });

      setTimeout(() => {
        if (!writeStream.writableEnded) {
          console.error('Timeout: El flujo no se completó en 60 segundos');
          writeStream.destroy();
          reject(new Error('Timeout: No se pudo completar el streaming en 30 segundos'));
        }
      }, 60000);
    });
  } catch (error) {
    console.error('Error en streaming:', error);
    throw error;
  }
});

// Obtener datos para la página de inicio
ipcMain.handle('get-home-data', async () => {
  console.log('Obteniendo datos de la página de inicio desde SQLite');
  return new Promise((resolve, reject) => {
    const data = {};
    db.all('SELECT * FROM recently_played ORDER BY played_at DESC LIMIT 20', (err, rows) => {
      if (err) return reject(err);
      data.recentlyPlayed = rows;
      db.all('SELECT * FROM recommendations LIMIT 10', (err, recs) => {
        if (err) return reject(err);
        data.recommendations = recs;
        resolve(data);
      });
    });
  });
});

// Manejo de biblioteca
ipcMain.handle('add-to-library', async (event, song) => {
  console.log(`Añadiendo a la biblioteca desde SQLite: ${song.title}`);
  return new Promise((resolve, reject) => {
    db.run(`
      INSERT OR IGNORE INTO library (video_id, title, artist, thumbnail, url, duration)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [song.id, song.title, song.artist, song.thumbnail, song.url, song.duration], (err) => {
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
  console.log(`Añadiendo canción a playlist ${playlistId}: ${song.title}`);
  return new Promise((resolve, reject) => {
    // Primero, asegurarse de que la canción esté en la biblioteca
    db.run(`
      INSERT OR IGNORE INTO library (video_id, title, artist, thumbnail, url, duration)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [song.id, song.title, song.artist, song.thumbnail, song.url, song.duration], (err) => {
      if (err) return reject(err);
      // Luego, añadir la canción a la playlist
      db.run(`
        INSERT OR IGNORE INTO playlist_songs (playlist_id, video_id)
        VALUES (?, ?)
      `, [playlistId, song.id], (err) => {
        if (err) return reject(err);
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

// Borrar todos los datos
ipcMain.handle('delete-all-data', async () => {
    console.log('Borrando todos los datos de la base de datos');
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            try {
                // Eliminar todas las tablas
                db.run('DELETE FROM recently_played', (err) => {
                    if (err) throw err;
                });
                db.run('DELETE FROM recommendations', (err) => {
                    if (err) throw err;
                });
                db.run('DELETE FROM library', (err) => {
                    if (err) throw err;
                });
                db.run('DELETE FROM playlist_songs', (err) => {
                    if (err) throw err;
                });
                db.run('DELETE FROM playlists', (err) => {
                    if (err) throw err;
                });
                db.run('DELETE FROM settings', (err) => {
                    if (err) throw err;
                });
                console.log('Todas las tablas han sido vaciadas');
                resolve(true);
            } catch (error) {
                console.error('Error al borrar datos:', error);
                reject(error);
            }
        });
    });
});

ipcMain.handle('add-to-favorites', async (event, song) => {
  console.log(`Añadiendo a favoritos desde SQLite: ${song.title}`);
  return new Promise((resolve, reject) => {
    db.run(`
      INSERT OR IGNORE INTO favorites (video_id, title, artist, thumbnail, url, duration)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [song.id, song.title, song.artist, song.thumbnail, song.url, song.duration], (err) => {
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

app.whenReady().then(() => {
  migrateUserData();
  createWindow();
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
