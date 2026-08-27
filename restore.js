const fs = require('fs');
const path = require('path');

const backupDir = path.join(__dirname, 'backup');
const manifestPath = path.join(backupDir, 'manifest.json');
let filesToRestore = ['renderer.js'];

if (fs.existsSync(manifestPath)) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (Array.isArray(manifest) && manifest.length > 0) {
      filesToRestore = manifest;
    }
  } catch (error) {
    console.warn('⚠️  No se pudo leer el manifiesto de restauración:', error.message);
  }
}

filesToRestore.forEach(file => {
  const backupPath = path.join(backupDir, file);
  const filePath = path.join(__dirname, file);
  
  if (fs.existsSync(backupPath)) {
    const originalCode = fs.readFileSync(backupPath, 'utf8');
    fs.writeFileSync(filePath, originalCode);
    console.log(`✅ Archivo restaurado: ${file}`);
  } else {
    console.log(`⚠️  Backup no encontrado: ${backupPath}`);
  }
});

console.log('\n✨ Restauración completada!');

