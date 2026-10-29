'use strict';
// Restored from backup/renderer.js: the original bars, hue cycle and resonance.
function createOriginalAudioScene() {
  let spectrogramCtx, time = 0;
  let spectrogramBursts = [], spectrogramBassSmooth = 0, spectrogramEnergySmooth = 0, lastSpectrogramImpactTime = 0;
  function render(ctx, width, height, data, now, reduced = false) {
    spectrogramCtx = ctx;
    ctx.save();
    spectrogramCtx.clearRect(0, 0, width, height);
    spectrogramCtx.fillStyle = 'rgba(10, 12, 18, 0.25)';
    spectrogramCtx.fillRect(0, 0, width, height);

    const bufferLength = data?.length || 0;
    const barCount = 200;
    const spacing = width / barCount;
    const barWidth = spacing * 0.7;

    const gradient = spectrogramCtx.createLinearGradient(0, height, 0, 0);
    const timeHue = (time * 0.3) % 360;
    gradient.addColorStop(0, `hsla(${timeHue}, 80%, 50%, 1)`);
    gradient.addColorStop(0.5, `hsla(${timeHue + 40}, 90%, 60%, 1)`);
    gradient.addColorStop(1, `hsla(${timeHue + 80}, 100%, 80%, 1)`);

    spectrogramCtx.fillStyle = gradient;
    spectrogramCtx.shadowBlur = 15;
    spectrogramCtx.shadowColor = `hsla(${timeHue}, 80%, 60%, 0.6)`;
    spectrogramCtx.beginPath();

    const usefulBands = Math.floor(bufferLength * 0.8);
    for (let i = 0; i < barCount / 2; i++) {
      const indexRatio = i / (barCount / 2);
      const dataIndex = Math.floor(Math.pow(indexRatio, 0.8) * usefulBands);
      let value = data ? data[dataIndex] : 0;
      value = Math.max(Number(value) || 0, 3);
      const barHeight = (Math.pow(value / 255, 1.2)) * (height * 0.6);
      const xLeft = width / 2 - (i * spacing) - spacing;
      const y = height / 2 - barHeight / 2;
      const xRight = width / 2 + (i * spacing);

      if (spectrogramCtx.roundRect) {
        spectrogramCtx.roundRect(xLeft, y, barWidth, barHeight, barWidth / 2);
        spectrogramCtx.roundRect(xRight, y, barWidth, barHeight, barWidth / 2);
      } else {
        spectrogramCtx.rect(xLeft, y, barWidth, barHeight);
        spectrogramCtx.rect(xRight, y, barWidth, barHeight);
      }
    }
    spectrogramCtx.fill();
    spectrogramCtx.shadowBlur = 0;

    if (!reduced) drawResonanceBloom(width, height, data, timeHue);


    ctx.restore();
    if (!reduced) time += 1;
  }
function clampVisualValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getBandAverage(data, start, end) {
  if (!data || data.length === 0) return 0;

  const first = Math.max(0, Math.min(data.length, start));
  const last = Math.max(first, Math.min(data.length, end));
  if (last <= first) return 0;

  let total = 0;
  for (let i = first; i < last; i++) {
    total += data[i];
  }

  return total / (last - first);
}

function drawResonanceBloom(width, height, data, hue) {
  if (!spectrogramCtx || !data) return;

  const bass = getBandAverage(data, 0, 18) / 255;
  const body = getBandAverage(data, 18, 72) / 255;
  const air = getBandAverage(data, 96, 220) / 255;
  const energy = clampVisualValue((bass * 0.62) + (body * 0.28) + (air * 0.1), 0, 1);
  const previousBass = spectrogramBassSmooth;
  const bassAttack = bass > spectrogramBassSmooth ? 0.24 : 0.07;
  const energyAttack = energy > spectrogramEnergySmooth ? 0.16 : 0.06;
  const now = performance.now();
  const impact = Math.max(0, bass - previousBass);

  spectrogramBassSmooth += (bass - spectrogramBassSmooth) * bassAttack;
  spectrogramEnergySmooth += (energy - spectrogramEnergySmooth) * energyAttack;

  if ((impact > 0.16 || bass > 0.84) && bass > 0.5 && now - lastSpectrogramImpactTime > 115 && spectrogramBursts.length < 10) {
    lastSpectrogramImpactTime = now;
    spectrogramBursts.push({
      age: 0,
      life: 34 + Math.floor(bass * 20),
      strength: clampVisualValue((impact * 2.2) + (bass * 0.42), 0.35, 1),
      hue: hue + (body * 70),
      spin: Math.random() * Math.PI * 2,
      twist: (Math.random() - 0.5) * 0.72
    });
  }

  spectrogramCtx.save();
  spectrogramCtx.globalCompositeOperation = 'screen';
  drawEpicCenterFlare(width, height, hue, energy, impact);
  drawCornerRadiance(width, height, hue, energy);
  drawSpectrogramBursts(width, height);
  drawImpactFlares(width, height, hue, energy, impact);
  spectrogramCtx.restore();
}

function drawEpicCenterFlare(width, height, hue, energy, impact) {
  if (!spectrogramCtx) return;

  const centerX = width / 2;
  const centerY = height / 2;
  const minDim = Math.min(width, height);
  let coreRadius = minDim * (0.05 + energy * 0.14 + impact * 0.14);
  let glowRadius = minDim * (0.22 + energy * 0.24 + impact * 0.1);

  // Defensive: ensure radii are finite and non-negative to avoid Canvas IndexSizeError
  if (!Number.isFinite(coreRadius)) coreRadius = 0;
  if (!Number.isFinite(glowRadius)) glowRadius = 0;
  coreRadius = Math.max(0, coreRadius);
  glowRadius = Math.max(0, glowRadius);

  const coreGlow = spectrogramCtx.createRadialGradient(centerX, centerY, 0, centerX, centerY, glowRadius);
  coreGlow.addColorStop(0, `hsla(${hue + 12}, 100%, 84%, ${0.22 + impact * 0.16})`);
  coreGlow.addColorStop(0.18, `hsla(${hue + 48}, 100%, 72%, ${0.16 + energy * 0.08})`);
  coreGlow.addColorStop(0.48, `hsla(${hue + 72}, 96%, 66%, ${0.1 + energy * 0.04})`);
  coreGlow.addColorStop(1, 'hsla(0,0%,100%,0)');

  if (glowRadius > 0.0001) {
    spectrogramCtx.fillStyle = coreGlow;
    spectrogramCtx.fillRect(centerX - glowRadius, centerY - glowRadius, glowRadius * 2, glowRadius * 2);
  }

  const ringHue = hue + 30;
  spectrogramCtx.strokeStyle = `hsla(${ringHue}, 100%, 82%, ${0.08 + impact * 0.1})`;
  spectrogramCtx.lineWidth = 2.2 + impact * 3.4;
  if (coreRadius * 1.12 > 0.0001) {
    spectrogramCtx.beginPath();
    spectrogramCtx.arc(centerX, centerY, coreRadius * 1.12, 0, Math.PI * 2);
    spectrogramCtx.stroke();
  }

  const pulseCount = 10;
  const baseAlpha = 0.08 + impact * 0.12;
  for (let i = 0; i < pulseCount; i++) {
    const angle = (Math.PI * 2 / pulseCount) * i + time * 0.02;
    const length = coreRadius * (1.1 + energy * 0.8 + impact * 0.9);
    const x = centerX + Math.cos(angle) * length;
    const y = centerY + Math.sin(angle) * length;

    spectrogramCtx.strokeStyle = `hsla(${hue + 22 + i * 12}, 100%, 88%, ${baseAlpha * (1 - i / pulseCount)})`;
    spectrogramCtx.lineWidth = 0.9 + energy * 1.1;
    spectrogramCtx.beginPath();
    spectrogramCtx.moveTo(centerX + Math.cos(angle) * coreRadius * 0.6, centerY + Math.sin(angle) * coreRadius * 0.6);
    spectrogramCtx.lineTo(x, y);
    spectrogramCtx.stroke();

    spectrogramCtx.fillStyle = `hsla(${hue + 28 + i * 10}, 100%, 82%, ${baseAlpha * 0.75})`;
    if ((2 + impact * 2) > 0.0001) {
      spectrogramCtx.beginPath();
      spectrogramCtx.arc(x, y, 2 + impact * 2, 0, Math.PI * 2);
      spectrogramCtx.fill();
    }
  }

  if (impact > 0.1) {
    const confettiCount = 14;
    for (let i = 0; i < confettiCount; i++) {
      const angle = (Math.PI * 2 / confettiCount) * i + (time * 0.03);
      const distance = coreRadius * (1.2 + Math.sin(time * 0.017 + i) * 0.18 + impact * 0.28);
      const px = centerX + Math.cos(angle) * distance;
      const py = centerY + Math.sin(angle) * distance;
      const hueOffset = hue + (i * 18);
      const size = 1.5 + Math.sin(i + time * 0.05) * 1.8 + impact * 1.8;
      if (size > 0.0001) {
        spectrogramCtx.fillStyle = `hsla(${hueOffset}, 100%, 78%, ${0.18 + impact * 0.1})`;
        spectrogramCtx.beginPath();
        spectrogramCtx.arc(px, py, size, 0, Math.PI * 2);
        spectrogramCtx.fill();
      }
    }
  }
}

function drawCornerRadiance(width, height, hue, energy) {
  if (!spectrogramCtx || energy < 0.12) return;

  const minDim = Math.min(width, height);
  // Hacer que el propio círculo de la esquina reaccione: mayor energía -> mayor tamaño y alpha
  const baseRadiance = minDim * 0.12;
  const radiance = baseRadiance * (1 + energy * 1.6);
  const bottomOffset = height * 0.08;
  const corners = [
    { x: 0, y: 0, offset: 0 },
    { x: width, y: 0, offset: 36 },
    { x: 0, y: height - bottomOffset, offset: 72 },
    { x: width, y: height - bottomOffset, offset: 108 }
  ];

  // Smoke/soft particle near corner - subtle animated noise using time
  corners.forEach(({ x, y, offset }, cornerIndex) => {
    const cornerHue = hue + offset;

    // Glow gradient for the corner circle
    const glow = spectrogramCtx.createRadialGradient(x, y, 0, x, y, radiance);
    const alphaMain = Math.min(0.6, 0.18 + energy * 0.22);
    glow.addColorStop(0, `hsla(${cornerHue}, 100%, 74%, ${alphaMain})`);
    glow.addColorStop(0.28, `hsla(${cornerHue + 34}, 92%, 70%, ${Math.min(0.42, 0.09 + energy * 0.12)})`);
    glow.addColorStop(1, 'hsla(0,0%,100%,0)');

    spectrogramCtx.fillStyle = glow;
    spectrogramCtx.fillRect(x - radiance, y - radiance, radiance * 2, radiance * 2);

    // Subtle animated smoke: low-opacity radial with slight offset
    const smokeStrength = Math.max(0, Math.min(0.32, energy * 0.6));
    if (smokeStrength > 0.01) {
      const smokeRadius = radiance * (1.25 + Math.sin(time * 0.012 + cornerIndex) * 0.08);
      const sx = x + Math.cos(time * 0.007 + cornerIndex * 1.3) * (radiance * 0.06);
      const sy = y + Math.sin(time * 0.009 + cornerIndex * 0.9) * (radiance * 0.04);
      const smoke = spectrogramCtx.createRadialGradient(sx, sy, 0, sx, sy, smokeRadius);
      smoke.addColorStop(0, `hsla(${cornerHue + 8}, 100%, 84%, ${smokeStrength * 0.65})`);
      smoke.addColorStop(0.45, `hsla(${cornerHue + 28}, 92%, 76%, ${smokeStrength * 0.28})`);
      smoke.addColorStop(1, 'hsla(0,0%,100%,0)');
      spectrogramCtx.globalCompositeOperation = 'lighter';
      spectrogramCtx.fillStyle = smoke;
      spectrogramCtx.fillRect(sx - smokeRadius, sy - smokeRadius, smokeRadius * 2, smokeRadius * 2);
      spectrogramCtx.globalCompositeOperation = 'source-over';
    }

    // Small confetti burst near corner when energy is high
    if (energy > 0.64) {
      const confettiCount = 6;
      for (let c = 0; c < confettiCount; c++) {
        const ang = Math.random() * Math.PI * 0.9 + (cornerIndex % 2 ? -0.2 : 0.2);
        const dist = radiance * (0.6 + Math.random() * 0.6);
        const cx = x + Math.cos(ang) * dist;
        const cy = y + Math.sin(ang) * dist;
        const confHue = cornerHue + (Math.random() * 60 - 30);
        const w = 2 + Math.random() * 4;
        const h = 1 + Math.random() * 3;
        spectrogramCtx.fillStyle = `hsla(${confHue}, 100%, 78%, ${0.18 + Math.random() * 0.26})`;
        spectrogramCtx.fillRect(cx - w / 2, cy - h / 2, w, h);
      }
    }
  });
}

function drawImpactFlares(width, height, hue, energy, impact) {
  if (!spectrogramCtx || impact <= 0.08) return;

  const flareStrength = Math.min(0.55, impact * 0.28 + energy * 0.16);
  const flareRadius = Math.max(width, height) * 0.14;
  const verticalOffset = height * 0.08;
  const positions = [
    { x: width * 0.16, y: height * 0.16 },
    { x: width * 0.84, y: height * 0.16 },
    { x: width * 0.16, y: height * 0.84 - verticalOffset },
    { x: width * 0.84, y: height * 0.84 - verticalOffset }
  ];

  // Draw larger flares but remove the small luminous dots near corners
  positions.forEach((pos, index) => {
    const flareHue = hue + index * 20;
    const flare = spectrogramCtx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, flareRadius);
    flare.addColorStop(0, `hsla(${flareHue}, 100%, 86%, ${flareStrength * 0.32})`);
    flare.addColorStop(0.18, `hsla(${flareHue + 22}, 98%, 77%, ${flareStrength * 0.18})`);
    flare.addColorStop(0.46, `hsla(${flareHue + 48}, 90%, 70%, ${flareStrength * 0.1})`);
    flare.addColorStop(1, 'hsla(0,0%,100%,0)');

    spectrogramCtx.fillStyle = flare;
    spectrogramCtx.fillRect(pos.x - flareRadius, pos.y - flareRadius, flareRadius * 2, flareRadius * 2);
  });

  const streakHue = hue + 56;
  const streak = spectrogramCtx.createLinearGradient(0, 0, width, height);
  streak.addColorStop(0, `hsla(${streakHue}, 100%, 82%, ${flareStrength * 0.09})`);
  streak.addColorStop(0.32, `hsla(${streakHue + 20}, 100%, 78%, ${flareStrength * 0.05})`);
  streak.addColorStop(1, 'hsla(0,0%,100%,0)');

  spectrogramCtx.strokeStyle = streak;
  spectrogramCtx.lineWidth = 0.9 + flareStrength * 2.2;
  spectrogramCtx.beginPath();
  spectrogramCtx.moveTo(width * 0.12, height * 0.48);
  spectrogramCtx.quadraticCurveTo(width * 0.5, height * 0.5 + impact * 0.08 * height, width * 0.88, height * 0.48);
  spectrogramCtx.stroke();
}

