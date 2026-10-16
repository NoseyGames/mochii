import { normalizeCatalogTitle } from './catalog-identity.js';
import { readDisplayText } from './display-text.js';
import { readMigratedStorage } from './storage.js';

const REFERENCE_ORIGIN = 'https://photos.tram-gallery.ru';
const CHERRI_ORIGIN = 'https://h35d5a9.jfs-autoelevadores.com.ar';
const CKV_ORIGIN = 'https://wanocapy.github.io';
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
  { id: 'tglsc', label: 'TGLSC', manifest: REFERENCE_ORIGIN + '/m576e992.json', base: REFERENCE_ORIGIN + '/', origins: [REFERENCE_ORIGIN] },
  ...[
    ['ckv', 'CKV'], ['seraph', 'Seraph'], ['truffled', 'Truffled'], ['ugs', 'UGS'], ['gn-math', 'GN-Math']
  ].map(([id, label]) => ({ id: 'cherri-' + id, label: 'Cherri · ' + label,
    manifest: CHERRI_ORIGIN + '/assets/json/' + id + '.json', file: 'cherri-' + id + '.json',
    base: CHERRI_ORIGIN + '/', origins: id === 'ckv' ? [CKV_ORIGIN] : [CHERRI_ORIGIN], cherri: true }))
].map(source => Object.freeze({ ...source, origins: Object.freeze(source.origins) })));

const SOURCE_BY_ID = new Map(GAME_SOURCES.map(source => [source.id, source]));
const FAVORITES_KEY = 'mochii.games.favorites.v1';
const RECENTS_KEY = 'mochii.games.recents.v1';
const PAGE_SIZE = 60;
const MAX_BYTES = 4 * 1024 * 1024;
const FEATURED = ['Coffee Talk', 'A Difficult Game About Climbing', 'Basketball Stars', 'Drive Mad', 'Slope', 'Geometry Dash', 'Minecraft 1.12.2', 'Minecraft 1.8.8', 'Vex 8'];
const FEATURED_RANK = new Map(FEATURED.map((name, index) => [normalizeCatalogTitle(name), index]));
const BROKEN_2048_URLS = new Set([
  HTML_BASE + '114-f.html', REFERENCE_ORIGIN + '/study2/114-f.html', CHERRI_ORIGIN + '/stores/gn-math/114-f.html'
]);
const VERIFIED_2048_URL = CHERRI_ORIGIN + '/stores/seraph/2048/index.html';
export const GAME_PREFERENCES_KEY = 'mochii.games.preferences.v1';
export const GAME_GENRES = Object.freeze({ puzzle: 'Puzzle', racing: 'Racing', sports: 'Sports' });
const unknownMetadata = Object.freeze({ genre: 'unknown', players: 'unknown', touch: 'unknown', controller: 'unknown', sources: Object.freeze([]) });
export const CURATED_GAME_METADATA = Object.freeze({
  '2048': Object.freeze({ genre: 'puzzle', players: 'unknown', touch: 'yes', controller: 'unknown', sources: Object.freeze(['https://github.com/gabrielecirulli/2048', 'https://raw.githubusercontent.com/gabrielecirulli/2048/master/js/keyboard_input_manager.js']) }),
  hextris: Object.freeze({ genre: 'puzzle', players: 'unknown', touch: 'yes', controller: 'unknown', sources: Object.freeze(['https://github.com/Hextris/hextris', 'https://raw.githubusercontent.com/Hextris/hextris/gh-pages/js/input.js']) }),
  hexgl: Object.freeze({ genre: 'racing', players: 'unknown', touch: 'yes', controller: 'yes', sources: Object.freeze(['https://hexgl.bkcore.com/', 'https://raw.githubusercontent.com/BKcore/HexGL/master/bkcore/hexgl/ShipControls.js']) }),
  basketrandom: Object.freeze({ genre: 'sports', players: 'local', touch: 'yes', controller: 'unknown', sources: Object.freeze(['https://www.twoplayergames.org/game/basket-random']) }),
});

export function gameMetadata(game) {
  return Object.hasOwn(CURATED_GAME_METADATA, game?.titleKey) ? CURATED_GAME_METADATA[game.titleKey] : unknownMetadata;
}

