# Actualizaciones de Windows

La aplicación instalada comprueba GitHub a los 15 segundos de abrirse y cada seis horas si el acceso a Internet está activado. Descarga nuevas versiones estables en segundo plano y permite reiniciar para instalarlas o instalarlas al cerrar. En desarrollo (`npm start`) no busca actualizaciones.

El repositorio de distribución es https://github.com/iTheRoken/RokMusic. Debe ser público para que los clientes puedan descargar releases sin credenciales. No incluyas tokens de GitHub dentro de la aplicación.

## Publicar una versión

1. Cambia `version` en `package.json` y actualiza el lockfile con `npm install --package-lock-only`.
2. Guarda los cambios en Git y súbelos al repositorio.
3. Crea y sube el tag correspondiente, por ejemplo `v1.2.1` para la versión `1.2.1`.
4. El workflow Windows release instala dependencias, ejecuta pruebas y genera el instalador NSIS, su blockmap y `latest.yml` en una release borrador. Usa el `GITHUB_TOKEN` del workflow con permiso `contents: write`.
5. Revisa los archivos y publica el borrador desde GitHub Releases. Los clientes solo ven releases publicadas; conserva todos los archivos generados.

`npm run build` genera un instalador local sin publicar. `npm run release` publica un borrador y requiere `GH_TOKEN` en el entorno. Ambos restauran el renderer original incluso si falla el empaquetado.

Los usuarios necesitan instalar una primera versión que incluya este sistema. Las versiones anteriores no pueden adquirir el actualizador automáticamente. La configuración actual no incorpora un certificado de firma de Windows.

La transferencia e instalación entre dos versiones reales debe verificarse con la aplicación instalada y una release publicada; las pruebas locales del controlador no prueban ese recorrido.
