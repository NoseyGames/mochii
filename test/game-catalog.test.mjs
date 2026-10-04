import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GAME_SOURCES, normalizeGameEntries, normalizeGameSnapshot, selectGames, gamePage, fetchGameJson, createGameCatalog } from '../browser-tools/game-catalog.js';

const fixture = { version: 1, sources: [
  { id: 'securly', games: [{ name: 'First game', url: '{HTML_URL}/first.html', cover: '{COVER_URL}/first.png', author: 'Creator' }, { name: 'Slope', url: '{HTML_URL}/slope.html' }] },
  { id: 'gn-math', games: [{ name: 'Slope', url: '/study2/1.html' }] }
] };
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('all playable reference entries ship alongside the previous catalog, with chat and suggestion entries removed', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../browser-tools/game-catalog.json', import.meta.url), 'utf8'));
  const games = normalizeGameSnapshot(snapshot);
  assert.equal(games.length, 3543);
  assert.deepEqual(Object.fromEntries(GAME_SOURCES.map(source => [source.id, games.filter(game => game.source === source.id).length])), {
    securly: 835, 'gn-math': 808, seraph: 468, hydra: 872, '3kh0': 370, ports: 107, tglsc: 83
  });
  assert.equal(new Set(games.map(game => game.id)).size, games.length);
  assert(games.every(game => !/^\[!\]/.test(game.name) && game.url.startsWith('https://')));
});

test('catalog normalization resolves each source and rejects unsafe URLs without trusting supplied IDs or source fields', () => {
  const inputs = [
    { id: 'forged', source: 'securly', name: 'Relative', url: 'study2/1.html', image: 'images/1.png' },
    { name: 'Duplicate', url: '/study2/1.html' },
    { name: 'Script', url: 'javascript:alert(1)' },
    { name: 'Login', url: 'https://user:password@photos.tram-gallery.ru/a' },
    { name: 'Impostor', url: 'https://photos.tram-gallery.ru.evil.example/a' },
    { name: 'Local', url: 'https://localhost/a' },
    { name: 'HTTP', url: 'http://photos.tram-gallery.ru/a' },
    { name: 'Controls', url: 'https://photos.tram-gallery.ru/\n/path' },
    { name: '[!] COMMENTS', url: '/study2/comments.html' },
    { name: 'SUGGEST GAMES', url: '/study2/suggest.html' },
    { name: '<img src=x onerror=alert(1)>', url: '/study2/2.html', image: 'https://unlisted.example/tracker' },
    null, false, 'text', []
  ];
  const games = normalizeGameEntries(inputs, 'gn-math');
  assert.equal(games.length, 2);
  assert.equal(games[0].url, 'https://photos.tram-gallery.ru/study2/1.html');
  assert.equal(games[0].cover, 'https://photos.tram-gallery.ru/images/1.png');
  assert.equal(games[0].source, 'gn-math');
  assert.equal(games[0].id, 'gn-math|https://photos.tram-gallery.ru/study2/1.html');
  assert.equal(games[1].cover, '');
  assert.deepEqual(normalizeGameEntries(inputs, 'unknown'), []);
  assert.deepEqual(normalizeGameSnapshot({ version: 2, sources: fixture.sources }), []);
});

test('favorites, recent order, search, and source filters retain alternate source versions', () => {
  const games = normalizeGameSnapshot(fixture);
  const slopes = selectGames(games, { query: 'slope' });
  assert.equal(slopes.length, 2);
  assert.notEqual(slopes[0].id, slopes[1].id);
  assert.equal(selectGames(games, { query: 'slope', source: 'gn-math' }).length, 1);
  assert.equal(selectGames(games, { query: 'Creator' })[0].name, 'First game');
  assert.deepEqual(selectGames(games, { view: 'favorites', favorites: [games[2].id] }), [games[2]]);
  assert.deepEqual(selectGames(games, { view: 'recent', recents: [games[2].id, games[0].id] }), [games[2], games[0]]);
  assert.equal(selectGames(games)[0].name, 'Slope');
  assert.equal(selectGames(games, { sort: 'az' })[0].name, 'First game');
});

test('pagination caps DOM work and clamps a stale page after filtering', () => {
  const games = Array.from({ length: 3543 }, (_, id) => ({ id }));
  assert.equal(gamePage(games).items.length, 60);
  assert.equal(gamePage(games).pages, 60);
  assert.deepEqual(gamePage(games.slice(0, 2), 50), { page: 1, pages: 1, items: games.slice(0, 2) });
  assert.equal(gamePage(games, 1, 100000).items.length, 100);
  assert.equal(gamePage(games, Infinity).page, 1);
  assert.deepEqual(gamePage([]), { page: 1, pages: 1, items: [] });
});

