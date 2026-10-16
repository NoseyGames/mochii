import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GAME_SOURCES, GAME_PREFERENCES_KEY, CURATED_GAME_METADATA, normalizeGamePreferences, gameMetadata, normalizeGameEntries, normalizeGameSnapshot, snapshotGameEntries, deduplicateGames, selectGames, gamePage, fetchGameJson, createGameCatalog, createLazyGameCovers } from '../browser-tools/game-catalog.js';

const fixture = { version: 1, sources: [
  { id: 'securly', games: [{ name: 'First game', url: '{HTML_URL}/first.html', cover: '{COVER_URL}/first.png', author: 'Creator' }, { name: 'Slope', url: '{HTML_URL}/slope.html' }] },
  { id: 'gn-math', games: [{ name: 'Slope', url: '/study2/1.html' }] }
] };
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('all public Cherri source games ship alongside existing games with one card per title', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../browser-tools/game-catalog.json', import.meta.url), 'utf8'));
  const games = normalizeGameSnapshot(snapshot);
  assert.equal(games.length, 3082);
  const entries = snapshotGameEntries(snapshot);
  assert.equal(entries.length, 7688);
  assert.deepEqual(Object.fromEntries(GAME_SOURCES.map(source => [source.id, entries.filter(game => game.source === source.id).length])), {
    securly: 835, 'gn-math': 808, seraph: 468, hydra: 872, '3kh0': 370, ports: 107, tglsc: 83,
    'cherri-ckv': 819, 'cherri-seraph': 492, 'cherri-truffled': 505, 'cherri-ugs': 1512, 'cherri-gn-math': 817
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

test('favorites, recent order, and source filters share one title while retaining alternate sources', () => {
  const games = normalizeGameSnapshot(fixture);
  const slopes = selectGames(games, { query: 'slope' });
  assert.equal(slopes.length, 1);
  assert.equal(slopes[0].variants.length, 2);
  assert.equal(selectGames(games, { query: 'slope', source: 'gn-math' }).length, 1);
  assert.equal(selectGames(games, { query: 'Creator' })[0].name, 'First game');
  assert.deepEqual(selectGames(games, { view: 'favorites', favorites: [games[1].aliases[1]] }), [games[1]]);
  assert.deepEqual(selectGames(games, { view: 'recent', recents: [games[1].aliases[1], games[0].id] }), [games[1], games[0]]);
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

function harness(fetcher, initialStorage = []) {
  const nodes = new Map();
  const observers = [];
  const imageRequests = [];
  let doc;
  function element(tagName = 'div') {
    const events = new Map();
    const el = {
      tagName, children: [], attributes: {}, value: '', textContent: '', parentNode: null, disabled: false, scrollTop: 0,
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(type, listener) { events.set(type, listener); },
      fire(type) { return events.get(type)?.({ target: this }); },
      appendChild(child) {
        if (child.tagName === '#fragment') { for (const item of [...child.children]) this.appendChild(item); return child; }
        if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(item => item !== child);
        this.children.push(child); child.parentNode = this; return child;
      },
      append(...children) { children.forEach(child => this.appendChild(child)); },
      replaceChildren(...children) { [...this.children].forEach(child => child.remove()); this.append(...children); },
      insertBefore(child, before) {
        if (child === before) return;
        if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(item => item !== child);
        const index = this.children.indexOf(before); if (index < 0) this.appendChild(child); else { this.children.splice(index, 0, child); child.parentNode = this; }
      },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); if (this.contains(doc?.activeElement)) doc.activeElement = null; this.parentNode = null; },
      contains(target) { return target === this || this.children.some(child => child.contains(target)); },
      focus() { doc.activeElement = this; },
      scrollTo({ top }) { this.scrollTop = top; }
    };
    el.classList = { contains(name) { return (el.className || '').split(' ').includes(name); } };
    Object.defineProperty(el, 'id', { get() { return this._id; }, set(value) { this._id = value; nodes.set(value, this); } });
    Object.defineProperty(el, 'src', { get() { return this._src; }, set(value) { this._src = value; imageRequests.push(value); } });
    Object.defineProperty(el, 'firstElementChild', { get() { return this.children[0]; } });
    Object.defineProperty(el, 'nextSibling', { get() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1]; } });
    return el;
  }
  const panel = element();
  const popover = element(); popover.id = 'games-popover'; popover.className = 'active'; popover.appendChild(panel);
  for (const id of ['popover-search-input', 'popover-sort-select', 'game-list']) { const item = element(); item.id = id; panel.appendChild(item); }
  doc = { getElementById: id => nodes.get(id), createElement: element, createDocumentFragment: () => element('#fragment'), activeElement: null, hidden: false };
  const storage = new Map(initialStorage);
  const opened = [];
  const winEvents = new Map();
  const win = { localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, fetch: fetcher,
    addEventListener(name, listener) { winEvents.set(name, listener); },
    openViewer: (...args) => opened.push(args), MochiiPrivacy: { get: () => ({ showCovers: true }) },
    IntersectionObserver: class {
      constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); observers.push(this); }
      observe(target) { this.targets.add(target); }
      unobserve(target) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
      emit(target, isIntersecting = true) { this.callback([{ target, isIntersecting }]); }
    }
  };
  const catalog = createGameCatalog(win, doc);
  return { catalog, nodes, panel, storage, opened, doc, win, popover, observers, imageRequests, winEvents };
}

