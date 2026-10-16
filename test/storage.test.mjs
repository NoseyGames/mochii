import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { readMigratedStorage } from '../browser-tools/storage.js';
import { normalizePrivacy } from '../browser-tools/privacy.js';
import { createUserscriptStore } from '../browser-tools/userscripts.js';
import { createGameCatalog } from '../browser-tools/game-catalog.js';
import { reportMirror } from '../browser-tools/mirror-report.js';

function storageFixture(entries = [], blocked = false) {
  const values = new Map(entries);
  const writes = [];
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) {
      if (blocked) throw new Error('Quota exceeded');
      writes.push([key, value]);
      values.set(key, value);
    }
  };
  return { values, writes, storage };
}

test('storage migration copies a legacy value once without deleting it', () => {
  const f = storageFixture([['old', '{"saved":true}']]);
  assert.equal(readMigratedStorage(f.storage, 'new', 'old'), '{"saved":true}');
  assert.equal(readMigratedStorage(f.storage, 'new', 'old'), '{"saved":true}');
  assert.equal(f.values.get('old'), '{"saved":true}');
  assert.deepEqual(f.writes, [['new', '{"saved":true}']]);
});

test('present new storage wins even when empty or invalid and does not read legacy data', () => {
  for (const current of ['', '[]', 'not JSON']) {
    const storage = {
      getItem(key) { assert.equal(key, 'new'); return current; },
      setItem() { assert.fail('Must not overwrite current data'); }
    };
    assert.equal(readMigratedStorage(storage, 'new', 'old'), current);
  }
});

test('quota failure retains readable legacy data and blocked reads do not write', () => {
  const f = storageFixture([['old', 'saved']], true);
  assert.equal(readMigratedStorage(f.storage, 'new', 'old'), 'saved');
  assert.equal(f.values.has('new'), false);
  assert.equal(f.values.get('old'), 'saved');
  assert.throws(() => readMigratedStorage({
    getItem() { throw new Error('Read blocked'); },
    setItem() { assert.fail('Blocked reads must not write'); }
  }, 'new', 'old'), /Read blocked/);
});

test('migration respects a current value arriving before the copy and does not create empty keys', () => {
  let reads = 0;
  assert.equal(readMigratedStorage({
    getItem(key) { return key === 'old' ? 'legacy' : ++reads === 1 ? null : 'current'; },
    setItem() { assert.fail('Must preserve the newer value'); }
  }, 'new', 'old'), 'current');
  const f = storageFixture();
  assert.equal(readMigratedStorage(f.storage, 'new', 'old'), null);
  assert.deepEqual(f.writes, []);
});

async function privacyFixture(storage) {
  const source = await readFile(new URL('../browser-tools/privacy.js', import.meta.url), 'utf8');
  const win = { dispatchEvent() {} };
  vm.runInNewContext(source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''), {
    window: win, URL, CustomEvent, readMigratedStorage, localStorage: storage,
    document: { readyState: 'complete', getElementById: () => null, querySelectorAll: () => [] }
  });
  return win;
}

test('legacy privacy state and imported cloaks survive rebranding while future saves use Mochii', async () => {
  const saved = JSON.stringify({ mode: 'light', cloak: 'monkeh', accent: '#123456', characterMasking: false, displayTextVersion: 1 });
  const f = storageFixture([['monkeh.privacy.v1', saved]]);
  const win = await privacyFixture(f.storage);
  assert.equal(win.MonkehPrivacy, win.MochiiPrivacy);
  assert.equal(win.MochiiPrivacy.get().mode, 'light');
  assert.equal(win.MochiiPrivacy.get().cloak, 'mochii');
  assert.equal(win.MochiiPrivacy.get().characterMasking, false);
  assert.equal(f.values.get('mochii.privacy.v1'), saved);
  win.MochiiPrivacy.update({ accent: '#654321' });
  assert.equal(JSON.parse(f.values.get('mochii.privacy.v1')).cloak, 'mochii');
  assert.equal(f.values.get('monkeh.privacy.v1'), saved);
  assert(f.writes.every(([key]) => key === 'mochii.privacy.v1'));
  assert.equal(normalizePrivacy({ cloak: 'monkeh' }).cloak, 'mochii');
});

test('current privacy settings take precedence and blocked migration keeps legacy preferences usable', async () => {
  const saved = JSON.stringify({ mode: 'light', cloak: 'google' });
  const current = JSON.stringify({ mode: 'dark', cloak: 'mochii', characterMasking: false, displayTextVersion: 1 });
  const f = storageFixture([['monkeh.privacy.v1', saved], ['mochii.privacy.v1', current]]);
  const win = await privacyFixture(f.storage);
  assert.equal(win.MochiiPrivacy.get().mode, 'dark');
  assert.equal(win.MochiiPrivacy.get().characterMasking, false);
  assert.deepEqual(f.writes, []);
  const blocked = storageFixture([['monkeh.privacy.v1', saved]], true);
  assert.equal((await privacyFixture(blocked.storage)).MochiiPrivacy.get().cloak, 'google');
});

