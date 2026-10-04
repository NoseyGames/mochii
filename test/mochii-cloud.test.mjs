import test from 'node:test';
import assert from 'node:assert/strict';
import { GAMES } from '../apps/mochii-cloud.data.js';
import { getFigureLaunchUrl } from '../apps/mochii-figure.js';
import { STORAGE_KEY, PLAYER_SANDBOX, validateLaunchUrl, normalizeState, createStore, createSessionTracker, buildEmbedCode, mountMochii } from '../apps/mochii-cloud.js';

function memoryStorage(initial = null) {
  const entries = new Map(initial === null ? [] : [[STORAGE_KEY, initial]]);
  return {
    entries,
    getItem(key) { return entries.get(key) ?? null; },
    setItem(key, value) { entries.set(key, value); },
    removeItem(key) { entries.delete(key); }
  };
}

function harness({ search = '', popupBlocked = false, storage = memoryStorage() } = {}) {
  const nodes = new Map();
  const frames = [];
  const popups = [];
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
    navigator: { getGamepads: () => [] }, URL,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    history: { replaceState() {} }, scrollTo() {},
    setTimeout(fn) { const id = ++sequence; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval(fn) { const id = ++sequence; intervals.set(id, fn); return id; }, clearInterval(id) { intervals.delete(id); },
    requestAnimationFrame() { return ++sequence; }, cancelAnimationFrame() {},
    addEventListener(type, listener) { winListeners.set(type, listener); },
    open(url, target) {
      if (popupBlocked) return null;
      const popup = { initialUrl: url, target, closed: false, opener: win, location: { replace(value) { popup.url = value; } }, close() { this.closed = true; }, focus() { this.focused = true; } };
      popups.push(popup); return popup;
    }
  };
  get('sort-filter').value = 'catalog';
  const mounted = mountMochii(doc, win);
  return { get, doc, win, mounted, nodes, frames, popups, timers, intervals, winListeners, docListeners };
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

test('catalog navigation remains on the original HTTPS game providers without credentials', () => {
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

test('launch validation rejects scheme, credentials, origin confusion, and shell-origin providers', () => {
  for (const game of GAMES) assert.equal(validateLaunchUrl(game.url, 'https://monkeh.example'), new URL(game.url).href);
  for (const input of [null, '', '/game', '//www.raccoongame.com/', 'javascript:alert(1)', 'data:text/html,hello', 'http://www.raccoongame.com/', 'https://www.raccoongame.com.evil.example/', 'https://evil.example/?https://www.raccoongame.com', 'https://user:pass@www.raccoongame.com/', 'https://www.raccoongame.com:8443/', 'https://raccoongame.com/', 'https://yee.pages.dev.evil.example/', 'https://monkeh.example/']) {
    assert.equal(validateLaunchUrl(input, 'https://monkeh.example'), null, String(input));
  }
  assert.equal(validateLaunchUrl(GAMES[0].url, 'https://www.raccoongame.com'), null);
});

test('embed output escapes attribute data and isolates allowed external navigation', () => {
  const code = buildEmbedCode({ url: GAMES[0].url, n: '\"><script>alert(1)</script>' }, 'https://monkeh.example');
  assert.match(code, /^<iframe\s/);
  assert.match(code, /&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(code, /referrerpolicy="no-referrer"/);
  assert.doesNotMatch(code, /<script|eval\(|javascript:|allow-top-navigation|allow-popups/);
  assert.match(code, new RegExp(`sandbox="${PLAYER_SANDBOX}"`));
  assert.equal(buildEmbedCode({ url: 'https://evil.example/', n: 'Bad' }), '');
  assert.equal(buildEmbedCode(GAMES[0], 'https://www.raccoongame.com'), '');
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

test('blocked popup leaves the selected game open and records no phantom session', async () => {
  const app = harness({ popupBlocked: true });
  app.mounted.openDetails(GAMES[0].id);
  await app.get('launch-tab').click();
  assert.equal(app.get('details-dialog').open, true);
  assert.equal(app.mounted.tracker.active, null);
  assert.deepEqual(app.mounted.store.value.records, {});
  assert.match(app.get('toast').textContent, /blocked/i);
});

test('new-tab launch removes the opener and stays attached to its own game when another detail is selected', async () => {
  const app = harness();
  app.mounted.openDetails(GAMES[0].id);
  await app.get('launch-tab').click();
  assert.equal(app.popups[0].opener, null);
  assert.equal(app.popups[0].url, GAMES[0].url);
  app.mounted.openDetails(GAMES[1].id);
  assert.equal(app.get('detail-title').textContent, GAMES[1].n);
  assert.equal(app.mounted.tracker.active.id, GAMES[0].id);
  await app.get('session-return').click();
  assert.equal(app.popups[0].focused, true);
  app.popups[0].closed = true;
  for (const pulse of [...app.intervals.values()]) pulse();
  assert.equal(app.mounted.tracker.active, null);
  assert.equal(app.intervals.size, 0);
});

test('Figure handoff uses the mapped game and removes its opener without claiming game readiness', async () => {
  const app = harness();
  const game = GAMES.find(game => game.id === '117');
  app.mounted.openDetails(game.id);
  assert.equal(app.get('launch-figure').hidden, false);
  assert.equal(app.get('launch-figure').disabled, false);
  assert.match(app.get('detail-provider').textContent, /Figure.*setup and queues/);
  assert.equal(app.popups.length, 0);
  await app.get('launch-figure').click();
  assert.equal(app.popups[0].url, getFigureLaunchUrl(game.id));
  assert.equal(app.popups[0].opener, null);
  assert.equal(app.frames.length, 0);
  assert.equal(app.mounted.store.value.setupConfirmed, false);
  assert.match(app.get('toast').textContent, /including loading and queues/);
  app.mounted.openDetails(GAMES.find(other => other.id !== game.id).id);
  await app.get('session-return').click();
  assert.equal(app.popups[0].focused, true);
  assert.equal(app.mounted.tracker.active.id, game.id);
});

test('Figure popup blocking preserves details, an active original tab, and existing activity', async () => {
  const app = harness();
  const game = GAMES.find(game => game.id === '117');
  app.mounted.openGameTab(game);
  const before = JSON.stringify(app.mounted.store.value.records);
  app.win.open = () => null;
  app.mounted.openDetails('209');
  await app.get('launch-figure').click();
  assert.equal(app.get('details-dialog').open, true);
  assert.equal(app.mounted.tracker.active.id, game.id);
  assert.equal(JSON.stringify(app.mounted.store.value.records), before);
  assert.match(app.get('toast').textContent, /blocked/i);
});

test('unmapped games retain original launch actions and never open a guessed Figure link', async () => {
  const app = harness();
  const game = GAMES.find(game => game.id === 'MC120');
  app.mounted.openDetails('117');
  app.mounted.openDetails(game.id);
  assert.equal(app.get('launch-figure').hidden, true);
  assert.equal(app.get('launch-figure').disabled, true);
  assert.equal(app.get('launch-tab').className, 'button primary');
  app.mounted.openFigureTab(game);
  assert.equal(app.popups.length, 0);
  await app.get('launch-tab').click();
  assert.equal(app.popups[0].url, game.url);
});

test('Figure navigation ignores supplied URL metadata and rejects unknown game identities', () => {
  const app = harness();
  for (const game of [null, {}, { id: 'unknown' }, { id: 117 }, { id: '__proto__' }]) app.mounted.openFigureTab(game);
  assert.equal(app.popups.length, 0);
  app.mounted.openFigureTab({ id: '117', url: 'https://evil.example/', n: 'wrong game' });
  assert.equal(app.popups[0].url, getFigureLaunchUrl('117'));
  assert.equal(app.get('session-name').textContent, 'Cyberpunk 2077');
});

test('failed Figure navigation closes only its empty popup and does not start tracking', () => {
  const app = harness();
  let closed = false;
  app.win.open = () => ({ opener: app.win, location: { replace() { throw new Error('Navigation failed'); } }, close() { closed = true; } });
  app.mounted.openDetails('117');
  app.mounted.openFigureTab(GAMES.find(game => game.id === '117'));
  assert.equal(closed, true);
  assert.equal(app.mounted.tracker.active, null);
  assert.equal(app.get('details-dialog').open, true);
  assert.deepEqual(app.mounted.store.value.records, {});
});

test('closing an embedded player before load removes its frame and prevents delayed resurrection', async () => {
  const app = harness();
  app.mounted.openDetails(GAMES[0].id);
  await app.get('launch-embed').click();
  const frame = app.get('player-container').children[0];
  assert.equal(frame.src, GAMES[0].url);
  assert.equal(frame.getAttribute('sandbox'), PLAYER_SANDBOX);
  assert.equal(frame.referrerPolicy, 'no-referrer');
  assert.equal(app.mounted.tracker.active.id, GAMES[0].id);
  await app.get('player-close').click();
  await frame.fire('load');
  for (const callback of [...app.timers.values()]) callback();
  assert.equal(app.get('player-container').children.length, 0);
  assert.equal(app.get('player-dialog').open, false);
  assert.equal(app.mounted.tracker.active, null);
  assert.equal(app.intervals.size, 0);
});

test('a queued close from an old player does not terminate its replacement or open the selected wrong game', async () => {
  const app = harness();
  app.mounted.openDetails(GAMES[0].id);
  app.mounted.launchEmbedded(GAMES[0]);
  app.mounted.launchEmbedded(GAMES[1]);
  await app.get('player-dialog').fire('close');
  assert.equal(app.mounted.tracker.active.id, GAMES[1].id);
  assert.equal(app.get('player-container').children[0].src, GAMES[1].url);
  await app.get('player-newtab').click();
  assert.equal(app.popups[0].url, GAMES[1].url);
  assert.equal(app.mounted.tracker.active.id, GAMES[1].id);
  assert.equal(app.mounted.tracker.active.mode, 'tab');
  assert.equal(app.get('player-container').children.length, 0);
});

test('page exit tears down player and tracking without closing an external user tab', () => {
  const embedded = harness();
  embedded.mounted.launchEmbedded(GAMES[0]);
  embedded.winListeners.get('pagehide')();
  assert.equal(embedded.get('player-container').children.length, 0);
  assert.equal(embedded.mounted.tracker.active, null);
  const external = harness();
  external.mounted.openGameTab(GAMES[0]);
  external.winListeners.get('pagehide')();
  assert.equal(external.mounted.tracker.active, null);
  assert.equal(external.popups[0].closed, false);
});