function sourceChooser(card) {
  const menu = card.children[2];
  menu.open = true;
  menu.fire('toggle');
  return menu.children[1];
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
  assert.equal(app.catalog.getState().count, 2);
  assert.equal(app.catalog.getState().duplicates, 1);
  assert.equal(app.nodes.get('game-list').children.length, 2);
  assert.equal(app.nodes.get('games-source-select').children.length, 13);
  const panelSize = app.panel.children.length;
  await app.catalog.open();
  assert.equal(app.panel.children.length, panelSize);
  finish(new Response('unavailable', { status: 503 }));
  assert.equal(await loading, 2);
  rejectSnapshot = true;
  assert.equal(await app.catalog.refresh(), 2);
  assert.match(app.nodes.get('games-status').textContent, /temporarily unavailable/);
});

test('game launches request fetched code execution using verified proxy destinations and favorites never launch', async () => {
  const app = harness(url => Promise.resolve(url.startsWith('/') ? response(fixture) : new Response('offline', { status: 503 })));
  await app.catalog.open();
  const firstCard = app.nodes.get('game-list').children[0];
  firstCard.children[1].fire('click');
  assert.equal(app.opened.length, 0);
  assert.equal(app.catalog.getState().favorites.length, 1);
  firstCard.children[0].fire('click');
  assert.equal(app.opened.length, 1);
  assert.equal(app.opened[0][3], true);
  assert.deepEqual(app.opened[0][4], { loadCode: true });
  const known = normalizeGameSnapshot(fixture)[0];
  app.catalog.launch({ id: known.id, name: 'Forged', url: 'https://attacker.example' });
  assert.deepEqual(app.opened.at(-1), ['First game', 'Original catalog', known.url, true, { loadCode: true }]);
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

test('catalog status shows game counts without duplicate-removal text and random launches use fetched code', async () => {
  const app = harness(url => Promise.resolve(url.startsWith('/') ? response(fixture) : new Response('offline', { status: 503 })));
  await app.catalog.open();
  assert.equal(app.catalog.getState().duplicates, 1);
  assert.equal(app.nodes.get('games-status').textContent, '2 of 2 games');
  app.nodes.get('popover-search-input').value = 'First game';
  app.catalog.render(true);
  assert.equal(app.nodes.get('games-status').textContent, '1 of 2 games');
  app.nodes.get('games-random').fire('click');
  assert.deepEqual(app.opened[0], ['First game', 'Original catalog', 'https://cdn.jsdelivr.net/gh/securlycdn/html@main/first.html', true, { loadCode: true }]);
});

test('Cherri manifests resolve stores and covers while rejecting destinations outside the source allowlist', () => {
  const entries = normalizeGameEntries([
    { name: 'Slope', url: '/seraph/slope/index.html', img: '/img/seraph/slope.jpg' },
    { name: 'External', url: 'https://attacker.example/game', img: 'https://attacker.example/pixel' },
    { name: 'Script', url: 'javascript:alert(1)' }
  ], 'cherri-seraph');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].url, 'https://h35d5a9.jfs-autoelevadores.com.ar/stores/seraph/slope/index.html');
  assert.equal(entries[0].cover, 'https://h35d5a9.jfs-autoelevadores.com.ar/covers/seraph/slope.jpg');
  const reread = normalizeGameEntries(entries, 'cherri-seraph');
  assert.equal(reread[0].url, entries[0].url);
});

