# Sistema de Sonidos para Notificaciones

## Sonidos Sintéticos Automáticos

El sistema de notificaciones utiliza **sonidos sintéticos generados automáticamente** usando Web Audio API. No necesitas archivos de audio externos.

### Características de los Sonidos:
- **Success**: Melodía ascendente (800Hz → 1000Hz → 1200Hz) - 0.3s
- **Error**: Secuencia descendente (400Hz → 300Hz → 200Hz) - 0.4s  
- **Warning**: Nota doble (600Hz → 800Hz) - 0.5s
- **Info**: Nota simple (500Hz → 700Hz) - 0.25s

### Especificaciones Técnicas:
- **Generación**: Web Audio API con osciladores sintéticos
- **Filtrado**: Low-pass filter para sonidos más agradables
- **Volumen**: Ajustado automáticamente por tipo
- **Duración**: Optimizada para cada tipo de notificación
- **Calidad**: 44.1kHz, 16-bit (estándar de navegador)

## Cómo Probar

### Desde la Consola del Navegador (F12):
```javascript
// Probar todos los tipos
testNotification()

// Probar individualmente
testSuccess()   // Sonido verde
testError()     // Sonido rojo
testWarning()   // Sonido naranja
testInfo()      // Sonido azul

// Pruebas simples
testNotif()     // Notificación básica
testSimple()    // Notificación simple
```

### Desde la Interfaz:
- Haz clic en el botón "Probar Notificaciones" en la página de inicio

## Funcionamiento

El sistema:
1. Carga automáticamente los archivos de audio al inicializar
2. Reproduce el sonido correspondiente cuando se muestra una notificación
3. Maneja errores graciosamente si los archivos no existen
4. Ajusta el volumen automáticamente
5. Reinicia el audio si se reproduce múltiples veces rápidamente

## Notas Importantes

- Los archivos deben estar en formato WAV para mejor compatibilidad
- Si un archivo no existe, la notificación se mostrará sin sonido
- El sistema funciona tanto en navegadores como en Electron
- Los sonidos se cargan de forma asíncrona para mejor rendimiento