export function normalizeGamePreferences(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) && input.version === 1 ? input : {};
  const choice = (key, allowed, fallback) => allowed.includes(value[key]) ? value[key] : fallback;
  const selectedSources = {};
  if (value.selectedSources && typeof value.selectedSources === 'object' && !Array.isArray(value.selectedSources)) {
    for (const [id, variant] of Object.entries(value.selectedSources).slice(0, 500)) {
      if (!/^game\|[\p{L}\p{N}+.]{1,500}$/u.test(id) || typeof variant !== 'string' || variant.length > 4200) continue;
      const separator = variant.indexOf('|');
      const source = SOURCE_BY_ID.get(variant.slice(0, separator));
      if (source && safeUrl(variant.slice(separator + 1), source) === variant.slice(separator + 1)) selectedSources[id] = variant;
    }
  }
  return {
    version: 1, source: choice('source', ['all', ...SOURCE_BY_ID.keys()], 'all'),
    view: choice('view', ['all', 'favorites', 'recent'], 'all'), sort: choice('sort', ['pop', 'az', 'za'], 'pop'),
    query: typeof value.query === 'string' ? value.query.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) : '',
    genre: choice('genre', ['all', ...Object.keys(GAME_GENRES), 'unknown'], 'all'),
    players: choice('players', ['all', 'local', 'online', 'unknown'], 'all'),
    input: choice('input', ['all', 'touch', 'controller', 'unknown'], 'all'),
    shelf: choice('shelf', ['all', 'curated'], 'all'),
    page: Number.isInteger(value.page) ? Math.min(10000, Math.max(1, value.page)) : 1,
    scrollTop: typeof value.scrollTop === 'number' && Number.isFinite(value.scrollTop) ? Math.min(10000000, Math.max(0, value.scrollTop)) : 0,
    selectedSources,
  };
}

function safeUrl(value, source, cover = false) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return '';
  let expanded = value.replaceAll('{HTML_URL}', HTML_BASE.slice(0, -1)).replaceAll('{COVER_URL}', COVER_BASE.slice(0, -1));
  if (source.cherri && !cover && expanded.startsWith('/') && !expanded.startsWith('/stores/')) expanded = '/stores' + expanded;
  if (source.cherri && cover && expanded.startsWith('/img/')) expanded = '/covers/' + expanded.slice(5);
  try {
    const url = new URL(expanded, source.base);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    if (!(cover ? [REFERENCE_ORIGIN, CHERRI_ORIGIN, CKV_ORIGIN, CDN_ORIGIN] : source.origins).includes(url.origin)) return '';
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
      cover: safeUrl(entry.cover || entry.image || entry.img, source, true),
      author: typeof entry.author === 'string' ? entry.author.trim().slice(0, 200) : '',
      titleKey: normalizeCatalogTitle(name)
    });
  }
  return games;
}

export function snapshotGameEntries(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.sources)) return [];
  const groups = new Map();
  for (const group of snapshot.sources.slice(0, GAME_SOURCES.length)) {
    if (group && SOURCE_BY_ID.has(group.id) && !groups.has(group.id)) groups.set(group.id, normalizeGameEntries(group.games, group.id));
  }
  return GAME_SOURCES.flatMap(source => groups.get(source.id) || []);
}

export function deduplicateGames(entries) {
  const unique = new Map();
  for (const entry of entries) {
    const titleKey = entry.titleKey || normalizeCatalogTitle(entry.name);
    if (!titleKey) continue;
    let game = unique.get(titleKey);
    if (!game) {
      game = { ...entry, id: 'game|' + titleKey, titleKey, aliases: [], variants: [], sources: [],
        searchText: '', rank: FEATURED_RANK.get(titleKey) ?? FEATURED.length,
        variantIds: new Set(), sourceIds: new Set(), searchParts: new Set() };
      unique.set(titleKey, game);
    }
    if (game.variantIds.has(entry.id)) continue;
    game.variantIds.add(entry.id);
    game.aliases.push(entry.id);
    game.variants.push(entry);
    if (!game.sourceIds.has(entry.source)) { game.sourceIds.add(entry.source); game.sources.push(entry.source); }
    if (!game.cover && entry.cover) game.cover = entry.cover;
    for (const value of [entry.name, entry.author, SOURCE_BY_ID.get(entry.source)?.label || '']) if (value) game.searchParts.add(value.toLowerCase());
  }
  return [...unique.values()].map(game => {
    if (game.titleKey === '2048' && game.variants.some(variant => BROKEN_2048_URLS.has(variant.url))) {
      const index = game.variants.findIndex(variant => variant.url === VERIFIED_2048_URL);
      if (index > 0) {
        const [preferred] = game.variants.splice(index, 1);
        game.variants.unshift(preferred);
        Object.assign(game, { url: preferred.url, source: preferred.source, cover: preferred.cover || game.cover });
      }
    }
    game.searchText = [...game.searchParts].join('\n');
    delete game.variantIds;
    delete game.sourceIds;
    delete game.searchParts;
    return game;
  });
}

export function normalizeGameSnapshot(snapshot) {
  return deduplicateGames(snapshotGameEntries(snapshot));
}