test('ingest deduplicates titles once and keeps every unique launch alternative', () => {
  const rows = normalizeGameEntries([
    { name: 'Game — One', url: '/study2/1.html' },
    { name: 'GAME ONE', url: '/study2/2.html' },
    { name: 'Game One 2', url: '/study2/3.html' },
    { name: 'Game One Remastered', url: '/study2/4.html' }
  ], 'gn-math');
  const games = deduplicateGames([...rows, rows[0]]);
  assert.equal(games.length, 3);
  assert.equal(games[0].variants.length, 2);
  assert.equal(games[0].aliases.length, 2);
  assert.equal(selectGames(games, { query: 'game-one' }).length, 3);
  assert.equal(selectGames(games, { query: 'game one 2' }).length, 1);
  assert.equal(games[0].id, 'game|gameone');
});

test('favorite and recent source IDs migrate to one canonical title and alternate selection routes through the proxy', async () => {
  const oldA = 'securly|https://cdn.jsdelivr.net/gh/securlycdn/html@main/slope.html';
  const oldB = 'gn-math|https://photos.tram-gallery.ru/study2/1.html';
  const app = harness(url => Promise.resolve(url.startsWith('/') ? response(fixture) : new Response('offline', { status: 503 })), [
    ['mochii.games.favorites.v1', JSON.stringify([oldA, oldB])],
    ['mochii.games.recents.v1', JSON.stringify([oldB, oldA])]
  ]);
  await app.catalog.open();
  assert.deepEqual(app.catalog.getState().favorites, ['game|slope']);
  assert.deepEqual(app.catalog.getState().recents, ['game|slope']);
  assert.equal(app.storage.get('mochii.games.favorites.v1'), '["game|slope"]');
  const card = app.nodes.get('game-list').children[0];
  assert.equal(card.children.length, 3);
  const chooser = sourceChooser(card);
  chooser.value = oldB;
  chooser.fire('change');
  card.children[0].fire('click');
  assert.deepEqual(app.opened[0], ['Slope', 'GN-Math', 'https://photos.tram-gallery.ru/study2/1.html', true, { loadCode: true }]);
  app.nodes.get('games-source-select').value = 'securly';
  app.nodes.get('games-source-select').fire('change');
  app.catalog.launch({ id: oldB });
  assert.equal(app.opened.at(-1)[1], 'Original catalog');
  assert.equal(app.catalog.getState().count, 2);
});

test('a live source refresh retains all alternative sources and merges new duplicate titles', async () => {
  const app = harness(url => Promise.resolve(response(url.startsWith('/') ? fixture : [
    { name: 'SLOPE', url: '{HTML_URL}/new-slope.html' },
    { name: 'Slope', url: '{HTML_URL}/backup-slope.html' }
  ])));
  assert.equal(await app.catalog.open(), 1);
  assert.equal(app.catalog.getState().variants, 3);
  assert.equal(app.catalog.getState().duplicates, 2);
  const card = app.nodes.get('game-list').children[0];
  assert.equal(sourceChooser(card).children.length, 3);
  app.nodes.get('games-source-select').value = 'gn-math';
  app.nodes.get('games-source-select').fire('change');
  app.nodes.get('game-list').children[0].children[0].fire('click');
  assert.equal(app.opened[0][2], 'https://photos.tram-gallery.ru/study2/1.html');
});

