// Configuración del canvas y variables globales
const canvas = document.getElementById('visualizer');
const ctx = canvas ? canvas.getContext('2d') : null;
let audioContext, analyser, dataArray;
let isInitialized = false;
let animationFrameId;
let showVisualizer = true; // Valor predeterminado, se actualizará desde renderer.js

const backgroundGradients = [
    { x: 0.2, y: 0.3, baseRadius: 200, color: '#1db954', speed: 0.5 },
    { x: 0.8, y: 0.4, baseRadius: 250, color: '#1ed760', speed: 0.7 },
    { x: 0.5, y: 0.6, baseRadius: 300, color: '#1db954', speed: 0.3 }
];

function setupCanvas() {
    if (!canvas) {
        console.error('Canvas #visualizer no encontrado');
        return;
    }
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    console.log('Canvas configurado:', canvas.width, canvas.height);
}

function initializeAudioContext() {
    if (isInitialized) return;

    try {
        console.log('Inicializando AudioContext...');
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 1024; // Aumentamos para capturar más datos de audio
        analyser.smoothingTimeConstant = 0.2; // Más respuesta dinámica

        const audioElement = document.getElementById('audioPlayer');
        if (!audioElement) {
            console.error('Elemento #audioPlayer no encontrado');
            return;
        }

        const source = audioContext.createMediaElementSource(audioElement);
        source.connect(analyser);
        analyser.connect(audioContext.destination);

        dataArray = new Uint8Array(analyser.frequencyBinCount);
        isInitialized = true;

        if (audioContext.state === 'suspended') {
            audioContext.resume().then(() => console.log('AudioContext reanudado'));
        } else {
            console.log('AudioContext iniciado en estado:', audioContext.state);
        }
    } catch (error) {
        console.error('Error al inicializar AudioContext:', error);
    }
}

function getAudioData() {
    if (!analyser) return null;
    analyser.getByteFrequencyData(dataArray);
    const bass = average(dataArray.slice(0, 64)); // Más rango para bajos
    const mids = average(dataArray.slice(64, 256));
    const treble = average(dataArray.slice(256, 512));
    return { bass, mids, treble };
}

function average(array) {
    return array.reduce((a, b) => a + b, 0) / array.length || 0.1; // Valor mínimo para visibilidad
}

function drawBackground(audioData) {
    if (!ctx || !showVisualizer) return;

    ctx.fillStyle = 'rgba(18, 18, 18, 0.05)'; // Fondo más transparente para mayor visibilidad
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!audioData) {
        drawStaticBackground();
        return;
    }

    backgroundGradients.forEach((gradient, index) => {
        const time = Date.now() * gradient.speed * 0.001;
        const x = canvas.width * gradient.x + Math.sin(time) * 50;
        const y = canvas.height * gradient.y + Math.cos(time) * 50;

        let radius = gradient.baseRadius;
        let intensity = 0;

        if (index === 0) {
            intensity = Math.min(1, audioData.bass / 128); // Ajustamos la escala para más impacto
            radius *= 1 + (intensity * 3.0); // Mayor expansión para bajos
        } else if (index === 1) {
            intensity = Math.min(1, audioData.mids / 128);
            radius *= 1 + (intensity * 2.0);
        } else {
            intensity = Math.min(1, audioData.treble / 128);
            radius *= 1 + (intensity * 1.5);
        }

        if (intensity <= 0) intensity = 0.1; // Mínimo para evitar valores nulos

        const grd = ctx.createRadialGradient(x, y, 0, x, y, radius);
        const alpha = Math.max(0.7, intensity * 2.0); // Mayor opacidad para visibilidad
        const colorHex = gradient.color.slice(1); // Quitamos el '#'
        const r = parseInt(colorHex.substr(0, 2), 16);
        const g = parseInt(colorHex.substr(2, 2), 16);
        const b = parseInt(colorHex.substr(4, 2), 16);
        grd.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha})`);
        grd.addColorStop(0.7, `rgba(${r}, ${g}, ${b}, ${alpha * 0.2})`); // Reducimos opacidad para el fade
        grd.addColorStop(1, 'rgba(18, 18, 18, 0)');

        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
    });
}

function drawStaticBackground() {
    if (!ctx || !showVisualizer) return;

    backgroundGradients.forEach((gradient) => {
        const x = canvas.width * gradient.x;
        const y = canvas.height * gradient.y;
        const grd = ctx.createRadialGradient(x, y, 0, x, y, gradient.baseRadius);
        grd.addColorStop(0, `${gradient.color}0A`); // Más tenue para contraste
        grd.addColorStop(1, 'rgba(18, 18, 18, 0)');
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(x, y, gradient.baseRadius, 0, Math.PI * 2);
        ctx.fill();
        console.log('Dibujando fondo estático');
    });
}

function animate() {
    if (!showVisualizer) {
        return; // No logueamos para evitar saturación
    }
    animationFrameId = requestAnimationFrame(animate);
    const audioData = getAudioData();
    drawBackground(audioData);
}

// Función para actualizar el estado del visualizador desde renderer.js
function updateVisualizerState(shouldShow) {
    showVisualizer = shouldShow;
    console.log('Estado del visualizador actualizado:', showVisualizer);
    if (shouldShow && isInitialized) {
        animate();
    }
}

window.addEventListener('resize', setupCanvas);

document.addEventListener('DOMContentLoaded', () => {
    setupCanvas();
    drawStaticBackground();
    console.log('DOM cargado, fondo estático dibujado');

    const audioElement = document.getElementById('audioPlayer');
    const playPauseButton = document.getElementById('playPauseButton');

    if (audioElement) {
        audioElement.addEventListener('play', () => {
            console.log('Evento play disparado');
            if (!isInitialized) {
                initializeAudioContext();
            } else if (audioContext && audioContext.state === 'suspended') {
                audioContext.resume().then(() => console.log('AudioContext reanudado tras play'));
            }
            if (showVisualizer) {
                animate();
            }
        });
    }

    if (playPauseButton) {
        playPauseButton.addEventListener('click', () => {
            console.log('Botón play/pause clickeado');
            if (!isInitialized) {
                initializeAudioContext();
            } else if (audioContext && audioContext.state === 'suspended') {
                audioContext.resume().then(() => console.log('AudioContext reanudado tras click'));
            }
        });
    }
});

function cleanup() {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
    }
    if (audioContext) {
        audioContext.close().catch(error => console.error('Error cerrando AudioContext:', error));
    }
    console.log('Limpieza de recursos completada');
}

window.addEventListener('beforeunload', cleanup);

// Exponer updateVisualizerState para que renderer.js pueda llamarlo
window.updateVisualizerState = updateVisualizerState;