export function selectGames(games, { query = '', source = 'all', view = 'all', sort = 'pop', favorites = [], recents = [], genre = 'all', players = 'all', input = 'all', shelf = 'all' } = {}) {
  const search = String(query).trim().toLowerCase().slice(0, 200);
  const searchKey = normalizeCatalogTitle(search);
  const saved = new Set(favorites);
  const recent = new Map(recents.map((id, index) => [id, index]));
  const list = games.filter(game => (source === 'all' || game.sources.includes(source))
    && (view !== 'favorites' || saved.has(game.id) || game.aliases.some(id => saved.has(id)))
    && (view !== 'recent' || recent.has(game.id) || game.aliases.some(id => recent.has(id)))
    && (genre === 'all' || gameMetadata(game).genre === genre)
    && (players === 'all' || gameMetadata(game).players === players)
    && (input === 'all' || (input === 'unknown' ? gameMetadata(game).touch === 'unknown' && gameMetadata(game).controller === 'unknown' : gameMetadata(game)[input] === 'yes'))
    && (shelf !== 'curated' || Object.hasOwn(CURATED_GAME_METADATA, game.titleKey))
    && (!search || game.searchText.includes(search) || (searchKey && game.titleKey.includes(searchKey))));
  for (const game of list) if (view === 'recent' && !recent.has(game.id)) recent.set(game.id, Math.min(...game.aliases.filter(id => recent.has(id)).map(id => recent.get(id))));
  if (view === 'recent') list.sort((a, b) => recent.get(a.id) - recent.get(b.id));
  else if (sort === 'az' || sort === 'za') list.sort((a, b) => a.name.localeCompare(b.name) * (sort === 'za' ? -1 : 1));
  else {
    list.sort((a, b) => a.rank - b.rank);
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

export function createLazyGameCovers(win, doc, container, isVisible) {
  const pending = new Map();
  let frame = null;
  const load = image => {
    const url = pending.get(image);
    if (!url || !isVisible() || doc.hidden) return;
    pending.delete(image);
    observer?.unobserve(image);
    image.src = url;
  };
  const observer = typeof win.IntersectionObserver === 'function' ? new win.IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) load(entry.target);
  }, { root: container, rootMargin: '0px', threshold: 0.01 }) : null;
  const check = () => {
    frame = null;
    if (!isVisible() || doc.hidden) return;
    const bounds = container.getBoundingClientRect?.();
    if (!bounds) return;
    for (const image of pending.keys()) {
      const rect = image.getBoundingClientRect?.();
      if (rect && rect.width > 0 && rect.height > 0 && rect.bottom > Math.max(0, bounds.top) && rect.top < Math.min(win.innerHeight || Infinity, bounds.bottom)
        && rect.right > Math.max(0, bounds.left) && rect.left < Math.min(win.innerWidth || Infinity, bounds.right)) load(image);
    }
  };
  const schedule = () => {
    if (frame !== null || !pending.size || !isVisible() || doc.hidden) return;
    frame = win.requestAnimationFrame ? win.requestAnimationFrame(check) : win.setTimeout(check, 16);
  };
  if (!observer) { container.addEventListener('scroll', schedule, { passive: true }); win.addEventListener?.('resize', schedule, { passive: true }); }
  const api = {
    add(image, url) { pending.set(image, url); if (observer) observer.observe(image); else schedule(); },
    remove(image) { pending.delete(image); observer?.unobserve(image); },
    resume() {
      if (!isVisible() || doc.hidden) return;
      if (observer) for (const image of pending.keys()) { observer.unobserve(image); observer.observe(image); }
      else schedule();
    },
    pause() {
      observer?.disconnect();
      if (frame !== null) {
        if (win.cancelAnimationFrame) win.cancelAnimationFrame(frame);
        else win.clearTimeout?.(frame);
        frame = null;
      }
    }
  };
  doc.addEventListener?.('visibilitychange', () => { if (doc.hidden) api.pause(); else api.resume(); });
  win.addEventListener?.('pagehide', () => api.pause());
  win.addEventListener?.('pageshow', () => api.resume());
  return api;
}