test('2048 defaults to its verified Seraph launch while keeping broken upstream alternatives selectable', async () => {
  const data = { version: 1, sources: [
    { id: 'securly', games: [{ name: '2048', url: '{HTML_URL}/114-f.html' }] },
    { id: 'cherri-seraph', games: [{ name: '2048', url: '/seraph/2048/index.html' }] },
    { id: 'cherri-gn-math', games: [{ name: '2048', url: '/gn-math/114-f.html' }] }
  ] };
  const healthy = 'https://h35d5a9.jfs-autoelevadores.com.ar/stores/seraph/2048/index.html';
  const [game] = normalizeGameSnapshot(data);
  assert.equal(game.variants.length, 3);
  assert.equal(game.url, healthy);
  const app = harness(url => Promise.resolve(url.startsWith('/') ? response(data) : new Response('offline', { status: 503 })));
  await app.catalog.open();
  app.catalog.launch({ id: game.id });
  assert.equal(app.opened[0][2], healthy);
  const chooser = sourceChooser(app.nodes.get('game-list').children[0]);
  chooser.value = game.aliases[0];
  chooser.fire('change');
  app.catalog.launch({ id: game.id });
  assert.equal(app.opened[1][2], 'https://cdn.jsdelivr.net/gh/securlycdn/html@main/114-f.html');
  assert.equal(app.opened.length, 2);
});

test('a fast live response waits for the complete snapshot instead of flashing a partial catalog', async () => {
  let finishSnapshot;
  const snapshot = new Promise(resolve => { finishSnapshot = resolve; });
  const app = harness(url => url.startsWith('/') ? snapshot : Promise.resolve(response(fixture.sources[0].games)));
  const pending = app.catalog.open();
  await flush();
  assert.equal(app.catalog.getState().count, 0);
  assert.equal(app.catalog.getState().ready, false);
  assert.equal(app.nodes.get('game-list').firstElementChild.textContent, 'Loading catalog…');
  finishSnapshot(response(fixture));
  assert.equal(await pending, 2);
  assert.equal(app.catalog.getState().variants, 3);
});

test('covers start only inside the visible viewport and retain a placeholder after image failure', async () => {
  const app = harness(url => Promise.resolve(url.startsWith('/') ? response(fixture) : new Response('offline', { status: 503 })));
  app.popover.className = '';
  await app.catalog.open();
  const observer = app.observers[0];
  const [cover] = observer.targets;
  assert(cover);
  assert.equal(observer.options.root, app.nodes.get('game-list'));
  assert.equal(observer.options.rootMargin, '0px');
  assert.equal(cover.loading, 'lazy');
  assert.equal(cover.decoding, 'async');
  assert.equal(cover.width, 320);
  assert.equal(cover.height, 180);
  observer.emit(cover);
  assert.deepEqual(app.imageRequests, []);
  app.popover.className = 'active';
  await app.catalog.open();
  observer.emit(cover, false);
  assert.deepEqual(app.imageRequests, []);
  observer.emit(cover);
  assert.equal(app.imageRequests.length, 1);
  observer.emit(cover);
  assert.equal(app.imageRequests.length, 1);
  const frame = cover.parentNode;
  cover.fire('error');
  assert.equal(frame.children.length, 1);
  assert.equal(frame.children[0].hidden, undefined);
});

test('favorite toggles and unchanged refreshes reuse cards without losing focus, scroll or loaded covers', async () => {
  const app = harness(url => Promise.resolve(url.startsWith('/') ? response(fixture) : response(fixture.sources[0].games)));
  await app.catalog.open();
  const list = app.nodes.get('game-list');
  const first = list.children[0];
  const covered = list.children[1];
  const [cover] = app.observers[0].targets;
  app.observers[0].emit(cover);
  list.scrollTop = 175;
  first.children[1].focus();
  first.children[1].fire('click');
  assert.equal(list.children[0], first);
  assert.equal(app.doc.activeElement, first.children[1]);
  assert.equal(first.children[1].attributes['aria-pressed'], 'true');
  assert.equal(list.scrollTop, 175);
  await app.catalog.refresh();
  assert.equal(list.children[0], first);
  assert.equal(list.children[1], covered);
  assert.equal(app.doc.activeElement, first.children[1]);
  assert.equal(list.scrollTop, 175);
  assert.equal(app.imageRequests.length, 1);
});

