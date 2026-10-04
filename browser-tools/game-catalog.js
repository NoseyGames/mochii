const REFERENCE_ORIGIN = 'https://photos.tram-gallery.ru';
const CDN_ORIGIN = 'https://cdn.jsdelivr.net';
const HTML_BASE = CDN_ORIGIN + '/gh/securlycdn/html@main/';
const COVER_BASE = CDN_ORIGIN + '/gh/securlycdn/covers@main/';

export const GAME_SOURCES = Object.freeze([
  { id: 'securly', label: 'Original catalog', manifest: CDN_ORIGIN + '/gh/securlycdn/assets/zones.json', base: HTML_BASE, origins: [CDN_ORIGIN], live: true },
  { id: 'gn-math', label: 'GN-Math', manifest: REFERENCE_ORIGIN + '/mc4d5af1.json', base: REFERENCE_ORIGIN + '/', origins: [REFERENCE_ORIGIN] },
  { id: 'seraph', label: 'Seraph', manifest: REFERENCE_ORIGIN + '/m882f408.json', base: REFERENCE_ORIGIN + '/', origins: [REFERENCE_ORIGIN] },
  { id: 'hydra', label: 'Hydra', manifest: REFERENCE_ORIGIN + '/m8f04680.json', base: REFERENCE_ORIGIN + '/', origins: [CDN_ORIGIN] },
  { id: '3kh0', label: '3kh0', manifest: REFERENCE_ORIGIN + '/mf113660.json', base: REFERENCE_ORIGIN + '/', origins: [CDN_ORIGIN] },
  { id: 'ports', label: 'Truffled', manifest: REFERENCE_ORIGIN + '/m630d80d.json', base: REFERENCE_ORIGIN + '/', origins: [REFERENCE_ORIGIN] },
  { id: 'tglsc', label: 'TGLSC', manifest: REFERENCE_ORIGIN + '/m576e992.json', base: REFERENCE_ORIGIN + '/', origins: [REFERENCE_ORIGIN] }
].map(source => Object.freeze({ ...source, origins: Object.freeze(source.origins) })));

const SOURCE_BY_ID = new Map(GAME_SOURCES.map(source => [source.id, source]));
const FAVORITES_KEY = 'monkeh.games.favorites.v1';
const RECENTS_KEY = 'monkeh.games.recents.v1';
const PAGE_SIZE = 60;
const MAX_BYTES = 4 * 1024 * 1024;
const FEATURED = ['Coffee Talk', 'A Difficult Game About Climbing', 'Basketball Stars', 'Drive Mad', 'Slope', 'Geometry Dash', 'Minecraft 1.12.2', 'Minecraft 1.8.8', 'Vex 8'];

function safeUrl(value, source, cover = false) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return '';
  const expanded = value.replaceAll('{HTML_URL}', HTML_BASE.slice(0, -1)).replaceAll('{COVER_URL}', COVER_BASE.slice(0, -1));
  try {
    const url = new URL(expanded, source.base);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    if (!(cover ? [REFERENCE_ORIGIN, CDN_ORIGIN] : source.origins).includes(url.origin)) return '';
    return url.href;
  } catch { return ''; }
}

export function normalizeGameEntries(entries, sourceId) {
  const source = SOURCE_BY_ID.get(sourceId);
  if (!source || !Array.isArray(entries)) return [];
  const games = [];
  const seen = new Set();
  for (const entry of entries.slice(0, 10000)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 200) : '';
    if (!name || /^\[!\]|suggest games|discord\.gg\//i.test(name)) continue;
    const url = safeUrl(entry.url, source);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    games.push({
      id: source.id + '|' + url, name, url, source: source.id,
      cover: safeUrl(entry.cover || entry.image, source, true),
      author: typeof entry.author === 'string' ? entry.author.trim().slice(0, 200) : ''
    });
  }
  return games;
}

