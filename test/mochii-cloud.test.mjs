import test from 'node:test';
import assert from 'node:assert/strict';
import { GAMES } from '../apps/mochii-cloud.data.js';
import { getFigureLaunchUrl, getFigureProxyUrl } from '../apps/mochii-figure.js';
import { STORAGE_KEY, PLAYER_SANDBOX, normalizeState, createStore, createSessionTracker, mountMochii } from '../apps/mochii-cloud.js';

function memoryStorage(initial = null) {
  const entries = new Map(initial === null ? [] : [[STORAGE_KEY, initial]]);
  return {
    entries,
    getItem(key) { return entries.get(key) ?? null; },
    setItem(key, value) { entries.set(key, value); },
    removeItem(key) { entries.delete(key); }
  };
}

const proxyConfig = { proxyOrigin: 'https://proxy.example', shellOrigins: ['https://monkeh.example'] };

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

function harness({ search = '', storage = memoryStorage(), configFetch = async () => proxyConfig } = {}) {
  const nodes = new Map();
  const frames = [];
  const popups = [];
  const configRequests = [];
  const timers = new Map();
  const intervals = new Map();
  const winListeners = new Map();
  const docListeners = new Map();
  let sequence = 0;
  let doc;
  class Node {
    constructor(tag = 'div', id = '') {
      this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.attributes = new Map();
      this.listeners = new Map(); this.value = ''; this.textContent = ''; this.hidden = false;
      this.disabled = false; this.checked = false; this.open = false; this.dataset = {};
      this.style = { setProperty() {} };
      if (tag === 'iframe') frames.push(this);
    }
    append(...children) { this.children.push(...children.flatMap(child => child.tagName === '#FRAGMENT' ? child.children : [child])); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
    fire(type, event = {}) { return Promise.all((this.listeners.get(type) || []).map(listener => listener({ target: this, preventDefault() {}, ...event }))); }
    click() { if (!this.disabled) { this.onclick?.(); return this.fire('click'); } }
    querySelectorAll(selector) { return selector === 'details' ? [] : this.children.filter(child => child.tagName === selector.toUpperCase()); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    showModal() { this.open = true; }
    close() { const wasOpen = this.open; this.open = false; if (wasOpen) this.fire('close'); }
    getContext() { return null; }
    focus() { doc.activeElement = this; }
    select() { this.selected = true; }
  }
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Node(id.endsWith('-dialog') ? 'dialog' : 'div', id)); return nodes.get(id); };
  const nav = ['discover', 'library', 'saved', 'guide', 'settings'].map(view => { const node = new Node('button'); node.dataset.view = view; return node; });
  doc = {
    hidden: false, activeElement: null, documentElement: new Node('html'),
    getElementById: get, createElement: tag => new Node(tag), createDocumentFragment: () => new Node('#fragment'),
    querySelectorAll(selector) { if (selector === '.view') return nav.map(node => get(`view-${node.dataset.view}`)); if (selector === '[data-view]') return nav; return []; },
    addEventListener(type, listener) { docListeners.set(type, listener); }
  };
  const win = {
    localStorage: storage, location: new URL(`https://monkeh.example/apps/mochii-cloud.html${search}`),
    navigator: { getGamepads: () => [] }, URL, AbortController,
    MonkehConfig: { fetchConfig(options = {}) { configRequests.push(options); return configFetch(options); } },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    history: { replaceState() {} }, scrollTo() {},
    setTimeout(fn) { const id = ++sequence; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval(fn) { const id = ++sequence; intervals.set(id, fn); return id; }, clearInterval(id) { intervals.delete(id); },
    requestAnimationFrame() { return ++sequence; }, cancelAnimationFrame() {},
    addEventListener(type, listener) { winListeners.set(type, listener); },
    open(url, target) {
      const popup = { initialUrl: url, target, closed: false, opener: win, location: { replace(value) { popup.url = value; } }, close() { this.closed = true; }, focus() { this.focused = true; } };
      popups.push(popup); return popup;
    }
  };
  get('sort-filter').value = 'catalog';
  const mounted = mountMochii(doc, win);
  return { get, doc, win, mounted, nodes, frames, popups, configRequests, timers, intervals, winListeners, docListeners };
}

test('Mochii preserves all 106 distinct catalog games with usable details', () => {
  assert.equal(GAMES.length, 106);
  assert.equal(new Set(GAMES.map(game => game.id)).size, GAMES.length);
  for (const game of GAMES) {
    for (const field of ['id', 'n', 'dev', 'desc']) assert.equal(typeof game[field], 'string', `${game.id}: ${field}`);
    assert(game.tags.length > 0, game.id);
    assert(game.tags.every(tag => typeof tag === 'string'), game.id);
    for (const profile of [game.rm, game.rr]) {
      for (const field of ['os', 'cpu', 'ram', 'gpu']) assert.equal(typeof profile[field], 'string', `${game.id}: ${field}`);
    }
    assert(Number.isSafeInteger(game.ach) && game.ach >= 0, game.id);
  }
});

test('retained catalog metadata and artwork use HTTPS without embedded credentials', () => {
  const origins = new Map();
  for (const game of GAMES) {
    const url = new URL(game.url);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.username + url.password + url.port, '');
    assert(['https://www.raccoongame.com', 'https://yee.pages.dev'].includes(url.origin), game.id);
    origins.set(url.origin, (origins.get(url.origin) || 0) + 1);
    for (const asset of [game.img, game.bg]) {
      const image = new URL(asset);
      assert.equal(image.protocol, 'https:');
      assert.equal(image.username + image.password, '');
    }
  }
  assert.equal(origins.get('https://www.raccoongame.com'), 105);
  assert.equal(origins.get('https://yee.pages.dev'), 1);
});

