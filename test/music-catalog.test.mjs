import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeMusicEntries, normalizeMusicSnapshot, mergeMusicTracks, preferMusicSource, musicStreamPath, fetchMusicJson, createMusicCatalog, createMusicPlayer, MUSIC_SOURCES } from '../browser-tools/music-catalog.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const track = (id, title = 'A Song', source = 'tidal') => ({ id, title, source, artist: 'Artist', duration: 120 });
const normalized = (...tracks) => mergeMusicTracks([normalizeMusicEntries(tracks)]);

test('music discovery snapshot has sanitized playable metadata and no arbitrary media URLs', async () => {
  const data = JSON.parse(await readFile(new URL('../browser-tools/music-catalog.json', import.meta.url), 'utf8'));
  const tracks = normalizeMusicSnapshot(data);
  assert(tracks.length > 200);
  assert.equal(new Set(tracks.map(item => item.key)).size, tracks.length);
  assert(tracks.every(item => item.variants.every(variant => MUSIC_SOURCES.some(source => source.id === variant.source))));
  assert.equal(tracks.some(item => 'url' in item || 'streamUrl' in item), false);
});

test('music ingestion validates fields and preserves titles as plain text', () => {
  const result = normalizeMusicEntries([
    { ...track(1, '<img onerror=alert(1)>'), artwork: 'https://resources.tidal.com/images/cover.jpg' },
    { ...track('ab', 'Safe'), artwork: 'https://resources.tidal.com.evil.test/track.jpg', duration: Infinity },
    { ...track(2), source: 'bad' }, { ...track(3), title: '' }, null, [], { ...track(4), artwork: 'https://a:b@static.qobuz.com/x.jpg' }
  ]);
  assert.equal(result.length, 3);
  assert.equal(result[0].title, '<img onerror=alert(1)>');
  assert.equal(result[1].artwork, ''); assert.equal(result[1].duration, 0);
  assert.equal(result[2].artwork, '');
});

test('name dedupe combines source versions in one pass and preserves alternate artists', () => {
  const result = normalized(track(1, 'Café — Song'), { ...track(2, 'cafe-song', 'qobuz'), artist: 'Other artist' }, track(2, 'cafe-song', 'qobuz'), track(3, 'Song 2'));
  assert.equal(result.length, 2);
  assert.equal(result[0].variants.length, 2);
  assert.equal(result[0].variants[1].artist, 'Other artist');
  const many = Array.from({ length: 10000 }, (_, i) => track(i, 'Track ' + (i % 500)));
  assert.equal(mergeMusicTracks([many]).length, 500);
});

test('stream URLs are fixed API paths with encoded metadata and no arbitrary targets', () => {
  const path = musicStreamPath(track('1234', 'a?b&c'));
  assert.equal(new URL(path, 'https://monkeh.test').pathname, '/api/music/stream');
  assert.equal(new URL(path, 'https://monkeh.test').searchParams.get('title'), 'a?b&c');
  assert.equal(new URL(path, 'https://monkeh.test').searchParams.get('url'), null);
  assert.throws(() => musicStreamPath(track(1, 'Title', 'unknown')));
  assert.throws(() => musicStreamPath(track('https://evil.test/audio')));
});

test('a source-filtered row plays that source first and retains fallbacks', () => {
  const [song] = normalized(track(1), { ...track(2, 'A Song', 'qobuz'), artist: 'Second artist' });
  const preferred = preferMusicSource(song, 'qobuz');
  assert.equal(preferred.variants[0].source, 'qobuz'); assert.equal(preferred.artist, 'Second artist');
  assert.equal(preferred.variants[1].source, 'tidal'); assert.equal(preferred.key, song.key);
  assert.equal(song.variants[0].source, 'tidal');
});

test('all five music sources start together; successes render before slow failures', async () => {
  const pending = new Map(); const snapshots = [];
  const catalog = createMusicCatalog({ fetchJson(path) { return new Promise((resolve, reject) => pending.set(new URL(path, 'https://m.test').searchParams.get('source'), { resolve, reject })); }, onChange(state) { snapshots.push(state); } });
  const loading = catalog.search('song'); await tick();
  assert.equal(pending.size, 5);
  pending.get('qobuz').resolve({ items: [track(1, 'A Song', 'qobuz')] }); await tick();
  assert.equal(catalog.snapshot().tracks.length, 1); assert.equal(catalog.snapshot().pending, 4);
  pending.get('tidal').resolve({ items: [track(2)] }); pending.get('ytm').resolve({ items: [] });
  pending.get('scdlp').reject(new Error('offline')); pending.get('soundcloud').resolve({ items: [track(1, 'A Song', 'qobuz')] });
  await loading;
  assert.equal(catalog.snapshot().tracks.length, 1); assert.equal(catalog.snapshot().tracks[0].variants.length, 2);
  assert.equal(catalog.snapshot().failures.length, 1); assert.equal(catalog.snapshot().pending, 0);
});

test('stale searches cannot overwrite newer results and cache avoids repeat requests', async () => {
  let calls = 0; const deferred = [];
  const catalog = createMusicCatalog({ fetchJson(path) { calls++; const query = new URL(path, 'https://m.test').searchParams.get('q'); if (query === 'old') return new Promise(resolve => deferred.push(resolve)); return Promise.resolve({ items: [track(1, query)] }); } });
  const old = catalog.search('old'); await tick();
  await catalog.search('new');
  deferred.forEach(resolve => resolve({ items: [track(2, 'old')] })); await old;
  assert.equal(catalog.snapshot().tracks[0].title, 'new'); assert.equal(calls, 10);
  await catalog.search('new'); assert.equal(calls, 10);
});

