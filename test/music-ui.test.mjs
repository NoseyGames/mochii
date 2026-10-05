import test from 'node:test';
import assert from 'node:assert/strict';
import { mountMusicCatalog } from '../browser-tools/music-catalog.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const tracks = [
  { id: '1', title: 'First Song', artist: 'First Artist', source: 'tidal', artwork: 'https://resources.tidal.com/images/first.jpg' },
  { id: '2', title: 'Second Song', artist: 'Second Artist', source: 'tidal', artwork: 'https://resources.tidal.com/images/second.jpg' },
  { id: '3', title: 'Third Song', artist: 'Third Artist', source: 'qobuz', artwork: 'https://static.qobuz.com/images/third.jpg' }
];

function emitter() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    fire(type, event = {}) { for (const listener of listeners.get(type) || []) listener({ target: this, preventDefault() {}, ...event }); }
  };
}

function fixture({ fetcher } = {}) {
  const nodes = [];
  const imageRequests = [];
  const observers = [];
  const storage = new Map();
  const requests = [];
  let doc;
  function element(tagName) {
    let source = '';
    const node = {
      ...emitter(), tagName, children: [], attributes: {}, dataset: {}, className: '', textContent: '', parentNode: null,
      value: '', hidden: false, disabled: false, open: false, scrollTop: 0, volume: .7, currentTime: 0, duration: 120,
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return name === 'src' ? source || null : this.attributes[name] ?? null; },
      removeAttribute(name) { if (name === 'src') source = ''; else delete this.attributes[name]; },
      toggleAttribute(name, force) { if (force) this.attributes[name] = ''; else delete this.attributes[name]; },
      contains(target) { return target === this || this.children.some(child => child.contains(target)); },
      append(...children) { for (const child of children) this.insertBefore(child, null); },
      prepend(...children) { for (const child of [...children].reverse()) this.insertBefore(child, this.children[0] || null); },
      insertBefore(child, before) {
        if (child === before) return;
        if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(item => item !== child);
        const index = this.children.indexOf(before);
        if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
        child.parentNode = this;
        if (this.tagName === 'select' && this.children.length === 1) this.value = child.value;
      },
      remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        if (this.contains(doc?.activeElement)) doc.activeElement = doc.body;
        this.parentNode = null;
      },
      replaceChildren(...children) { [...this.children].forEach(child => child.remove()); this.append(...children); },
      querySelectorAll(selector) { return this.children.flatMap(child => [...(selector.startsWith('.') && child.classList.contains(selector.slice(1)) ? [child] : []), ...child.querySelectorAll(selector)]); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      closest(selector) { return selector.startsWith('.') && this.classList.contains(selector.slice(1)) ? this : this.parentNode?.closest(selector) || null; },
      focus() { doc.activeElement = this; },
      showModal() { this.open = true; },
      close() { if (this.open) { this.open = false; this.fire('close'); } },
      async play() { this.plays = (this.plays || 0) + 1; this.fire('playing'); },
      pause() { this.fire('pause'); },
      load() { this.fire('emptied'); }
    };
    node.classList = {
      contains: name => node.className.split(/\s+/).includes(name),
      add(...names) { node.className = [...new Set([...node.className.split(/\s+/).filter(Boolean), ...names])].join(' '); }
    };
    Object.defineProperty(node, 'src', { get: () => source, set(value) { source = value; if (tagName === 'img') imageRequests.push(value); } });
    Object.defineProperty(node, 'isConnected', { get: () => Boolean(doc?.body?.contains(node)) });
    nodes.push(node);
    return node;
  }
  doc = { ...emitter(), createElement: element, hidden: false, activeElement: null };
  doc.body = element('body');
  const win = {
    ...emitter(), document: doc,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    MonkehPrivacy: { get: () => ({ showCovers: true }) },
    fetch: async (url, options) => {
      requests.push(url);
      if (fetcher) return fetcher(url, options);
      return Response.json(url.startsWith('/browser-tools/') ? { version: 1, tracks } : { rows: { featured: tracks } });
    },
    IntersectionObserver: class {
      constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); this.observed = []; observers.push(this); }
      observe(target) { this.targets.add(target); this.observed.push(target); }
      unobserve(target) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
      emit(target, isIntersecting = true) { this.callback([{ target, isIntersecting }]); }
    }
  };
  const app = mountMusicCatalog(win, doc, { resolveApi: path => path });
  const byClass = name => nodes.find(node => node.classList.contains(name));
  const byLabel = label => nodes.find(node => node.attributes['aria-label'] === label);
  return { app, doc, win, requests, imageRequests, observers, storage, nodes, byClass, byLabel };
}

