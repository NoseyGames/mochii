import { normalizeCatalogTitle } from './catalog-identity.js';

export const MUSIC_SOURCES = Object.freeze([
  { id: 'qobuz', label: 'Qobuz' }, { id: 'tidal', label: 'Tidal' }, { id: 'ytm', label: 'YouTube Music' },
  { id: 'scdlp', label: 'SoundCloud alternative' }, { id: 'soundcloud', label: 'SoundCloud' }
].map(Object.freeze));
const SOURCE_IDS = new Set(MUSIC_SOURCES.map(source => source.id));
const SOURCE_LABELS = new Map(MUSIC_SOURCES.map(source => [source.id, source.label]));
const ART_ORIGINS = new Set(['https://resources.tidal.com', 'https://static.qobuz.com', 'https://yt3.googleusercontent.com', 'https://i.ytimg.com', 'https://i1.sndcdn.com']);
const FAVORITES_KEY = 'monkeh.music.favorites.v1';
const PLAYER_KEY = 'monkeh.music.player.v1';
const MAX_TRACKS = 1000;
const MAX_JSON = 2 * 1024 * 1024;

function untilAborted(promise, signal) {
  if (signal.aborted) return Promise.reject(new Error('Music search stopped.'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Music search stopped.'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function shortText(value, max = 200) { return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : ''; }

export function normalizeMusicEntries(input, sourceHint) {
  const entries = Array.isArray(input) ? input : Array.isArray(input?.items) ? input.items : [];
  const tracks = [];
  for (const entry of entries.slice(0, MAX_TRACKS)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const source = SOURCE_IDS.has(entry.source) ? entry.source : sourceHint;
    const id = typeof entry.id === 'number' && Number.isSafeInteger(entry.id) && entry.id >= 0 ? String(entry.id) : shortText(entry.id, 512);
    const title = shortText(entry.title || entry.name);
    if (!SOURCE_IDS.has(source) || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !title) continue;
    let artwork = '';
    try { const url = new URL(entry.artwork); if (ART_ORIGINS.has(url.origin) && !url.username && !url.password && url.href.length < 2048) artwork = url.href; } catch {}
    tracks.push({ id, source, title, artist: shortText(entry.artist) || 'Unknown artist', album: shortText(entry.album),
      duration: typeof entry.duration === 'number' && Number.isFinite(entry.duration) ? Math.max(0, Math.min(86400, entry.duration)) : 0,
      isrc: shortText(entry.isrc, 30), artwork, explicit: entry.explicit === true });
  }
  return tracks;
}

export function mergeMusicTracks(groups) {
  const byName = new Map();
  const identities = new Map();
  for (const tracks of groups) for (const track of tracks) {
    const key = normalizeCatalogTitle(track.title);
    if (!key) continue;
    const identity = track.source + '|' + track.id;
    let item = byName.get(key);
    if (!item) {
      item = { ...track, key, variants: [] };
      byName.set(key, item);
      identities.set(key, new Set());
    }
    if (!identities.get(key).has(identity)) { identities.get(key).add(identity); item.variants.push(track); }
  }
  return [...byName.values()];
}

export function normalizeMusicSnapshot(snapshot) {
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.tracks)) return [];
  return mergeMusicTracks([normalizeMusicEntries(snapshot.tracks)]);
}

export function preferMusicSource(track, source) {
  if (source === 'all' || !SOURCE_IDS.has(source)) return track;
  const variants = track.variants || [track];
  const preferred = variants.filter(variant => variant.source === source);
  if (!preferred.length) return track;
  return { ...track, ...preferred[0], key: track.key, variants: [...preferred, ...variants.filter(variant => variant.source !== source)] };
}

export function musicStreamPath(track) {
  const normalized = normalizeMusicEntries([track])[0];
  if (!normalized) throw new Error('This track has no supported source.');
  const query = new URLSearchParams();
  for (const name of ['id', 'source', 'title', 'artist', 'isrc', 'duration']) if (normalized[name]) query.set(name, normalized[name]);
  return '/api/music/stream?' + query;
}

export async function fetchMusicJson(fetcher, url, { signal } = {}) {
  const response = await fetcher(url, { signal, credentials: 'omit', mode: 'cors', redirect: 'error', referrerPolicy: 'no-referrer' });
  if (!response.headers.get('content-type')?.includes('application/json')) { void response.body?.cancel().catch(() => {}); throw new Error('The music service returned a non-JSON response.'); }
  if (Number(response.headers.get('content-length')) > MAX_JSON) { void response.body?.cancel().catch(() => {}); throw new Error('Music results exceed the size limit.'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The music service returned an empty response.');
  const chunks = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new Error('Music search stopped.');
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON) throw new Error('Music results exceed the size limit.');
      chunks.push(value);
    }
    if (signal?.aborted) throw new Error('Music search stopped.');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!response.ok) throw new Error(shortText(payload.error) || 'Music returned HTTP ' + response.status + '.');
    return payload;
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
}