export function normalizeGameSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.sources)) return [];
  const groups = new Map();
  for (const group of snapshot.sources.slice(0, GAME_SOURCES.length)) {
    if (group && SOURCE_BY_ID.has(group.id) && !groups.has(group.id)) groups.set(group.id, normalizeGameEntries(group.games, group.id));
  }
  return GAME_SOURCES.flatMap(source => groups.get(source.id) || []);
}

export function selectGames(games, { query = '', source = 'all', view = 'all', sort = 'pop', favorites = [], recents = [] } = {}) {
  const search = String(query).trim().toLocaleLowerCase().slice(0, 200);
  const saved = new Set(favorites);
  const recent = new Map(recents.map((id, index) => [id, index]));
  const list = games.filter(game => (source === 'all' || game.source === source)
    && (view !== 'favorites' || saved.has(game.id)) && (view !== 'recent' || recent.has(game.id))
    && (!search || [game.name, game.author, SOURCE_BY_ID.get(game.source)?.label || ''].some(value => value.toLocaleLowerCase().includes(search))));
  if (view === 'recent') list.sort((a, b) => recent.get(a.id) - recent.get(b.id));
  else if (sort === 'az' || sort === 'za') list.sort((a, b) => a.name.localeCompare(b.name) * (sort === 'za' ? -1 : 1));
  else {
    const rank = name => { const index = FEATURED.findIndex(value => value.toLowerCase() === name.toLowerCase()); return index < 0 ? FEATURED.length : index; };
    list.sort((a, b) => rank(a.name) - rank(b.name));
  }
  return list;
}

export function gamePage(games, page = 1, size = PAGE_SIZE) {
  const pageSize = Number.isInteger(size) ? Math.max(1, Math.min(100, size)) : PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(games.length / pageSize));
  const current = Number.isInteger(page) ? Math.max(1, Math.min(pages, page)) : 1;
  return { page: current, pages, items: games.slice((current - 1) * pageSize, current * pageSize) };
}

