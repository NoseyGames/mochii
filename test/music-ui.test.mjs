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

function fixture({ fetcher, initialStorage = [], blockStorageWrites = false, mediaSession = null } = {}) {
  const nodes = [];
  const imageRequests = [];
  const observers = [];
  const storage = new Map(initialStorage);
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
    Object.defineProperty(node, 'options', { get: () => tagName === 'select' ? node.children : undefined });
    Object.defineProperty(node, 'src', { get: () => source, set(value) { source = value; if (tagName === 'img') imageRequests.push(value); } });
    Object.defineProperty(node, 'isConnected', { get: () => Boolean(doc?.body?.contains(node)) });
    nodes.push(node);
    return node;
  }
  doc = { ...emitter(), createElement: element, createTextNode: text => { const node = element('#text'); node.textContent = text; return node; }, hidden: false, activeElement: null };
  doc.body = element('body');
  const win = {
    ...emitter(), document: doc, navigator: { mediaSession }, MediaMetadata: class { constructor(data) { Object.assign(this, data); } }, crypto: { randomUUID: () => 'playlist-' + nodes.length },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => { if (blockStorageWrites) throw new Error('Quota exceeded'); storage.set(key, value); } },
    MochiiPrivacy: { get: () => ({ showCovers: true }) },
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
  assert.equal(new URL(audio.src, 'https://mochii.test').searchParams.get('source'), 'qobuz');
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

test('legacy music favorites and playback preferences migrate and later changes use Mochii storage', () => {
  const favorites = JSON.stringify([tracks[1], { ...tracks[0], source: 'invalid' }]);
  const settings = JSON.stringify({ volume: .32, shuffle: true, repeat: 'one' });
  const ui = fixture({ initialStorage: [['monkeh.music.favorites.v1', favorites], ['monkeh.music.player.v1', settings]] });
  assert.equal(ui.win.MonkehMusic, ui.win.MochiiMusic);
  assert.equal(ui.nodes.find(node => node.tagName === 'audio').volume, .32);
  assert.equal(ui.byLabel('Shuffle').getAttribute('aria-pressed'), 'true');
  assert.equal(ui.byLabel('Repeat: off').textContent, 'Repeat: one');
  const collection = ui.byLabel('Music collection');
  collection.value = 'favorites'; collection.fire('change');
  const list = ui.byClass('music-list');
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children[0].getAttribute('aria-label'), 'Play Second Song by Second Artist');
  assert.equal(ui.storage.get('mochii.music.favorites.v1'), favorites);
  assert.equal(ui.storage.get('mochii.music.player.v1'), settings);
  list.children[0].children[1].fire('click');
  assert.equal(ui.storage.get('mochii.music.favorites.v1'), '[]');
  const volume = ui.nodes.find(node => node.tagName === 'input' && node.max === '1');
  volume.value = '.45'; volume.fire('input');
  assert.deepEqual(JSON.parse(ui.storage.get('mochii.music.player.v1')), { volume: .45, shuffle: true, repeat: 'one', remember: false });
  assert.equal(ui.storage.get('monkeh.music.favorites.v1'), favorites);
  assert.equal(ui.storage.get('monkeh.music.player.v1'), settings);
});

test('new music state takes precedence over old favorites and settings', () => {
  const ui = fixture({ initialStorage: [
    ['monkeh.music.favorites.v1', JSON.stringify([tracks[0]])], ['mochii.music.favorites.v1', '[]'],
    ['monkeh.music.player.v1', JSON.stringify({ volume: .2, shuffle: true, repeat: 'one' })],
    ['mochii.music.player.v1', JSON.stringify({ volume: .8, shuffle: false, repeat: 'all' })]
  ] });
  assert.equal(ui.nodes.find(node => node.tagName === 'audio').volume, .8);
  assert.equal(ui.byLabel('Shuffle').getAttribute('aria-pressed'), 'false');
  assert.equal(ui.byLabel('Repeat: off').textContent, 'Repeat: all');
  const collection = ui.byLabel('Music collection'); collection.value = 'favorites'; collection.fire('change');
  assert.equal(ui.byClass('music-list').children[0].className, 'music-empty');
  assert.equal(ui.storage.get('mochii.music.favorites.v1'), '[]');
});