export function createMusicCatalog({ fetchJson, onChange = () => {}, timeout = 20000, now = Date.now } = {}) {
  let generation = 0;
  let controller;
  const cache = new Map();
  const state = { tracks: [], pending: 0, failures: [], query: '', duplicates: 0 };
  const emit = () => onChange({ ...state, failures: [...state.failures] });
  return {
    snapshot() { return { ...state }; },
    seed(tracks) { if (generation === 0) { state.tracks = tracks; emit(); } },
    cancel() { generation++; controller?.abort(); state.pending = 0; emit(); },
    async search(rawQuery, { refresh = false } = {}) {
      const query = shortText(rawQuery).slice(0, 200);
      const current = ++generation;
      controller?.abort();
      controller = new AbortController();
      state.query = query;
      state.failures = [];
      const cacheKey = query.toLocaleLowerCase();
      const saved = cache.get(cacheKey);
      if (!refresh && saved && now() - saved.at < 300000) { state.tracks = saved.tracks; state.duplicates = saved.duplicates; state.pending = 0; emit(); return state.tracks; }
      const groups = new Map();
      const sources = query ? MUSIC_SOURCES : [{ id: 'browse', label: 'Featured music' }];
      state.pending = sources.length;
      state.duplicates = 0;
      if (query) state.tracks = [];
      emit();
      const parentSignal = controller.signal;
      await Promise.allSettled(sources.map(async source => {
        const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(timeout)]);
        try {
          const path = source.id === 'browse' ? '/api/music/browse' : '/api/music/search?' + new URLSearchParams({ q: query, source: source.id, limit: '40' });
          const data = await untilAborted(Promise.resolve().then(() => fetchJson(path, { signal })), signal);
          if (generation !== current || signal.aborted) return;
          const rows = source.id === 'browse' ? Object.values(data.rows || {}).filter(Array.isArray).flat().slice(0, MAX_TRACKS) : data.items;
          groups.set(source.id, normalizeMusicEntries(rows, source.id));
          const ordered = sources.map(item => groups.get(item.id) || []);
          state.tracks = mergeMusicTracks(ordered);
          state.duplicates = ordered.reduce((sum, tracks) => sum + tracks.length, 0) - state.tracks.length;
        } catch (error) {
          if (generation === current && !parentSignal.aborted) state.failures.push(source.label + ': ' + (signal.aborted ? 'timed out' : shortText(error.message)));
        } finally { if (generation === current) { state.pending--; emit(); } }
      }));
      if (generation === current && !state.failures.length) {
        cache.delete(cacheKey);
        if (cache.size >= 8) cache.delete(cache.keys().next().value);
        cache.set(cacheKey, { at: now(), tracks: state.tracks, duplicates: state.duplicates });
      }
      return state.tracks;
    }
  };
}

