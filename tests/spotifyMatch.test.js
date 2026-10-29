const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreSpotifyCandidate, chooseSpotifyCandidate } = require('../services/spotifyMatch');

test('Coincidencias Spotify exigen artista completo, título y versión compatibles', () => {
  const source = { title: 'One', artist: 'Metallica', duration: 446 };
  const candidates = [
    { id: 'wrong-artist', title: 'U2 - One', artist: 'U2', duration: 446 },
    { id: 'substring', title: 'Metallica - Someone', artist: 'Metallica', duration: 446 },
    { id: 'cover', title: 'Metallica - One cover', artist: 'Metallica', duration: 446 },
    { id: 'live', title: 'Metallica - One live', artist: 'Metallica', duration: 446 },
    { id: 'mix', title: 'Metallica - One', artist: 'Metallica', duration: 1600 },
    { id: 'correct', title: 'Metallica - One (Official Audio)', artist: 'Metallica - Topic', duration: 446 }
  ];
  assert.equal(chooseSpotifyCandidate(source, candidates).id, 'correct');
  for (const candidate of candidates.slice(0, -1)) assert.equal(scoreSpotifyCandidate(source, candidate).accepted, false, candidate.id);
});
test('Una palabra genérica del artista o la mitad del título no bastan', () => {
  const track = { title: 'My Beautiful Song', artist: 'Lil Artist', duration: 200 };
  assert.equal(scoreSpotifyCandidate(track, { id: 'a', title: 'Lil Other - My Beautiful Song', artist: 'Lil Other', duration: 200 }).accepted, false);
  assert.equal(scoreSpotifyCandidate(track, { id: 'b', title: 'Lil Artist - My Song', artist: 'Lil Artist', duration: 200 }).accepted, false);
  assert.equal(scoreSpotifyCandidate(track, { id: 'c', title: 'Lil Artist - My Beautiful Song instrumental', artist: 'Lil Artist', duration: 200 }).accepted, false);
});
test('Acepta acentos y escritura Unicode, y no adivina si falta el artista', () => {
  assert.equal(scoreSpotifyCandidate({ title: 'Canción', artist: 'Artísta', duration: 180 },
    { id: 'a', title: 'Artista - Cancion (Video Oficial)', artist: 'ArtistaVEVO', duration: 182 }).accepted, true);
  assert.equal(scoreSpotifyCandidate({ title: '夜', artist: '宇多田ヒカル' },
    { id: 'b', title: '宇多田ヒカル 夜', artist: '宇多田ヒカル' }).accepted, true);
  assert.equal(scoreSpotifyCandidate({ title: 'Song', artist: 'Desconocido' },
    { id: 'c', title: 'Song', artist: 'Someone' }).accepted, false);
});
