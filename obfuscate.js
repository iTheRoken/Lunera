const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const filesToObfuscate = [
  'renderer.js'
  // Solo renderer por el momento
];

const backupDir = path.join(__dirname, 'backup');
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir);
}

const backedUpFiles = [];

filesToObfuscate.forEach(file => {
  const filePath = path.join(__dirname, file);

  if (!fs.existsSync(filePath)) {
    console.log(`⚠️ Archivo no encontrado: ${file}`);
    return;
  }

  const code = fs.readFileSync(filePath, 'utf8');

  const backupPath = path.join(backupDir, file);
  fs.writeFileSync(backupPath, code);
  backedUpFiles.push(file);

  const obfuscationResult = JavaScriptObfuscator.obfuscate(code, {
    compact: true,

    // Más seguro
    controlFlowFlattening: false,
    deadCodeInjection: false,

    debugProtection: false,
    disableConsoleOutput: false,

    identifierNamesGenerator: 'hexadecimal',

    renameGlobals: false,

    // nunca usar esto en electron
    selfDefending: false,

    simplify: true,

    stringArray: true,
    stringArrayEncoding: ['base64'],

    transformObjectKeys: false
  });

  fs.writeFileSync(filePath, obfuscationResult.getObfuscatedCode());
  console.log(`✅ Ofuscado: ${file}`);
});

fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(backedUpFiles, null, 2));

console.log('\n✨ Ofuscación segura completada');
