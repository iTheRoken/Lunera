'use strict';
const { createOriginalAudioScene } = require('./originalAudioScene');
const STYLES = ['original', 'prism', 'orbit', 'aurora'];
function createAudioScene() {
  const original = createOriginalAudioScene();
  const bands = new Float32Array(96);
  let last = 0, bass = 0, floor = .12, energy = 0, lastBeat = 0;
  let rings = [];
  const average = (data, from, to) => {
    let total = 0; const end = Math.min(data?.length || 0, to);
    for (let i = from; i < end; i++) total += data[i] / 255;
    return total / Math.max(1, end - from);
  };
  function render(ctx, width, height, data, now, style = 'prism', reduced = false) {
    if (style === 'original') return original.render(ctx, width, height, data, now, reduced);
    const dt = Math.min(.06, Math.max(.001, (now - last) / 1000 || .016)); last = now;
    const amount = reduced ? .35 : 1;
    const rawBass = average(data, 1, 20);
    const rawEnergy = average(data, 5, 200);
    const attack = 1 - Math.exp(-dt * 13), decay = 1 - Math.exp(-dt * 4);
    bass += (rawBass - bass) * (rawBass > bass ? attack : decay);
    energy += (rawEnergy - energy) * attack;
    floor += (rawBass - floor) * (1 - Math.exp(-dt * 1.5));
    const beat = Math.max(0, rawBass - floor * 1.12);
    if (!reduced && beat > .11 && rawBass > .32 && now - lastBeat > 280) {
      lastBeat = now; rings.push({ age: 0, strength: Math.min(1, beat * 3) });
      if (rings.length > 5) rings.shift();
    }
    rings = rings.filter(ring => (ring.age += dt) < 1.4);
    const length = Math.max(1, Math.min(data?.length || 0, 700));
    for (let i = 0; i < bands.length; i++) {
      const index = Math.min(length - 1, Math.floor(Math.pow(i / bands.length, 1.65) * length));
      const value = (data?.[index] || 0) / 255;
      bands[i] += (value - bands[i]) * (value > bands[i] ? attack : decay);
    }
    const seconds = reduced ? 0 : now / 1000;
    const hue = 153 + Math.sin(seconds * .035) * 25;
    const color = (alpha, offset = 0) => `hsla(${hue + offset},72%,72%,${alpha})`;
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    const centerX = width / 2, centerY = height * .47;
    const radius = Math.min(width, height) * .16;
    // Four curved filaments replace corner blobs. Bass changes their reach,
    // curvature and glow; they remain narrow, leaving the center readable.
    ctx.lineCap = 'round';
    for (let corner = 0; corner < 4; corner++) {
      ctx.save(); ctx.translate(corner % 2 ? width : 0, corner > 1 ? height : 0);
      ctx.scale(corner % 2 ? -1 : 1, corner > 1 ? -1 : 1);
      for (let strand = 0; strand < 5; strand++) {
        const reach = Math.min(width * .25, height * .38) * (.65 + bass * .5 * amount);
        const sway = Math.sin(seconds * .7 + strand * .65) * 18 * energy * amount;
        ctx.beginPath(); ctx.moveTo(8 + strand * 10, 0);
        ctx.bezierCurveTo(reach * .12, reach * .4 + sway, reach * .65, reach * .2 + strand * 9, reach, 7 + strand * 8);
        ctx.strokeStyle = color((.05 + energy * .3) * (1 - strand * .12), corner * 18 + strand * 4);
        ctx.lineWidth = 1 + bass * 2 * amount;
        ctx.shadowColor = color(.5, corner * 18); ctx.shadowBlur = reduced ? 0 : 8 + beat * 30;
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.shadowBlur = reduced ? 0 : 12 + bass * 8;
    ctx.shadowColor = color(.5);
    if (style === 'orbit') {
      for (let layer = 3; layer >= 0; layer--) {
        ctx.beginPath();
        for (let i = 0; i <= 192; i++) {
          const angle = i / 192 * Math.PI * 2;
          const sample = bands[Math.min(95, Math.floor((1 - Math.abs(i / 96 - 1)) * 95))];
          const deformation = Math.sin(angle * 3 + seconds * .65) * .035 + Math.cos(angle * 5 - seconds * .4) * .02;
          const r = radius * (1 + layer * .08 + bass * .13 * amount + deformation * bass * amount + sample * (.3 + layer * .03) * amount);
          const x = centerX + Math.cos(angle) * r, y = centerY + Math.sin(angle) * r;
          if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath(); ctx.strokeStyle = color(layer ? .12 + energy * .15 : .8, layer * 18);
        ctx.lineWidth = layer ? 1.5 : 2.5; ctx.stroke();
      }
      const core = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
      core.addColorStop(0, color(.025 + bass * .04)); core.addColorStop(1, color(.005));
      ctx.fillStyle = core; ctx.beginPath(); ctx.arc(centerX, centerY, radius * .95, 0, Math.PI * 2); ctx.fill();
      rings.forEach(ring => {
        ctx.beginPath(); ctx.arc(centerX, centerY, radius * (1.05 + ring.age * .6), 0, Math.PI * 2);
        ctx.strokeStyle = color((1 - ring.age / 1.4) * ring.strength * .25, 30); ctx.lineWidth = 1; ctx.stroke();
      });
    } else if (style === 'aurora') {
      for (let layer = 0; layer < 5; layer++) {
        ctx.beginPath();
        for (let i = 0; i <= 140; i++) {
          const ratio = i / 140;
          const value = bands[Math.min(95, Math.floor(ratio * 95))];
          const envelope = Math.sin(ratio * Math.PI);
          const wave = Math.sin(ratio * Math.PI * (3 + layer * .4) + seconds * (.6 + layer * .13));
          const y = centerY + wave * envelope * (height * .04 + value * height * .2 * amount) + (layer - 2) * 8;
          if (!i) ctx.moveTo(0, y); else ctx.lineTo(width * ratio, y);
        }
        ctx.lineWidth = 1.3 + layer * .4;
        ctx.strokeStyle = color(.22 + layer * .09, layer * 22); ctx.stroke();
      }
    } else {
      const spacing = Math.min(10, width * .006), count = 70;
      ctx.strokeStyle = color(.85); ctx.lineWidth = Math.max(2, spacing * .42);
      for (let i = 0; i < count; i++) {
        const sample = bands[Math.floor(i / count * 95)];
        const bar = Math.max(1, Math.pow(sample, 1.5) * height * .33 * amount);
        const left = centerX - (i + .5) * spacing, right = centerX + (i + .5) * spacing;
        ctx.beginPath(); ctx.moveTo(left, centerY - bar); ctx.lineTo(left, centerY + bar);
        ctx.moveTo(right, centerY - bar); ctx.lineTo(right, centerY + bar); ctx.stroke();
      }
    }
    ctx.restore();
  }
  return { render, reset() { original.reset(); bands.fill(0); rings = []; bass = 0; energy = 0; floor = .12; last = 0; lastBeat = 0; } };
}
module.exports = { createAudioScene, STYLES };