test('stored state drops unknown IDs, invalid numbers, forged setup state, and unrecognized settings', () => {
  const state = normalizeState({
    saved: [GAMES[0].id, GAMES[0].id, 'unknown', '__proto__', 117],
    records: { [GAMES[0].id]: { seconds: -4, last: Infinity }, [GAMES[1].id]: { seconds: 1e200, last: 1e200 }, unknown: { seconds: 30, last: 40 } },
    theme: '__proto__', particles: 'unsupported', setupConfirmed: 'true', controller: false
  });
  assert.deepEqual(state.saved, [GAMES[0].id]);
  assert.deepEqual(Object.keys(state.records), [GAMES[0].id, GAMES[1].id]);
  assert.deepEqual(state.records[GAMES[0].id], { seconds: 0, last: 0 });
  assert(Number.isFinite(state.records[GAMES[1].id].seconds));
  assert(state.records[GAMES[1].id].seconds < 1e10);
  assert(!Number.isNaN(new Date(state.records[GAMES[1].id].last).getTime()));
  assert.equal(state.theme, 'dark');
  assert.equal(state.particles, 'none');
  assert.equal(state.setupConfirmed, false);
  assert.equal(state.controller, false);
  assert.equal(normalizeState({ theme: { toString: null } }).theme, 'dark');
  assert.equal(normalizeState({ theme: ['mochii'] }).theme, 'dark');
});

test('corrupt, disabled, and full storage keep a usable in-memory state', () => {
  const unavailable = { getItem() { throw new Error('Denied'); }, setItem() { throw new Error('Quota'); }, removeItem() { throw new Error('Denied'); } };
  for (const storage of [undefined, memoryStorage('{broken'), unavailable]) {
    const store = createStore(storage);
    assert.equal(store.available, false);
    assert.deepEqual(store.value.saved, []);
    store.save({ ...store.value, saved: [GAMES[0].id] });
    assert.deepEqual(store.value.saved, [GAMES[0].id]);
    assert.deepEqual(store.clear().saved, []);
  }
  const storage = memoryStorage();
  storage.entries.set('other-app', 'keep');
  const store = createStore(storage);
  store.save({ ...store.value, saved: [GAMES[1].id], setupConfirmed: true });
  assert.deepEqual(createStore(storage).value.saved, [GAMES[1].id]);
  store.clear();
  assert.equal(storage.entries.get('other-app'), 'keep');
  assert.equal(storage.entries.has(STORAGE_KEY), false);
});

test('session time belongs to the active game and flushes exactly once when a session changes', () => {
  let now = 1000;
  const updates = []; const finished = [];
  const tracker = createSessionTracker({ now: () => now, onUpdate: (session, delta) => updates.push({ id: session.id, delta }), onFinish: session => finished.push(session) });
  assert.equal(tracker.start(GAMES[0].id, 'embed'), true);
  now += 2500;
  tracker.pulse();
  const snapshot = tracker.active;
  snapshot.id = GAMES[1].id;
  now += 1000;
  assert.equal(tracker.start(GAMES[1].id, 'embed'), true);
  assert.deepEqual(updates, [{ id: GAMES[0].id, delta: 2.5 }, { id: GAMES[0].id, delta: 1 }]);
  assert.equal(finished[0].id, GAMES[0].id);
  assert.equal(finished[0].seconds, 3.5);
  now += 500;
  tracker.end(); tracker.end(); tracker.pulse();
  assert.equal(finished.length, 2);
  assert.equal(finished[1].id, GAMES[1].id);
  assert.equal(finished[1].seconds, .5);
  assert.equal(tracker.active, null);
});