test('source controls are built only on demand and choosing a variant keeps the card and keyboard focus', async () => {
  const app = harness(url => Promise.resolve(url.startsWith('/') ? response(fixture) : new Response('offline', { status: 503 })));
  await app.catalog.open();
  const first = app.nodes.get('game-list').children[0];
  const menu = first.children[2];
  assert.equal(menu.children.length, 1);
  const chooser = sourceChooser(first);
  assert.equal(app.doc.activeElement, chooser);
  chooser.value = chooser.children[1].value;
  chooser.fire('change');
  assert.equal(menu.open, false);
  assert.equal(app.doc.activeElement, menu.children[0]);
  app.catalog.render();
  assert.equal(app.nodes.get('game-list').children[0], first);
  first.children[0].fire('click');
  assert.equal(app.opened[0][1], 'GN-Math');
});

test('removing a focused favorite moves focus to the next card while search keeps its input focus', async () => {
  const app = harness(url => Promise.resolve(url.startsWith('/') ? response(fixture) : new Response('offline', { status: 503 })));
  await app.catalog.open();
  const list = app.nodes.get('game-list');
  list.children[0].children[1].fire('click');
  list.children[1].children[1].fire('click');
  app.nodes.get('games-view-select').value = 'favorites';
  app.nodes.get('games-view-select').fire('change');
  const survivor = list.children[1];
  list.children[0].children[1].focus();
  list.children[0].children[1].fire('click');
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0], survivor);
  assert.equal(app.doc.activeElement, survivor.children[1]);
  const search = app.nodes.get('popover-search-input');
  search.focus(); search.value = 'missing'; list.scrollTop = 200;
  app.catalog.render(true);
  assert.equal(app.doc.activeElement, search);
  assert.equal(list.scrollTop, 0);
});

test('lazy image fallback checks actual viewport bounds when IntersectionObserver is unavailable', () => {
  const frames = [];
  let visible = false;
  const container = { addEventListener() {}, getBoundingClientRect: () => ({ top: 100, bottom: 500, left: 0, right: 600 }) };
  const win = { innerHeight: 400, innerWidth: 600, addEventListener() {}, requestAnimationFrame(callback) { frames.push(callback); return frames.length; } };
  const doc = { hidden: false };
  const inside = { getBoundingClientRect: () => ({ top: 150, bottom: 250, left: 50, right: 200, width: 150, height: 100 }) };
  const below = { getBoundingClientRect: () => ({ top: 450, bottom: 550, left: 50, right: 200, width: 150, height: 100 }) };
  const lazy = createLazyGameCovers(win, doc, container, () => visible);
  lazy.add(inside, 'https://example.com/inside.png');
  lazy.add(below, 'https://example.com/below.png');
  assert.equal(frames.length, 0);
  visible = true; lazy.resume(); frames.shift()();
  assert.equal(inside.src, 'https://example.com/inside.png');
  assert.equal(below.src, undefined);
  below.getBoundingClientRect = inside.getBoundingClientRect;
  lazy.resume(); frames.shift()();
  assert.equal(below.src, 'https://example.com/below.png');
});

test('curated genre and controls use explicit cited metadata while unfamiliar titles remain unknown', () => {
  const games = deduplicateGames(normalizeGameEntries([
    { name: '2048', url: '{HTML_URL}/2048.html' },
    { name: 'Hextris', url: '{HTML_URL}/hextris.html' },
    { name: 'HexGL', url: '{HTML_URL}/hexgl.html' },
    { name: 'Basket Random', url: '{HTML_URL}/basket.html' },
    { name: 'Basket Random sequel', url: '{HTML_URL}/sequel.html', genre: 'sports', touch: true },
    { name: 'Unknown Racing Multiplayer', url: '{HTML_URL}/unknown.html', metadata: { genre: 'racing', controller: 'yes' } },
  ], 'securly'));
  assert.equal(selectGames(games, { shelf: 'curated' }).length, 4);
  assert.deepEqual(selectGames(games, { genre: 'puzzle' }).map(game => game.name), ['2048', 'Hextris']);
  assert.deepEqual(selectGames(games, { input: 'controller' }).map(game => game.name), ['HexGL']);
  assert.deepEqual(selectGames(games, { players: 'local' }).map(game => game.name), ['Basket Random']);
  assert.equal(selectGames(games, { players: 'online' }).length, 0);
  assert.equal(selectGames(games, { input: 'touch' }).length, 4);
  assert.equal(selectGames(games, { genre: 'unknown', input: 'unknown' }).length, 2);
  assert.equal(gameMetadata(games.at(-1)).players, 'unknown');
  assert.equal(gameMetadata(games[0]).controller, 'unknown');
  for (const metadata of Object.values(CURATED_GAME_METADATA)) {
    assert(metadata.sources.length > 0);
    for (const source of metadata.sources) assert.equal(new URL(source).protocol, 'https:');
  }
});

