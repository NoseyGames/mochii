import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryBackup, parseLibraryBackup, previewLibraryBackup, importLibraryBackup, mountLibraryBackup, LIBRARY_KEYS, MAX_BACKUP_BYTES } from '../browser-tools/library-backup.js';
import { GAME_SOURCES, normalizeGamePreferences } from '../browser-tools/game-catalog.js';

function storage(seed = {}) {
  const values = new Map(Object.entries(seed).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  const reads = [];
  return { values, reads, getItem(key) { reads.push(key); return values.get(key) ?? null; }, setItem(key, value) { values.set(key, value); }, removeItem(key) { values.delete(key); } };
}
const keys = LIBRARY_KEYS;
const track = (id = '1', title = 'Piano', source = 'qobuz') => ({ id, title, source, artist: 'Artist', duration: 90 });
const bookmark = (id = 'bookmark-a', url = 'https://example.com/game') => ({ id, title: 'Example', url });
const script = (id = 'script-a', code = 'window.userCode = true;') => ({ id, name: 'My script', match: 'https://example.com/*', code, enabled: true });
function backup(categories) { return { app: 'mochii', type: 'library-backup', version: 1, createdAt: '2026-10-15T00:00:00.000Z', categories }; }
const parse = categories => parseLibraryBackup(JSON.stringify(backup(categories)));

test('portable export reads only allowlisted selected storage and strips credentials from records', () => {
  const state = storage({ [keys.preferences[0]]: { mode: 'light', password: 'secret-never-export', session: 'secret-never-export' },
    [keys.bookmarks[0]]: [{ ...bookmark(), token: 'secret-never-export' }], access_token: 'secret-never-export', cookies: 'secret-never-export' });
  const result = createLibraryBackup(state, { selected: ['preferences', 'bookmarks'], now: new Date('2026-10-15') });
  assert.deepEqual(Object.keys(result.categories), ['preferences', 'bookmarks']);
  assert.equal(result.categories.preferences.mode, 'light');
  assert(!JSON.stringify(result).includes('secret-never-export'));
  assert.deepEqual(state.reads, [keys.preferences[0], keys.bookmarks[0]]);
  assert.deepEqual(parseLibraryBackup(JSON.stringify(result)), result);
});

test('legacy library keys are read without migration writes and current keys take precedence', () => {
  const state = storage({ 'monkeh.games.favorites.v1': ['game|legacy'], [keys.games[1]]: ['game|current'] });
  const before = new Map(state.values);
  const result = createLibraryBackup(state, { selected: ['games'] });
  assert.deepEqual(result.categories.games.favorites, ['game|legacy']);
  assert.deepEqual(result.categories.games.recent, ['game|current']);
  assert.deepEqual(state.values, before);
});

test('preview reports category counts without writing storage or running source code', () => {
  const result = parse({ userscripts: [script()], games: { favorites: ['game|2048'], recent: ['game|2048'], preferences: { selectedSources: { 'game|2048': 'cherri-seraph|https://h35d5a9.jfs-autoelevadores.com.ar/stores/seraph/2048/index.html' } } } });
  assert.equal(previewLibraryBackup(result)[0].details, '1 scripts; imported disabled');
  assert.match(previewLibraryBackup(result)[1].details, /1 favorites, 1 recent, 1 source choices/);
  assert.equal(globalThis.userCode, undefined);
});

test('imports merge chosen libraries and preserve unrelated storage exactly', () => {
  const state = storage({ [keys.games[0]]: ['game|old'], [keys.games[1]]: ['game|old', 'game|new'], [keys.bookmarks[0]]: [bookmark()], session: 'preserve-me' });
  const result = backup({ games: { favorites: ['game|new', 'game|old'], recent: ['game|new'], preferences: { query: 'new', selectedSources: {} } }, preferences: { mode: 'light' } });
  const imported = importLibraryBackup(state, result, { selected: ['games'] });
  assert.deepEqual(JSON.parse(state.getItem(keys.games[0])), ['game|old', 'game|new']);
  assert.deepEqual(JSON.parse(state.getItem(keys.games[1])), ['game|new', 'game|old']);
  assert.equal(state.getItem(keys.preferences[0]), null);
  assert.equal(state.getItem('session'), 'preserve-me');
  assert.deepEqual(imported.keys, keys.games);
});

test('game state carries filters and source choices while validating canonical IDs and catalog origins', () => {
  const result = parse({ games: { favorites: ['game|2048'], recent: [], preferences: { version: 1, source: 'all', view: 'recent', sort: 'az', genre: 'puzzle', players: 'local', input: 'touch', shelf: 'curated', page: 2, scrollTop: 120, query: '2048', selectedSources: { 'game|2048': 'cherri-seraph|https://h35d5a9.jfs-autoelevadores.com.ar/stores/seraph/2048/index.html' } } } });
  assert.equal(result.categories.games.preferences.genre, 'puzzle');
  for (const selectedSources of [{ 'game|bad name': 'seraph|https://photos.tram-gallery.ru/game' }, { 'game|2048': 'seraph|https://attacker.example/game' }, { 'game|2048': 'game|2048' }]) {
    assert.throws(() => parse({ games: { preferences: { selectedSources } } }));
  }
  for (const preferences of [{ page: 0 }, { scrollTop: 1e8 }, { source: 'unknown' }, { query: 'x'.repeat(201) }, { input: 'probably' }]) assert.throws(() => parse({ games: { preferences } }));
});

test('backup source validation stays compatible with every configured game catalog', () => {
  for (const source of GAME_SOURCES) {
    const variant = source.id + '|' + new URL('/stores/backup-test.html', source.origins[0]).href;
    const preferences = { version: 1, source: source.id, selectedSources: { 'game|test': variant } };
    const result = parse({ games: { preferences } }).categories.games.preferences;
    assert.equal(normalizeGamePreferences(result).selectedSources['game|test'], variant, source.id);
  }
});

test('music roundtrip retains source variants, playlists and opt-in resume without stream credentials', () => {
  const first = { ...track(), variants: [track(), track('youtube', 'Piano', 'ytm')], streamUrl: 'https://secret.example/?token=secret', accessToken: 'secret' };
  const state = storage({ [keys.music[0]]: [first], [keys.music[1]]: { version: 1, playlists: [{ id: 'calm', name: 'Calm', tracks: [first] }] },
    [keys.music[2]]: { volume: .4, shuffle: true, repeat: 'all', remember: true, session: { track: first, queue: [first], index: 0, position: 25, token: 'secret' } } });
  const exported = createLibraryBackup(state, { selected: ['music'] });
  assert(!JSON.stringify(exported).includes('secret'));
  const destination = storage();
  importLibraryBackup(destination, exported);
  const imported = JSON.parse(destination.getItem(keys.music[2]));
  assert.equal(imported.session.position, 25);
  assert.equal(imported.session.track.variants.length, 2);
  assert.equal(imported.playing, undefined);
  assert.equal(JSON.parse(destination.getItem(keys.music[1])).playlists[0].name, 'Calm');
});

test('playlist merges deduplicate matching names and retain alternate music sources', () => {
  const state = storage({ [keys.music[0]]: [track()], [keys.music[1]]: { version: 1, playlists: [{ id: 'mine', name: 'Calm', tracks: [track()] }] } });
  importLibraryBackup(state, backup({ music: { favorites: [track('y1', 'Piano', 'ytm')], playlists: { version: 1, playlists: [{ id: 'theirs', name: 'CALM', tracks: [track('2', 'Rain')] }] } } }));
  assert.equal(JSON.parse(state.getItem(keys.music[0]))[0].variants.length, 2);
  const playlists = JSON.parse(state.getItem(keys.music[1])).playlists;
  assert.equal(playlists.length, 1);
  assert.equal(playlists[0].id, 'mine');
  assert.equal(playlists[0].tracks.length, 2);
});

test('music resume data is omitted when remembering playback is off', () => {
  const result = parse({ music: { player: { remember: false, session: { track: track(), queue: [track()], position: 7 } } } });
  assert.equal(result.categories.music.player.session, undefined);
});

test('imported userscripts are disabled even when replacing an enabled existing script', () => {
  const state = storage({ [keys.userscripts[0]]: [script('script-a', 'old code'), script('script-b', 'untouched')] });
  importLibraryBackup(state, backup({ userscripts: [script('script-a', 'globalThis.shouldNeverRun = true;')] }));
  const saved = JSON.parse(state.getItem(keys.userscripts[0]));
  assert.equal(saved.find(item => item.id === 'script-a').enabled, false);
  assert.equal(saved.find(item => item.id === 'script-b').enabled, true);
  assert.equal(globalThis.shouldNeverRun, undefined);
});

test('bookmark merge deduplicates URLs and resolves ID collisions without deleting saved links', () => {
  const state = storage({ [keys.bookmarks[0]]: [bookmark()] });
  importLibraryBackup(state, backup({ bookmarks: [bookmark('bookmark-a', 'https://second.example/'), { ...bookmark('different-id'), title: 'Renamed' }] }));
  const saved = JSON.parse(state.getItem(keys.bookmarks[0]));
  assert.equal(saved.length, 2);
  assert.equal(new Set(saved.map(item => item.id)).size, 2);
  assert.equal(saved.find(item => item.url === bookmark().url).id, 'bookmark-a');
  assert.equal(saved.find(item => item.url === bookmark().url).title, 'Renamed');
});

test('unsafe URLs, credentials and common token query or hash fields reject before writes', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'file:///secret', 'https://user:password@example.com/', 'https://example.com/?access_token=secret', 'https://example.com/#id_token=secret', 'https://example.com/?X-Amz-Signature=secret', 'https://example.com/?%61pi_key=secret']) {
    const state = storage();
    assert.throws(() => importLibraryBackup(state, backup({ bookmarks: [bookmark('a', url)] })), /URL|token|secret/);
    assert.equal(state.values.size, 0);
  }
  assert.throws(() => parse({ preferences: { backgroundUrl: 'https://example.com/?token=secret' } }), /token/);
  assert.throws(() => parse({ music: { favorites: [{ ...track(), artwork: 'https://i.ytimg.com/?token=secret' }] } }), /token/);
});

