import { MUSIC_SOURCES, normalizeMusicEntries, mergeMusicTracks, normalizeMusicFavorites, normalizeMusicPlaylists, normalizeMusicPlayerSettings } from './music-library.js';
export { MUSIC_SOURCES, normalizeMusicEntries, mergeMusicTracks } from './music-library.js';
import { readMigratedStorage } from './storage.js';
import { createMusicApi } from './music-transport.js';

const SOURCE_IDS = new Set(MUSIC_SOURCES.map(source => source.id));
const SOURCE_LABELS = new Map(MUSIC_SOURCES.map(source => [source.id, source.label]));
const FAVORITES_KEY = 'mochii.music.favorites.v1';
const PLAYER_KEY = 'mochii.music.player.v1';
const PLAYLISTS_KEY = 'mochii.music.playlists.v1';
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
  let response;
  try { response = await fetcher(url, { signal, credentials: 'omit', mode: 'cors', redirect: 'error', referrerPolicy: 'no-referrer' }); }
  catch (cause) { if (signal?.aborted) throw cause; throw Object.assign(new Error('Relay connection failed. Retry another server.'), { kind: 'relay', cause }); }
  if (!response.headers.get('content-type')?.includes('application/json')) { void response.body?.cancel().catch(() => {}); throw Object.assign(new Error('Music connection returned a non-JSON response. The relay or aggregator may be unavailable.'), { kind: 'connection' }); }
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
    let payload;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch (cause) { throw Object.assign(new Error('Music aggregator returned invalid JSON.'), { kind: 'provider', cause }); }
    if (!response.ok || payload?.error) throw Object.assign(new Error('Music aggregator: ' + (shortText(payload?.error) || 'HTTP ' + response.status + '.')), { kind: 'provider' });
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