test('fetch rejects HTML errors and oversized streaming catalogs and cancels their readers', async () => {
  await assert.rejects(fetchGameJson(async () => new Response('<!DOCTYPE html>', { headers: { 'content-type': 'text/html' } }), '/catalog'), /did not return JSON/);
  await assert.rejects(fetchGameJson(async () => new Response('{}', { status: 503 }), '/catalog'), /HTTP 503/);
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
  await assert.rejects(fetchGameJson(async () => new Response(stream, { headers: { 'content-type': 'application/json' } }), '/catalog'), /too large/);
  assert.equal(cancelled, true);
  let options;
  const result = await fetchGameJson(async (_, value) => { options = value; return response(fixture); }, '/catalog');
  assert.deepEqual(result, fixture);
  assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer');
});

function harness(fetcher) {
  const nodes = new Map();
  function element(tagName = 'div') {
    const events = new Map();
    const el = {
      tagName, children: [], attributes: {}, value: '', textContent: '', parentNode: null, disabled: false,
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(type, listener) { events.set(type, listener); },
      fire(type) { return events.get(type)?.({ target: this }); },
      appendChild(child) {
        if (child.tagName === '#fragment') { for (const item of [...child.children]) this.appendChild(item); return child; }
        this.children.push(child); child.parentNode = this; return child;
      },
      append(...children) { children.forEach(child => this.appendChild(child)); },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      insertBefore(child, before) { const index = this.children.indexOf(before); if (index < 0) this.appendChild(child); else { this.children.splice(index, 0, child); child.parentNode = this; } },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); },
      scrollTo() {}
    };
    Object.defineProperty(el, 'id', { get() { return this._id; }, set(value) { this._id = value; nodes.set(value, this); } });
    Object.defineProperty(el, 'firstElementChild', { get() { return this.children[0]; } });
    Object.defineProperty(el, 'nextSibling', { get() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1]; } });
    return el;
  }
  const panel = element();
  for (const id of ['popover-search-input', 'popover-sort-select', 'game-list']) { const item = element(); item.id = id; panel.appendChild(item); }
  const doc = { getElementById: id => nodes.get(id), createElement: element, createDocumentFragment: () => element('#fragment') };
  const storage = new Map();
  const opened = [];
  const win = { localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, fetch: fetcher,
    openViewer: (...args) => opened.push(args), MonkehPrivacy: { get: () => ({ showCovers: true }) } };
  const catalog = createGameCatalog(win, doc);
  return { catalog, nodes, panel, storage, opened };
}

test('saved catalogs render before a slow live source, controls are installed once, and failed refresh keeps usable games', async () => {
  let finish;
  let rejectSnapshot = false;
  const pending = new Promise(resolve => { finish = resolve; });
  const app = harness(url => {
    if (url.startsWith('/')) return rejectSnapshot ? Promise.reject(new Error('offline')) : Promise.resolve(response(fixture));
    return pending;
  });
  const loading = app.catalog.open();
  await flush();
  assert.equal(app.catalog.getState().count, 3);
  assert.equal(app.nodes.get('game-list').children.length, 3);
  assert.equal(app.nodes.get('games-source-select').children.length, 8);
  const panelSize = app.panel.children.length;
  await app.catalog.open();
  assert.equal(app.panel.children.length, panelSize);
  finish(new Response('unavailable', { status: 503 }));
  assert.equal(await loading, 3);
  rejectSnapshot = true;
  assert.equal(await app.catalog.refresh(), 3);
  assert.match(app.nodes.get('games-status').textContent, /temporarily unavailable/);
});

test('launches use verified known destinations through the proxy and favorite buttons never launch a game', async () => {
  const app = harness(url => Promise.resolve(url.startsWith('/') ? response(fixture) : new Response('offline', { status: 503 })));
  await app.catalog.open();
  const firstCard = app.nodes.get('game-list').children[0];
  firstCard.children[1].fire('click');
  assert.equal(app.opened.length, 0);
  assert.equal(app.catalog.getState().favorites.length, 1);
  firstCard.children[0].fire('click');
  assert.equal(app.opened.length, 1);
  assert.equal(app.opened[0][3], true);
  const known = normalizeGameSnapshot(fixture)[0];
  app.catalog.launch({ id: known.id, name: 'Forged', url: 'https://attacker.example' });
  assert.deepEqual(app.opened.at(-1), ['First game', 'Original catalog', known.url, true]);
  app.catalog.launch({ id: 'unknown', url: known.url });
  assert.equal(app.opened.length, 2);
  assert.equal(app.catalog.getState().recents[0], known.id);
  app.nodes.get('games-view-select').value = 'favorites';
  app.nodes.get('games-view-select').fire('change');
  assert.equal(app.nodes.get('game-list').children.length, 1);
  app.nodes.get('games-clear').fire('click');
  assert.deepEqual(app.catalog.getState().favorites, []);
});

test('one failed snapshot does not hide a healthy live source', async () => {
  const app = harness(url => url.startsWith('/') ? Promise.reject(new Error('offline')) : Promise.resolve(response(fixture.sources[0].games)));
  assert.equal(await app.catalog.open(), 2);
  assert.equal(app.catalog.getState().ready, true);
});