test('saved catalog preferences reject forged source URLs and normalize all bounded filter state', () => {
  const data = normalizeGamePreferences({ version: 1, source: 'forged', view: '__proto__', sort: 'fastest', genre: 'guessed', players: 'unlimited', input: 'evil', shelf: 'new', query: 'x'.repeat(300), page: 100000, scrollTop: Infinity,
    selectedSources: { 'game|slope': 'gn-math|https://photos.tram-gallery.ru/study2/1.html', 'game|bad': 'gn-math|https://evil.example/game', 'game|login': 'gn-math|https://user:pass@photos.tram-gallery.ru/game', 'game|local': 'gn-math|javascript:alert(1)', 'bad-id': 'gn-math|https://photos.tram-gallery.ru/game' } });
  assert.equal(data.source, 'all'); assert.equal(data.view, 'all'); assert.equal(data.sort, 'pop');
  assert.equal(data.genre, 'all'); assert.equal(data.players, 'all'); assert.equal(data.input, 'all'); assert.equal(data.shelf, 'all');
  assert.equal(data.query.length, 200); assert.equal(data.page, 10000); assert.equal(data.scrollTop, 0);
  assert.deepEqual(data.selectedSources, { 'game|slope': 'gn-math|https://photos.tram-gallery.ru/study2/1.html' });
  assert.deepEqual(normalizeGamePreferences({ version: 2, query: 'unsupported' }), normalizeGamePreferences(null));
});

test('selected source survives reload and recent reopen ignores unrelated source filters', async () => {
  const fetcher = url => Promise.resolve(url.startsWith('/') ? response(fixture) : new Response('offline', { status: 503 }));
  const app = harness(fetcher);
  await app.catalog.open();
  const card = app.nodes.get('game-list').children[0];
  const chooser = sourceChooser(card);
  chooser.value = 'gn-math|https://photos.tram-gallery.ru/study2/1.html'; chooser.fire('change');
  card.children[0].fire('click');
  const again = harness(fetcher, [...app.storage]);
  await again.catalog.open();
  again.nodes.get('game-list').children[0].children[0].fire('click');
  assert.equal(again.opened.at(-1)[1], 'GN-Math');
  again.nodes.get('games-source-select').value = 'securly'; again.nodes.get('games-source-select').fire('change');
  again.nodes.get('games-continue').fire('click');
  assert.equal(again.opened.at(-1)[1], 'GN-Math');
  assert.equal(again.nodes.get('games-view-select').children[2].textContent, 'Recently opened');
  assert.match(again.nodes.get('games-continue').textContent, /^Reopen: Slope$/);
  assert.equal(again.catalog.rememberSource('https://attacker.example/game'), false);
  assert.equal(again.catalog.rememberSource('https://cdn.jsdelivr.net/gh/securlycdn/html@main/slope.html'), true);
  const saved = JSON.parse(again.storage.get(GAME_PREFERENCES_KEY));
  assert.equal(saved.selectedSources['game|slope'], 'securly|https://cdn.jsdelivr.net/gh/securlycdn/html@main/slope.html');
});