export function createMusicPlayer({ audio, resolveUrl, onChange = () => {}, random = Math.random, loadTimeout = 30000 } = {}) {
  let generation = 0;
  let variants = [];
  let variantIndex = 0;
  let restorePosition = 0;
  const state = { queue: [], index: -1, current: null, variant: null, playing: false, loading: false, error: '', shuffle: false, repeat: 'off', queueRevision: 0 };
  audio.preload = 'none';
  audio.crossOrigin = 'anonymous';
  const snapshot = () => ({ ...state, queue: [...state.queue] });
  const emit = () => onChange(snapshot());
  const load = async (index, position = 0) => {
    if (!state.current || !variants[index]) return;
    const current = ++generation;
    variantIndex = index;
    state.variant = variants[index];
    state.error = '';
    state.loading = true;
    state.playing = false;
    restorePosition = position;
    audio.pause();
    audio.removeAttribute('src');
    emit();
    let timer;
    try {
      await Promise.race([
        (async () => {
          const url = await resolveUrl(state.variant);
          if (current !== generation) return;
          audio.src = url;
          await audio.play();
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Audio timed out.'), { code: 'MUSIC_TIMEOUT' })), loadTimeout); }),
      ]);
      if (current !== generation) return;
      state.playing = true;
      state.loading = false;
    } catch (error) {
      if (current !== generation) return;
      if (error?.code === 'MUSIC_TIMEOUT') { generation++; audio.pause(); audio.removeAttribute('src'); }
      state.loading = false;
      state.error = error?.name === 'NotAllowedError' ? 'Press Play to start this track.' : error?.code === 'MUSIC_TIMEOUT' ? 'Audio took too long to start. Retry another server or choose another source.' : 'Audio could not start. Retry another server or choose another source.';
    } finally { clearTimeout(timer); }
    emit();
  };
  const select = (track, index) => {
    state.current = track;
    state.index = index;
    variants = track.variants?.length ? track.variants : [track];
    variantIndex = 0;
    state.variant = variants[0];
  };
  const api = {
    snapshot,
    async play(track, queue = [track]) {
      state.queue = queue.slice(0, 200);
      let index = state.queue.findIndex(item => item === track);
      if (index < 0) index = state.queue.findIndex(item => item.key === track.key);
      if (index < 0) { state.queue = [track, ...state.queue.filter(item => item.key !== track.key)].slice(0, 200); index = 0; }
      state.queueRevision++;
      select(track, index);
      return load(0);
    },
    restore(session) {
      const saved = normalizeMusicPlayerSettings({ remember: true, session }).session;
      if (!saved) return;
      generation++;
      audio.pause(); audio.removeAttribute('src');
      state.queue = saved.queue; state.queueRevision++;
      select(saved.track, saved.index);
      restorePosition = saved.position;
      state.playing = false; state.loading = false; state.error = 'Saved playback is ready. Press Play to resume.';
      emit();
    },
    position() { return restorePosition || (Number.isFinite(audio.currentTime) ? audio.currentTime : 0); },
    async toggle() {
      if (!state.current) return;
      if (state.playing || state.loading) { generation++; audio.pause(); state.playing = false; state.loading = false; emit(); return; }
      if (!audio.getAttribute('src')) return load(variantIndex, restorePosition);
      const current = generation;
      try { await audio.play(); if (current !== generation) return; state.playing = true; state.error = ''; } catch { if (current !== generation) return; state.error = 'Unable to resume. Select a track or another source.'; }
      emit();
    },
    retry() { return load(variantIndex, api.position()); },
    async next(direction = 1, ended = false) {
      if (!state.queue.length) return;
      if (ended && state.repeat === 'one') { audio.currentTime = 0; return api.toggle(); }
      let index = state.index + direction;
      if (state.shuffle && direction > 0 && state.queue.length > 1) index = (state.index + 1 + Math.floor(random() * (state.queue.length - 1))) % state.queue.length;
      if (index >= state.queue.length) { if (state.repeat === 'all' || !ended) index = 0; else { state.playing = false; emit(); return; } }
      if (index < 0) index = state.queue.length - 1;
      return api.play(state.queue[index], state.queue);
    },
    enqueue(track, next = false) {
      if (!track?.key || state.queue.length >= 200 || track.key === state.current?.key) return false;
      const existing = state.queue.findIndex(item => item.key === track.key);
      if (existing >= 0) { state.queue.splice(existing, 1); if (existing < state.index) state.index--; }
      const index = next && state.index >= 0 ? state.index + 1 : state.queue.length;
      state.queue.splice(index, 0, track);
      state.queueRevision++;
      if (!state.current) { select(track, 0); state.error = 'Press Play to start the queue.'; }
      emit(); return true;
    },
    remove(index) {
      if (!Number.isInteger(index) || index < 0 || index >= state.queue.length) return;
      const current = index === state.index;
      const resume = state.playing;
      state.queue.splice(index, 1); state.queueRevision++;
      if (!state.queue.length) { api.stop(); return; }
      if (current) {
        generation++; audio.pause(); audio.removeAttribute('src');
        select(state.queue[Math.min(index, state.queue.length - 1)], Math.min(index, state.queue.length - 1));
        restorePosition = 0; state.loading = false; state.playing = false; state.error = '';
        if (resume) { void load(0); return; }
      } else if (index < state.index) state.index--;
      emit();
    },
    move(from, to) {
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= state.queue.length || to >= state.queue.length || from === to) return;
      const current = state.queue[state.index];
      state.queue.splice(to, 0, state.queue.splice(from, 1)[0]);
      state.index = state.queue.indexOf(current); state.queueRevision++; emit();
    },
    chooseSource(index) { if (Number.isInteger(index) && index >= 0 && index < variants.length) return load(index); },
    setShuffle(value) { state.shuffle = value === true; emit(); },
    setRepeat(value) { state.repeat = ['off', 'one', 'all'].includes(value) ? value : 'off'; emit(); },
    suspend() { generation++; restorePosition = api.position(); audio.pause(); audio.removeAttribute('src'); audio.load(); state.playing = false; state.loading = false; state.error = ''; emit(); },
    stop() { generation++; audio.pause(); audio.removeAttribute('src'); audio.load(); restorePosition = 0; state.current = null; state.variant = null; state.queue = []; state.index = -1; state.queueRevision++; state.playing = false; state.loading = false; state.error = ''; emit(); }
  };
  audio.addEventListener('loadedmetadata', () => {
    if (!restorePosition || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = Math.min(restorePosition, Math.max(0, audio.duration - .1)); restorePosition = 0;
  });
  audio.addEventListener('ended', () => { state.playing = false; void api.next(1, true); });
  audio.addEventListener('playing', () => { if (!state.current || !audio.getAttribute('src')) return; state.loading = false; state.playing = true; state.error = ''; emit(); });
  audio.addEventListener('pause', () => { state.playing = false; emit(); });
  audio.addEventListener('waiting', () => { if (state.current) { state.loading = true; emit(); } });
  audio.addEventListener('error', () => {
    if (!state.current || !audio.getAttribute('src')) return;
    if (variantIndex + 1 < variants.length) { void load(variantIndex + 1); return; }
    state.loading = false; state.playing = false; state.error = 'The music sources could not play this track. The relay or provider may be unavailable; retry another server or choose another source.'; emit();
  });
  return api;
}

export function mountMusicCatalog(win = window, doc = document, { fetcher = win.fetch.bind(win), resolveApi } = {}) {
  if (win.MochiiMusic) return win.MochiiMusic;
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
  const storageStatus = element('p', 'music-storage-status'); storageStatus.setAttribute('role', 'status'); storageStatus.hidden = true;
  const issues = element('details', 'music-issues'); const issuesSummary = element('summary', '', 'Source availability'); const issuesText = element('p'); const retrySearch = button('Retry another server', () => void retryRelay('search')); issues.append(issuesSummary, issuesText, retrySearch); issues.hidden = true;
  const list = element('div', 'music-list'); list.setAttribute('aria-label', 'Music tracks');
  const pagination = element('div', 'music-pagination');
  let page = 1;
  const previousPage = button('Previous', () => { page--; render(); });
  const nextPage = button('Next', () => { page++; render(); });
  const pageLabel = element('span'); pagination.append(previousPage, pageLabel, nextPage);
  const library = element('details', 'music-library');
  const librarySummary = element('summary', '', 'Playlists');
  const libraryControls = element('div', 'music-library-controls');
  const playlistName = element('input'); playlistName.type = 'text'; playlistName.maxLength = 64; playlistName.placeholder = 'Playlist name'; playlistName.setAttribute('aria-label', 'Playlist name');
  const createPlaylist = button('New', () => editPlaylist('create'));
  const renamePlaylist = button('Rename', () => editPlaylist('rename'));
  const deletePlaylist = button('Delete', () => editPlaylist('delete'));
  libraryControls.append(playlistName, createPlaylist, renamePlaylist, deletePlaylist);
  const libraryStatus = element('p', 'music-library-status'); libraryStatus.setAttribute('role', 'status');
  library.append(librarySummary, libraryControls, libraryStatus);
  const queueBox = element('details', 'music-queue'); const queueSummary = element('summary', '', 'Queue');
  const queueList = element('ol'); queueList.setAttribute('aria-label', 'Playback queue'); queueBox.append(queueSummary, queueList);
  const playerBox = element('section', 'music-player'); playerBox.setAttribute('aria-label', 'Music player');
  const nowPlaying = element('strong', '', 'Choose a track');
  const artist = element('span', 'music-artist');
  const playControls = element('div', 'music-player-controls');
  const prev = button('‹', () => void player.next(-1), 'Previous track');
  const play = button('Play', () => void player.toggle(), 'Play or pause music');
  const next = button('›', () => void player.next(1), 'Next track');
  const shuffle = button('Shuffle', () => { player.setShuffle(!player.snapshot().shuffle); persistPlayer(); });
  const repeat = button('Repeat: off', () => { const choices = ['off', 'all', 'one']; player.setRepeat(choices[(choices.indexOf(player.snapshot().repeat) + 1) % 3]); persistPlayer(); });
  const stop = button('Stop', () => { player.stop(); persistPlayer(); });
  playControls.append(prev, play, next, shuffle, repeat, stop);
  const audio = element('audio'); audio.hidden = true;
  const seek = element('input'); seek.type = 'range'; seek.min = '0'; seek.max = '100'; seek.step = '0.1'; seek.value = '0'; seek.disabled = true; seek.setAttribute('aria-label', 'Playback position');
  const time = element('span', 'music-time', '0:00 / 0:00');
  const volumeLabel = element('label', 'music-volume', 'Volume'); const volume = element('input'); volume.type = 'range'; volume.min = '0'; volume.max = '1'; volume.step = '.01'; volume.value = '.7'; volumeLabel.append(volume);
  const variants = select('Playback source'); variants.hidden = true;
  const playerStatus = element('p', 'music-player-status'); playerStatus.setAttribute('role', 'status');
  const retryAudio = button('Retry another server', () => void retryRelay('audio')); retryAudio.hidden = true;
  const rememberLabel = element('label', 'music-remember'); const remember = element('input'); remember.type = 'checkbox'; rememberLabel.append(remember, doc.createTextNode('Remember playback on this device'));
  const importedNotice = element('section', 'music-imported-playback'); importedNotice.hidden = true;
  const importedText = element('p', '', 'Imported playback is saved. Keep listening, or choose which queue to keep.'); importedText.setAttribute('role', 'status');
  const useImported = button('Use imported playback', () => chooseImportedPlayback(true));
  const keepCurrent = button('Keep current playback', () => chooseImportedPlayback(false));
  importedNotice.append(importedText, useImported, keepCurrent);
  playerBox.append(nowPlaying, artist, playControls, seek, time, volumeLabel, variants, playerStatus, retryAudio, rememberLabel, importedNotice, audio);
  const footnote = element('p', 'music-footnote', 'Searches all five sources together. Matching names share one row; choose a version in the player. Playlists and favorites stay on this device.');
  card.append(header, form, controls, library, storageStatus, status, issues, list, pagination, queueBox, playerBox, footnote); dialog.append(card); doc.body.append(dialog);
  const launcher = button('♫ Music', () => open(), 'Open music player'); launcher.classList.add('music-mini-player'); launcher.hidden = true; doc.body.append(launcher);
  const musicApi = resolveApi ? null : createMusicApi({ win });
  const apiUrl = resolveApi || musicApi.resolve;
  let seeded = false;
  let suspended = false;
  let showCovers = win.MochiiPrivacy?.get().showCovers !== false;
  let resumeQuery = null;
  let data = { tracks: [], failures: [], pending: 0, duplicates: 0, query: '' };
  const favorites = new Map();
  let playlists = { version: 1, playlists: [] };
  const readSaved = (key, fallback) => {
    try { return JSON.parse(readMigratedStorage(win.localStorage, key, key.replace('mochii.', 'monkeh.')) || JSON.stringify(fallback)); }
    catch { return fallback; }
  };
  const failedSaves = new Set();
  const save = (key, value) => {
    try {
      win.localStorage.setItem(key, JSON.stringify(value));
      failedSaves.delete(key);
      if (!failedSaves.size) { storageStatus.hidden = true; storageStatus.textContent = ''; }
      return true;
    } catch {
      failedSaves.add(key);
      storageStatus.textContent = 'Could not save on this device. Changes remain available here until this page closes. Free some storage or export your library from Settings.';
      storageStatus.hidden = false; return false;
    }
  };
  const reloadLibrary = () => {
    favorites.clear();
    for (const track of normalizeMusicFavorites(readSaved(FAVORITES_KEY, []))) favorites.set(track.key, track);
    playlists = normalizeMusicPlaylists(readSaved(PLAYLISTS_KEY, {}));
  };
  reloadLibrary();
  const saveFavorites = () => save(FAVORITES_KEY, normalizeMusicFavorites([...favorites.values()]));
  const savePlaylists = () => { playlists = normalizeMusicPlaylists(playlists); return save(PLAYLISTS_KEY, playlists); };
  const catalog = createMusicCatalog({ fetchJson: async (path, options) => fetchMusicJson(fetcher, await apiUrl(path), options), onChange(snapshot) { data = snapshot; render(); } });
  let playerReady = false;
  let pendingImportedSettings = null;
  const persistPlayer = () => {
    if (!playerReady || pendingImportedSettings) return;
    const state = player.snapshot();
    save(PLAYER_KEY, normalizeMusicPlayerSettings({ volume: audio.volume, shuffle: state.shuffle, repeat: state.repeat, remember: remember.checked,
      session: remember.checked && state.current ? { track: state.current, queue: state.queue, index: state.index, position: player.position() } : undefined }));
  };
  let retrying = false;
  async function retryRelay(target) {
    if (retrying || !musicApi) return;
    retrying = true; retrySearch.disabled = retryAudio.disabled = true;
    const current = player.snapshot().current;
    const query = search.value;
    if (target === 'search') catalog.cancel();
    const output = target === 'audio' ? playerStatus : issuesText;
    output.textContent = 'Connecting through another server…';
    try {
      await musicApi.retryRelay();
      if (target === 'audio' && current === player.snapshot().current) await player.retry();
      else if (target === 'search' && search.value === query && dialog.open) await catalog.search(query, { refresh: true });
    } catch (error) { output.textContent = 'Relay retry: ' + shortText(error.message, 350); }
    finally { retrying = false; retrySearch.disabled = retryAudio.disabled = false; }
  }
  const selectedPlaylist = () => playlists.playlists.find(item => 'playlist:' + item.id === view.value);
  function refreshCollections() {
    const selected = view.value;
    view.replaceChildren(); option(view, 'all', 'All tracks'); option(view, 'favorites', 'Favorites');
    for (const item of playlists.playlists) option(view, 'playlist:' + item.id, item.name);
    view.value = [...view.options].some(item => item.value === selected) ? selected : 'all';
    const current = selectedPlaylist(); renamePlaylist.disabled = deletePlaylist.disabled = !current;
  }
  function editPlaylist(action) {
    const name = shortText(playlistName.value, 64);
    let selected = selectedPlaylist();
    if (action !== 'delete' && !name) { libraryStatus.textContent = 'Enter a playlist name.'; playlistName.focus(); return; }
    if (action === 'create') {
      if (playlists.playlists.length >= 30) { libraryStatus.textContent = 'You can keep up to 30 playlists.'; return; }
      selected = { id: win.crypto.randomUUID(), name, tracks: [] }; playlists.playlists.push(selected);
    } else if (!selected) return;
    else if (action === 'rename') selected.name = name;
    else playlists.playlists = playlists.playlists.filter(item => item !== selected);
    const saved = savePlaylists();
    refreshCollections(); view.value = action === 'delete' ? 'all' : 'playlist:' + selected.id; refreshCollections();
    libraryStatus.textContent = saved ? (action === 'delete' ? 'Playlist deleted.' : 'Playlist saved.') : 'Playlist changed for this session only.';
    playlistName.value = action === 'delete' ? '' : selected.name; page = 1; render();
  }
  function trackAction(track, action) {
    if (action === 'next' || action === 'queue') {
      const added = player.enqueue(track, action === 'next');
      libraryStatus.textContent = added ? (action === 'next' ? 'Added to play next.' : 'Added to queue.') : 'This track is already playing or the queue is full.';
      if (!added) library.open = true;
      queueBox.open = true; persistPlayer(); return;
    }
    const selected = action === 'remove' ? selectedPlaylist() : playlists.playlists.find(item => action === 'add:' + item.id);
    if (!selected) return;
    if (action === 'remove') selected.tracks = selected.tracks.filter(item => item.key !== track.key);
    else if (selected.tracks.length >= 200 && !selected.tracks.some(item => item.key === track.key)) { libraryStatus.textContent = 'Each playlist can hold up to 200 tracks.'; library.open = true; return; }
    else selected.tracks = normalizeMusicFavorites([...selected.tracks, track]);
    const saved = savePlaylists(); render();
    if (saved && action !== 'remove') status.textContent = 'Saved to ' + selected.name + '.';
  }
  let renderedQueue = '';
  function renderQueue(state) {
    queueSummary.textContent = 'Queue · ' + state.queue.length;
    const revision = state.queueRevision + ':' + state.index;
    if (revision === renderedQueue) return;
    renderedQueue = revision;
    const focused = doc.activeElement?.closest?.('.music-queue-row');
    const focusIndex = focused ? [...queueList.children].indexOf(focused) : -1;
    queueList.replaceChildren();
    state.queue.forEach((track, index) => {
      const row = element('li', 'music-queue-row'); row.toggleAttribute('data-current', index === state.index);
      const launch = button(track.title, () => void player.play(track, player.snapshot().queue), 'Play ' + track.title); launch.classList.add('music-queue-title');
      const up = button('↑', () => { player.move(index, index - 1); persistPlayer(); }, 'Move ' + track.title + ' up'); up.disabled = index === 0;
      const down = button('↓', () => { player.move(index, index + 1); persistPlayer(); }, 'Move ' + track.title + ' down'); down.disabled = index === state.queue.length - 1;
      const remove = button('×', () => { player.remove(index); persistPlayer(); }, 'Remove ' + track.title + ' from queue');
      row.append(launch, up, down, remove); queueList.append(row);
    });
    if (!state.queue.length) queueList.append(element('li', 'music-empty', 'Use a track’s actions to build your queue.'));
    if (focusIndex >= 0) queueList.children[Math.min(focusIndex, queueList.children.length - 1)]?.querySelector('button')?.focus({ preventScroll: true });
  }
  let displayedTrack;
  let visibleTracks = [];
  const rows = new Map();
  const loadCover = image => {
    const source = image.dataset.src;
    if (!source || image.dataset.loading === source) return;
    if (!musicApi) { image.src = source; delete image.dataset.src; return; }
    image.dataset.loading = source;
    void musicApi.artwork(source).then(url => {
      if (image.dataset.src !== source || !image.isConnected || !dialog.open || doc.hidden || suspended) return;
      image.src = url;
      delete image.dataset.src;
    }).catch(() => { image.classList.add('music-art-missing'); }).finally(() => { delete image.dataset.loading; });
  };
  const coverObserver = typeof win.IntersectionObserver === 'function' ? new win.IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting && dialog.open && !doc.hidden && !suspended && entry.target.dataset.src) {
        loadCover(entry.target);
        coverObserver.unobserve(entry.target);
      }
    }
  }, { root: list, rootMargin: '0px' }) : null;
  const player = createMusicPlayer({ audio, resolveUrl: track => apiUrl(musicStreamPath(track)), onChange(state) {
    nowPlaying.textContent = state.current?.title || 'Choose a track';
    artist.textContent = state.variant ? state.variant.artist + ' · ' + SOURCE_LABELS.get(state.variant.source) : '';
    play.textContent = state.playing ? 'Pause' : state.loading ? 'Pause' : 'Play';
    play.disabled = prev.disabled = next.disabled = stop.disabled = !state.current;
    shuffle.setAttribute('aria-pressed', String(state.shuffle)); repeat.textContent = 'Repeat: ' + state.repeat;
    playerStatus.textContent = state.error || (state.loading ? 'Loading audio…' : '');
    retryAudio.hidden = !state.error || !musicApi;
    renderQueue(state);
    updateMediaSession(state);
    launcher.hidden = !state.current; launcher.textContent = state.current ? (state.playing ? '♫ ' : 'Ⅱ ') + state.current.title : '♫ Music';
    if (displayedTrack !== state.current) {
      displayedTrack = state.current;
      variants.replaceChildren();
      state.current?.variants.forEach((track, index) => option(variants, String(index), SOURCE_LABELS.get(track.source) + ' · ' + track.artist));
      variants.hidden = !state.current || state.current.variants.length < 2;
      if (playerReady && remember.checked) persistPlayer();
    }
    if (state.current) variants.value = String(state.current.variants.indexOf(state.variant));
    for (const row of list.children) row.toggleAttribute('data-playing', row.dataset.key === state.current?.key && state.playing);
  } });
  function filtered() {
    const tracks = view.value === 'favorites' ? [...favorites.values()] : selectedPlaylist()?.tracks || data.tracks;
    return tracks.filter(track => source.value === 'all' || track.variants.some(variant => variant.source === source.value)).map(track => preferMusicSource(track, source.value));
  }
  function render() {
    const focusedRow = doc.activeElement?.closest?.('.music-track');
    const focusedIndex = focusedRow ? Array.from(list.children).indexOf(focusedRow) : -1;
    const tracks = filtered();
    visibleTracks = tracks;
    const pages = Math.max(1, Math.ceil(tracks.length / 40)); page = Math.max(1, Math.min(pages, page));
    const current = player?.snapshot();
    const keep = new Set();
    let position = 0;
    for (const track of tracks.slice((page - 1) * 40, page * 40)) {
      keep.add(track.key);
      let entry = rows.get(track.key);
      if (!entry) {
        const row = element('div', 'music-track'); row.dataset.key = track.key;
        entry = { row, track };
        entry.launch = button('', () => void player.play(entry.track, visibleTracks)); entry.launch.className = 'music-track-play';
        entry.info = element('span', 'music-track-info'); entry.title = element('strong'); entry.meta = element('small');
        entry.info.append(entry.title, entry.meta); entry.launch.append(entry.info);
        entry.favorite = button('', () => {
          const item = entry.track;
          if (favorites.has(item.key)) favorites.delete(item.key);
          else { if (favorites.size >= 200) favorites.delete(favorites.keys().next().value); favorites.set(item.key, item); }
          saveFavorites(); render();
        }); entry.favorite.classList.add('music-favorite');
        entry.actions = select('Actions for ' + track.title); entry.actions.classList.add('music-track-actions');
        entry.actions.addEventListener('change', () => { const action = entry.actions.value; entry.actions.value = ''; trackAction(entry.track, action); });
        row.append(entry.launch, entry.favorite, entry.actions); rows.set(track.key, entry);
      }
      entry.track = track;
      entry.actions.replaceChildren(); option(entry.actions, '', '•••'); option(entry.actions, 'next', 'Play next'); option(entry.actions, 'queue', 'Add to queue');
      for (const item of playlists.playlists) option(entry.actions, 'add:' + item.id, 'Add to ' + item.name);
      if (selectedPlaylist()) option(entry.actions, 'remove', 'Remove from playlist');
      const { row, launch, favorite } = entry;
      row.toggleAttribute('data-playing', track.key === current?.current?.key && current.playing);
      launch.setAttribute('aria-label', 'Play ' + track.title + ' by ' + track.artist);
      entry.title.textContent = track.title;
      entry.meta.textContent = track.artist + (track.explicit ? ' · Explicit' : '') + ' · ' + [...new Set(track.variants.map(variant => SOURCE_LABELS.get(variant.source)))].join(', ');
      const artwork = showCovers ? track.artwork : '';
      if (entry.artwork !== artwork) {
        if (entry.image) { coverObserver?.unobserve(entry.image); entry.image.remove(); }
        entry.artwork = artwork; entry.image = null;
        if (artwork) {
          const image = element('img', 'music-art'); image.alt = ''; image.width = image.height = 42; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
          image.dataset.src = artwork; entry.image = image; launch.prepend(image);
          image.addEventListener('error', () => { image.removeAttribute('src'); image.classList.add('music-art-missing'); }, { once: true });
        }
      }
      favorite.textContent = favorites.has(track.key) ? '★' : '☆';
      favorite.setAttribute('aria-label', (favorites.has(track.key) ? 'Unfavorite ' : 'Favorite ') + track.title);
      favorite.setAttribute('aria-pressed', String(favorites.has(track.key)));
      if (list.children[position] !== row) list.insertBefore(row, list.children[position] || null);
      position++;
      if (entry.image?.dataset.src && dialog.open && !doc.hidden && !suspended) {
        if (coverObserver) coverObserver.observe(entry.image);
        else loadCover(entry.image);
      }
    }
    for (const [key, entry] of rows) if (!keep.has(key)) { if (entry.image) coverObserver?.unobserve(entry.image); entry.row.remove(); rows.delete(key); }
    for (const empty of list.querySelectorAll('.music-empty')) empty.remove();
    if (!tracks.length) list.append(element('p', 'music-empty', data.pending ? 'Searching music sources…' : view.value === 'favorites' ? 'Save tracks with the star to find them here.' : selectedPlaylist() ? 'Use track actions to add songs to this playlist.' : 'No tracks found. Try a song or artist name.'));
    if (focusedIndex >= 0 && !focusedRow.isConnected) {
      const neighbor = list.children[Math.min(focusedIndex, list.children.length - 1)];
      (neighbor?.querySelector('.music-favorite') || search).focus({ preventScroll: true });
    }
    status.textContent = tracks.length.toLocaleString() + (tracks.length === 1 ? ' track' : ' tracks') + (view.value === 'all' && data.pending ? ' · ' + data.pending + ' sources loading' : '') + (view.value === 'all' && data.duplicates ? ' · ' + data.duplicates + ' duplicate results combined' : '');
    issues.hidden = !data.failures.length; issuesText.textContent = data.failures.join(' · '); retrySearch.hidden = !musicApi;
    renamePlaylist.disabled = deletePlaylist.disabled = !selectedPlaylist();
    previousPage.disabled = page === 1; nextPage.disabled = page === pages; pageLabel.textContent = page + ' / ' + pages;
  }
  function updateMediaSession(state) {
    const session = win.navigator?.mediaSession;
    if (!session) return;
    try {
      session.playbackState = state.playing ? 'playing' : state.current ? 'paused' : 'none';
      if (!state.current) session.metadata = null;
      else if (typeof win.MediaMetadata === 'function' && (session.metadata?.title !== state.current.title || session.metadata?.artist !== (state.variant?.artist || state.current.artist))) session.metadata = new win.MediaMetadata({ title: state.current.title, artist: state.variant?.artist || state.current.artist, album: state.current.album || '' });
    } catch {}
  }
  if (win.navigator?.mediaSession) {
    const actions = {
      play: () => { if (!player.snapshot().playing) void player.toggle(); },
      pause: () => { if (player.snapshot().playing || player.snapshot().loading) void player.toggle(); },
      previoustrack: () => void player.next(-1), nexttrack: () => void player.next(1), stop: () => { player.stop(); persistPlayer(); },
      seekto: event => { if (Number.isFinite(event.seekTime) && Number.isFinite(audio.duration)) audio.currentTime = Math.max(0, Math.min(audio.duration, event.seekTime)); },
      seekbackward: event => { audio.currentTime = Math.max(0, audio.currentTime - (event.seekOffset || 10)); },
      seekforward: event => { if (Number.isFinite(audio.duration)) audio.currentTime = Math.min(audio.duration, audio.currentTime + (event.seekOffset || 10)); },
    };
    for (const [action, handler] of Object.entries(actions)) try { win.navigator.mediaSession.setActionHandler(action, handler); } catch {}
  }
  let lastPositionSave = 0;
  audio.addEventListener('timeupdate', () => {
    if (remember.checked && Date.now() - lastPositionSave > 5000) { lastPositionSave = Date.now(); persistPlayer(); }
    try { if (win.navigator?.mediaSession?.setPositionState && Number.isFinite(audio.duration) && audio.duration > 0) win.navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate || 1, position: Math.max(0, Math.min(audio.currentTime, audio.duration)) }); } catch {}
  });
  audio.addEventListener('pause', () => { if (remember.checked) persistPlayer(); });
  remember.addEventListener('change', persistPlayer);
  const durationText = seconds => { const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0; return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0'); };
  const updateTime = () => { const duration = Number.isFinite(audio.duration) ? audio.duration : 0; seek.disabled = !duration; seek.value = duration ? String(audio.currentTime / duration * 100) : '0'; time.textContent = durationText(audio.currentTime) + ' / ' + durationText(duration); };
  audio.addEventListener('timeupdate', updateTime); audio.addEventListener('durationchange', updateTime); audio.addEventListener('emptied', updateTime);
  seek.addEventListener('input', () => { if (Number.isFinite(audio.duration)) audio.currentTime = Number(seek.value) / 100 * audio.duration; });
  volume.addEventListener('input', () => { audio.volume = Number(volume.value); persistPlayer(); });
  variants.addEventListener('change', () => void player.chooseSource(Number(variants.value)));
  source.addEventListener('change', () => { page = 1; render(); }); view.addEventListener('change', () => { page = 1; playlistName.value = selectedPlaylist()?.name || ''; render(); });
  form.addEventListener('submit', event => { event.preventDefault(); page = 1; view.value = 'all'; void catalog.search(search.value); });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { coverObserver?.disconnect(); catalog.cancel(); launcher.hidden = !player.snapshot().current; });
  win.addEventListener('mochii:privacy', event => { const next = event.detail?.showCovers !== false; if (showCovers !== next) { showCovers = next; render(); } });
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) coverObserver?.disconnect(); else if (dialog.open) render(); });
  win.addEventListener('pagehide', () => { persistPlayer(); suspended = true; coverObserver?.disconnect(); resumeQuery = dialog.open && (data.pending || !data.tracks.length) ? data.query : null; catalog.cancel(); player.suspend(); });
  win.addEventListener('pageshow', () => { suspended = false; render(); if (dialog.open && resumeQuery !== null) void catalog.search(resumeQuery); resumeQuery = null; });
  const restorePreferences = (restore = false, saved = normalizeMusicPlayerSettings(readSaved(PLAYER_KEY, {}))) => {
    volume.value = String(saved.volume); audio.volume = saved.volume; remember.checked = saved.remember;
    player.setShuffle(saved.shuffle); player.setRepeat(saved.repeat);
    if (restore && saved.session) player.restore(saved.session);
  };
  function chooseImportedPlayback(useSaved) {
    const saved = pendingImportedSettings;
    if (!saved) return;
    playerReady = false; pendingImportedSettings = null; importedNotice.hidden = true;
    if (useSaved) restorePreferences(true, saved);
    playerReady = true; persistPlayer();
  }
  restorePreferences(true); playerReady = true; refreshCollections();
  win.addEventListener('mochii:library-import', event => {
    const keys = event.detail?.keys || [];
    if (keys.includes(FAVORITES_KEY) || keys.includes(PLAYLISTS_KEY)) { reloadLibrary(); refreshCollections(); render(); }
    if (keys.includes(PLAYER_KEY)) {
      const saved = normalizeMusicPlayerSettings(readSaved(PLAYER_KEY, {}));
      const state = player.snapshot();
      playerReady = false;
      pendingImportedSettings = saved.session && (state.playing || state.loading) ? saved : null;
      importedNotice.hidden = !pendingImportedSettings;
      restorePreferences(!pendingImportedSettings, saved);
      playerReady = true;
    }
  });
  async function open() {
    win.closeGamesPopover?.(); win.closeAppsPopover?.(); win.closeSettingsModal?.(); win.MochiiBookmarks?.close();
    if (!dialog.open) dialog.showModal(); search.focus(); render();
    if (!seeded) {
      seeded = true;
      try {
        const snapshot = await fetchMusicJson(fetcher, '/browser-tools/music-catalog.json', { signal: AbortSignal.timeout(5000) });
        catalog.seed(normalizeMusicSnapshot(snapshot));
      } catch {}
      if (dialog.open && !suspended && !data.query) void catalog.search('');
    } else if (!data.pending && !data.tracks.length) void catalog.search(data.query);
  }
  render();
  win.MochiiMusic = { open, close: () => dialog.close(), stop: () => player.stop() };
  win.MonkehMusic = win.MochiiMusic;
  return win.MochiiMusic;
}
