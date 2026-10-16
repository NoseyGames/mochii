import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMusicFavorites, normalizeMusicPlaylists, normalizeMusicPlayerSettings } from '../browser-tools/music-library.js';

const track = (id, title = 'Song', source = 'tidal') => ({ id: String(id), title, artist: 'Artist', source, duration: 120 });

test('stored favorites preserve alternate recordings and discard arbitrary URLs and nested fields', () => {
  const saved = normalizeMusicFavorites([{ ...track(1), variants: [track(1), track(2, 'song', 'qobuz'), { ...track(3), source: 'bad' }], streamUrl: 'https://bad.test', extra: {} }]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].variants.length, 2);
  assert.equal(saved[0].variants[1].source, 'qobuz');
  assert.equal('streamUrl' in saved[0], false);
  assert.equal('extra' in saved[0], false);
  assert.deepEqual(normalizeMusicFavorites(JSON.parse(JSON.stringify(saved))), saved);
});

test('playlist imports validate identity, deduplicate rows and enforce size limits', () => {
  const many = Array.from({ length: 500 }, (_, index) => track(index, 'Song ' + index));
  const result = normalizeMusicPlaylists({ version: 1, playlists: [
    { id: 'valid', name: '  My\u0000 music  ', tracks: [track(1), track(2, 'song', 'qobuz')] },
    { id: 'valid', name: 'Duplicate', tracks: many }, { id: '<script>', name: 'Invalid', tracks: [] },
    { id: 'large', name: 'x'.repeat(100), tracks: many }, ...Array.from({ length: 100 }, (_, i) => ({ id: 'p' + i, name: 'List', tracks: [] })),
  ] });
  assert.equal(result.playlists[0].name, 'My music');
  assert.equal(result.playlists[0].tracks.length, 1);
  assert.equal(result.playlists[0].tracks[0].variants.length, 2);
  assert.equal(result.playlists[1].name.length, 64);
  assert.equal(result.playlists[1].tracks.length, 200);
  assert(result.playlists.length <= 30);
  assert.deepEqual(normalizeMusicPlaylists({ version: 2, playlists: [] }), { version: 1, playlists: [] });
});

test('playback persistence is opt-in and restores only validated track metadata and position', () => {
  const session = { track: track(1), queue: [track(2, 'Second'), track(1)], index: 99, position: 42, playing: true };
  assert.equal(normalizeMusicPlayerSettings({ session }).session, undefined);
  const saved = normalizeMusicPlayerSettings({ remember: true, session, volume: Infinity, shuffle: 'true', repeat: 'all' });
  assert.equal(saved.volume, .7);
  assert.equal(saved.shuffle, false);
  assert.equal(saved.session.index, 1);
  assert.equal(saved.session.position, 42);
  assert.equal('playing' in saved.session, false);
  assert.equal(normalizeMusicPlayerSettings({ remember: true, session: { ...session, position: -50 } }).session.position, 0);
  assert.equal(normalizeMusicPlayerSettings({ remember: true, session: { ...session, track: { url: 'https://bad.test' } } }).session, undefined);
});