test('prototype pollution at every nesting level is rejected', () => {
  for (const property of ['__proto__', 'constructor', 'prototype']) {
    const content = JSON.stringify(backup({ bookmarks: [] })).replace('"bookmarks":[]', '"bookmarks":[],"' + property + '":{"polluted":true}');
    assert.throws(() => parseLibraryBackup(content), /unsafe property/);
    const nested = JSON.stringify(backup({ music: {} })).replace('"music":{}', '"music":{"player":{"' + property + '":{}}}');
    assert.throws(() => parseLibraryBackup(nested), /unsafe property/);
  }
  assert.equal({}.polluted, undefined);
});

test('unknown versions, categories, invalid JSON, depth and byte limits fail clearly', () => {
  for (const input of ['', '{', 'null', '[]', JSON.stringify({ ...backup({ bookmarks: [] }), version: 2 }), JSON.stringify(backup({ credentials: {} })), JSON.stringify(backup({})), ' '.repeat(MAX_BACKUP_BYTES + 1)]) assert.throws(() => parseLibraryBackup(input));
  let nested = {};
  for (let i = 0; i < 20; i++) nested = { next: nested };
  assert.throws(() => parse({ preferences: { unknown: nested } }), /complex/);
  assert.throws(() => parse({ games: { favorites: 0 } }), /entries/);
  assert.throws(() => parse({ preferences: { glassBlur: 999 } }), /range/);
});