test('userscript migration retains validation, old records, and new-key-only saves', () => {
  const script = { id: 'saved', name: 'Saved script', match: 'https://example.com/*', code: 'console.log("saved")', enabled: true };
  const raw = JSON.stringify([script, { ...script, id: 'invalid id' }]);
  const f = storageFixture([['monkeh.userscripts.v1', raw]]);
  const store = createUserscriptStore(f.storage);
  assert.deepEqual(store.list(), [script]);
  assert.match(store.warning, /invalid/);
  store.save({ ...script, name: 'Renamed script' });
  assert.equal(JSON.parse(f.values.get('mochii.userscripts.v1'))[0].name, 'Renamed script');
  assert.equal(f.values.get('monkeh.userscripts.v1'), raw);
  assert(f.writes.every(([key]) => key === 'mochii.userscripts.v1'));
  const blocked = storageFixture([['monkeh.userscripts.v1', JSON.stringify([script])]], true);
  assert.deepEqual(createUserscriptStore(blocked.storage).list(), [script]);
  const present = storageFixture([['monkeh.userscripts.v1', raw], ['mochii.userscripts.v1', '[]']]);
  assert.deepEqual(createUserscriptStore(present.storage).list(), []);
  assert.deepEqual(present.writes, []);
});

test('game favorites and recents migrate independently with existing validation and limits', () => {
  const favorites = JSON.stringify(['game|first', 'game|first', 17, 'a'.repeat(4201), ...Array.from({ length: 510 }, (_, i) => `game|${i}`)]);
  const recents = JSON.stringify(Array.from({ length: 55 }, (_, i) => `game|${i}`));
  const f = storageFixture([['monkeh.games.favorites.v1', favorites], ['monkeh.games.recents.v1', recents]]);
  const catalog = createGameCatalog({ localStorage: f.storage }, {});
  assert.equal(catalog.getState().favorites.length, 500);
  assert.equal(catalog.getState().favorites[0], 'game|first');
  assert.equal(catalog.getState().recents.length, 50);
  assert.equal(f.values.get('mochii.games.favorites.v1'), favorites);
  assert.equal(f.values.get('mochii.games.recents.v1'), recents);
  assert.equal(f.values.get('monkeh.games.favorites.v1'), favorites);
  assert.equal(f.values.get('monkeh.games.recents.v1'), recents);
  f.values.set('mochii.games.favorites.v1', '[]');
  assert.deepEqual(createGameCatalog({ localStorage: f.storage }, {}).getState().favorites, []);
  const blocked = storageFixture([['monkeh.games.recents.v1', '["game|saved"]']], true);
  assert.deepEqual(createGameCatalog({ localStorage: blocked.storage }, {}).getState().recents, ['game|saved']);
});

function mirrorWindow(storage) {
  const win = { location: { origin: 'https://example.pages.dev' }, localStorage: storage };
  win.top = win.self = win;
  return win;
}

test('legacy mirror acknowledgements prevent repeat reports even when migration cannot be saved', async () => {
  const endpoint = 'https://watch.workers.dev/report';
  const identity = JSON.stringify(['https://example.pages.dev', endpoint]);
  for (const blocked of [false, true]) {
    const f = storageFixture([['monkeh:mirror-reported:v1', identity]], blocked);
    assert.equal(await reportMirror(mirrorWindow(f.storage), endpoint, { fetcher() { assert.fail('Already reported'); } }), true);
    assert.equal(f.values.get('monkeh:mirror-reported:v1'), identity);
    assert.equal(f.values.get('mochii:mirror-reported:v1'), blocked ? undefined : identity);
  }
});

test('fresh mirror acknowledgements use the Mochii key and an existing new acknowledgement wins', async () => {
  const endpoint = 'https://watch.workers.dev/report';
  const identity = JSON.stringify(['https://example.pages.dev', endpoint]);
  const f = storageFixture([['monkeh:mirror-reported:v1', 'outdated']]);
  let requests = 0;
  const fetcher = async () => { requests++; return new Response('', { status: 202 }); };
  assert.equal(await reportMirror(mirrorWindow(f.storage), endpoint, { fetcher }), true);
  assert.equal(await reportMirror(mirrorWindow(f.storage), endpoint, { fetcher }), true);
  assert.equal(requests, 1);
  assert.equal(f.values.get('mochii:mirror-reported:v1'), identity);
  assert.equal(f.values.get('monkeh:mirror-reported:v1'), 'outdated');
  assert(f.writes.every(([key]) => key === 'mochii:mirror-reported:v1'));
});