test('query sort page and scroll restore across section visits and a full reload', async () => {
  const large = { version: 1, sources: [{ id: 'securly', games: Array.from({ length: 135 }, (_, index) => ({ name: 'Game ' + String(index).padStart(3, '0'), url: '{HTML_URL}/game-' + index + '.html' })) }] };
  const fetcher = url => Promise.resolve(url.startsWith('/') ? response(large) : new Response('offline', { status: 503 }));
  const app = harness(fetcher);
  await app.catalog.open();
  app.nodes.get('popover-search-input').value = 'Game'; app.nodes.get('popover-sort-select').value = 'za'; app.catalog.render(true);
  app.nodes.get('games-next').fire('click'); app.nodes.get('game-list').scrollTop = 240;
  app.catalog.close();
  app.popover.className = ''; await app.catalog.open();
  assert.equal(app.catalog.getState().page, 2); assert.equal(app.nodes.get('game-list').scrollTop, 240);
  const again = harness(fetcher, [...app.storage]); await again.catalog.open();
  assert.equal(again.nodes.get('popover-search-input').value, 'Game'); assert.equal(again.nodes.get('popover-sort-select').value, 'za');
  assert.equal(again.catalog.getState().page, 2); assert.equal(again.nodes.get('game-list').scrollTop, 240);
  assert.equal(again.nodes.get('game-list').children.length, 60);
});

test('metadata filters and curated shelves persist without tagging unknown games or losing lazy rendering', async () => {
  const data = { version: 1, sources: [{ id: 'securly', games: [
    { name: 'HexGL', url: '{HTML_URL}/hexgl.html' }, { name: 'Basket Random', url: '{HTML_URL}/basket.html' }, { name: 'Unknown Game', url: '{HTML_URL}/unknown.html' }
  ] }] };
  const fetcher = url => Promise.resolve(url.startsWith('/') ? response(data) : new Response('offline', { status: 503 }));
  const app = harness(fetcher); await app.catalog.open();
  const filters = app.nodes.get('games-filters');
  assert.equal(filters.tagName, 'details'); assert(!filters.open);
  assert(filters.contains(app.nodes.get('games-genre-select')));
  assert(filters.contains(app.nodes.get('games-players-select')));
  assert(filters.contains(app.nodes.get('games-input-select')));
  assert(!filters.contains(app.nodes.get('games-source-select')));
  const unknownCard = app.nodes.get('game-list').children.find(card => card.children[0].attributes['aria-label'].includes('Unknown Game'));
  assert.equal(unknownCard.children[0].children[1].children.length, 2);
  assert.match(unknownCard.children[0].attributes['aria-description'], /Genre unknown/);
  app.nodes.get('games-shelf-local').fire('click');
  assert.equal(app.nodes.get('games-filters-label').textContent, 'Filters (1)');
  assert.equal(app.nodes.get('game-list').children.length, 1);
  assert.equal(app.nodes.get('game-list').children[0].children[0].attributes['aria-label'], 'Play Basket Random from Original catalog');
  const again = harness(fetcher, [...app.storage]); await again.catalog.open();
  assert.equal(again.nodes.get('games-players-select').value, 'local');
  assert.equal(again.nodes.get('game-list').children.length, 1);
  again.nodes.get('games-shelf-all').fire('click');
  again.nodes.get('games-input-select').value = 'unknown'; again.nodes.get('games-input-select').fire('change');
  assert.equal(again.nodes.get('game-list').children.length, 1);
  assert.match(again.nodes.get('game-list').children[0].children[0].attributes['aria-label'], /Unknown Game/);
});

test('library import refreshes saved choices without fetching catalogs or writing imported state back', async () => {
  let fetches = 0;
  const app = harness(url => { fetches++; return Promise.resolve(url.startsWith('/') ? response(fixture) : new Response('offline', { status: 503 })); });
  await app.catalog.open(); const before = fetches;
  app.storage.set('mochii.games.favorites.v1', JSON.stringify(['game|slope']));
  const imported = JSON.stringify(normalizeGamePreferences({ version: 1, view: 'favorites', query: 'slope' }));
  app.storage.set(GAME_PREFERENCES_KEY, imported);
  app.winEvents.get('mochii:library-import')({ detail: { keys: [GAME_PREFERENCES_KEY, 'mochii.games.favorites.v1'] } });
  assert.equal(fetches, before); assert.equal(app.nodes.get('game-list').children.length, 1);
  assert.equal(app.nodes.get('games-view-select').value, 'favorites');
  assert.equal(app.nodes.get('popover-search-input').value, 'slope');
  assert.equal(app.storage.get(GAME_PREFERENCES_KEY), imported);
});

