import { GAMES } from './mochii-cloud.data.js';
import { getFigureLaunchUrl } from './mochii-figure.js';
import { mountInbox } from './mochii-inbox.js';

export const STORAGE_KEY = 'mochii.cloud.v1';
export const PLAYER_SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-pointer-lock allow-presentation';
export const THEMES = {
  dark: ['Charcoal', '#111210', '#e5ebcf'],
  mochii: ['Mochii', '#160f0e', '#efaaa0'],
  neon: ['Neon', '#08141a', '#76d7ef'],
  forest: ['Forest', '#0d1711', '#a1cfaa'],
  sunset: ['Sunset', '#1c1210', '#ecb18b'],
  amethyst: ['Amethyst', '#18131e', '#c5afdf'],
  gold: ['Gold', '#19170f', '#dbc581'],
  hacker: ['Terminal', '#0b150e', '#8bdd9c'],
  ocean: ['Ocean', '#0b151b', '#8fc9dd'],
  lava: ['Lava', '#1c100d', '#f09c81'],
  cyberp: ['Cyber', '#15121e', '#baa5e7'],
  ice: ['Ice', '#11181c', '#c7dce5'],
  rose: ['Rose', '#1b1015', '#e3aabc'],
  mint: ['Mint', '#0b1915', '#99d7bc'],
  crimson: ['Crimson', '#1c0f10', '#dd9a9d']
};
export const PARTICLES = ['none', 'snow', 'rain', 'stars', 'cyber', 'matrix', 'bubbles', 'fireflies', 'nexus'];
const gameIds = new Set(GAMES.map(game => game.id));
const byId = new Map(GAMES.map(game => [game.id, game]));
const boundedNumber = (value, max) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : 0;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateLaunchUrl(value, shellOrigin = '') {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.origin === shellOrigin) return null;
    if (!['https://www.raccoongame.com', 'https://yee.pages.dev'].includes(url.origin)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function normalizeState(input) {
  const source = isRecord(input) ? input : {};
  const records = {};
  if (isRecord(source.records)) {
    for (const [id, item] of Object.entries(source.records)) {
      if (!gameIds.has(id) || !isRecord(item)) continue;
      records[id] = { seconds: boundedNumber(item.seconds, 315360000), last: boundedNumber(item.last, 8640000000000000) };
    }
  }
  return {
    records,
    saved: Array.isArray(source.saved) ? [...new Set(source.saved.filter(id => typeof id === 'string' && gameIds.has(id)))].slice(0, GAMES.length) : [],
    theme: typeof source.theme === 'string' && Object.hasOwn(THEMES, source.theme) ? source.theme : 'dark',
    particles: PARTICLES.includes(source.particles) ? source.particles : 'none',
    setupConfirmed: source.setupConfirmed === true,
    controller: source.controller !== false
  };
}

export function createStore(storage) {
  let value = normalizeState(null);
  let available = true;
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw) value = normalizeState(JSON.parse(raw));
    if (!storage) available = false;
  } catch {
    available = false;
  }
  return {
    get value() { return value; },
    get available() { return available; },
    save(next = value) {
      value = normalizeState(next);
      try {
        if (!storage) throw new Error('Storage unavailable');
        storage.setItem(STORAGE_KEY, JSON.stringify(value));
        available = true;
      } catch {
        available = false;
      }
      return value;
    },
    clear() {
      value = normalizeState(null);
      try {
        if (!storage) throw new Error('Storage unavailable');
        storage.removeItem(STORAGE_KEY);
        available = true;
      } catch {
        available = false;
      }
      return value;
    }
  };
}

export function createSessionTracker({ now = () => Date.now(), onUpdate = () => {}, onFinish = () => {} } = {}) {
  let active = null;
  function pulse() {
    if (!active) return null;
    if (active.mode === 'tab') {
      try {
        if (active.popup.closed) return end();
      } catch {
        return end();
      }
    }
    const stamp = now();
    const delta = Math.min(86400, Math.max(0, (stamp - active.updated) / 1000));
    active.updated = stamp;
    active.seconds += delta;
    if (delta) onUpdate({ ...active }, delta);
    return { ...active };
  }
  function end() {
    if (!active) return null;
    const previous = active;
    active = null;
    const delta = Math.min(86400, Math.max(0, (now() - previous.updated) / 1000));
    previous.seconds += delta;
    if (delta) onUpdate({ ...previous }, delta);
    onFinish({ ...previous });
    return null;
  }
  return {
    get active() { return active ? { ...active } : null; },
    start(id, mode, popup = null) {
      if (!gameIds.has(id) || !['embed', 'tab'].includes(mode) || (mode === 'tab' && (!popup || popup.closed))) return false;
      end();
      active = { id, mode, popup, started: now(), updated: now(), seconds: 0 };
      return true;
    },
    pulse,
    end
  };
}

