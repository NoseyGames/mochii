import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCatalogTitle, deduplicateCatalog } from '../browser-tools/catalog-identity.js';

test('catalog identity folds casing, unicode presentation, accents, whitespace and common punctuation', () => {
  for (const name of ['  Pokémon - Red ', 'POKEMON_RED', 'Ｐｏｋéｍｏｎ：Ｒｅｄ', 'Pokemon\u200b Red', 'PokemonRed']) {
    assert.equal(normalizeCatalogTitle(name), 'pokemonred');
  }
  assert.equal(normalizeCatalogTitle('Paper.io 2'), normalizeCatalogTitle('Paper IO 2'));
  assert.equal(normalizeCatalogTitle('Rock & Roll'), normalizeCatalogTitle('rock and roll'));
  assert.equal(normalizeCatalogTitle("Papa’s Pizzeria"), normalizeCatalogTitle('Papas Pizzeria'));
  assert.equal(normalizeCatalogTitle(null), '');
});

test('identity retains sequel numbers, editions, decimal versions, remix titles and plus signs', () => {
  const names = ['Vex', 'Vex 2', 'Vex 3', 'Vex Remastered', 'Vex Plus', 'Vex+', 'Minecraft 1.12.2', 'Minecraft 1.8.8', 'Minecraft 1122', 'Song', 'Song Remix', 'Song Live'];
  assert.equal(new Set(names.map(normalizeCatalogTitle)).size, names.length);
});

test('dedupe evaluates each key once, preserves order and allows alternate sources to merge', () => {
  const entries = Array.from({ length: 20000 }, (_, index) => ({ name: 'Game ' + index % 5000, sources: [index] }));
  let calls = 0;
  const result = deduplicateCatalog(entries, {
    key: entry => { calls++; return normalizeCatalogTitle(entry.name); },
    merge: (first, next) => ({ ...first, sources: [...first.sources, ...next.sources] })
  });
  assert.equal(calls, entries.length);
  assert.equal(result.length, 5000);
  assert.deepEqual(result[0].sources, [0, 5000, 10000, 15000]);
  assert.equal(result.at(-1).name, 'Game 4999');
  assert.deepEqual(deduplicateCatalog([{ name: '' }, null]), []);
});