test('blocked preference storage preserves usable choices and reports visit-only saving', async () => {
  const app = harness(url => Promise.resolve(url.startsWith('/') ? response(fixture) : new Response('offline', { status: 503 })));
  await app.catalog.open(); app.win.localStorage.setItem = () => { throw new Error('Storage unavailable'); };
  app.nodes.get('games-source-select').value = 'gn-math'; app.nodes.get('games-source-select').fire('change');
  assert.equal(app.nodes.get('game-list').children.length, 1);
  assert.match(app.nodes.get('games-status').textContent, /saved for this visit/);
  app.nodes.get('game-list').children[0].children[0].fire('click');
  assert.equal(app.opened[0][1], 'GN-Math');
});

test('cleared favorites can be undone without losing new selections and focus returns to the controls', async () => {
  const app = harness(url => Promise.resolve(url.startsWith('/') ? response(fixture) : new Response('offline', { status: 503 })));
  await app.catalog.open();
  app.nodes.get('game-list').children[0].children[1].fire('click');
  app.nodes.get('games-view-select').value = 'favorites'; app.nodes.get('games-view-select').fire('change');
  app.nodes.get('games-clear').fire('click');
  assert.deepEqual(app.catalog.getState().favorites, []);
  assert.equal(app.nodes.get('games-undo').hidden, false);
  assert.equal(app.doc.activeElement, app.nodes.get('games-undo'));
  assert.equal(app.nodes.get('games-clear').disabled, true);
  assert.match(app.nodes.get('games-status').textContent, /Favorites cleared/);
  app.nodes.get('games-view-select').value = 'all'; app.nodes.get('games-view-select').fire('change');
  app.nodes.get('game-list').children[1].children[1].fire('click');
  app.nodes.get('games-undo').fire('click');
  assert.deepEqual(app.catalog.getState().favorites, ['game|firstgame', 'game|slope']);
  assert.deepEqual(JSON.parse(app.storage.get('mochii.games.favorites.v1')), ['game|firstgame', 'game|slope']);
  assert.equal(app.nodes.get('games-undo').hidden, true);
  assert.equal(app.doc.activeElement, app.nodes.get('games-view-select'));
});

test('recent clear undo keeps newer opens first and import discards stale undo state', async () => {
  const app = harness(url => Promise.resolve(url.startsWith('/') ? response(fixture) : new Response('offline', { status: 503 })));
  await app.catalog.open(); app.catalog.launch({ id: 'game|slope' });
  app.nodes.get('games-view-select').value = 'recent'; app.nodes.get('games-view-select').fire('change');
  app.nodes.get('games-clear').fire('click');
  assert.equal(app.nodes.get('games-continue').hidden, true);
  app.catalog.launch({ id: 'game|firstgame' }); app.nodes.get('games-undo').fire('click');
  assert.deepEqual(app.catalog.getState().recents, ['game|firstgame', 'game|slope']);
  assert.match(app.nodes.get('games-continue').textContent, /First game/);
  app.nodes.get('games-clear').fire('click');
  app.winEvents.get('mochii:library-import')({ detail: { keys: ['mochii.games.recents.v1'] } });
  assert.equal(app.nodes.get('games-undo').hidden, true);
});

test('confirmed source updates a reused card and existing chooser without losing focus', async () => {
  const app = harness(url => Promise.resolve(url.startsWith('/') ? response(fixture) : new Response('offline', { status: 503 })));
  await app.catalog.open(); const card = app.nodes.get('game-list').children[0]; const chooser = sourceChooser(card);
  assert.equal(app.catalog.rememberSource('https://photos.tram-gallery.ru/study2/1.html'), true);
  assert.equal(chooser.value, 'gn-math|https://photos.tram-gallery.ru/study2/1.html');
  assert.equal(card.children[0].children[1].children[1].textContent, 'GN-Math');
  assert.equal(card.children[0].attributes['aria-label'], 'Play Slope from GN-Math');
  assert.equal(app.doc.activeElement, chooser);
});