test('blocked migration does not discard old music favorites or playback preferences', () => {
  const ui = fixture({ blockStorageWrites: true, initialStorage: [
    ['monkeh.music.favorites.v1', JSON.stringify([tracks[2]])],
    ['monkeh.music.player.v1', JSON.stringify({ volume: .25, shuffle: true, repeat: 'all' })]
  ] });
  assert.equal(ui.nodes.find(node => node.tagName === 'audio').volume, .25);
  assert.equal(ui.byLabel('Shuffle').getAttribute('aria-pressed'), 'true');
  assert.equal(ui.byLabel('Repeat: off').textContent, 'Repeat: all');
  const collection = ui.byLabel('Music collection'); collection.value = 'favorites'; collection.fire('change');
  assert.equal(ui.byClass('music-list').children[0].children[0].getAttribute('aria-label'), 'Play Third Song by Third Artist');
  assert.equal(ui.storage.has('mochii.music.favorites.v1'), false);
  assert.equal(ui.storage.has('mochii.music.player.v1'), false);
});


test('playlists create, retain source variants, rename and remove tracks without a login', async t => {
  const sourceTracks = [...tracks, { ...tracks[0], id: '4', source: 'qobuz' }];
  const ui = fixture({ fetcher: async url => Response.json(url.startsWith('/browser-tools/') ? { version: 1, tracks: sourceTracks } : { rows: { featured: sourceTracks } }) });
  t.after(() => ui.app.close());
  await ui.app.open(); await tick();
  const name = ui.byLabel('Playlist name'); name.value = 'Road trip'; ui.byLabel('New').fire('click');
  const collection = ui.byLabel('Music collection'); const playlistValue = collection.value;
  assert.match(playlistValue, /^playlist:/);
  assert.equal(name.value, 'Road trip');
  collection.value = 'all'; collection.fire('change');
  const actions = ui.byClass('music-list').children[0].children[2];
  actions.value = 'add:' + playlistValue.slice(9); actions.fire('change');
  let saved = JSON.parse(ui.storage.get('mochii.music.playlists.v1'));
  assert.equal(saved.playlists[0].tracks[0].variants.length, 2);
  collection.value = playlistValue; collection.fire('change');
  assert.equal(ui.byClass('music-status').textContent, '1 track');
  name.value = 'Favorites for driving'; ui.byLabel('Rename').fire('click');
  saved = JSON.parse(ui.storage.get('mochii.music.playlists.v1'));
  assert.equal(saved.playlists[0].name, 'Favorites for driving');
  const remove = ui.byClass('music-list').children[0].children[2]; remove.value = 'remove'; remove.fire('change');
  assert.equal(JSON.parse(ui.storage.get('mochii.music.playlists.v1')).playlists[0].tracks.length, 0);
});

test('favorites save every recording and clearly report storage failures', async t => {
  const sourceTracks = [...tracks, { ...tracks[0], id: '4', source: 'qobuz' }];
  const ui = fixture({ fetcher: async url => Response.json(url.startsWith('/browser-tools/') ? { version: 1, tracks: sourceTracks } : { rows: { featured: sourceTracks } }) });
  t.after(() => ui.app.close()); await ui.app.open(); await tick();
  ui.byClass('music-list').children[0].children[1].fire('click');
  assert.equal(JSON.parse(ui.storage.get('mochii.music.favorites.v1'))[0].variants.length, 2);
  const blocked = fixture({ blockStorageWrites: true }); t.after(() => blocked.app.close()); await blocked.app.open(); await tick();
  blocked.byClass('music-list').children[0].children[1].fire('click');
  assert.equal(blocked.byClass('music-storage-status').hidden, false);
  assert.match(blocked.byClass('music-storage-status').textContent, /Could not save/);
  assert.equal(blocked.byClass('music-list').children[0].children[1].getAttribute('aria-pressed'), 'true');
});

test('remember playback restores paused and opting out removes saved session data', async t => {
  const ui = fixture({ initialStorage: [['mochii.music.player.v1', JSON.stringify({ remember: true, session: { track: tracks[0], queue: tracks, position: 36 } })]] });
  t.after(() => ui.app.close());
  const audio = ui.nodes.find(node => node.tagName === 'audio');
  assert.equal(audio.plays || 0, 0); assert.equal(audio.src, ''); assert.equal(ui.requests.length, 0);
  ui.byLabel('Play or pause music').fire('click'); await tick();
  assert.equal(audio.plays, 1); audio.fire('loadedmetadata'); assert.equal(audio.currentTime, 36);
  const remember = ui.byClass('music-remember').children[0]; remember.checked = false; remember.fire('change');
  const saved = JSON.parse(ui.storage.get('mochii.music.player.v1'));
  assert.equal(saved.remember, false); assert.equal(saved.session, undefined);
});