export function createGameCatalog(win, doc) {
  let games = [];
  let rawGames = [];
  let gameIndex = new Map();
  let aliasIndex = new Map();
  function readPreferences() {
    try { return normalizeGamePreferences(JSON.parse(win.localStorage.getItem(GAME_PREFERENCES_KEY) || '{}')); }
    catch { return normalizeGamePreferences(null); }
  }
  let preferences = readPreferences();
  const preferredVariants = new Map(Object.entries(preferences.selectedSources));
  const cards = new Map();
  let covers;
  let catalogRevision = 0;
  let favoritesRevision = 0;
  let recentsRevision = 0;
  let filterSignature = '';
  let filtered = [];
  let page = preferences.page;
  let restoredScroll = preferences.scrollTop;
  let saveTimer;
  let saveFailed = false;
  let restoring = false;
  let clearedList = null;
  let loading = null;
  let ready = false;
  let bound = false;
  let favorites = readList(FAVORITES_KEY, 500);
  let recents = readList(RECENTS_KEY, 50);
  const node = id => doc.getElementById?.(id);

  function currentPreferences() {
    return normalizeGamePreferences({ version: 1, page, scrollTop: restoredScroll ?? node('game-list')?.scrollTop ?? 0,
      query: node('popover-search-input')?.value ?? preferences.query,
      sort: node('popover-sort-select')?.value || preferences.sort,
      source: node('games-source-select')?.value || preferences.source,
      view: node('games-view-select')?.value || preferences.view,
      genre: node('games-genre-select')?.value || preferences.genre,
      players: node('games-players-select')?.value || preferences.players,
      input: node('games-input-select')?.value || preferences.input,
      shelf: preferences.shelf, selectedSources: Object.fromEntries(preferredVariants) });
  }

  function savePreferences() {
    if (saveTimer !== undefined) win.clearTimeout?.(saveTimer);
    saveTimer = undefined;
    preferences = currentPreferences();
    try { win.localStorage.setItem(GAME_PREFERENCES_KEY, JSON.stringify(preferences)); if (saveFailed) { saveFailed = false; updateStatus(); } }
    catch { saveFailed = true; updateStatus(); }
  }

  function scheduleSave() {
    if (!ready || restoring) return;
    if (win.setTimeout) {
      if (saveTimer !== undefined) win.clearTimeout?.(saveTimer);
      saveTimer = win.setTimeout(savePreferences, 200);
    } else savePreferences();
  }

  function applyPreferences() {
    for (const [id, key] of [['popover-search-input', 'query'], ['popover-sort-select', 'sort'], ['games-source-select', 'source'], ['games-view-select', 'view'], ['games-genre-select', 'genre'], ['games-players-select', 'players'], ['games-input-select', 'input']]) {
      if (node(id)) node(id).value = preferences[key];
    }
    page = preferences.page;
    restoredScroll = preferences.scrollTop;
    filterSignature = '';
  }

  function readList(key, limit) {
    try {
      const stored = JSON.parse(readMigratedStorage(win.localStorage, key, key === FAVORITES_KEY ? 'monkeh.games.favorites.v1' : 'monkeh.games.recents.v1') || '[]');
      return Array.isArray(stored) ? [...new Set(stored.filter(id => typeof id === 'string' && id.length <= 4200))].slice(0, limit) : [];
    } catch { return []; }
  }

  function saveList(key, value) {
    try { win.localStorage.setItem(key, JSON.stringify(value)); }
    catch { if (node('games-status')) node('games-status').textContent = 'Saved for this visit. Browser storage is unavailable.'; }
  }

  function activeVariant(game, resume = false) {
    const source = resume ? 'all' : node('games-source-select')?.value || 'all';
    const variants = source === 'all' ? game.variants : game.variants.filter(item => item.source === source);
    return variants.find(item => item.id === preferredVariants.get(game.id)) || variants[0] || game.variants[0];
  }

  function launch(game, resume = false) {
    const known = gameIndex.get(game?.id) || gameIndex.get(aliasIndex.get(game?.id));
    if (!known) return;
    recents = [known.id, ...recents.filter(id => id !== known.id)].slice(0, 50);
    recentsRevision++;
    saveList(RECENTS_KEY, recents);
    const variant = activeVariant(known, resume);
    preferredVariants.delete(known.id);
    preferredVariants.set(known.id, variant.id);
    if (preferredVariants.size > 500) preferredVariants.delete(preferredVariants.keys().next().value);
    savePreferences();
    updateContinue();
    return win.openViewer?.(known.name, SOURCE_BY_ID.get(variant.source).label, variant.url, true, { loadCode: true });
  }

  function updateContinue() {
    const recent = recents.map(id => gameIndex.get(id) || gameIndex.get(aliasIndex.get(id))).find(Boolean);
    const button = node('games-continue');
    if (button) { button.hidden = !recent; button.disabled = !recent; button.textContent = recent ? 'Reopen: ' + recent.name : 'Recently opened'; button.title = 'Reopen the last game. Saved game progress is managed by that game.'; }
  }

  function rememberSource(url) {
    if (typeof url !== 'string') return false;
    for (const game of games) {
      const variant = game.variants.find(entry => entry.url === url);
      if (!variant) continue;
      preferredVariants.delete(game.id);
      preferredVariants.set(game.id, variant.id);
      if (preferredVariants.size > 500) preferredVariants.delete(preferredVariants.keys().next().value);
      savePreferences();
      const card = cards.get(game.id);
      if (card) updateSource(card);
      return true;
    }
    return false;
  }

  function toggleFavorite(game) {
    favorites = favorites.includes(game.id) ? favorites.filter(id => id !== game.id) : [game.id, ...favorites].slice(0, 500);
    favoritesRevision++;
    saveList(FAVORITES_KEY, favorites);
    const card = cards.get(game.id);
    if (card) updateFavorite(card, favorites.includes(game.id));
    if (node('games-view-select')?.value === 'favorites') render();
  }

  function element(tag, className, text) {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function updateFavorite(card, saved) {
    card.star.textContent = saved ? '★' : '☆';
    card.star.setAttribute('aria-label', (saved ? 'Remove ' : 'Add ') + card.game.name + (saved ? ' from favorites' : ' to favorites'));
    card.star.setAttribute('aria-pressed', String(saved));
  }

  function updateSource(card) {
    const selected = activeVariant(card.game);
    const label = SOURCE_BY_ID.get(selected.source).label;
    card.launchButton.setAttribute('aria-label', 'Play ' + card.game.name + ' from ' + label);
    card.sourceLabel.textContent = label;
    if (card.chooser) card.chooser.value = selected.id;
  }

  function createCard(game, sourceFilter, showCovers) {
    const variant = activeVariant(game);
    const item = element('div', 'game-item');
    const launchButton = element('button', 'game-launch');
    launchButton.type = 'button';
    launchButton.setAttribute('aria-label', 'Play ' + game.name + ' from ' + SOURCE_BY_ID.get(variant.source).label);
    launchButton.addEventListener('click', () => launch(game));
    const coverFrame = element('span', 'game-cover-frame');
    coverFrame.setAttribute('aria-hidden', 'true');
    const placeholder = element('span', 'game-cover-placeholder', game.name.split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase());
    coverFrame.appendChild(placeholder);
    let cover;
    if (game.cover && showCovers) {
      cover = element('img', 'game-cover');
      cover.alt = '';
      cover.width = 320;
      cover.height = 180;
      cover.loading = 'lazy';
      cover.decoding = 'async';
      cover.referrerPolicy = 'no-referrer';
      cover.addEventListener('load', () => { placeholder.hidden = true; cover.setAttribute('data-loaded', ''); }, { once: true });
      cover.addEventListener('error', () => { covers?.remove(cover); cover.remove(); }, { once: true });
      coverFrame.appendChild(cover);
    }
    launchButton.appendChild(coverFrame);
    const info = element('span', 'game-info');
    info.appendChild(element('span', 'game-title', game.name));
    const sourceLabel = element('span', 'game-author', SOURCE_BY_ID.get(variant.source).label);
    info.appendChild(sourceLabel);
    const metadata = gameMetadata(game);
    const description = `${GAME_GENRES[metadata.genre] || 'Genre unknown'}. Multiplayer: ${metadata.players === 'local' ? 'local two-player documented' : metadata.players}. Touch: ${metadata.touch === 'yes' ? 'documented' : 'unknown'}. Controller: ${metadata.controller === 'yes' ? 'documented' : 'unknown'}. Mirror compatibility may vary.`;
    info.title = description;
    launchButton.setAttribute('aria-description', description);
    if (GAME_GENRES[metadata.genre]) info.appendChild(element('span', 'game-tags', GAME_GENRES[metadata.genre]));
    launchButton.appendChild(info);
    const star = element('button', 'game-favorite');
    star.type = 'button';
    star.addEventListener('click', () => toggleFavorite(game));
    item.append(launchButton, star);
    const card = { game, item, star, launchButton, cover, sourceLabel, sourceFilter, showCovers };
    updateFavorite(card, favorites.includes(game.id));
    const variants = sourceFilter === 'all' ? game.variants : game.variants.filter(entry => entry.source === sourceFilter);
    if (variants.length > 1) {
      const menu = element('details', 'game-source-menu');
      const summary = element('summary', '', '⋯');
      summary.setAttribute('aria-label', 'Choose source for ' + game.name);
      summary.title = 'Choose source';
      menu.appendChild(summary);
      menu.addEventListener('toggle', () => {
        if (!menu.open || card.chooser) return;
        const chooser = element('select', 'game-source-choice');
        chooser.setAttribute('aria-label', 'Source for ' + game.name);
        const sourceCounts = new Map();
        for (const entry of variants) {
          const count = (sourceCounts.get(entry.source) || 0) + 1;
          sourceCounts.set(entry.source, count);
          const option = element('option', '', SOURCE_BY_ID.get(entry.source).label + (count > 1 ? ' · alternate ' + count : ''));
          option.value = entry.id;
          chooser.appendChild(option);
        }
        chooser.value = activeVariant(game).id;
        chooser.addEventListener('change', () => {
          preferredVariants.set(game.id, chooser.value);
          if (preferredVariants.size > 500) preferredVariants.delete(preferredVariants.keys().next().value);
          savePreferences();
          updateSource(card);
          menu.open = false;
          summary.focus?.({ preventScroll: true });
        });
        card.chooser = chooser;
        menu.appendChild(chooser);
        chooser.focus?.({ preventScroll: true });
      });
      item.appendChild(menu);
      card.summary = summary;
    }
    return card;
  }

  function render(resetPage = false) {
    const container = node('game-list');
    if (!container) return;
    covers ||= createLazyGameCovers(win, doc, container, () => !node('games-popover') || node('games-popover').classList.contains('active'));
    const source = node('games-source-select')?.value || 'all';
    const view = node('games-view-select')?.value || 'all';
    const query = node('popover-search-input')?.value || '';
    const sort = node('popover-sort-select')?.value || 'pop';
    const genre = node('games-genre-select')?.value || 'all';
    const players = node('games-players-select')?.value || 'all';
    const input = node('games-input-select')?.value || 'all';
    const shelf = preferences.shelf;
    const signature = JSON.stringify([catalogRevision, query, source, view, sort, genre, players, input, shelf, view === 'favorites' ? favoritesRevision : 0, view === 'recent' ? recentsRevision : 0]);
    if (signature !== filterSignature) {
      filtered = selectGames(games, { query, source, view, sort, favorites, recents, genre, players, input, shelf });
      filterSignature = signature;
    }
    if (resetPage) { page = 1; restoredScroll = null; }
    const slice = gamePage(filtered, page);
    if (ready) page = slice.page;
    const showCovers = win.MochiiPrivacy?.get().showCovers !== false;
    const desired = new Set(slice.items.map(game => game.id));
    const saved = new Set(favorites);
    const scrollTop = container.scrollTop || 0;
    let focusGame;
    let focusAction;
    let focusIndex = 0;
    let previousIndex = 0;
    for (const [id, card] of cards) {
      if (card.item.contains?.(doc.activeElement)) {
        focusGame = id;
        focusAction = doc.activeElement === card.star ? 'star' : doc.activeElement === card.launchButton ? 'launchButton' : 'summary';
        focusIndex = previousIndex;
      }
      previousIndex++;
      const nextGame = gameIndex.get(id);
      if (!desired.has(id) || card.game !== nextGame || card.sourceFilter !== source || card.showCovers !== showCovers) {
        if (card.cover) covers.remove(card.cover);
        card.item.remove();
        cards.delete(id);
      }
    }
    if (!slice.items.length) {
      if (container.children.length !== 1 || container.firstElementChild?.className !== 'loading-text') container.replaceChildren(element('div', 'loading-text'));
      container.firstElementChild.textContent = ready ? 'No games match these filters.' : 'Loading catalog…';
    } else {
      if (container.firstElementChild?.className === 'loading-text') container.replaceChildren();
      slice.items.forEach((game, index) => {
        let card = cards.get(game.id);
        if (!card) { card = createCard(game, source, showCovers); cards.set(game.id, card); }
        updateFavorite(card, saved.has(game.id));
        updateSource(card);
        if (container.children[index] !== card.item) container.insertBefore(card.item, container.children[index] || null);
        if (card.cover && !card.coverQueued) { covers.add(card.cover, game.cover); card.coverQueued = true; }
      });
    }
    container.scrollTop = resetPage ? 0 : ready && restoredScroll !== null ? restoredScroll : scrollTop;
    if (ready) restoredScroll = null;
    if (focusGame && !container.contains?.(doc.activeElement)) {
      const fallback = slice.items[Math.min(focusIndex, slice.items.length - 1)];
      const card = cards.get(focusGame) || (fallback && cards.get(fallback.id));
      (card?.[focusAction] || card?.launchButton || node('popover-search-input'))?.focus?.({ preventScroll: true });
    }
    updateStatus();
    if (node('games-page')) node('games-page').textContent = `Page ${page} of ${slice.pages}`;
    if (node('games-prev')) node('games-prev').disabled = page <= 1;
    if (node('games-next')) node('games-next').disabled = page >= slice.pages;
    if (node('games-random')) node('games-random').disabled = !filtered.length;
    if (node('games-clear')) node('games-clear').disabled = view === 'favorites' ? !favorites.length : view === 'recent' ? !recents.length : true;
    if (node('games-undo')) { node('games-undo').hidden = !clearedList; node('games-undo').disabled = !clearedList; }
    const filterCount = [genre, players, input].filter(value => value !== 'all').length;
    if (node('games-filters-label')) node('games-filters-label').textContent = filterCount ? `Filters (${filterCount})` : 'Filters';
    updateContinue();
    for (const value of ['all', 'curated', 'touch', 'local']) {
      const selected = value === 'all' ? shelf === 'all' && input === 'all' && players === 'all' : value === 'curated' ? shelf === 'curated' : value === 'touch' ? input === 'touch' : players === 'local';
      node('games-shelf-' + value)?.setAttribute('aria-pressed', String(selected));
    }
    scheduleSave();
  }

  function updateStatus() {
    if (node('games-status')) node('games-status').textContent = ready
      ? `${filtered.length.toLocaleString()} of ${games.length.toLocaleString()} games${clearedList ? ` · ${clearedList.view === 'favorites' ? 'Favorites' : 'Recently opened'} cleared. Undo is available.` : ''}${saveFailed ? ' · Changes are saved for this visit only.' : ''}`
      : 'Loading catalog…';
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
    for (const [value, label] of [['all', 'All games'], ['favorites', 'Favorites'], ['recent', 'Recently opened']]) {
      const option = element('option', '', label);
      option.value = value;
      view.appendChild(option);
    }
    controls.append(source, view);
    const filters = element('details', 'game-filters'); filters.id = 'games-filters';
    const filterLabel = element('summary', '', 'Filters'); filterLabel.id = 'games-filters-label'; filters.appendChild(filterLabel);
    const filterControls = element('div', 'game-filter-controls');
    for (const [id, label, options] of [
      ['games-genre-select', 'Genre', [['all', 'All genres'], ...Object.entries(GAME_GENRES), ['unknown', 'Genre unknown']]],
      ['games-players-select', 'Multiplayer', [['all', 'Any players'], ['local', 'Local two-player documented'], ['online', 'Online multiplayer documented'], ['unknown', 'Multiplayer unknown']]],
      ['games-input-select', 'Game controls', [['all', 'Any controls'], ['touch', 'Touch documented'], ['controller', 'Controller documented'], ['unknown', 'Controls unknown']]],
    ]) {
      const select = element('select', 'modal-sort-select'); select.id = id; select.setAttribute('aria-label', label);
      for (const [value, text] of options) { const option = element('option', '', text); option.value = value; select.appendChild(option); }
      filterControls.appendChild(select);
    }
    for (const [id, label] of [['games-random', 'Random game'], ['games-refresh', 'Refresh'], ['games-clear', 'Clear list']]) {
      const button = element('button', 'catalog-button', label);
      button.type = 'button';
      button.id = id;
      controls.appendChild(button);
    }
    const undo = element('button', 'catalog-button', 'Undo clear'); undo.id = 'games-undo'; undo.type = 'button'; undo.hidden = true; undo.disabled = true; controls.appendChild(undo);
    const status = element('p', 'catalog-status');
    status.id = 'games-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const shelves = element('div', 'game-shelves'); shelves.setAttribute('role', 'group'); shelves.setAttribute('aria-label', 'Discover games');
    for (const [value, label] of [['all', 'All games'], ['curated', 'Curated picks'], ['touch', 'Touch controls'], ['local', 'Play together']]) {
      const button = element('button', 'catalog-button game-shelf', label); button.type = 'button'; button.id = 'games-shelf-' + value;
      button.addEventListener('click', () => {
        preferences.shelf = value === 'curated' ? 'curated' : 'all';
        for (const [id, next] of [['games-source-select', 'all'], ['games-view-select', 'all'], ['games-genre-select', 'all'], ['games-input-select', value === 'touch' ? 'touch' : 'all'], ['games-players-select', value === 'local' ? 'local' : 'all'], ['popover-search-input', '']]) node(id).value = next;
        render(true);
      });
      shelves.appendChild(button);
    }
    const continueButton = element('button', 'catalog-button game-continue', 'Recently opened'); continueButton.type = 'button'; continueButton.id = 'games-continue'; continueButton.hidden = true;
    continueButton.addEventListener('click', () => { const recent = recents.map(id => gameIndex.get(id) || gameIndex.get(aliasIndex.get(id))).find(Boolean); if (recent) launch(recent, true); });
    shelves.appendChild(continueButton);
    const details = element('details', 'game-metadata-info'); details.appendChild(element('summary', '', 'About game filters'));
    details.appendChild(element('p', '', 'Only documented original-game features are tagged. Other games remain unknown. Controls and availability can differ between mirrors. Curated picks are selections, not new releases or guaranteed quick games.'));
    const references = element('div', 'game-metadata-references');
    for (const [title, key] of [['2048', '2048'], ['Hextris', 'hextris'], ['HexGL', 'hexgl'], ['Basket Random', 'basketrandom']]) {
      const link = element('a', '', title + ' documentation'); link.href = CURATED_GAME_METADATA[key].sources[0]; link.target = '_blank'; link.rel = 'noopener noreferrer'; references.appendChild(link);
    }
    details.appendChild(references);
    filters.append(filterControls, details);
    const footer = element('div', 'controls-row catalog-pagination');
    for (const [id, label] of [['games-prev', 'Previous'], ['games-page', 'Page 1 of 1'], ['games-next', 'Next']]) {
      const child = element(id === 'games-page' ? 'span' : 'button', id === 'games-page' ? 'catalog-page' : 'catalog-button', label);
      child.id = id;
      if (id !== 'games-page') child.type = 'button';
      footer.appendChild(child);
    }
    list.parentNode.insertBefore(shelves, list);
    list.parentNode.insertBefore(controls, list);
    list.parentNode.insertBefore(filters, list);
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
    applyPreferences();
    node('games-view-select')?.addEventListener('change', () => render(true));
    for (const id of ['games-genre-select', 'games-players-select', 'games-input-select']) node(id)?.addEventListener('change', () => render(true));
    node('game-list')?.addEventListener('scroll', scheduleSave, { passive: true });
    node('games-random')?.addEventListener('click', () => { if (filtered.length) launch(filtered[Math.floor(Math.random() * filtered.length)]); });
    node('games-prev')?.addEventListener('click', () => { page--; render(); node('game-list')?.scrollTo?.({ top: 0 }); });
    node('games-next')?.addEventListener('click', () => { page++; render(); node('game-list')?.scrollTo?.({ top: 0 }); });
    node('games-refresh')?.addEventListener('click', () => refresh());
    node('games-clear')?.addEventListener('click', () => {
      const view = node('games-view-select')?.value;
      const values = view === 'favorites' ? favorites : view === 'recent' ? recents : [];
      if (!values.length) return;
      clearedList = { view, values: [...values] };
      if (view === 'favorites') { favorites = []; favoritesRevision++; saveList(FAVORITES_KEY, favorites); }
      else { recents = []; recentsRevision++; saveList(RECENTS_KEY, recents); }
      render(true);
      node('games-undo')?.focus?.({ preventScroll: true });
    });
    node('games-undo')?.addEventListener('click', () => {
      if (!clearedList) return;
      if (clearedList.view === 'favorites') { favorites = [...new Set([...favorites, ...clearedList.values])].slice(0, 500); favoritesRevision++; saveList(FAVORITES_KEY, favorites); }
      else { recents = [...new Set([...recents, ...clearedList.values])].slice(0, 50); recentsRevision++; saveList(RECENTS_KEY, recents); }
      clearedList = null;
      render();
      (node('games-clear')?.disabled ? node('games-view-select') : node('games-clear'))?.focus?.({ preventScroll: true });
    });
    win.addEventListener?.('mochii:privacy', () => render());
    const reloadSaved = () => {
      if (saveTimer !== undefined) win.clearTimeout?.(saveTimer);
      saveTimer = undefined;
      clearedList = null;
      preferences = readPreferences();
      preferredVariants.clear();
      for (const [id, variant] of Object.entries(preferences.selectedSources)) preferredVariants.set(id, variant);
      favorites = readList(FAVORITES_KEY, 500); recents = readList(RECENTS_KEY, 50);
      favoritesRevision++; recentsRevision++;
      applyPreferences();
      for (const card of cards.values()) { if (card.cover) covers?.remove(card.cover); card.item.remove(); }
      cards.clear();
      restoring = true;
      try { render(); } finally { restoring = false; }
    };
    const keys = new Set([FAVORITES_KEY, RECENTS_KEY, GAME_PREFERENCES_KEY]);
    win.addEventListener?.('mochii:library-import', event => { if (event.detail?.keys?.some(key => keys.has(key))) reloadSaved(); });
    win.addEventListener?.('storage', event => { if (event.key === null || keys.has(event.key)) reloadSaved(); });
    win.addEventListener?.('pagehide', savePreferences);
  }

  async function refresh() {
    if (loading) return loading;
    loading = (async () => {
      if (node('games-status')) node('games-status').textContent = 'Loading catalogs…';
      let base = rawGames;
      let snapshotSettled = false;
      const live = new Map();
      const publish = () => {
        if (!snapshotSettled) return;
        const groups = new Map();
        for (const game of base) {
          if (!groups.has(game.source)) groups.set(game.source, []);
          groups.get(game.source).push(game);
        }
        for (const [source, entries] of live) groups.set(source, entries);
        const next = GAME_SOURCES.flatMap(source => groups.get(source.id) || []);
        const unchanged = (before, after) => before.length === after.length && before.every((entry, index) => {
          const other = after[index];
          return entry.id === other.id && entry.name === other.name && entry.cover === other.cover && entry.author === other.author;
        });
        if (unchanged(rawGames, next)) { updateStatus(); return; }
        rawGames = next;
        games = deduplicateGames(rawGames).map(game => {
          const previous = gameIndex.get(game.id);
          return previous && previous.name === game.name && previous.cover === game.cover && unchanged(previous.variants, game.variants) ? previous : game;
        });
        gameIndex = new Map(games.map(game => [game.id, game]));
        aliasIndex = new Map(games.flatMap(game => game.aliases.map(id => [id, game.id])));
        for (const [key, values] of [[FAVORITES_KEY, favorites], [RECENTS_KEY, recents]]) {
          const migrated = [...new Set(values.map(id => aliasIndex.get(id) || id))];
          if (migrated.length !== values.length || migrated.some((id, index) => id !== values[index])) {
            saveList(key, migrated);
            if (key === FAVORITES_KEY) favoritesRevision++;
            else recentsRevision++;
          }
          if (key === FAVORITES_KEY) favorites = migrated;
          else recents = migrated;
        }
        ready = games.length > 0;
        catalogRevision++;
        render();
      };
      const outcomes = await Promise.allSettled([
        fetchGameJson(win.fetch.bind(win), '/browser-tools/game-catalog.json', { signal: AbortSignal.timeout(10000) }).then(data => {
          const snapshot = snapshotGameEntries(data);
          if (!snapshot.length) throw new Error('Saved catalogs are empty.');
          base = snapshot;
        }).finally(() => { snapshotSettled = true; publish(); }),
        ...GAME_SOURCES.filter(source => source.live).map(source => fetchGameJson(win.fetch.bind(win), source.manifest, { signal: AbortSignal.timeout(8000) }).then(entries => {
          const normalized = normalizeGameEntries(entries, source.id);
          if (!normalized.length) throw new Error('Source catalog is empty.');
          live.set(source.id, normalized);
          publish();
        }))
      ]);
      if (!ready) render();
      else updateStatus();
      if (!ready && node('games-status')) node('games-status').textContent = 'Catalogs could not be loaded. Use Refresh to try again.';
      else if (outcomes[0].status === 'rejected' && node('games-status')) node('games-status').textContent = readDisplayText(node('games-status')) + ' · Some sources are temporarily unavailable.';
      return games.length;
    })().finally(() => { loading = null; });
    return loading;
  }

  function open() {
    bind();
    render();
    covers?.resume();
    return ready ? Promise.resolve(games.length) : refresh();
  }

  return Object.freeze({ open, close() { savePreferences(); covers?.pause(); }, refresh, render, launch, rememberSource, getState: () => ({ count: games.length, variants: rawGames.length, duplicates: rawGames.length - games.length, ready, page, favorites: [...favorites], recents: [...recents], preferences: currentPreferences() }) });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.MochiiGames = createGameCatalog(window, document);
  window.MonkehGames = window.MochiiGames;
  window.renderGames = () => window.MochiiGames.render(true);
}
