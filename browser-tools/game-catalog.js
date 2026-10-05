import { normalizeCatalogTitle } from './catalog-identity.js';

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
const FAVORITES_KEY = 'monkeh.games.favorites.v1';
const RECENTS_KEY = 'monkeh.games.recents.v1';
const PAGE_SIZE = 60;
const MAX_BYTES = 4 * 1024 * 1024;
const FEATURED = ['Coffee Talk', 'A Difficult Game About Climbing', 'Basketball Stars', 'Drive Mad', 'Slope', 'Geometry Dash', 'Minecraft 1.12.2', 'Minecraft 1.8.8', 'Vex 8'];
const FEATURED_RANK = new Map(FEATURED.map((name, index) => [normalizeCatalogTitle(name), index]));
const BROKEN_2048_URLS = new Set([
  HTML_BASE + '114-f.html', REFERENCE_ORIGIN + '/study2/114-f.html', CHERRI_ORIGIN + '/stores/gn-math/114-f.html'
]);
const VERIFIED_2048_URL = CHERRI_ORIGIN + '/stores/seraph/2048/index.html';

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

export function selectGames(games, { query = '', source = 'all', view = 'all', sort = 'pop', favorites = [], recents = [] } = {}) {
  const search = String(query).trim().toLowerCase().slice(0, 200);
  const searchKey = normalizeCatalogTitle(search);
  const saved = new Set(favorites);
  const recent = new Map(recents.map((id, index) => [id, index]));
  const list = games.filter(game => (source === 'all' || game.sources.includes(source))
    && (view !== 'favorites' || saved.has(game.id) || game.aliases.some(id => saved.has(id)))
    && (view !== 'recent' || recent.has(game.id) || game.aliases.some(id => recent.has(id)))
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
  const preferredVariants = new Map();
  const cards = new Map();
  let covers;
  let catalogRevision = 0;
  let favoritesRevision = 0;
  let recentsRevision = 0;
  let filterSignature = '';
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

  function activeVariant(game) {
    const source = node('games-source-select')?.value || 'all';
    const variants = source === 'all' ? game.variants : game.variants.filter(item => item.source === source);
    return variants.find(item => item.id === preferredVariants.get(game.id)) || variants[0] || game.variants[0];
  }

  function launch(game) {
    const known = gameIndex.get(game?.id) || gameIndex.get(aliasIndex.get(game?.id));
    if (!known) return;
    recents = [known.id, ...recents.filter(id => id !== known.id)].slice(0, 50);
    recentsRevision++;
    saveList(RECENTS_KEY, recents);
    const variant = activeVariant(known);
    return win.openViewer?.(known.name, SOURCE_BY_ID.get(variant.source).label, variant.url, true, { loadCode: true });
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
    info.appendChild(element('span', 'game-author', SOURCE_BY_ID.get(variant.source).label));
    launchButton.appendChild(info);
    const star = element('button', 'game-favorite');
    star.type = 'button';
    star.addEventListener('click', () => toggleFavorite(game));
    item.append(launchButton, star);
    const card = { game, item, star, launchButton, cover, sourceFilter, showCovers };
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
          const selected = activeVariant(game);
          launchButton.setAttribute('aria-label', 'Play ' + game.name + ' from ' + SOURCE_BY_ID.get(selected.source).label);
          info.children[1].textContent = SOURCE_BY_ID.get(selected.source).label;
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
    const signature = JSON.stringify([catalogRevision, query, source, view, sort, view === 'favorites' ? favoritesRevision : 0, view === 'recent' ? recentsRevision : 0]);
    if (signature !== filterSignature) {
      filtered = selectGames(games, { query, source, view, sort, favorites, recents });
      filterSignature = signature;
    }
    if (resetPage) page = 1;
    const slice = gamePage(filtered, page);
    page = slice.page;
    const showCovers = win.MonkehPrivacy?.get().showCovers !== false;
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
        if (container.children[index] !== card.item) container.insertBefore(card.item, container.children[index] || null);
        if (card.cover && !card.coverQueued) { covers.add(card.cover, game.cover); card.coverQueued = true; }
      });
    }
    container.scrollTop = resetPage ? 0 : scrollTop;
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
    if (node('games-clear')) node('games-clear').disabled = !['favorites', 'recent'].includes(view);
  }

  function updateStatus() {
    if (node('games-status')) node('games-status').textContent = ready
      ? `${filtered.length.toLocaleString()} of ${games.length.toLocaleString()} games`
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
      if (view === 'favorites') { favorites = []; favoritesRevision++; saveList(FAVORITES_KEY, favorites); }
      if (view === 'recent') { recents = []; recentsRevision++; saveList(RECENTS_KEY, recents); }
      render(true);
    });
    win.addEventListener?.('monkeh:privacy', () => render());
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
      else if (outcomes[0].status === 'rejected' && node('games-status')) node('games-status').textContent += ' · Some sources are temporarily unavailable.';
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

  return Object.freeze({ open, refresh, render, launch, getState: () => ({ count: games.length, variants: rawGames.length, duplicates: rawGames.length - games.length, ready, page, favorites: [...favorites], recents: [...recents] }) });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.MonkehGames = createGameCatalog(window, document);
  window.renderGames = () => window.MonkehGames.render(true);
}