test('collection and code limits fail instead of silently truncating user data', () => {
  assert.throws(() => parse({ bookmarks: Array.from({ length: 41 }, (_, i) => bookmark('b' + i, 'https://example.com/' + i)) }), /40/);
  assert.throws(() => parse({ games: { favorites: Array.from({ length: 501 }, (_, i) => 'game|' + i) } }), /500/);
  assert.throws(() => parse({ music: { favorites: Array.from({ length: 201 }, (_, i) => track(String(i))) } }), /200/);
  assert.throws(() => parse({ userscripts: [{ ...script(), code: 'x'.repeat(100001) }] }), /invalid/);
  assert.throws(() => parse({ userscripts: [{ ...script(), match: 'javascript:*' }] }), /HTTP/);
  assert.throws(() => parse({ music: { favorites: [{ ...track(), variants: [track('2', 'Different song')] }] } }), /mismatched/);
  assert.throws(() => parse({ music: { favorites: [{ ...track(), variants: Array.from({ length: 10 }, (_, i) => track('v' + i)) }] } }), /10/);
});

test('merge capacity errors are detected before any category is written', () => {
  const existing = Array.from({ length: 40 }, (_, i) => bookmark('b' + i, 'https://example.com/' + i));
  const state = storage({ [keys.bookmarks[0]]: existing, [keys.preferences[0]]: { mode: 'dark' } });
  const before = new Map(state.values);
  assert.throws(() => importLibraryBackup(state, backup({ preferences: { mode: 'light' }, bookmarks: [bookmark('new', 'https://new.example/')] })), /exceed/);
  assert.deepEqual(state.values, before);
});