function drawResonanceRibbons(width, height, data, hue, energy) {
  // Ribbons are intentionally disabled to avoid floating line artifacts.
}

function drawSpectrogramBursts(width, height) {
  const centerX = width / 2;
  const centerY = height / 2;
  const minDim = Math.min(width, height);

  for (let i = spectrogramBursts.length - 1; i >= 0; i--) {
    const burst = spectrogramBursts[i];
    burst.age += 1;

    const progress = burst.age / burst.life;
    if (progress >= 1) {
      spectrogramBursts.splice(i, 1);
      continue;
    }

    const fade = Math.pow(1 - progress, 1.85) * burst.strength;
    const radius = minDim * (0.07 + progress * (0.48 + burst.strength * 0.2));
    const ringHue = burst.hue + progress * 34;
    const bandHeight = height * (0.045 + burst.strength * 0.065) * (1 - progress * 0.55);
    const flash = spectrogramCtx.createLinearGradient(0, centerY, width, centerY);

    flash.addColorStop(0, `hsla(${ringHue}, 100%, 65%, 0)`);
    flash.addColorStop(0.43, `hsla(${ringHue + 35}, 100%, 70%, ${fade * 0.08})`);
    flash.addColorStop(0.5, `hsla(${ringHue + 95}, 100%, 78%, ${fade * 0.13})`);
    flash.addColorStop(0.57, `hsla(${ringHue + 35}, 100%, 70%, ${fade * 0.08})`);
    flash.addColorStop(1, `hsla(${ringHue}, 100%, 65%, 0)`);

    spectrogramCtx.fillStyle = flash;
    spectrogramCtx.fillRect(0, centerY - bandHeight, width, bandHeight * 2);

    spectrogramCtx.beginPath();
    spectrogramCtx.ellipse(centerX, centerY, radius * 1.65, radius * 0.42, burst.spin + progress * burst.twist, 0, Math.PI * 2);
    spectrogramCtx.shadowBlur = 24 * fade;
    spectrogramCtx.shadowColor = `hsla(${ringHue + 32}, 100%, 70%, ${fade * 0.65})`;
    spectrogramCtx.strokeStyle = `hsla(${ringHue + 18}, 100%, 72%, ${fade * 0.62})`;
    spectrogramCtx.lineWidth = Math.max(1, (1 - progress) * 5.5 * burst.strength);
    spectrogramCtx.stroke();

    spectrogramCtx.beginPath();
    spectrogramCtx.ellipse(centerX, centerY, radius * 1.08, radius * 0.72, -burst.spin * 0.4 - progress * burst.twist, 0, Math.PI * 2);
    spectrogramCtx.strokeStyle = `hsla(${ringHue + 118}, 100%, 74%, ${fade * 0.28})`;
    spectrogramCtx.lineWidth = Math.max(0.7, (1 - progress) * 2.5 * burst.strength);
    spectrogramCtx.stroke();

    spectrogramCtx.beginPath();
    for (let spoke = 0; spoke < 14; spoke++) {
      const angle = (spoke / 14) * Math.PI * 2 + burst.spin + progress * 0.9;
      const yScale = 0.46 + Math.sin(spoke + burst.spin) * 0.08;
      const inner = radius * 0.24;
      const outer = radius * (0.76 + Math.sin((progress * 8) + spoke) * 0.07);

      spectrogramCtx.moveTo(centerX + Math.cos(angle) * inner, centerY + Math.sin(angle) * inner * yScale);
      spectrogramCtx.lineTo(centerX + Math.cos(angle) * outer, centerY + Math.sin(angle) * outer * yScale);
    }

    spectrogramCtx.shadowBlur = 10 * fade;
    spectrogramCtx.strokeStyle = `hsla(${ringHue + 62}, 100%, 76%, ${fade * 0.18})`;
    spectrogramCtx.lineWidth = 1;
    spectrogramCtx.stroke();
  }
}


  return { render, reset() {
    time = 0; spectrogramBursts = []; spectrogramBassSmooth = 0;
    spectrogramEnergySmooth = 0; lastSpectrogramImpactTime = 0;
  } };
}
module.exports = { createOriginalAudioScene };