export async function fetchGameJson(fetcher, url, { signal } = {}) {
  const response = await fetcher(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error('Catalog returned HTTP ' + response.status + '.');
  const contentType = response.headers?.get('content-type') || '';
  if (contentType && !/\bjson\b/i.test(contentType)) throw new Error('Catalog did not return JSON.');
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) throw new Error('Catalog is too large.');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error('Catalog is too large.');
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('Catalog is too large.');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

export function createGameCatalog(win, doc) {
  let games = [];
  let filtered = [];
  let page = 1;
  let loading = null;
  let ready = false;
  let bound = false;
  let favorites = readList(FAVORITES_KEY, 500);
  let recents = readList(RECENTS_KEY, 50);
  const node = id => doc.getElementById(id);

  function readList(key, limit) {
    try {
      const stored = JSON.parse(win.localStorage.getItem(key) || '[]');
      return Array.isArray(stored) ? [...new Set(stored.filter(id => typeof id === 'string' && id.length <= 4200))].slice(0, limit) : [];
    } catch { return []; }
  }

  function saveList(key, value) {
    try { win.localStorage.setItem(key, JSON.stringify(value)); }
    catch { if (node('games-status')) node('games-status').textContent = 'Saved for this visit. Browser storage is unavailable.'; }
  }

  function launch(game) {
    const known = games.find(item => item.id === game?.id);
    if (!known) return;
    recents = [known.id, ...recents.filter(id => id !== known.id)].slice(0, 50);
    saveList(RECENTS_KEY, recents);
    return win.openViewer?.(known.name, SOURCE_BY_ID.get(known.source).label, known.url, true);
  }

  function toggleFavorite(game) {
    favorites = favorites.includes(game.id) ? favorites.filter(id => id !== game.id) : [game.id, ...favorites].slice(0, 500);
    saveList(FAVORITES_KEY, favorites);
    render();
  }

  function element(tag, className, text) {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function render(resetPage = false) {
    const container = node('game-list');
    if (!container) return;
    if (resetPage) page = 1;
    filtered = selectGames(games, { query: node('popover-search-input')?.value, source: node('games-source-select')?.value || 'all',
      view: node('games-view-select')?.value || 'all', sort: node('popover-sort-select')?.value, favorites, recents });
    const slice = gamePage(filtered, page);
    page = slice.page;
    const fragment = doc.createDocumentFragment();
    if (!slice.items.length) fragment.appendChild(element('div', 'loading-text', ready ? 'No games match these filters.' : 'Loading catalog…'));
    const saved = new Set(favorites);
    for (const game of slice.items) {
      const item = element('div', 'game-item');
      const launchButton = element('button', 'game-launch');
      launchButton.type = 'button';
      launchButton.setAttribute('aria-label', 'Play ' + game.name + ' from ' + SOURCE_BY_ID.get(game.source).label);
      launchButton.addEventListener('click', () => launch(game));
      if (game.cover && win.MonkehPrivacy?.get().showCovers !== false) {
        const cover = element('img', 'game-cover');
        cover.src = game.cover;
        cover.alt = '';
        cover.loading = 'lazy';
        cover.decoding = 'async';
        cover.referrerPolicy = 'no-referrer';
        cover.addEventListener('error', () => cover.remove(), { once: true });
        launchButton.appendChild(cover);
      }
      const info = element('span', 'game-info');
      info.appendChild(element('span', 'game-title', game.name));
      info.appendChild(element('span', 'game-author', SOURCE_BY_ID.get(game.source).label + (game.author ? ' · ' + game.author : '')));
      launchButton.appendChild(info);
      const star = element('button', 'game-favorite', saved.has(game.id) ? '★' : '☆');
      star.type = 'button';
      star.setAttribute('aria-label', (saved.has(game.id) ? 'Remove ' : 'Add ') + game.name + (saved.has(game.id) ? ' from favorites' : ' to favorites'));
      star.setAttribute('aria-pressed', String(saved.has(game.id)));
      star.addEventListener('click', () => toggleFavorite(game));
      item.append(launchButton, star);
      fragment.appendChild(item);
    }
    container.replaceChildren(fragment);
    if (node('games-status')) node('games-status').textContent = `${filtered.length.toLocaleString()} of ${games.length.toLocaleString()} games · Source versions are listed separately`;
    if (node('games-page')) node('games-page').textContent = `Page ${page} of ${slice.pages}`;
    if (node('games-prev')) node('games-prev').disabled = page <= 1;
    if (node('games-next')) node('games-next').disabled = page >= slice.pages;
    if (node('games-random')) node('games-random').disabled = !filtered.length;
    if (node('games-clear')) node('games-clear').disabled = !['favorites', 'recent'].includes(node('games-view-select')?.value);
  }

  function installControls() {
    const list = node('game-list');
    if (!list?.parentNode || node('games-source-select')) return;
    const controls = element('div', 'controls-row game-catalog-controls');
    const source = element('select', 'modal-sort-select');
    source.id = 'games-source-select';
    source.setAttribute('aria-label', 'Game source');
    const view = element('select', 'modal-sort-select');
    view.id = 'games-view-select';
    view.setAttribute('aria-label', 'Game collection');
    for (const [value, label] of [['all', 'All games'], ['favorites', 'Favorites'], ['recent', 'Recently played']]) {
      const option = element('option', '', label);
      option.value = value;
      view.appendChild(option);
    }
    controls.append(source, view);
    for (const [id, label] of [['games-random', 'Random game'], ['games-refresh', 'Refresh'], ['games-clear', 'Clear list']]) {
      const button = element('button', 'catalog-button', label);
      button.type = 'button';
      button.id = id;
      controls.appendChild(button);
    }
    const status = element('p', 'catalog-status');
    status.id = 'games-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const footer = element('div', 'controls-row catalog-pagination');
    for (const [id, label] of [['games-prev', 'Previous'], ['games-page', 'Page 1 of 1'], ['games-next', 'Next']]) {
      const child = element(id === 'games-page' ? 'span' : 'button', id === 'games-page' ? 'catalog-page' : 'catalog-button', label);
      child.id = id;
      if (id !== 'games-page') child.type = 'button';
      footer.appendChild(child);
    }
    list.parentNode.insertBefore(controls, list);
    list.parentNode.insertBefore(status, list);
    list.parentNode.insertBefore(footer, list.nextSibling);
  }

  function bind() {
    if (bound) return;
    bound = true;
    installControls();
    const source = node('games-source-select');
    if (source) {
      source.replaceChildren(element('option', '', 'All sources'), ...GAME_SOURCES.map(item => { const option = element('option', '', item.label); option.value = item.id; return option; }));
      source.firstElementChild.value = 'all';
      source.addEventListener('change', () => render(true));
    }
    node('games-view-select')?.addEventListener('change', () => render(true));
    node('games-random')?.addEventListener('click', () => { if (filtered.length) launch(filtered[Math.floor(Math.random() * filtered.length)]); });
    node('games-prev')?.addEventListener('click', () => { page--; render(); node('game-list')?.scrollTo?.({ top: 0 }); });
    node('games-next')?.addEventListener('click', () => { page++; render(); node('game-list')?.scrollTo?.({ top: 0 }); });
    node('games-refresh')?.addEventListener('click', () => refresh());
    node('games-clear')?.addEventListener('click', () => {
      const view = node('games-view-select')?.value;
      if (view === 'favorites') { favorites = []; saveList(FAVORITES_KEY, favorites); }
      if (view === 'recent') { recents = []; saveList(RECENTS_KEY, recents); }
      render(true);
    });
  }

  async function refresh() {
    if (loading) return loading;
    loading = (async () => {
      if (node('games-status')) node('games-status').textContent = 'Loading catalogs…';
      let base = games;
      const live = new Map();
      const publish = () => {
        const next = new Map(base.map(game => [game.id, game]));
        for (const [source, entries] of live) {
          for (const [id, game] of next) if (game.source === source) next.delete(id);
          for (const game of entries) next.set(game.id, game);
        }
        games = [...next.values()];
        ready = games.length > 0;
        render();
      };
      const outcomes = await Promise.allSettled([
        fetchGameJson(win.fetch.bind(win), '/browser-tools/game-catalog.json', { signal: AbortSignal.timeout(10000) }).then(data => {
          const snapshot = normalizeGameSnapshot(data);
          if (!snapshot.length) throw new Error('Saved catalogs are empty.');
          base = snapshot;
          publish();
        }),
        ...GAME_SOURCES.filter(source => source.live).map(source => fetchGameJson(win.fetch.bind(win), source.manifest, { signal: AbortSignal.timeout(8000) }).then(entries => {
          const normalized = normalizeGameEntries(entries, source.id);
          if (!normalized.length) throw new Error('Source catalog is empty.');
          live.set(source.id, normalized);
          publish();
        }))
      ]);
      if (!ready) render();
      if (!ready && node('games-status')) node('games-status').textContent = 'Catalogs could not be loaded. Use Refresh to try again.';
      else if (outcomes[0].status === 'rejected' && node('games-status')) node('games-status').textContent += ' · Some sources are temporarily unavailable.';
      return games.length;
    })().finally(() => { loading = null; });
    return loading;
  }

  function open() {
    bind();
    render();
    return ready ? Promise.resolve(games.length) : refresh();
  }

  return Object.freeze({ open, refresh, render, launch, getState: () => ({ count: games.length, ready, page, favorites: [...favorites], recents: [...recents] }) });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.MonkehGames = createGameCatalog(window, document);
  window.renderGames = () => window.MonkehGames.render(true);
}