export function createMusicPlayer({ audio, resolveUrl, onChange = () => {}, random = Math.random } = {}) {
  let generation = 0;
  let variants = [];
  let variantIndex = 0;
  const state = { queue: [], index: -1, current: null, variant: null, playing: false, loading: false, error: '', shuffle: false, repeat: 'off' };
  audio.preload = 'none';
  audio.crossOrigin = 'anonymous';
  const emit = () => onChange({ ...state });
  const load = async index => {
    if (!state.current || !variants[index]) return;
    const current = ++generation;
    variantIndex = index;
    state.variant = variants[index];
    state.error = '';
    state.loading = true;
    state.playing = false;
    audio.pause();
    audio.removeAttribute('src');
    emit();
    try {
      const url = await resolveUrl(state.variant);
      if (current !== generation) return;
      audio.src = url;
      await audio.play();
      if (current !== generation) return;
      state.playing = true;
      state.loading = false;
    } catch (error) {
      if (current !== generation) return;
      state.loading = false;
      state.error = error?.name === 'NotAllowedError' ? 'Press Play to start this track.' : 'This source could not play the track. Try another source.';
    }
    emit();
  };
  const api = {
    snapshot() { return { ...state }; },
    async play(track, queue = [track]) {
      state.queue = queue.slice(0, MAX_TRACKS);
      state.index = state.queue.findIndex(item => item.key === track.key);
      if (state.index < 0) { state.queue = [track]; state.index = 0; }
      state.current = track;
      variants = track.variants?.length ? track.variants : [track];
      return load(0);
    },
    async toggle() {
      if (!state.current) return;
      if (state.playing || state.loading) { generation++; audio.pause(); state.playing = false; state.loading = false; emit(); return; }
      if (!audio.getAttribute('src')) return load(variantIndex);
      try { await audio.play(); state.playing = true; state.error = ''; } catch { state.error = 'Unable to resume. Select a track or another source.'; }
      emit();
    },
    async next(direction = 1, ended = false) {
      if (!state.queue.length) return;
      if (ended && state.repeat === 'one') { audio.currentTime = 0; return api.toggle(); }
      let index = state.index + direction;
      if (state.shuffle && direction > 0 && state.queue.length > 1) index = (state.index + 1 + Math.floor(random() * (state.queue.length - 1))) % state.queue.length;
      if (index >= state.queue.length) { if (state.repeat === 'all' || !ended) index = 0; else { state.playing = false; emit(); return; } }
      if (index < 0) index = state.queue.length - 1;
      return api.play(state.queue[index], state.queue);
    },
    chooseSource(index) { if (Number.isInteger(index) && index >= 0 && index < variants.length) return load(index); },
    setShuffle(value) { state.shuffle = value === true; emit(); },
    setRepeat(value) { state.repeat = ['off', 'one', 'all'].includes(value) ? value : 'off'; emit(); },
    suspend() { generation++; audio.pause(); audio.removeAttribute('src'); audio.load(); state.playing = false; state.loading = false; state.error = ''; emit(); },
    stop() { generation++; audio.pause(); audio.removeAttribute('src'); audio.load(); state.current = null; state.variant = null; state.queue = []; state.index = -1; state.playing = false; state.loading = false; state.error = ''; emit(); }
  };
  audio.addEventListener('ended', () => { state.playing = false; void api.next(1, true); });
  audio.addEventListener('playing', () => { if (!state.current || !audio.getAttribute('src')) return; state.loading = false; state.playing = true; state.error = ''; emit(); });
  audio.addEventListener('pause', () => { state.playing = false; emit(); });
  audio.addEventListener('waiting', () => { if (state.current) { state.loading = true; emit(); } });
  audio.addEventListener('error', () => {
    if (!state.current || !audio.getAttribute('src')) return;
    if (variantIndex + 1 < variants.length) { void load(variantIndex + 1); return; }
    state.loading = false; state.playing = false; state.error = 'The music sources could not play this track. Select another track or retry.'; emit();
  });
  return api;
}

