const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.join(__dirname, '..');
function run(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} falló (${result.status})`);
}
try {
  run('obfuscate.js');
  run(require.resolve('electron-builder/cli.js'), ['--win', '--x64', ...process.argv.slice(2)]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  run('restore.js');
}