test('blocked or closed popups do not replace an active session and closing the real popup ends tracking', () => {
  let now = 0;
  const tracker = createSessionTracker({ now: () => now });
  tracker.start(GAMES[0].id, 'embed');
  for (const popup of [null, { closed: true }]) assert.equal(tracker.start(GAMES[1].id, 'tab', popup), false);
  assert.equal(tracker.active.id, GAMES[0].id);
  const popup = { closed: false };
  assert.equal(tracker.start(GAMES[1].id, 'tab', popup), true);
  now += 1000;
  assert.equal(tracker.pulse().seconds, 1);
  popup.closed = true;
  tracker.pulse();
  assert.equal(tracker.active, null);
});

test('initialization and game deep links render details without launching or pretending authentication', () => {
  for (const search of ['', `?game=${GAMES[0].id}&embed=1`, '?game=unknown']) {
    const app = harness({ search });
    assert.equal(app.frames.length, 0);
    assert.equal(app.popups.length, 0);
    assert.equal(app.intervals.size, 0);
    assert.equal(app.mounted.tracker.active, null);
    assert.equal(app.mounted.store.value.setupConfirmed, false);
    assert.equal(app.get('setup-confirmed').checked, false);
    if (search.includes(GAMES[0].id)) assert.equal(app.get('details-dialog').open, true);
  }
});

test('Figure play opens the local modal immediately and waits for proxy configuration without external navigation', async () => {
  const pending = deferred();
  const app = harness({ configFetch: () => pending.promise });
  const game = GAMES.find(item => item.id === '117');
  app.mounted.openDetails(game.id);
  assert.equal(app.get('launch-figure').disabled, false);
  const launch = app.mounted.launchFigure(game);
  assert.equal(app.get('player-dialog').open, true);
  assert.equal(app.get('details-dialog').open, false);
  assert.match(app.get('player-hint').textContent, /connecting|proxy/i);
  assert.equal(app.frames.length, 0);
  assert.equal(app.mounted.tracker.active, null);
  pending.resolve(proxyConfig);
  await launch;
  const frame = app.get('player-container').children[0];
  assert.equal(frame.src, getFigureProxyUrl(game.id, proxyConfig, app.win.location.origin));
  assert.equal(new URL(frame.src).origin, proxyConfig.proxyOrigin);
  assert.equal(decodeURIComponent(new URL(frame.src).hash.slice(1)), getFigureLaunchUrl(game.id));
  assert.equal(frame.getAttribute('sandbox'), PLAYER_SANDBOX);
  assert.doesNotMatch(frame.getAttribute('sandbox'), /allow-top-navigation|allow-popups/);
  assert.match(frame.getAttribute('sandbox'), /allow-same-origin/);
  assert.match(frame.getAttribute('allow'), /fullscreen/);
  assert.match(frame.getAttribute('allow'), /gamepad/);
  assert.match(frame.getAttribute('allow'), /autoplay/);
  assert.equal(frame.referrerPolicy, 'no-referrer');
  assert.equal(app.mounted.tracker.active.id, game.id);
  assert.equal(app.mounted.tracker.active.mode, 'embed');
  assert.equal(app.mounted.store.value.setupConfirmed, false);
  assert.equal(app.popups.length, 0);
});

test('the Figure button starts only an embedded proxy session', async () => {
  const app = harness();
  app.mounted.openDetails('117');
  await app.get('launch-figure').click();
  await settle();
  assert.equal(app.get('player-container').children.length, 1);
  assert.equal(app.mounted.tracker.active.id, '117');
  assert.equal(app.popups.length, 0);
});

test('unmapped and invalid games cannot launch a guessed provider or open any external tab', async () => {
  const app = harness();
  const unmatched = GAMES.find(game => game.id === 'MC120');
  app.mounted.openDetails('117');
  app.mounted.openDetails(unmatched.id);
  assert.equal(app.get('launch-figure').disabled, true);
  for (const game of [unmatched, null, {}, { id: 'unknown' }, { id: 117 }, { id: '__proto__' }]) await app.mounted.launchFigure(game);
  assert.equal(app.frames.length, 0);
  assert.equal(app.configRequests.length, 0);
  assert.equal(app.popups.length, 0);
  assert.equal(app.mounted.tracker.active, null);
});

test('Figure launch ignores untrusted URL and title metadata and uses the verified catalog identity', async () => {
  const app = harness();
  await app.mounted.launchFigure({ id: '117', url: 'https://evil.example/', n: 'forged title' });
  assert.equal(app.get('player-container').children[0].src, getFigureProxyUrl('117', proxyConfig, app.win.location.origin));
  assert.equal(app.get('player-title').textContent, 'Cyberpunk 2077');
  assert.equal(app.get('session-name').textContent, 'Cyberpunk 2077');
  assert.equal(app.popups.length, 0);
});