export function formatDuration(seconds) {
  const minutes = Math.floor(boundedNumber(seconds, 315360000) / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function buildEmbedCode(game, shellOrigin = '') {
  const url = validateLaunchUrl(game?.url, shellOrigin);
  if (!url) return '';
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<iframe\n  src="${escape(url)}"\n  title="${escape(game.n)} · Mochii Cloud"\n  width="1280" height="720"\n  sandbox="${PLAYER_SANDBOX}"\n  allow="fullscreen; gamepad; autoplay"\n  referrerpolicy="no-referrer"\n  allowfullscreen>\n</iframe>`;
}

export function mountMochii(doc = document, win = window) {
  const $ = id => doc.getElementById(id);
  let storage;
  try { storage = win.localStorage; } catch {}
  const store = createStore(storage);
  let state = store.value;
  let view = 'discover';
  let selected = null;
  let heroIndex = 0;
  let toastTimer;
  let sessionTimer;
  let musicUrl;
  let audio;
  let musicWanted = false;
  let particleFrame;
  let controllerFrame;
  let controllerPrevious = {};
  let controllerLastMove = 0;
  let particleItems = [];
  let particleTime = 0;
  const reducedMotion = win.matchMedia('(prefers-reduced-motion: reduce)');
  const details = $('details-dialog');
  const player = $('player-dialog');
  const canvas = $('particles');
  const context = canvas.getContext('2d');
  const tracker = createSessionTracker({
    onUpdate(session, seconds) {
      const record = state.records[session.id] || { seconds: 0, last: session.started };
      record.seconds += seconds;
      state.records[session.id] = record;
      save();
      $('session-time').textContent = formatDuration(session.seconds);
    },
    onFinish() {
      win.clearInterval(sessionTimer);
      $('session-bar').hidden = true;
      syncMusic();
      restartParticles();
    }
  });

  function save() {
    state = store.save(state);
    storageStatus();
  }

  function storageStatus() {
    $('storage-status').textContent = store.available ? 'Preferences are saved in this browser.' : 'Browser storage is unavailable or full. Changes work for this visit, but may not survive a reload.';
  }

  function toast(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    win.clearTimeout(toastTimer);
    toastTimer = win.setTimeout(() => { $('toast').hidden = true; }, 4500);
  }

  function element(tag, text, className) {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function image(node, src, name = '') {
    node.alt = name;
    node.referrerPolicy = 'no-referrer';
    node.onerror = () => { node.hidden = true; };
    node.hidden = false;
    try {
      const url = new URL(src);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid image URL');
      node.src = url.href;
    } catch { node.removeAttribute('src'); node.hidden = true; }
  }

  function card(game) {
    const button = element('button', undefined, 'game-card');
    button.type = 'button';
    button.setAttribute('aria-label', `View ${game.n}`);
    const poster = element('span', undefined, 'poster-wrap');
    const art = element('img');
    art.loading = 'lazy';
    art.decoding = 'async';
    image(art, game.img);
    poster.append(art);
    if (state.saved.includes(game.id)) {
      const mark = element('span', '✓', 'saved-mark');
      mark.setAttribute('aria-label', 'Saved');
      poster.append(mark);
    }
    if (state.records[game.id]?.seconds) poster.append(element('span', formatDuration(state.records[game.id].seconds), 'card-time'));
    button.append(poster, element('span', game.n, 'card-name'), element('span', game.tags.slice(0, 2).join(' · '), 'card-meta'));
    button.addEventListener('click', () => openDetails(game.id));
    return button;
  }

  function renderGrid(id, games) {
    const fragment = doc.createDocumentFragment();
    games.forEach(game => fragment.append(card(game)));
    $(id).replaceChildren(fragment);
  }

  function recentGames() {
    return GAMES.filter(game => state.records[game.id]?.last).sort((a, b) => state.records[b.id].last - state.records[a.id].last);
  }

  function featuredGames() {
    return [...new Set([...recentGames().slice(0, 1), ...['117', '598', '49', '209'].map(id => byId.get(id))])].slice(0, 4);
  }

  function renderHero() {
    const featured = featuredGames();
    heroIndex = (heroIndex + featured.length) % featured.length;
    const game = featured[heroIndex];
    image($('hero-image'), game.bg);
    $('hero-title').textContent = game.n;
    $('hero-description').textContent = game.desc;
    $('hero-label').textContent = state.records[game.id]?.last ? 'PICK UP WHERE YOU LEFT OFF' : 'THE SPOTLIGHT';
    $('hero-number').textContent = `${String(heroIndex + 1).padStart(2, '0')} / ${String(featured.length).padStart(2, '0')}`;
    $('hero-open').onclick = () => openDetails(game.id);
  }

  function renderDiscovery() {
    renderHero();
    const day = Math.floor(Date.now() / 86400000);
    const daily = Array.from({ length: 6 }, (_, index) => GAMES[(day * 7 + index * 17) % GAMES.length]);
    const sections = [
      ['Recently opened', recentGames().slice(0, 6), ''],
      ["Today's picks", daily, ''],
      ['Popular in the collection', GAMES.slice(0, 6), ''],
      ['Made for the open road', GAMES.filter(game => game.tags.some(tag => ['Racing', 'Driving'].includes(tag))).slice(0, 6), 'Racing'],
      ['A little after dark', GAMES.filter(game => game.n.toLowerCase().includes('poppy')).slice(0, 6), 'poppy'],
      ['Worth a look', GAMES.filter(game => game.tags.includes('Adventure')).slice(-6), 'Adventure']
    ];
    const fragment = doc.createDocumentFragment();
    for (const [title, games, query] of sections) {
      if (!games.length) continue;
      const section = element('section');
      const heading = element('div', undefined, 'section-heading');
      const seeAll = element('button', 'Browse library →', 'text-button');
      seeAll.type = 'button';
      seeAll.addEventListener('click', () => { $('library-search').value = query; $('genre-filter').value = ''; showView('library'); });
      heading.append(element('h2', title), seeAll);
      const grid = element('div', undefined, 'game-grid discovery-grid');
      games.forEach(game => grid.append(card(game)));
      section.append(heading, grid);
      fragment.append(section);
    }
    $('discovery-sections').replaceChildren(fragment);
  }

  function renderLibrary() {
    const query = $('library-search').value.trim().toLowerCase();
    const genre = $('genre-filter').value;
    let games = GAMES.filter(game => (!genre || game.tags.includes(genre)) && `${game.n} ${game.dev} ${game.tags.join(' ')}`.toLowerCase().includes(query));
    const sort = $('sort-filter').value;
    if (sort === 'title') games = games.sort((a, b) => a.n.localeCompare(b.n));
    if (sort === 'recent') games = games.sort((a, b) => (state.records[b.id]?.last || 0) - (state.records[a.id]?.last || 0));
    if (sort === 'time') games = games.sort((a, b) => (state.records[b.id]?.seconds || 0) - (state.records[a.id]?.seconds || 0));
    renderGrid('library-grid', games);
    $('library-empty').hidden = games.length > 0;
    $('result-count').textContent = `${games.length} ${games.length === 1 ? 'game' : 'games'}`;
  }

  function renderSaved() {
    const games = state.saved.map(id => byId.get(id)).filter(Boolean);
    renderGrid('saved-grid', games);
    $('saved-empty').hidden = games.length > 0;
  }

  function showView(next) {
    if (!['discover', 'library', 'saved', 'guide', 'settings'].includes(next)) return;
    view = next;
    doc.querySelectorAll('.view').forEach(node => { node.hidden = node.id !== `view-${view}`; });
    doc.querySelectorAll('[data-view]').forEach(node => {
      if (node.dataset.view === view) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    });
    if (view === 'library') renderLibrary();
    if (view === 'saved') renderSaved();
    if (view === 'discover') renderDiscovery();
    win.scrollTo({ top: 0, behavior: 'instant' });
  }

  function gameLink(game) {
    const url = new URL(win.location.pathname, win.location.origin);
    url.searchParams.set('game', game.id);
    return url.href;
  }

  function openDetails(id) {
    const game = byId.get(id);
    if (!game || player.open) return;
    selected = game;
    image($('detail-image'), game.img);
    $('detail-title').textContent = game.n;
    $('detail-developer').textContent = game.dev;
    $('detail-description').textContent = game.desc;
    $('detail-tags').replaceChildren(...game.tags.map(tag => element('span', tag)));
    const record = state.records[id];
    $('detail-time').textContent = formatDuration(record?.seconds || 0);
    $('detail-last').textContent = record?.last ? new Date(record.last).toLocaleDateString() : 'Not yet';
    $('detail-achievements').textContent = String(game.ach);
    const figureUrl = getFigureLaunchUrl(game.id);
    $('launch-figure').hidden = !figureUrl;
    $('launch-figure').disabled = !figureUrl;
    $('launch-tab').className = figureUrl ? 'button' : 'button primary';
    $('launch-tab').textContent = figureUrl ? 'Original provider ↗' : 'Play in new tab ↗';
    $('launch-embed').textContent = figureUrl ? 'Play original here' : 'Play here';
    $('detail-provider').textContent = figureUrl
      ? 'Figure opens this game in a new tab and handles session setup and queues. Its availability and terms apply. The original provider is also available below.'
      : game.url.includes('raccoongame.com') ? 'Opens with Raccoon. Its account requirements, availability, and pricing apply.' : 'Opens with the original browser-game provider.';
    const specs = [];
    for (const [title, requirement] of [['Minimum', game.rm], ['Recommended', game.rr]]) {
      const group = element('div');
      const list = element('dl');
      for (const [label, key] of [['System', 'os'], ['Processor', 'cpu'], ['Memory', 'ram'], ['Graphics', 'gpu']]) list.append(element('dt', label), element('dd', requirement?.[key] || 'Not listed'));
      group.append(element('h3', title), list);
      specs.push(group);
    }
    $('detail-specs').replaceChildren(...specs);
    $('detail-link').href = gameLink(game);
    $('detail-link').textContent = `Link to ${game.n}`;
    $('embed-code').value = buildEmbedCode(game, win.location.origin);
    const launchValid = Boolean(validateLaunchUrl(game.url, win.location.origin));
    $('launch-tab').disabled = !launchValid;
    $('launch-embed').disabled = !launchValid;
    updateSaveButton();
    details.querySelectorAll('details').forEach(node => { node.open = false; });
    if (!details.open) details.showModal();
    try { win.history.replaceState(null, '', gameLink(game)); } catch {}
  }

  function updateSaveButton() {
    const saved = selected && state.saved.includes(selected.id);
    $('save-game').textContent = saved ? 'Saved ✓' : 'Save game';
    $('save-game').setAttribute('aria-pressed', String(Boolean(saved)));
  }

  function refreshCards() {
    if (view === 'discover') renderDiscovery();
    if (view === 'library') renderLibrary();
    if (view === 'saved') renderSaved();
  }

  function startSession(game, mode, popup = null) {
    if (!tracker.start(game.id, mode, popup)) return false;
    state.records[game.id] = { seconds: state.records[game.id]?.seconds || 0, last: Date.now() };
    save();
    $('session-name').textContent = game.n;
    $('session-time').textContent = '0m';
    $('session-return').textContent = mode === 'tab' ? 'Return to game ↗' : 'Return to player';
    $('session-end').textContent = mode === 'tab' ? 'End tracking' : 'Close player';
    $('session-bar').hidden = false;
    win.clearInterval(sessionTimer);
    sessionTimer = win.setInterval(() => { tracker.pulse(); }, 1000);
    syncMusic();
    restartParticles();
    return true;
  }

  function openGameTab(game) {
    const url = validateLaunchUrl(game?.url, win.location.origin);
    if (!url) return toast('This game has an unsupported provider address.');
    return openProviderTab(game, url);
  }

  function openFigureTab(game) {
    const knownGame = byId.get(game?.id);
    const url = getFigureLaunchUrl(knownGame?.id);
    if (!url) return toast('This game has no verified Figure link. Use the original provider instead.');
    return openProviderTab(knownGame, url, 'Figure');
  }

  function openProviderTab(game, url, provider = 'the provider') {
    let popup;
    try {
      popup = win.open('about:blank', '_blank');
      if (!popup) return toast('Your browser blocked the new tab. Allow popups for this site, then try again.');
      popup.opener = null;
      popup.location.replace(url);
    } catch {
      try { popup?.close(); } catch {}
      return toast('The game tab could not open. Try again or choose the original provider.');
    }
    closePlayer();
    if (details.open) details.close();
    startSession(game, 'tab', popup);
    toast(`Opened with ${provider}. Session time estimates how long its tab stays open, including loading and queues.`);
  }

  function launchEmbedded(game) {
    const url = validateLaunchUrl(game?.url, win.location.origin);
    if (!url) return toast('This game has an unsupported provider address.');
    closePlayer();
    if (details.open) details.close();
    const frame = element('iframe');
    frame.title = `${game.n} · provider player`;
    frame.setAttribute('sandbox', PLAYER_SANDBOX);
    frame.setAttribute('allow', 'fullscreen; gamepad; autoplay');
    frame.referrerPolicy = 'no-referrer';
    frame.allowFullscreen = true;
    frame.src = url;
    $('player-container').replaceChildren(frame);
    $('player-title').textContent = game.n;
    player.showModal();
    startSession(game, 'embed');
  }

  function closePlayer() {
    if (tracker.active?.mode === 'embed') tracker.end();
    if (doc.pointerLockElement) doc.exitPointerLock?.();
    if (doc.fullscreenElement === player) doc.exitFullscreen?.().catch(() => {});
    $('player-container').replaceChildren();
    if (player.open) player.close();
  }

  async function copy(value, area) {
    try {
      if (!win.navigator.clipboard) throw new Error('Clipboard unavailable');
      await win.navigator.clipboard.writeText(value);
      toast('Copied to clipboard.');
    } catch {
      if (area) { area.focus(); area.select(); }
      toast(area ? 'Clipboard permission is unavailable. The code is selected; copy it manually.' : 'Clipboard permission is unavailable. Open Share & embed and copy the game link.');
    }
  }

  function applyTheme() {
    const [, background, accent] = THEMES[state.theme];
    doc.documentElement.style.setProperty('--bg', background);
    doc.documentElement.style.setProperty('--accent', accent);
    $('theme-select').value = state.theme;
    $('particle-select').value = state.particles;
    $('controller-toggle').checked = state.controller;
    $('setup-confirmed').checked = state.setupConfirmed;
    $('setup-status').textContent = state.setupConfirmed ? 'Setup marked complete by you. Provider sign-in has not been verified.' : 'This is a reminder only. Mochii cannot check your provider login.';
    restartParticles();
  }

  function syncMusic() {
    if (!audio) return;
    const shouldPlay = musicWanted && !doc.hidden && !tracker.active;
    if (shouldPlay) audio.play().catch(() => { musicWanted = false; $('music-toggle').textContent = 'Play music'; toast('This audio could not play. Try another audio file.'); });
    else audio.pause();
    $('music-toggle').textContent = musicWanted ? 'Pause music' : 'Play music';
  }

  function clearMusic() {
    musicWanted = false;
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    if (musicUrl) win.URL.revokeObjectURL(musicUrl);
    audio = null;
    musicUrl = null;
    $('music-file').value = '';
    $('music-name').textContent = 'No audio selected.';
    $('music-toggle').textContent = 'Play music';
    $('music-toggle').disabled = true;
    $('music-clear').disabled = true;
  }

  function restartParticles() {
    win.cancelAnimationFrame(particleFrame);
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (state.particles === 'none' || reducedMotion.matches || doc.hidden || tracker.active) return;
    const width = win.innerWidth;
    const height = win.innerHeight;
    const ratio = Math.min(win.devicePixelRatio || 1, 2);
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    particleItems = Array.from({ length: 35 }, () => ({ x: Math.random() * width, y: Math.random() * height, speed: .15 + Math.random() * .4, size: 1 + Math.random() * 2, phase: Math.random() * 6.28 }));
    particleTime = 0;
    const draw = now => {
      if (doc.hidden || tracker.active || state.particles === 'none' || reducedMotion.matches) return;
      const step = Math.min(2, (now - (particleTime || now)) / 30);
      if (particleTime && now - particleTime < 30) { particleFrame = win.requestAnimationFrame(draw); return; }
      particleTime = now;
      context.clearRect(0, 0, width, height);
      context.fillStyle = THEMES[state.theme][2];
      context.strokeStyle = THEMES[state.theme][2];
      context.lineWidth = .7;
      for (let index = 0; index < particleItems.length; index++) {
        const item = particleItems[index];
        item.y = (item.y + (state.particles === 'bubbles' ? -item.speed : item.speed) * step + height) % height;
        if (state.particles === 'rain' || state.particles === 'matrix') item.y = (item.y + item.speed * 4 * step) % height;
        const x = item.x + Math.sin(now / 3000 + item.phase) * (state.particles === 'fireflies' ? 20 : 4);
        context.globalAlpha = state.particles === 'stars' ? .2 + Math.abs(Math.sin(now / 3000 + item.phase)) * .6 : .45;
        context.beginPath();
        if (state.particles === 'matrix') {
          context.font = '10px monospace';
          context.fillText(String(index % 2), x, item.y);
        } else if (state.particles === 'rain' || state.particles === 'cyber') {
          context.moveTo(x, item.y);
          context.lineTo(x + (state.particles === 'cyber' ? 8 : 2), item.y + 12);
          context.stroke();
        } else {
          context.arc(x, item.y, state.particles === 'bubbles' ? item.size * 5 : item.size, 0, Math.PI * 2);
          if (state.particles === 'bubbles') context.stroke();
          else context.fill();
        }
        if (state.particles === 'nexus' && index > 0) {
          const other = particleItems[index - 1];
          if (Math.hypot(other.x - x, other.y - item.y) < 160) { context.beginPath(); context.moveTo(x, item.y); context.lineTo(other.x, other.y); context.stroke(); }
        }
      }
      context.globalAlpha = 1;
      particleFrame = win.requestAnimationFrame(draw);
    };
    particleFrame = win.requestAnimationFrame(draw);
  }

  function controllerTargets() {
    const scope = $('clear-dialog').open ? $('clear-dialog') : player.open ? player : details.open ? details : doc;
    return [...scope.querySelectorAll('button, a[href], input, select, summary, textarea')].filter(node => !node.disabled && !node.closest('[hidden]') && node.getClientRects().length && node.tabIndex >= 0);
  }

  function moveControllerFocus(dx, dy) {
    const targets = controllerTargets();
    if (!targets.length) return;
    const current = doc.activeElement;
    if (!targets.includes(current)) { targets[0].focus(); return; }
    const rect = current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let best;
    let distance = Infinity;
    for (const target of targets) {
      if (target === current) continue;
      const box = target.getBoundingClientRect();
      const x = box.left + box.width / 2 - cx;
      const y = box.top + box.height / 2 - cy;
      if ((dx && x * dx <= 3) || (dy && y * dy <= 3)) continue;
      const score = Math.hypot(x, y) + Math.abs(dx ? y : x) * 2;
      if (score < distance) { best = target; distance = score; }
    }
    if (best) { best.focus(); best.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }

  function startController() {
    win.cancelAnimationFrame(controllerFrame);
    controllerPrevious = {};
    if (!state.controller || doc.hidden || !win.navigator.getGamepads) return;
    let pads;
    try { pads = win.navigator.getGamepads(); } catch { return; }
    if (![...pads].some(Boolean)) return;
    const update = now => {
      if (!state.controller || doc.hidden) return;
      let pad;
      try { pad = [...win.navigator.getGamepads()].find(Boolean); } catch { return; }
      if (!pad) return;
      const pressed = index => Boolean(pad.buttons?.[index]?.pressed);
      const buttons = { a: pressed(0), b: pressed(1), left: pressed(14) || (pad.axes?.[0] || 0) < -.6, right: pressed(15) || (pad.axes?.[0] || 0) > .6, up: pressed(12) || (pad.axes?.[1] || 0) < -.6, down: pressed(13) || (pad.axes?.[1] || 0) > .6 };
      const frameOwnsFocus = player.open && doc.activeElement?.tagName === 'IFRAME';
      if (!frameOwnsFocus) {
        if (buttons.a && !controllerPrevious.a && controllerTargets().includes(doc.activeElement)) doc.activeElement.click();
        if (buttons.b && !controllerPrevious.b) {
          if ($('clear-dialog').open) $('clear-dialog').close();
          else if (player.open) closePlayer();
          else if (details.open) details.close();
          else showView('discover');
        }
        if (now - controllerLastMove > 180 && (buttons.left || buttons.right || buttons.up || buttons.down)) {
          moveControllerFocus(buttons.left ? -1 : buttons.right ? 1 : 0, buttons.up ? -1 : buttons.down ? 1 : 0);
          controllerLastMove = now;
        }
      }
      controllerPrevious = buttons;
      controllerFrame = win.requestAnimationFrame(update);
    };
    controllerFrame = win.requestAnimationFrame(update);
  }

  $('catalog-count').textContent = `${GAMES.length} games · Your next favorite is here`;
  for (const tag of [...new Set(GAMES.flatMap(game => game.tags))].sort()) {
    const option = element('option', tag);
    option.value = tag;
    $('genre-filter').append(option);
  }
  for (const [key, [title]] of Object.entries(THEMES)) {
    const option = element('option', title);
    option.value = key;
    $('theme-select').append(option);
  }
  for (const key of PARTICLES) {
    const option = element('option', key === 'none' ? 'Off' : key[0].toUpperCase() + key.slice(1));
    option.value = key;
    $('particle-select').append(option);
  }
  doc.querySelectorAll('[data-view]').forEach(node => node.addEventListener('click', () => showView(node.dataset.view)));
  doc.querySelectorAll('[data-go]').forEach(node => node.addEventListener('click', () => showView(node.dataset.go)));
  $('hero-prev').addEventListener('click', () => { heroIndex--; renderHero(); });
  $('hero-next').addEventListener('click', () => { heroIndex++; renderHero(); });
  $('library-search').addEventListener('input', renderLibrary);
  $('genre-filter').addEventListener('change', renderLibrary);
  $('sort-filter').addEventListener('change', renderLibrary);
  $('detail-close').addEventListener('click', () => details.close());
  details.addEventListener('close', () => {
    try { win.history.replaceState(null, '', win.location.pathname); } catch {}
  });
  $('save-game').addEventListener('click', () => {
    if (!selected) return;
    state.saved = state.saved.includes(selected.id) ? state.saved.filter(id => id !== selected.id) : [...state.saved, selected.id];
    save();
    updateSaveButton();
    refreshCards();
  });
  $('launch-tab').addEventListener('click', () => { if (selected) openGameTab(selected); });
  $('launch-figure').addEventListener('click', () => { if (selected) openFigureTab(selected); });
  $('launch-embed').addEventListener('click', () => { if (selected) launchEmbedded(selected); });
  $('copy-link').addEventListener('click', () => { if (selected) copy(gameLink(selected)); });
  $('copy-embed').addEventListener('click', () => copy($('embed-code').value, $('embed-code')));
  $('player-close').addEventListener('click', closePlayer);
  player.addEventListener('cancel', event => { event.preventDefault(); closePlayer(); });
  $('player-newtab').addEventListener('click', () => { const active = tracker.active; if (active) openGameTab(byId.get(active.id)); });
  $('player-fullscreen').addEventListener('click', async () => {
    try {
      if (doc.fullscreenElement === player) await doc.exitFullscreen();
      else if (player.requestFullscreen) await player.requestFullscreen();
      else throw new Error('Unavailable');
    } catch { toast('Fullscreen is unavailable here. Try opening the game in a new tab.'); }
  });
  doc.addEventListener('fullscreenchange', () => { $('player-fullscreen').textContent = doc.fullscreenElement === player ? 'Exit fullscreen' : 'Fullscreen'; });
  $('player-pointer').addEventListener('click', async () => {
    const frame = $('player-container').querySelector('iframe');
    try {
      if (doc.pointerLockElement) { doc.exitPointerLock(); return; }
      if (!frame?.requestPointerLock) throw new Error('Unavailable');
      frame.focus();
      await frame.requestPointerLock();
    } catch { toast('Pointer capture is unavailable here. Use the provider’s control or a new tab.'); }
  });
  doc.addEventListener('pointerlockchange', () => { $('player-pointer').textContent = doc.pointerLockElement ? 'Release pointer' : 'Capture pointer'; });
  doc.addEventListener('pointerlockerror', () => toast('Pointer capture was declined by your browser.'));
  $('session-return').addEventListener('click', () => {
    const active = tracker.active;
    if (!active) return;
    if (active.mode === 'embed') { if (!player.open) player.showModal(); }
    else { try { if (!active.popup.closed) active.popup.focus(); else tracker.end(); } catch { toast('Use your browser tabs to return to the game.'); } }
  });
  $('session-end').addEventListener('click', () => { if (tracker.active?.mode === 'embed') closePlayer(); else tracker.end(); refreshCards(); });
  $('setup-confirmed').addEventListener('change', () => { state.setupConfirmed = $('setup-confirmed').checked; save(); applyTheme(); });
  $('theme-select').addEventListener('change', () => { state.theme = $('theme-select').value; save(); applyTheme(); });
  $('particle-select').addEventListener('change', () => { state.particles = $('particle-select').value; save(); restartParticles(); });
  $('controller-toggle').addEventListener('change', () => { state.controller = $('controller-toggle').checked; save(); startController(); });
  $('music-file').addEventListener('change', () => {
    const file = $('music-file').files?.[0];
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) return toast('Choose an audio file smaller than 100 MB.');
    if (file.type && !file.type.startsWith('audio/')) return toast('Choose an audio file.');
    clearMusic();
    musicUrl = win.URL.createObjectURL(file);
    audio = new win.Audio(musicUrl);
    audio.loop = true;
    audio.volume = .18;
    audio.preload = 'none';
    audio.addEventListener('error', () => { musicWanted = false; $('music-toggle').textContent = 'Play music'; toast('This audio format could not be loaded.'); });
    $('music-name').textContent = file.name;
    $('music-toggle').disabled = false;
    $('music-clear').disabled = false;
  });
  $('music-toggle').addEventListener('click', () => { musicWanted = !musicWanted; syncMusic(); });
  $('music-clear').addEventListener('click', clearMusic);
  $('clear-data').addEventListener('click', () => $('clear-dialog').showModal());
  $('clear-cancel').addEventListener('click', () => $('clear-dialog').close());
  $('clear-confirm').addEventListener('click', () => {
    closePlayer();
    tracker.end();
    clearMusic();
    state = store.clear();
    storageStatus();
    applyTheme();
    startController();
    refreshCards();
    $('clear-dialog').close();
    toast(store.available ? 'Local activity and preferences cleared.' : 'Cleared for this visit. Browser storage could not be changed.');
  });
  doc.addEventListener('keydown', event => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || details.open || player.open || $('clear-dialog').open || /INPUT|TEXTAREA|SELECT/.test(doc.activeElement?.tagName)) return;
    event.preventDefault();
    showView('library');
    $('library-search').focus();
  });
  win.addEventListener('gamepadconnected', startController);
  win.addEventListener('gamepaddisconnected', startController);
  win.addEventListener('resize', restartParticles);
  reducedMotion.addEventListener?.('change', restartParticles);
  doc.addEventListener('visibilitychange', () => { tracker.pulse(); syncMusic(); restartParticles(); startController(); });
  win.addEventListener('pagehide', () => { tracker.end(); closePlayer(); audio?.pause(); win.cancelAnimationFrame(particleFrame); win.cancelAnimationFrame(controllerFrame); });
  win.addEventListener('pageshow', () => { syncMusic(); restartParticles(); startController(); });
  storageStatus();
  applyTheme();
  renderDiscovery();
  startController();
  const deepLink = new URLSearchParams(win.location.search).get('game');
  if (deepLink) {
    if (byId.has(deepLink)) openDetails(deepLink);
    else toast('That game is not in this collection.');
  }
  return { store, tracker, showView, openDetails, openGameTab, openFigureTab, launchEmbedded, closePlayer };
}

if (typeof document !== 'undefined' && document.getElementById('view-discover')) {
  mountMochii();
  mountInbox();
}
