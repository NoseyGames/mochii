import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MUSIC_SOURCES, normalizeMusicEntries, mergeMusicTracks } from '../browser-tools/music-catalog.js';

const index = process.argv.indexOf('--from-dir');
const directory = index >= 0 ? process.argv[index + 1] : null;
const origin = 'https://h35d5a9.jfs-autoelevadores.com.ar';
const requests = [{ path: '/api/music/browse', file: 'music-api-1.json', id: 'browse' }, ...MUSIC_SOURCES.map((source, i) => ({ path: '/api/music/search?' + new URLSearchParams({ q: 'lofi', source: source.id, limit: '40' }), file: 'music-api-' + (i + 2) + '.json', id: source.id }))];
const results = await Promise.allSettled(requests.map(async request => {
  let json;
  if (directory) json = JSON.parse(await readFile(resolve(directory, request.file), 'utf8'));
  else {
    const response = await fetch(origin + request.path, { signal: AbortSignal.timeout(18000), redirect: 'error' });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error(request.id + ': HTTP ' + response.status);
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw new Error(request.id + ': catalog too large');
    json = JSON.parse(text);
  }
  const rows = request.id === 'browse' ? Object.values(json.rows || {}).filter(Array.isArray).flat() : json.items;
  return normalizeMusicEntries(rows, request.id);
}));
const successes = results.filter(result => result.status === 'fulfilled').map(result => result.value);
if (!successes.length) throw new Error('No music source was available; the current snapshot was preserved.');
const merged = mergeMusicTracks(successes);
const tracks = merged.flatMap(track => track.variants);
const snapshot = { version: 1, generatedAt: new Date().toISOString(), source: origin, description: 'Featured and lofi discovery snapshot. Live searches query all supported sources.', tracks };
await writeFile(new URL('../browser-tools/music-catalog.json', import.meta.url), JSON.stringify(snapshot) + '\n');
console.log(JSON.stringify({ uniqueTitles: merged.length, variants: tracks.length, sources: [...new Set(tracks.map(track => track.source))], failedSources: results.filter(result => result.status === 'rejected').length }));