test('a late bundled snapshot cannot replace an active or completed user search', async () => {
  const pending = [];
  const catalog = createMusicCatalog({ fetchJson: () => new Promise(resolve => pending.push(resolve)) });
  const seed = normalized(track(9, 'Featured'));
  catalog.seed(seed); assert.equal(catalog.snapshot().tracks[0].title, 'Featured');
  const search = catalog.search('requested'); await tick();
  catalog.seed(seed); assert.equal(catalog.snapshot().tracks.length, 0);
  pending.forEach(resolve => resolve({ items: [track(1, 'Requested')] })); await search;
  catalog.seed(seed); assert.equal(catalog.snapshot().tracks[0].title, 'Requested');
});

test('search deadlines settle even when a source ignores abort', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const catalog = createMusicCatalog({ fetchJson: () => new Promise(() => {}), timeout: 5 });
    await catalog.search('song');
    assert.equal(catalog.snapshot().pending, 0); assert.equal(catalog.snapshot().failures.length, 5);
  } finally { clearTimeout(keepAlive); }
});

test('music JSON rejects HTML, oversized streaming bodies and upstream errors', async () => {
  await assert.rejects(fetchMusicJson(async () => new Response('<!DOCTYPE html>', { headers: { 'content-type': 'text/html' } }), '/api/music/search'), /non-JSON/);
  await assert.rejects(fetchMusicJson(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }), '/api/music/search'), /size limit/);
  await assert.rejects(fetchMusicJson(async () => Response.json({ error: 'Provider busy' }, { status: 503 }), '/api/music/search'), /Provider busy/);
});

class AudioFixture extends EventTarget {
  src = ''; currentTime = 0; duration = 120; plays = 0; pauses = 0;
  async play() { this.plays++; } pause() { this.pauses++; } load() {}
  removeAttribute(name) { this[name] = ''; } getAttribute(name) { return this[name]; }
}

test('audio stays idle until selected; playback fallback never loads other songs', async () => {
  const audio = new AudioFixture(); const requests = [];
  const player = createMusicPlayer({ audio, resolveUrl: async variant => { requests.push(variant.source); return 'https://monkeh.test' + musicStreamPath(variant); } });
  const tracks = normalized(track(1), track(2, 'a song', 'qobuz'), track(3, 'Other'));
  assert.equal(audio.preload, 'none'); assert.equal(audio.plays, 0); assert.deepEqual(requests, []);
  await player.play(tracks[0], tracks); assert.equal(audio.plays, 1); assert.deepEqual(requests, ['tidal']);
  audio.dispatchEvent(new Event('error')); await tick();
  assert.deepEqual(requests, ['tidal', 'qobuz']); assert.equal(player.snapshot().current.title, 'A Song');
  audio.dispatchEvent(new Event('error')); await tick();
  assert.match(player.snapshot().error, /could not play/); assert.equal(requests.length, 2);
});

test('queue advances, repeats one, and stops at its end without autoplaying a fresh queue', async () => {
  const audio = new AudioFixture(); const player = createMusicPlayer({ audio, resolveUrl: async () => 'https://monkeh.test/audio' });
  const tracks = normalized(track(1, 'First'), track(2, 'Second'));
  await player.play(tracks[0], tracks);
  audio.dispatchEvent(new Event('ended')); await tick(); assert.equal(player.snapshot().current.title, 'Second');
  const plays = audio.plays;
  audio.dispatchEvent(new Event('ended')); await tick(); assert.equal(audio.plays, plays); assert.equal(player.snapshot().playing, false);
  player.setRepeat('one'); audio.dispatchEvent(new Event('ended')); await tick(); assert.equal(audio.plays, plays + 1); assert.equal(player.snapshot().current.title, 'Second');
  player.stop(); assert.equal(audio.src, ''); assert.equal(player.snapshot().current, null);
});

test('an old asynchronous track resolution cannot replace a newer selection', async () => {
  const audio = new AudioFixture(); let release;
  const player = createMusicPlayer({ audio, resolveUrl: variant => variant.id === '1' ? new Promise(resolve => { release = resolve; }) : Promise.resolve('https://monkeh.test/second') });
  const tracks = normalized(track(1, 'First'), track(2, 'Second'));
  const old = player.play(tracks[0], tracks); await player.play(tracks[1], tracks);
  release('https://monkeh.test/first'); await old;
  assert.equal(audio.src, 'https://monkeh.test/second'); assert.equal(player.snapshot().current.title, 'Second');
});

test('page suspension cancels pending audio and resumes only after a new play gesture', async () => {
  const audio = new AudioFixture(); let release; let first = true;
  const player = createMusicPlayer({ audio, resolveUrl: () => { if (first) { first = false; return new Promise(resolve => { release = resolve; }); } return Promise.resolve('https://monkeh.test/resumed'); } });
  const [song] = normalized(track(1));
  const loading = player.play(song); player.suspend(); release('https://monkeh.test/stale'); await loading;
  assert.equal(audio.src, ''); assert.equal(audio.plays, 0); assert.equal(player.snapshot().current.key, song.key);
  audio.dispatchEvent(new Event('playing')); assert.equal(player.snapshot().playing, false);
  await player.toggle(); assert.equal(audio.plays, 1); assert.equal(audio.src, 'https://monkeh.test/resumed');
});
