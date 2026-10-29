# Identidad Lunera

La luna conserva el trazado del encabezado de Lunera Mobile. Color: #a0e8c4.

- `lunera-moon.svg`: original vectorial, sin fondo.
- `lunera-moon-1024.png`: PNG transparente para reutilizar.
- `lunera.ico`: icono de Windows con siete resoluciones (16 a 256 px).
- `startup-preview.png`: captura de la entrada de escritorio.

`node scripts/generate-brand.cjs` regenera los PNG, el ICO y los recursos Android. Requiere `@resvg/resvg-js`; se puede indicar su ubicación externa con `LUNERA_RESVG_PATH`. No necesita esa dependencia para ejecutar Lunera.

Android utiliza PNG por densidad y un icono adaptable con fondo transparente. El lanzador del teléfono puede aplicar su propia máscara o apariencia temática.

La entrada de Windows dura aproximadamente 2,2 segundos más el desvanecimiento de salida. Respeta la preferencia de movimiento reducido.

## Comprobación de esta entrega

- PNG RGBA verificado: fondo con alfa 0 y trazado visible.
- Escritorio: 60 pruebas existentes aprobadas; entrada normal y con movimiento reducido comprobadas, incluido el cierre gradual y su ejecución única. Vista previa capturada con Electron.
- Android 0.3.12 (15): ensamblado, 126 pruebas unitarias y lint ejecutados correctamente. APK instalado correctamente en emulador Android y luna comprobada en el menú.
- El Pixel Launcher del emulador representa el fondo transparente del icono adaptable como un círculo negro. Ese círculo lo compone el lanzador: los PNG no contienen un fondo negro. Captura: `android-launcher-preview.png`.
- Instalador Windows generado en `dist/moon-branding/Lunera-Setup-1.8.0.exe`; APK en `Lunera Mobile/entregables/Lunera-Mobile-debug.apk`.