test('a quota failure rolls all touched keys back, leaving unrelated data untouched', () => {
  const state = storage({ [keys.games[0]]: ['game|old'], session: 'keep' });
  const before = new Map(state.values);
  const set = state.setItem;
  let writes = 0;
  state.setItem = (key, value) => { if (++writes === 2) throw new Error('QuotaExceededError'); set(key, value); };
  assert.throws(() => importLibraryBackup(state, backup({ games: { favorites: ['game|new'], recent: ['game|new'] } })), /previous library was restored/);
  assert.deepEqual(state.values, before);
});

test('rollback failure is reported rather than claiming the original library was restored', () => {
  const state = storage({ [keys.games[0]]: ['game|old'], [keys.games[1]]: ['game|old'] });
  const set = state.setItem;
  let writes = 0;
  state.setItem = (key, value) => { if (++writes >= 2) throw new Error('Storage blocked'); set(key, value); };
  assert.throws(() => importLibraryBackup(state, backup({ games: { favorites: ['game|new'], recent: ['game|new'] } })), /rollback failed/);
});

test('successful import can be undone exactly once, including originally absent keys', () => {
  const state = storage({ [keys.bookmarks[0]]: [bookmark()], session: 'keep' });
  const before = new Map(state.values);
  const change = importLibraryBackup(state, backup({ bookmarks: [bookmark('new', 'https://new.example/')], games: { favorites: ['game|2048'] } }));
  change.undo();
  assert.deepEqual(state.values, before);
  assert.throws(() => change.undo(), /already/);
});

test('undo refuses to overwrite library edits made after the import', () => {
  const state = storage();
  const change = importLibraryBackup(state, backup({ bookmarks: [bookmark()] }));
  state.setItem(keys.bookmarks[0], JSON.stringify([bookmark(), bookmark('new', 'https://new.example/')]));
  const before = new Map(state.values);
  assert.throws(() => change.undo(), /changed after import/);
  assert.deepEqual(state.values, before);
});

test('blocked storage and malformed existing data fail without overwriting recoverable records', () => {
  assert.throws(() => createLibraryBackup({ getItem() { throw new Error('SecurityError'); } }, { selected: ['bookmarks'] }), /storage is blocked/);
  const state = storage({ [keys.bookmarks[0]]: '{broken' });
  assert.throws(() => importLibraryBackup(state, backup({ bookmarks: [bookmark()] })), /invalid JSON/);
  assert.equal(state.getItem(keys.bookmarks[0]), '{broken');
});

