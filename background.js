// Configuración del canvas
const canvas = document.getElementById('visualizer');
const ctx = canvas.getContext('2d');
let audioContext, analyser, dataArray;
let isInitialized = false;

// Configuración de los puntos de degradado con más variación
const gradientPoints = [
    { x: 0.2, y: 0.3, radius: 150, color: '#1db954' },
    { x: 0.8, y: 0.4, radius: 200, color: '#1ed760' },
    { x: 0.5, y: 0.7, radius: 180, color: '#1db954' },
    { x: 0.1, y: 0.8, radius: 120, color: '#1ed760' },
    { x: 0.9, y: 0.2, radius: 160, color: '#1db954' }
];

function initializeVisualizer() {
    if (isInitialized) return;
    
    // Ajustar tamaño del canvas al tamaño de la ventana
    function resizeCanvas() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Configurar el contexto de audio con mayor sensibilidad
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048; // Aumentado para mayor detalle
    analyser.smoothingTimeConstant = 0.85; // Suavizado para transiciones más fluidas
    
    const bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);
    
    const audioElement = document.getElementById('audioPlayer');
    const source = audioContext.createMediaElementSource(audioElement);
    source.connect(analyser);
    analyser.connect(audioContext.destination);
    
    isInitialized = true;
    animate();
}

function animate() {
    requestAnimationFrame(animate);
    
    if (!analyser) return;
    
    analyser.getByteFrequencyData(dataArray);
    
    // Limpieza del canvas con efecto de desvanecimiento
    ctx.fillStyle = 'rgba(18, 18, 18, 0.1)'; // Reducido el alpha para mejor trail
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Calcular promedios de frecuencia con rangos más precisos
    const bassAvg = getFrequencyRangeAverage(0, 100);
    const midAvg = getFrequencyRangeAverage(101, 500);
    const trebleAvg = getFrequencyRangeAverage(501, 1023);

    // Dibujar los degradados con animación mejorada
    gradientPoints.forEach((point, index) => {
        let intensity;
        // Asignar diferentes rangos de frecuencia a cada punto
        if (index % 3 === 0) {
            intensity = bassAvg * 2.5; // Amplificar bajos
        } else if (index % 3 === 1) {
            intensity = midAvg * 2.0; // Amplificar medios
        } else {
            intensity = trebleAvg * 1.5; // Amplificar agudos
        }

        // Calcular posición con movimiento suave
        const time = Date.now() * 0.001;
        const x = point.x * canvas.width + Math.sin(time + index) * 100;
        const y = point.y * canvas.height + Math.cos(time + index) * 100;
        
        // Radio dinámico basado en la intensidad
        const radius = point.radius * (1 + intensity / 255 * 1.5);
        
        // Crear degradado radial con opacidad dinámica
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        const alpha = Math.min(0.9, intensity / 255);
        
        gradient.addColorStop(0, `${point.color}${Math.floor(alpha * 255).toString(16).padStart(2, '0')}`);
        gradient.addColorStop(1, 'rgba(29, 185, 84, 0)');

        // Dibujar el degradado
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
    });
}

function getFrequencyRangeAverage(start, end) {
    let sum = 0;
    let count = 0;
    for (let i = start; i <= end; i++) {
        sum += dataArray[i];
        count++;
    }
    return sum / count;
}

// Inicializar el visualizador cuando se carga la página
document.addEventListener('DOMContentLoaded', () => {
    const audioElement = document.getElementById('audioPlayer');
    
    // Inicializar cuando se reproduce por primera vez
    audioElement.addEventListener('play', () => {
        if (audioContext && audioContext.state === 'suspended') {
            audioContext.resume();
        }
        if (!isInitialized) {
            initializeVisualizer();
        }
    });

    // Manejar el botón de reproducción
    const playPauseButton = document.getElementById('playPauseButton');
    if (playPauseButton) {
        playPauseButton.addEventListener('click', () => {
            if (audioContext && audioContext.state === 'suspended') {
                audioContext.resume();
            }
            if (!isInitialized) {
                initializeVisualizer();
            }
        });
    }
});