test('music library imports refresh playlists without replacing active audio', async t => {
  const ui = fixture(); t.after(() => ui.app.close()); await ui.app.open(); await tick();
  ui.byClass('music-list').children[0].children[0].fire('click'); await tick();
  const audio = ui.nodes.find(node => node.tagName === 'audio'); const before = audio.src; const plays = audio.plays;
  ui.storage.set('mochii.music.playlists.v1', JSON.stringify({ version: 1, playlists: [{ id: 'imported', name: 'Imported list', tracks: [tracks[2]] }] }));
  ui.win.fire('mochii:library-import', { detail: { keys: ['mochii.music.playlists.v1'] } });
  assert(ui.byLabel('Music collection').children.some(item => item.textContent === 'Imported list'));
  assert.equal(audio.src, before); assert.equal(audio.plays, plays);
});


test('Media Session controls operate the current player without starting it on mount', async t => {
  const handlers = new Map();
  const session = { setActionHandler: (action, handler) => handlers.set(action, handler), setPositionState() {} };
  const ui = fixture({ mediaSession: session }); t.after(() => ui.app.close());
  const audio = ui.nodes.find(node => node.tagName === 'audio');
  assert.equal(audio.plays || 0, 0); assert.equal(session.playbackState, 'none');
  await ui.app.open(); await tick(); ui.byClass('music-list').children[0].children[0].fire('click'); await tick();
  assert.equal(session.metadata.title, 'First Song'); assert.equal(session.playbackState, 'playing');
  handlers.get('pause')(); assert.equal(session.playbackState, 'paused');
  handlers.get('play')(); await tick(); assert.equal(session.playbackState, 'playing');
  handlers.get('nexttrack')(); await tick(); assert.equal(session.metadata.title, 'Second Song');
  handlers.get('seekto')({ seekTime: 33 }); assert.equal(audio.currentTime, 33);
});


test('imported playback installs a paused queue when idle and survives page persistence', () => {
  const ui = fixture(); const audio = ui.nodes.find(node => node.tagName === 'audio');
  const imported = { remember: true, session: { track: tracks[2], queue: [tracks[2]], position: 51 } };
  ui.storage.set('mochii.music.player.v1', JSON.stringify(imported));
  ui.win.fire('mochii:library-import', { detail: { keys: ['mochii.music.player.v1'] } });
  assert.equal(audio.plays || 0, 0); assert.equal(audio.src, '');
  assert.equal(ui.byClass('music-imported-playback').hidden, true);
  ui.win.fire('pagehide');
  const saved = JSON.parse(ui.storage.get('mochii.music.player.v1'));
  assert.equal(saved.session.track.id, '3'); assert.equal(saved.session.position, 51);
});

test('an imported session cannot be overwritten during active listening until an explicit choice', async t => {
  const ui = fixture(); t.after(() => ui.app.close()); await ui.app.open(); await tick();
  ui.byClass('music-list').children[0].children[0].fire('click'); await tick();
  const audio = ui.nodes.find(node => node.tagName === 'audio'); const original = audio.src; const plays = audio.plays;
  const imported = { remember: true, session: { track: tracks[2], queue: [tracks[2]], position: 51 } };
  ui.storage.set('mochii.music.player.v1', JSON.stringify(imported));
  ui.win.fire('mochii:library-import', { detail: { keys: ['mochii.music.player.v1'] } });
  assert.equal(audio.src, original); assert.equal(audio.plays, plays); assert.equal(ui.byClass('music-imported-playback').hidden, false);
  audio.currentTime = 14; audio.fire('timeupdate'); audio.fire('pause');
  ui.byLabel('Shuffle').fire('click');
  assert.deepEqual(JSON.parse(ui.storage.get('mochii.music.player.v1')), imported);
  ui.byLabel('Use imported playback').fire('click');
  assert.equal(audio.src, ''); assert.equal(audio.plays, plays); assert.equal(ui.byClass('music-imported-playback').hidden, true);
  ui.win.fire('pagehide');
  const saved = JSON.parse(ui.storage.get('mochii.music.player.v1'));
  assert.equal(saved.session.track.id, '3'); assert.equal(saved.session.position, 51);
});

test('keeping current playback explicitly replaces a pending imported session', async t => {
  const ui = fixture(); t.after(() => ui.app.close()); await ui.app.open(); await tick();
  ui.byClass('music-list').children[0].children[0].fire('click'); await tick();
  const audio = ui.nodes.find(node => node.tagName === 'audio'); audio.currentTime = 19;
  const imported = { remember: true, session: { track: tracks[2], queue: [tracks[2]], position: 51 } };
  ui.storage.set('mochii.music.player.v1', JSON.stringify(imported));
  ui.win.fire('mochii:library-import', { detail: { keys: ['mochii.music.player.v1'] } });
  ui.byLabel('Keep current playback').fire('click');
  const saved = JSON.parse(ui.storage.get('mochii.music.player.v1'));
  assert.equal(saved.session.track.id, '1'); assert.equal(saved.session.position, 19);
  assert.equal(ui.byClass('music-imported-playback').hidden, true);
});