export function mountMusicCatalog(win = window, doc = document, { fetcher = win.fetch.bind(win), resolveApi } = {}) {
  if (win.MonkehMusic) return win.MonkehMusic;
  const element = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, action, label = text) => { const node = element('button', 'music-button', text); node.type = 'button'; node.setAttribute('aria-label', label); node.addEventListener('click', action); return node; };
  const select = label => { const node = element('select', 'music-select'); node.setAttribute('aria-label', label); return node; };
  const option = (parent, value, text) => { const item = element('option', '', text); item.value = value; parent.append(item); };
  const dialog = element('dialog', 'music-dialog');
  dialog.id = 'music-popover';
  dialog.setAttribute('aria-labelledby', 'music-heading');
  const card = element('div', 'music-card');
  const header = element('div', 'music-header');
  const heading = element('h2', '', 'Music'); heading.id = 'music-heading';
  const close = button('×', () => dialog.close(), 'Close music'); close.classList.add('music-close');
  header.append(heading, close);
  const form = element('form', 'music-search');
  const search = element('input'); search.type = 'search'; search.placeholder = 'Search all music sources'; search.maxLength = 200; search.setAttribute('aria-label', 'Search music');
  const submit = element('button', 'music-button', 'Search'); submit.type = 'submit';
  form.append(search, submit);
  const controls = element('div', 'music-controls');
  const source = select('Filter music source'); option(source, 'all', 'All sources'); MUSIC_SOURCES.forEach(item => option(source, item.id, item.label));
  const view = select('Music collection'); option(view, 'all', 'All tracks'); option(view, 'favorites', 'Favorites');
  const refresh = button('Refresh', () => void catalog.search(search.value, { refresh: true }));
  controls.append(source, view, refresh);
  const status = element('p', 'music-status'); status.setAttribute('role', 'status');
  const issues = element('details', 'music-issues'); const issuesSummary = element('summary', '', 'Source availability'); const issuesText = element('p'); issues.append(issuesSummary, issuesText); issues.hidden = true;
  const list = element('div', 'music-list'); list.setAttribute('aria-label', 'Music tracks');
  const pagination = element('div', 'music-pagination');
  let page = 1;
  const previousPage = button('Previous', () => { page--; render(); });
  const nextPage = button('Next', () => { page++; render(); });
  const pageLabel = element('span'); pagination.append(previousPage, pageLabel, nextPage);
  const playerBox = element('section', 'music-player'); playerBox.setAttribute('aria-label', 'Music player');
  const nowPlaying = element('strong', '', 'Choose a track');
  const artist = element('span', 'music-artist');
  const playControls = element('div', 'music-player-controls');
  const prev = button('‹', () => void player.next(-1), 'Previous track');
  const play = button('Play', () => void player.toggle(), 'Play or pause music');
  const next = button('›', () => void player.next(1), 'Next track');
  const shuffle = button('Shuffle', () => { player.setShuffle(!player.snapshot().shuffle); persistPlayer(); });
  const repeat = button('Repeat: off', () => { const choices = ['off', 'all', 'one']; player.setRepeat(choices[(choices.indexOf(player.snapshot().repeat) + 1) % 3]); persistPlayer(); });
  const stop = button('Stop', () => player.stop());
  playControls.append(prev, play, next, shuffle, repeat, stop);
  const audio = element('audio'); audio.hidden = true;
  const seek = element('input'); seek.type = 'range'; seek.min = '0'; seek.max = '100'; seek.step = '0.1'; seek.value = '0'; seek.disabled = true; seek.setAttribute('aria-label', 'Playback position');
  const time = element('span', 'music-time', '0:00 / 0:00');
  const volumeLabel = element('label', 'music-volume', 'Volume'); const volume = element('input'); volume.type = 'range'; volume.min = '0'; volume.max = '1'; volume.step = '.01'; volume.value = '.7'; volumeLabel.append(volume);
  const variants = select('Playback source'); variants.hidden = true;
  const playerStatus = element('p', 'music-player-status'); playerStatus.setAttribute('role', 'status');
  playerBox.append(nowPlaying, artist, playControls, seek, time, volumeLabel, variants, playerStatus, audio);
  const footnote = element('p', 'music-footnote', 'Searches all five sources together. Matching names share one row; choose a version in the player. Favorites stay on this device.');
  card.append(header, form, controls, status, issues, list, pagination, playerBox, footnote); dialog.append(card); doc.body.append(dialog);
  const launcher = button('♫ Music', () => open(), 'Open music player'); launcher.classList.add('music-mini-player'); launcher.hidden = true; doc.body.append(launcher);
  let apiOrigin;
  const apiUrl = async path => {
    if (resolveApi) return resolveApi(path);
    if (!apiOrigin) apiOrigin = (await win.MonkehConfig.fetchConfig()).proxyOrigin;
    return new URL(path, apiOrigin).href;
  };
  let seeded = false;
  let suspended = false;
  let showCovers = win.MonkehPrivacy?.get().showCovers !== false;
  let resumeQuery = null;
  let data = { tracks: [], failures: [], pending: 0, duplicates: 0, query: '' };
  const favorites = new Map();
  try {
    const saved = JSON.parse(win.localStorage.getItem(FAVORITES_KEY) || '[]');
    for (const track of mergeMusicTracks([normalizeMusicEntries(Array.isArray(saved) ? saved.slice(0, 200) : [])])) favorites.set(track.key, track);
  } catch {}
  const saveFavorites = () => { try { win.localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites.values()].slice(-200).map(track => track.variants[0]))); } catch {} };
  const catalog = createMusicCatalog({ fetchJson: async (path, options) => fetchMusicJson(fetcher, await apiUrl(path), options), onChange(snapshot) { data = snapshot; render(); } });
  const persistPlayer = () => { try { const state = player.snapshot(); win.localStorage.setItem(PLAYER_KEY, JSON.stringify({ volume: audio.volume, shuffle: state.shuffle, repeat: state.repeat })); } catch {} };
  let displayedTrack;
  const player = createMusicPlayer({ audio, resolveUrl: track => apiUrl(musicStreamPath(track)), onChange(state) {
    nowPlaying.textContent = state.current?.title || 'Choose a track';
    artist.textContent = state.variant ? state.variant.artist + ' · ' + SOURCE_LABELS.get(state.variant.source) : '';
    play.textContent = state.playing ? 'Pause' : state.loading ? 'Pause' : 'Play';
    play.disabled = prev.disabled = next.disabled = stop.disabled = !state.current;
    shuffle.setAttribute('aria-pressed', String(state.shuffle)); repeat.textContent = 'Repeat: ' + state.repeat;
    playerStatus.textContent = state.error || (state.loading ? 'Loading audio…' : '');
    launcher.hidden = !state.current; launcher.textContent = state.current ? (state.playing ? '♫ ' : 'Ⅱ ') + state.current.title : '♫ Music';
    if (displayedTrack !== state.current) {
      displayedTrack = state.current;
      variants.replaceChildren();
      state.current?.variants.forEach((track, index) => option(variants, String(index), SOURCE_LABELS.get(track.source) + ' · ' + track.artist));
      variants.hidden = !state.current || state.current.variants.length < 2;
    }
    if (state.current) variants.value = String(state.current.variants.indexOf(state.variant));
    for (const row of list.children) row.toggleAttribute('data-playing', row.dataset.key === state.current?.key && state.playing);
  } });
  function filtered() {
    const tracks = view.value === 'favorites' ? [...favorites.values()] : data.tracks;
    return tracks.filter(track => source.value === 'all' || track.variants.some(variant => variant.source === source.value)).map(track => preferMusicSource(track, source.value));
  }
  function render() {
    const tracks = filtered();
    const pages = Math.max(1, Math.ceil(tracks.length / 40)); page = Math.max(1, Math.min(pages, page));
    list.replaceChildren();
    const current = player?.snapshot();
    for (const track of tracks.slice((page - 1) * 40, page * 40)) {
      const row = element('div', 'music-track'); row.dataset.key = track.key;
      row.toggleAttribute('data-playing', track.key === current?.current?.key && current.playing);
      const launch = button('', () => void player.play(track, tracks), 'Play ' + track.title + ' by ' + track.artist); launch.className = 'music-track-play';
      if (track.artwork && showCovers) { const image = element('img', 'music-art'); image.src = track.artwork; image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; image.addEventListener('error', () => image.remove(), { once: true }); launch.append(image); }
      const info = element('span', 'music-track-info'); info.append(element('strong', '', track.title), element('small', '', track.artist + (track.explicit ? ' · Explicit' : '') + ' · ' + [...new Set(track.variants.map(variant => SOURCE_LABELS.get(variant.source)))].join(', '))); launch.append(info);
      const favorite = button(favorites.has(track.key) ? '★' : '☆', () => {
        if (favorites.has(track.key)) favorites.delete(track.key);
        else { if (favorites.size >= 200) favorites.delete(favorites.keys().next().value); favorites.set(track.key, track); }
        saveFavorites(); render();
      }, (favorites.has(track.key) ? 'Unfavorite ' : 'Favorite ') + track.title); favorite.classList.add('music-favorite'); favorite.setAttribute('aria-pressed', String(favorites.has(track.key)));
      row.append(launch, favorite); list.append(row);
    }
    if (!tracks.length) list.append(element('p', 'music-empty', data.pending ? 'Searching music sources…' : view.value === 'favorites' ? 'Save tracks with the star to find them here.' : 'No tracks found. Try a song or artist name.'));
    status.textContent = tracks.length.toLocaleString() + ' tracks' + (data.pending ? ' · ' + data.pending + ' sources loading' : '') + (data.duplicates ? ' · ' + data.duplicates + ' duplicate results combined' : '');
    issues.hidden = !data.failures.length; issuesText.textContent = data.failures.join(' · ');
    previousPage.disabled = page === 1; nextPage.disabled = page === pages; pageLabel.textContent = page + ' / ' + pages;
  }
  const durationText = seconds => { const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0; return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0'); };
  const updateTime = () => { const duration = Number.isFinite(audio.duration) ? audio.duration : 0; seek.disabled = !duration; seek.value = duration ? String(audio.currentTime / duration * 100) : '0'; time.textContent = durationText(audio.currentTime) + ' / ' + durationText(duration); };
  audio.addEventListener('timeupdate', updateTime); audio.addEventListener('durationchange', updateTime); audio.addEventListener('emptied', updateTime);
  seek.addEventListener('input', () => { if (Number.isFinite(audio.duration)) audio.currentTime = Number(seek.value) / 100 * audio.duration; });
  volume.addEventListener('input', () => { audio.volume = Number(volume.value); persistPlayer(); });
  variants.addEventListener('change', () => void player.chooseSource(Number(variants.value)));
  source.addEventListener('change', () => { page = 1; render(); }); view.addEventListener('change', () => { page = 1; render(); });
  form.addEventListener('submit', event => { event.preventDefault(); page = 1; view.value = 'all'; void catalog.search(search.value); });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { catalog.cancel(); launcher.hidden = !player.snapshot().current; });
  win.addEventListener('monkeh:privacy', event => { const next = event.detail?.showCovers !== false; if (showCovers !== next) { showCovers = next; render(); } });
  win.addEventListener('pagehide', () => { suspended = true; resumeQuery = dialog.open && (data.pending || !data.tracks.length) ? data.query : null; catalog.cancel(); player.suspend(); });
  win.addEventListener('pageshow', () => { suspended = false; render(); if (dialog.open && resumeQuery !== null) void catalog.search(resumeQuery); resumeQuery = null; });
  try {
    const saved = JSON.parse(win.localStorage.getItem(PLAYER_KEY) || '{}');
    if (typeof saved.volume === 'number' && Number.isFinite(saved.volume)) volume.value = String(Math.max(0, Math.min(1, saved.volume)));
    audio.volume = Number(volume.value); player.setShuffle(saved.shuffle); player.setRepeat(saved.repeat);
  } catch { audio.volume = .7; }
  async function open() {
    if (!dialog.open) dialog.showModal(); search.focus();
    if (!seeded) {
      seeded = true;
      try {
        const snapshot = await fetchMusicJson(fetcher, '/browser-tools/music-catalog.json', { signal: AbortSignal.timeout(5000) });
        catalog.seed(normalizeMusicSnapshot(snapshot));
      } catch {}
      if (dialog.open && !suspended && !data.query) void catalog.search('');
    }
  }
  render();
  win.MonkehMusic = { open, close: () => dialog.close(), stop: () => player.stop() };
  return win.MonkehMusic;
}
