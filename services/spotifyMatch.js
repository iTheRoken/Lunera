'use strict';
const normalize = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const phrase = (text, value) => value && (` ${text} `).includes(` ${value} `);
const artistsOf = track => String(track.artist || '').split(/[,;]|\s+(?:feat\.?|ft\.?)\s+/i).map(normalize)
  .filter(artist => artist && !['desconocido', 'unknown', 'various artists', 'varios artistas'].includes(artist));
function canonicalTitle(value, artists) {
  let text = ` ${normalize(value)} `;
  for (const artist of [...artists].sort((a, b) => b.length - a.length)) text = text.split(` ${artist} `).join(' ');
  return text.replace(/\b(?:official|oficial|music video|official visualizer|audio|video|visualizer|lyrics|lyric|letra|hd|hq|4k|1080p|feat|ft|featuring)\b/g, ' ')
    .trim().replace(/\s+/g, ' ');
}
const VERSIONS = [
  ['cover', /\bcover\b/], ['karaoke', /\bkaraoke\b/], ['remix', /\bremix\b/],
  ['live', /\b(?:live|en vivo|directo)\b/], ['instrumental', /\binstrumental\b/],
  ['slowed', /\b(?:slowed|reverb)\b/], ['sped', /\b(?:sped up|speed up|nightcore)\b/],
  ['acoustic', /\b(?:acoustic|acustic[oa])\b/], ['remaster', /\bremaster(?:ed|izado)?\b/],
  ['extended', /\bextended\b/], ['radio', /\bradio edit\b/], ['8d', /\b8d\b/]
];
function scoreSpotifyCandidate(track, result) {
  if (!result?.id || !result.title) return { accepted: false, score: 0, reason: 'Sin metadatos' };
  const artists = artistsOf(track);
  if (!artists.length) return { accepted: false, score: 0, reason: 'Artista de origen desconocido' };
  const sourceText = normalize(track.title);
  const candidateText = normalize(result.title);
  const combined = normalize(`${result.title} ${result.artist || ''} ${result.channel || ''}`);
  // Require the complete primary artist name, not a common token such as "Lil".
  if (!phrase(combined, artists[0])) return { accepted: false, score: 0, reason: 'El artista no coincide' };
  const sourceTitle = canonicalTitle(track.title, artists);
  const candidateTitle = canonicalTitle(result.title, artists);
  if (!sourceTitle || !candidateTitle) return { accepted: false, score: 0, reason: 'Título no verificable' };
  for (const [version, regex] of VERSIONS) {
    if (regex.test(sourceText) !== regex.test(candidateText)) return { accepted: false, score: 0, reason: `Versión diferente (${version})` };
  }
  const sourceWords = new Set(sourceTitle.split(' '));
  const candidateWords = new Set(candidateTitle.split(' '));
  const common = [...sourceWords].filter(word => candidateWords.has(word)).length;
  const coverage = common / sourceWords.size;
  const precision = common / candidateWords.size;
  if (coverage < .95 || precision < .85 || (sourceWords.size <= 2 && sourceTitle !== candidateTitle)) {
    return { accepted: false, score: 0, reason: 'El título no coincide con suficiente precisión' };
  }
  const duration = Number(track.duration), candidateDuration = Number(result.duration);
  let difference = null;
  if (duration > 0 && candidateDuration > 0) {
    difference = Math.abs(duration - candidateDuration);
    if (difference > Math.max(6, Math.min(15, duration * .08))) return { accepted: false, score: 0, reason: 'Duración incompatible' };
  }
  return { accepted: true, score: coverage * .45 + precision * .3 + (difference === null ? .08 : .2 * (1 - Math.min(1, difference / 20)))
    + (/\b(?:topic|vevo|official|oficial)\b/.test(normalize(result.artist)) ? .05 : 0)
    + (normalize(result.artist) === artists[0] ? .03 : 0)
    + (/\b(?:official|oficial)\b/.test(candidateText) ? .02 : 0), reason: null };
}
function chooseSpotifyCandidate(track, results) {
  const ranked = (Array.isArray(results) ? results : []).map(result => ({ result, ...scoreSpotifyCandidate(track, result) }))
    .filter(candidate => candidate.accepted).sort((a, b) => b.score - a.score);
  return ranked[0]?.result || null;
}
module.exports = { scoreSpotifyCandidate, chooseSpotifyCandidate, normalize, artistsOf };
