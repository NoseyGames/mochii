import { readFile, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { GAME_SOURCES, normalizeGameEntries, normalizeGameSnapshot, fetchGameJson } from '../browser-tools/game-catalog.js';

const target = new URL('../browser-tools/game-catalog.json', import.meta.url);
const fromIndex = process.argv.indexOf('--from-dir');
const fromDirectory = fromIndex >= 0 ? process.argv[fromIndex + 1] : null;
if (fromIndex >= 0 && !fromDirectory) throw new Error('--from-dir requires a directory.');
let previous;
try { previous = JSON.parse(await readFile(target, 'utf8')); } catch { previous = { sources: [] }; }
const errors = [];
const sources = await Promise.all(GAME_SOURCES.map(async source => {
  let games;
  try {
    const raw = fromDirectory
      ? JSON.parse(await readFile(resolve(fromDirectory, source.file || (source.id === 'securly' ? 'securlycdn.json' : basename(new URL(source.manifest).pathname))), 'utf8'))
      : await fetchGameJson(fetch, source.manifest, { signal: AbortSignal.timeout(20000) });
    games = normalizeGameEntries(raw, source.id);
    if (!games.length) throw new Error('No playable entries.');
  } catch (error) {
    const existing = previous.sources?.find(group => group.id === source.id);
    games = normalizeGameEntries(existing?.games, source.id);
    errors.push({ source: source.id, error: error.message, kept: games.length });
    if (!games.length) throw new Error(source.label + ': ' + error.message);
  }
  return { id: source.id, label: source.label, manifest: source.manifest,
    games: games.map(({ name, url, cover, author }) => ({ name, url, cover, ...(author ? { author } : {}) })) };
}));
const snapshot = { version: 1, updatedAt: new Date().toISOString(), references: ['https://photos.tram-gallery.ru/play', 'https://h35d5a9.jfs-autoelevadores.com.ar/g'], sources };
await writeFile(target, JSON.stringify(snapshot) + '\n', 'utf8');
const total = sources.reduce((count, source) => count + source.games.length, 0);
const unique = normalizeGameSnapshot(snapshot).length;
console.log(JSON.stringify({ file: target.pathname, total, unique, duplicates: total - unique, sources: sources.map(source => ({ id: source.id, count: source.games.length })), retainedAfterErrors: errors }, null, 2));