function ui(state = storage()) {
  const all = [];
  function element(tag) {
    const listeners = new Map();
    const node = { tag, children: [], dataset: {}, checked: false, hidden: false, _text: '',
      addEventListener(name, handler) { listeners.set(name, handler); },
      async emit(name) { return listeners.get(name)?.({ target: node }); },
      click() { return node.emit('click'); },
      setAttribute(name, value) { node[name] = value; },
      append(...children) { node.children.push(...children); }, remove() {},
      get textContent() { return node._text + node.children.map(child => child.textContent).join(''); },
      set textContent(value) { node._text = value; node.children = []; }
    };
    all.push(node); return node;
  }
  const downloads = [], events = [], messages = [];
  const doc = { createElement: element, body: element('body') };
  const win = { document: doc, localStorage: state, CustomEvent, URL: { createObjectURL(blob) { downloads.push(blob); return 'blob:local'; }, revokeObjectURL() {} }, setTimeout() {}, dispatchEvent(event) { events.push(event); } };
  const parent = element('div');
  mountLibraryBackup(parent, win, { notice: message => messages.push(message) });
  return { all, state, win, downloads, events, messages, parent, button: label => all.find(node => node.tag === 'button' && node.textContent === label), file: all.find(node => node.type === 'file'), preview: all.find(node => node.className === 'library-backup-preview') };
}

test('export UI previews categories first, leaves userscripts opt-in and only downloads on request', async () => {
  const f = ui(storage({ [keys.bookmarks[0]]: [bookmark()], [keys.userscripts[0]]: [script()] }));
  await f.button('Prepare export').click();
  assert.equal(f.downloads.length, 0);
  assert.equal(f.preview.hidden, false);
  assert.match(f.preview.textContent, /Bookmarks: 1 saved links/);
  assert(!f.preview.textContent.includes('Userscripts:'));
  await f.button('Download backup').click();
  const downloaded = parseLibraryBackup(await f.downloads[0].text());
  assert.equal(downloaded.categories.bookmarks.length, 1);
  assert.equal(downloaded.categories.userscripts, undefined);
  assert.equal(f.events.length, 0);
});

test('import UI reads a file without mutation, respects deselection and reports undo events', async () => {
  const f = ui();
  const data = JSON.stringify(backup({ bookmarks: [bookmark()], userscripts: [script()] }));
  f.file.files = [{ size: data.length, text: async () => data }];
  await f.file.emit('change');
  assert.equal(f.state.values.size, 0);
  assert.match(f.preview.textContent, /1 scripts; imported disabled/);
  const scripts = f.all.find(node => node['aria-label'] === 'Back up userscripts');
  scripts.checked = false; await scripts.emit('change');
  await f.button('Import selected').click();
  assert.equal(f.state.getItem(keys.userscripts[0]), null);
  assert.equal(JSON.parse(f.state.getItem(keys.bookmarks[0])).length, 1);
  assert.equal(f.events[0].type, 'mochii:library-import');
  assert.deepEqual(f.events[0].detail.keys, keys.bookmarks);
  await f.button('Undo import').click();
  assert.equal(f.state.values.size, 0);
  assert.equal(f.events.length, 2);
});

test('invalid import UI shows its error without replacing an existing library', async () => {
  const f = ui(storage({ [keys.bookmarks[0]]: [bookmark()] }));
  f.file.files = [{ size: 4, text: async () => 'oops' }];
  await f.file.emit('change');
  assert.match(f.messages.at(-1), /valid JSON/);
  assert.equal(f.preview.hidden, true);
  assert.equal(JSON.parse(f.state.getItem(keys.bookmarks[0])).length, 1);
  assert.equal(f.events.length, 0);
});
