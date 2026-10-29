const test = require('node:test');
const assert = require('node:assert/strict');
const { createAudioScene, STYLES } = require('../services/audioScene');
function context() {
  const commands = [];
  const ctx = { commands };
  for (const name of ['clearRect','save','restore','translate','scale','beginPath','moveTo','lineTo','bezierCurveTo','stroke','closePath','arc','fill','fillRect','rect','roundRect','ellipse','quadraticCurveTo']) {
    ctx[name] = (...args) => { args.forEach(arg => { if (typeof arg === 'number') assert.ok(Number.isFinite(arg), `${name} recibió un número inválido`); }); commands.push([name, ...args]); };
  }
  ctx.createRadialGradient = () => ({ addColorStop() {} });
  ctx.createLinearGradient = () => ({ addColorStop() {} });
  return ctx;
}
test('Las cuatro escenas dibujan silencio y audio sin coordenadas inválidas', () => {
  for (const style of STYLES) {
    const painter = createAudioScene(); const ctx = context();
    painter.render(ctx, 1000, 700, new Uint8Array(1024), 1000, style);
    painter.render(ctx, 1000, 700, new Uint8Array(1024).fill(220), 1032, style);
    painter.render(ctx, 800, 600, undefined, 1064, style, true);
    assert.ok(ctx.commands.length > 100);
  }
});
test('Órbita aumenta su geometría con el audio y reset elimina la energía anterior', () => {
  const painter = createAudioScene(); const ctx = context();
  for (let index = 0; index < 80; index++) painter.render(ctx, 1000, 700, new Uint8Array(1024).fill(230), 1000 + index * 16, 'orbit');
  const loud = ctx.commands.filter(command => command[0] === 'arc').at(-1)[3];
  painter.reset(); ctx.commands.length = 0;
  painter.render(ctx, 1000, 700, new Uint8Array(1024), 1000, 'orbit');
  const silent = ctx.commands.filter(command => command[0] === 'arc').at(-1)[3];
  assert.ok(loud > silent);
});