test('configuration failures leave a retryable modal without frames or phantom session time', async () => {
  for (const configFetch of [async () => { throw new Error('Configuration unavailable'); },
    async () => ({ proxyOrigin: 'https://monkeh.example', shellOrigins: ['https://monkeh.example'] }),
    async () => ({ proxyOrigin: 'https://proxy.example', shellOrigins: ['https://another-shell.example'] })]) {
    const app = harness({ configFetch });
    await app.mounted.launchFigure(GAMES[0]);
    assert.equal(app.get('player-dialog').open, true);
    assert.equal(app.get('player-retry').hidden, false);
    assert.equal(app.frames.length, 0);
    assert.equal(app.mounted.tracker.active, null);
    assert.deepEqual(app.mounted.store.value.records, {});
    assert.equal(app.popups.length, 0);
    assert.match(app.get('player-hint').textContent, /proxy|configuration|unavailable|cannot|unable|failed|could/i);
  }
});

test('retry keeps the failed player game and succeeds without a new tab', async () => {
  let fail = true;
  const app = harness({ configFetch: async () => { if (fail) throw new Error('Proxy temporarily unavailable'); return proxyConfig; } });
  await app.mounted.launchFigure(GAMES[0]);
  fail = false;
  await app.get('player-retry').click();
  await settle();
  assert.equal(app.get('player-container').children[0].src, getFigureProxyUrl(GAMES[0].id, proxyConfig, app.win.location.origin));
  assert.equal(app.mounted.tracker.active.id, GAMES[0].id);
  assert.equal(app.get('player-retry').hidden, true);
  assert.equal(app.popups.length, 0);
});

test('closing while configuration is pending aborts and prevents late frame resurrection', async () => {
  const pending = deferred();
  const app = harness({ configFetch: () => pending.promise });
  const launch = app.mounted.launchFigure(GAMES[0]);
  assert.equal(app.configRequests.length, 1);
  const signal = app.configRequests[0].signal;
  assert.equal(signal.aborted, false);
  await app.get('player-close').click();
  assert.equal(signal.aborted, true);
  pending.resolve(proxyConfig);
  await launch;
  assert.equal(app.get('player-dialog').open, false);
  assert.equal(app.get('player-container').children.length, 0);
  assert.equal(app.frames.length, 0);
  assert.equal(app.mounted.tracker.active, null);
  assert.deepEqual(app.mounted.store.value.records, {});
});

test('a later launch wins when configuration responses resolve in reverse order', async () => {
  const pending = [deferred(), deferred()];
  let count = 0;
  const app = harness({ configFetch: () => pending[count++].promise });
  const first = app.mounted.launchFigure(GAMES[0]);
  const second = app.mounted.launchFigure(GAMES[1]);
  assert.equal(app.configRequests[0].signal.aborted, true);
  pending[1].resolve(proxyConfig);
  await second;
  pending[0].resolve(proxyConfig);
  await first;
  assert.equal(app.get('player-container').children.length, 1);
  assert.equal(app.frames.length, 1);
  assert.equal(app.get('player-container').children[0].src, getFigureProxyUrl(GAMES[1].id, proxyConfig, app.win.location.origin));
  assert.equal(app.mounted.tracker.active.id, GAMES[1].id);
  assert.equal(app.mounted.store.value.records[GAMES[0].id], undefined);
});

test('late iframe loads and queued old close events cannot revive or end the wrong player', async () => {
  const app = harness();
  await app.mounted.launchFigure(GAMES[0]);
  const oldFrame = app.get('player-container').children[0];
  await app.mounted.launchFigure(GAMES[1]);
  await app.get('player-dialog').fire('close');
  await oldFrame.fire('load');
  assert.equal(app.get('player-dialog').open, true);
  assert.equal(app.mounted.tracker.active.id, GAMES[1].id);
  assert.equal(app.get('player-container').children[0].src, getFigureProxyUrl(GAMES[1].id, proxyConfig, app.win.location.origin));
  await app.get('player-close').click();
  await oldFrame.fire('load');
  assert.equal(app.get('player-dialog').open, false);
  assert.equal(app.get('player-container').children.length, 0);
  assert.equal(app.mounted.tracker.active, null);
  assert.equal(app.intervals.size, 0);
});

test('page exit tears down both pending and active embedded sessions', async () => {
  const active = harness();
  await active.mounted.launchFigure(GAMES[0]);
  active.winListeners.get('pagehide')();
  assert.equal(active.get('player-container').children.length, 0);
  assert.equal(active.mounted.tracker.active, null);
  assert.equal(active.popups.length, 0);
  const pending = deferred();
  const waiting = harness({ configFetch: () => pending.promise });
  const launch = waiting.mounted.launchFigure(GAMES[1]);
  waiting.winListeners.get('pagehide')();
  assert.equal(waiting.configRequests[0].signal.aborted, true);
  pending.resolve(proxyConfig);
  await launch;
  assert.equal(waiting.frames.length, 0);
  assert.equal(waiting.get('player-dialog').open, false);
  assert.equal(waiting.mounted.tracker.active, null);
});