test('music favorite toggles retain the same row, focus, scroll and already loaded artwork', async t => {
  const ui = fixture(); t.after(() => ui.app.close());
  await ui.app.open(); await tick();
  const list = ui.byClass('music-list');
  const row = list.children[0];
  const favorite = row.children[1];
  const artwork = row.children[0].children[0];
  ui.observers[0].emit(artwork);
  favorite.focus(); list.scrollTop = 140;
  favorite.fire('click');
  assert.equal(list.children[0], row);
  assert.equal(ui.doc.activeElement, favorite);
  assert.equal(list.scrollTop, 140);
  assert.equal(favorite.getAttribute('aria-pressed'), 'true');
  assert.equal(ui.imageRequests.length, 1);
  favorite.fire('click');
  assert.equal(list.children[0], row);
  assert.equal(ui.doc.activeElement, favorite);
  assert.equal(favorite.getAttribute('aria-pressed'), 'false');
  assert.equal(ui.imageRequests.length, 1);
});

test('music artwork waits for intersection and pending covers are observed again after closing and reopening', async t => {
  const ui = fixture(); t.after(() => ui.app.close());
  await ui.app.open(); await tick();
  const observer = ui.observers[0];
  const images = ui.byClass('music-list').children.map(row => row.children[0].children[0]);
  assert.equal(observer.options.root, ui.byClass('music-list'));
  assert.equal(observer.options.rootMargin, '0px');
  assert.equal(ui.imageRequests.length, 0);
  observer.emit(images[0], false);
  assert.equal(ui.imageRequests.length, 0);
  observer.emit(images[0]);
  assert.equal(ui.imageRequests.length, 1);
  assert.equal(images[0].decoding, 'async');
  assert.equal(images[0].width, 42);
  ui.app.close();
  assert.equal(observer.targets.size, 0);
  observer.emit(images[1]);
  assert.equal(ui.imageRequests.length, 1);
  await ui.app.open();
  assert(observer.targets.has(images[1]));
  assert(observer.targets.has(images[2]));
  assert.equal(observer.targets.has(images[0]), false);
  observer.emit(images[1]);
  assert.equal(ui.imageRequests.length, 2);
});

test('music reuses matching rows as source filtering changes the preferred recording', async t => {
  const sourceTracks = [...tracks, { ...tracks[0], id: '4', source: 'qobuz', artist: 'Alternate Artist' }];
  const ui = fixture({ fetcher: async url => Response.json(url.startsWith('/browser-tools/') ? { version: 1, tracks: sourceTracks } : { rows: { featured: sourceTracks } }) });
  t.after(() => ui.app.close());
  await ui.app.open(); await tick();
  const row = ui.byClass('music-list').children[0];
  const source = ui.byLabel('Filter music source');
  source.value = 'qobuz'; source.fire('change');
  assert.equal(ui.byClass('music-list').children[0], row);
  assert.equal(row.children[0].getAttribute('aria-label'), 'Play First Song by Alternate Artist');
  row.children[0].fire('click'); await tick();
  const audio = ui.nodes.find(node => node.tagName === 'audio');
  assert.equal(new URL(audio.src, 'https://monkeh.test').searchParams.get('source'), 'qobuz');
});

test('removing a focused music favorite chooses a neighboring favorite, then the search input', async t => {
  const ui = fixture(); t.after(() => ui.app.close());
  await ui.app.open(); await tick();
  const list = ui.byClass('music-list');
  list.children[0].children[1].fire('click');
  list.children[1].children[1].fire('click');
  const collection = ui.byLabel('Music collection');
  collection.value = 'favorites'; collection.fire('change');
  const nextFavorite = list.children[1].children[1];
  list.children[0].children[1].focus();
  list.children[0].children[1].fire('click');
  assert.equal(list.children.length, 1);
  assert.equal(ui.doc.activeElement, nextFavorite);
  nextFavorite.fire('click');
  assert.equal(ui.doc.activeElement, ui.byLabel('Search music'));
  assert.equal(list.children[0].className, 'music-empty');
});

test('closing during the first snapshot load can reopen into a fresh discovery request', async t => {
  let resolveSnapshot;
  const pendingSnapshot = new Promise(resolve => { resolveSnapshot = resolve; });
  const ui = fixture({ fetcher: async url => url.startsWith('/browser-tools/') ? pendingSnapshot : Response.json({ rows: { featured: tracks } }) });
  t.after(() => ui.app.close());
  const firstOpen = ui.app.open();
  ui.app.close();
  resolveSnapshot(Response.json({ version: 1, tracks }));
  await firstOpen;
  assert.equal(ui.byClass('music-list').children[0].className, 'music-empty');
  await ui.app.open(); await tick();
  assert.equal(ui.requests.filter(url => url === '/api/music/browse').length, 1);
  assert.equal(ui.byClass('music-list').children.length, 3);
  assert.equal(ui.byClass('music-list').children[0].dataset.key, 'firstsong');
});
