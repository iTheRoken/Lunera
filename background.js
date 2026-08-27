document.addEventListener("DOMContentLoaded", () => {
    console.log("✅ background.js cargado y ejecutándose");

    // Verificar si estamos en Electron o en un entorno móvil
    const isElectron = typeof require !== 'undefined' && typeof window.require === 'function';

    if (!isElectron) {
        console.log("Ejecutando en entorno móvil, desactivando canvas por ahora");
        return;
    }

    const canvas = document.getElementById("visualizer");
    if (!canvas) {
        console.error("⚠️ No se encontró el canvas #visualizer.");
        return;
    }

    const canvasCtx = canvas.getContext("2d");
    if (!canvasCtx) {
        console.error("⚠️ No se pudo obtener el contexto 2D del canvas.");
        return;
    }

    // Ajustar el tamaño del canvas
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    console.log("🔧 Canvas inicializado:", canvas.width, "x", canvas.height);

    // Dibujar un rectángulo rojo estático (solo en Electron)
    canvasCtx.fillStyle = "red";
    canvasCtx.fillRect(0, 0, canvas.width / 2, canvas.height / 2);

    console.log("🔴 Rectángulo rojo dibujado en el canvas.");
});