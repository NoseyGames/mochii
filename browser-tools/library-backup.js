import { defaults, normalizePrivacy } from './privacy.js';
import { validatePatterns } from './userscripts.js';
import { normalizeMusicFavorites, normalizeMusicPlaylists, normalizeMusicPlayerSettings } from './music-library.js';

export const MAX_BACKUP_BYTES = 8 * 1024 * 1024;
export const LIBRARY_CATEGORIES = Object.freeze({ preferences: 'Preferences', games: 'Games', music: 'Music', bookmarks: 'Bookmarks', userscripts: 'Userscripts' });
export const LIBRARY_KEYS = Object.freeze({
  preferences: Object.freeze(['mochii.privacy.v1']),
  games: Object.freeze(['mochii.games.favorites.v1', 'mochii.games.recents.v1', 'mochii.games.preferences.v1']),
  music: Object.freeze(['mochii.music.favorites.v1', 'mochii.music.playlists.v1', 'mochii.music.player.v1']),
  bookmarks: Object.freeze(['mochii.browser.bookmarks.v1']),
  userscripts: Object.freeze(['mochii.userscripts.v1'])
});
const sources = ['all', 'securly', 'gn-math', 'seraph', 'hydra', '3kh0', 'ports', 'tglsc', 'cherri-ckv', 'cherri-seraph', 'cherri-truffled', 'cherri-ugs', 'cherri-gn-math'];
const gameOrigins = Object.freeze({ securly: 'https://cdn.jsdelivr.net', 'gn-math': 'https://photos.tram-gallery.ru', seraph: 'https://photos.tram-gallery.ru', hydra: 'https://cdn.jsdelivr.net', '3kh0': 'https://cdn.jsdelivr.net', ports: 'https://photos.tram-gallery.ru', tglsc: 'https://photos.tram-gallery.ru', 'cherri-ckv': 'https://wanocapy.github.io', 'cherri-seraph': 'https://h35d5a9.jfs-autoelevadores.com.ar', 'cherri-truffled': 'https://h35d5a9.jfs-autoelevadores.com.ar', 'cherri-ugs': 'https://h35d5a9.jfs-autoelevadores.com.ar', 'cherri-gn-math': 'https://h35d5a9.jfs-autoelevadores.com.ar' });
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const credentialKeys = /^(?:password|passwd|pass|token|accesstoken|refreshtoken|idtoken|apikey|key|secret|clientsecret|auth|authorization|session|sessionid|signature|sig|code|assertion|xamzcredential|xamzsignature)$/i;
const bytes = value => new TextEncoder().encode(value).byteLength;
const fail = message => { throw new Error(message); };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
function object(value, label) { if (!record(value)) fail(label + ' must be an object.'); return value; }
function list(value, maximum, label) { if (!Array.isArray(value) || value.length > maximum) fail(label + ' must contain at most ' + maximum + ' entries.'); return value; }
function text(value, maximum, label, empty = false) {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value) || !empty && !value.trim()) fail(label + ' contains invalid text.');
  return value.trim();
}
function integer(value, min, max, label) { if (!Number.isInteger(value) || value < min || value > max) fail(label + ' is outside its supported range.'); return value; }
function tree(value) {
  let count = 0;
  const visit = (item, depth) => {
    if (++count > 200000 || depth > 16) fail('The backup is too complex.');
    if (!item || typeof item !== 'object') {
      if (typeof item === 'number' && !Number.isFinite(item) || !['string', 'number', 'boolean', 'object'].includes(typeof item)) fail('The backup contains unsupported values.');
      return;
    }
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail('The backup contains an unsupported object.');
    for (const key of Object.keys(item)) {
      if (unsafeKeys.has(key)) fail('The backup contains an unsafe property name.');
      visit(item[key], depth + 1);
    }
  };
  visit(value, 0);
}
function portableUrl(value, label, maximum = 4096, httpsOnly = false) {
  text(value, maximum, label);
  let url;
  try { url = new URL(value); } catch { fail(label + ' must be a complete HTTP(S) URL.'); }
  if (!(httpsOnly ? ['https:'] : ['http:', 'https:']).includes(url.protocol) || url.username || url.password || value.includes('\\')) fail(label + ' must be an HTTP(S) URL without login details.');
  for (const params of [url.searchParams, new URLSearchParams(url.hash.slice(1))]) {
    for (const key of params.keys()) if (credentialKeys.test(key.replace(/[-_]/g, ''))) fail(label + ' contains a login token or secret. Remove it before making a portable backup.');
  }
  return url.href;
}
function gameId(value) {
  text(value, 4608, 'Game ID');
  if (!value.includes('|')) fail('Game ID is invalid.');
  const split = value.indexOf('|');
  const prefix = value.slice(0, split);
  const suffix = value.slice(split + 1);
  if (prefix === 'game') { if (!/^[\p{L}\p{N}+.]{1,500}$/u.test(suffix)) fail('Canonical game ID is invalid.'); return value; }
  if (!sources.includes(prefix) || prefix === 'all') fail('Unknown game source.');
  const url = new URL(portableUrl(suffix, 'Game source URL', 4096, true));
  if (url.origin !== gameOrigins[prefix]) fail('Game source URL does not match its catalog.');
  return value;
}
function gameList(value, max, label) { return [...new Set(list(value, max, label).map(gameId))]; }
function gamePreferences(value) {
  object(value, 'Game preferences');
  if (value.version !== undefined && value.version !== 1) fail('Unsupported game preferences version.');
  const result = { version: 1 };
  const choices = { source: sources, view: ['all', 'favorites', 'recent'], sort: ['pop', 'az', 'za'], genre: ['all', 'puzzle', 'racing', 'sports', 'unknown'], players: ['all', 'local', 'online', 'unknown'], input: ['all', 'touch', 'controller', 'unknown'], shelf: ['all', 'curated'] };
  for (const [key, options] of Object.entries(choices)) if (Object.hasOwn(value, key)) { if (!options.includes(value[key])) fail('Unknown game ' + key + ' choice.'); result[key] = value[key]; }
  if (Object.hasOwn(value, 'query')) result.query = text(value.query, 200, 'Game search', true);
  if (Object.hasOwn(value, 'page')) result.page = integer(value.page, 1, 10000, 'Game page');
  if (Object.hasOwn(value, 'scrollTop')) { if (typeof value.scrollTop !== 'number' || !Number.isFinite(value.scrollTop) || value.scrollTop < 0 || value.scrollTop > 10000000) fail('Game scroll position is invalid.'); result.scrollTop = value.scrollTop; }
  if (Object.hasOwn(value, 'selectedSources')) {
    object(value.selectedSources, 'Selected game sources');
    const entries = Object.entries(value.selectedSources);
    if (entries.length > 500) fail('At most 500 game source choices can be backed up.');
    result.selectedSources = Object.fromEntries(entries.map(([id, variant]) => {
      if (!id.startsWith('game|') || typeof variant !== 'string' || variant.startsWith('game|')) fail('Game source choices need a canonical game and a catalog variant.');
      return [gameId(id), gameId(variant)];
    }));
  }
  return result;
}
function preferences(value) {
  object(value, 'Preferences');
  for (const key of ['backgroundUrl', 'panicUrl']) if (value[key]) portableUrl(value[key], 'Preference URL', 2048, true);
  const normalized = normalizePrivacy(value);
  for (const [key, fallback] of Object.entries(defaults)) if (Object.hasOwn(value, key)) {
    if (typeof value[key] !== typeof fallback) fail('Preference ' + key + ' has the wrong type.');
    if (typeof fallback === 'number' && value[key] !== normalized[key]) fail('Preference ' + key + ' is outside its supported range.');
    if (typeof fallback === 'string' && !['userAgent', 'accent', 'backgroundUrl', 'panicUrl', 'panicKey'].includes(key) && value[key] !== normalized[key] && !(key === 'cloak' && value[key] === 'monkeh')) fail('Preference ' + key + ' is unsupported.');
    if (key === 'userAgent' && (value[key].length > 512 || !/^[\x20-\x7e]*$/.test(value[key]))) fail('Browser identity is invalid.');
    if (key === 'accent' && !/^#[0-9a-f]{6}$/i.test(value[key])) fail('Accent color is invalid.');
    if (key === 'panicKey' && value[key] && !normalized.panicKey) fail('Panic shortcut is invalid.');
  }
  return normalized;
}
function trackList(value, label) {
  list(value, 200, label);
  for (const item of value) {
    object(item, label + ' track');
    const base = normalizeMusicFavorites([{ ...item, variants: [] }])[0];
    if (!base) fail(label + ' contains an invalid track.');
    const identities = new Set();
    for (const variant of [item, ...(item.variants === undefined ? [] : list(item.variants, 10, 'Track variants'))]) {
      object(variant, 'Music variant');
      const normalized = normalizeMusicFavorites([{ ...variant, variants: [] }])[0];
      if (!normalized || normalized.key !== base.key) fail(label + ' contains an invalid track or mismatched variant.');
      identities.add(normalized.source + '|' + normalized.id);
      if (variant.artwork) portableUrl(variant.artwork, 'Artwork URL', 2048, true);
    }
    if (identities.size > 10) fail('A track can contain at most 10 source variants.');
  }
  return normalizeMusicFavorites(value);
}
function playlists(value) {
  object(value, 'Music playlists');
  if (value.version !== 1) fail('Unsupported music playlists version.');
  const seen = new Set();
  for (const item of list(value.playlists, 30, 'Music playlists')) {
    object(item, 'Playlist');
    if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(item.id) || seen.has(item.id)) fail('Playlist IDs must be valid and unique.');
    seen.add(item.id);
    text(item.name, 64, 'Playlist name');
    trackList(item.tracks, 'Playlist');
  }
  return normalizeMusicPlaylists(value);
}
function player(value) {
  object(value, 'Music player settings');
  if (Object.hasOwn(value, 'volume') && (typeof value.volume !== 'number' || !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 1)) fail('Music volume must be between 0 and 1.');
  for (const key of ['shuffle', 'remember']) if (Object.hasOwn(value, key) && typeof value[key] !== 'boolean') fail('Music ' + key + ' must be true or false.');
  if (Object.hasOwn(value, 'repeat') && !['off', 'one', 'all'].includes(value.repeat)) fail('Music repeat option is invalid.');
  if (value.session !== undefined) {
    object(value.session, 'Music resume position');
    trackList([value.session.track], 'Resume track');
    trackList(value.session.queue, 'Music queue');
    if (typeof value.session.position !== 'number' || !Number.isFinite(value.session.position) || value.session.position < 0 || value.session.position > 86400) fail('Music resume position is invalid.');
  }
  return normalizeMusicPlayerSettings(value);
}
function bookmarks(value) {
  const seen = new Set();
  return list(value, 40, 'Bookmarks').map(item => {
    object(item, 'Bookmark');
    const id = text(item.id, 100, 'Bookmark ID');
    if (!/^[A-Za-z0-9_-]+$/.test(id) || seen.has(id)) fail('Bookmark IDs must be valid and unique.');
    seen.add(id);
    return { id, title: text(item.title, 120, 'Bookmark title'), url: portableUrl(item.url, 'Bookmark URL') };
  });
}
function userscripts(value, disable = false) {
  const seen = new Set();
  return list(value, 50, 'Userscripts').map(item => {
    object(item, 'Userscript');
    const id = text(item.id, 100, 'Userscript ID');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || seen.has(id)) fail('Userscript IDs must be valid and unique.');
    seen.add(id);
    validatePatterns(item.match);
    if (typeof item.code !== 'string' || item.code.length > 100000 || item.enabled !== undefined && typeof item.enabled !== 'boolean') fail('Userscript code or enabled state is invalid.');
    return { id, name: text(item.name, 100, 'Userscript name'), match: item.match.trim(), code: item.code, enabled: !disable && item.enabled === true };
  });
}
function category(name, value) {
  if (name === 'preferences') return preferences(value);
  if (name === 'bookmarks') return bookmarks(value);
  if (name === 'userscripts') return userscripts(value);
  object(value, LIBRARY_CATEGORIES[name]);
  if (name === 'games') return { favorites: gameList(value.favorites === undefined ? [] : value.favorites, 500, 'Favorite games'), recent: gameList(value.recent === undefined ? [] : value.recent, 50, 'Recent games'), preferences: gamePreferences(value.preferences === undefined ? {} : value.preferences) };
  return { favorites: trackList(value.favorites === undefined ? [] : value.favorites, 'Favorite music'), playlists: playlists(value.playlists === undefined ? { version: 1, playlists: [] } : value.playlists), player: player(value.player === undefined ? {} : value.player) };
}
function selectedCategories(selected) {
  const values = selected === undefined ? Object.keys(LIBRARY_CATEGORIES) : selected;
  if (!Array.isArray(values) || !values.length || values.some(key => !Object.hasOwn(LIBRARY_CATEGORIES, key))) fail('Choose at least one supported backup category.');
  return [...new Set(values)];
}
function read(storage, key, fallback) {
  let raw;
  try { raw = storage.getItem(key); if (raw == null) raw = storage.getItem(key.replace(/^mochii\./, 'monkeh.')); }
  catch { fail('Browser storage is blocked. Allow site storage and try again.'); }
  if (raw == null) return fallback;
  if (typeof raw !== 'string' || bytes(raw) > MAX_BACKUP_BYTES) fail('Saved library data is too large.');
  let result;
  try { result = JSON.parse(raw); } catch { fail('Saved ' + key + ' contains invalid JSON. Repair it or exclude that category.'); }
  tree(result);
  return result;
}
function readCategory(storage, name) {
  const keys = LIBRARY_KEYS[name];
  if (name === 'preferences') return read(storage, keys[0], defaults);
  if (name === 'games') return { favorites: read(storage, keys[0], []), recent: read(storage, keys[1], []), preferences: read(storage, keys[2], {}) };
  if (name === 'music') return { favorites: read(storage, keys[0], []), playlists: read(storage, keys[1], { version: 1, playlists: [] }), player: read(storage, keys[2], {}) };
  return read(storage, keys[0], []);
}
export function createLibraryBackup(storage, { selected, now = new Date() } = {}) {
  const categories = {};
  for (const name of selectedCategories(selected)) categories[name] = category(name, readCategory(storage, name));
  const result = { app: 'mochii', type: 'library-backup', version: 1, createdAt: now.toISOString(), categories };
  if (bytes(JSON.stringify(result)) > MAX_BACKUP_BYTES) fail('The selected library exceeds 8 MB. Export fewer categories at a time.');
  return result;
}
export function parseLibraryBackup(value) {
  if (typeof value !== 'string' || bytes(value) > MAX_BACKUP_BYTES) fail('Choose a Mochii library JSON file no larger than 8 MB.');
  let input;
  try { input = JSON.parse(value); } catch { fail('This file is not valid JSON.'); }
  tree(input);
  object(input, 'Backup');
  if (input.app !== 'mochii' || input.type !== 'library-backup' || input.version !== 1) fail('This is not a supported Mochii library backup.');
  if (Object.keys(input).some(key => !['app', 'type', 'version', 'createdAt', 'categories'].includes(key))) fail('The backup contains unsupported fields.');
  if (typeof input.createdAt !== 'string' || input.createdAt.length > 40 || !Number.isFinite(Date.parse(input.createdAt))) fail('The backup date is invalid.');
  object(input.categories, 'Backup categories');
  const categories = {};
  for (const name of selectedCategories(Object.keys(input.categories))) categories[name] = category(name, input.categories[name]);
  return { app: 'mochii', type: 'library-backup', version: 1, createdAt: input.createdAt, categories };
}
export function previewLibraryBackup(backup, selected = Object.keys(backup.categories)) {
  return selectedCategories(selected).filter(name => Object.hasOwn(backup.categories, name)).map(name => {
    const value = backup.categories[name];
    const details = name === 'preferences' ? Object.keys(value).length + ' settings'
      : name === 'games' ? value.favorites.length + ' favorites, ' + value.recent.length + ' recent, ' + Object.keys(value.preferences.selectedSources || {}).length + ' source choices'
        : name === 'music' ? value.favorites.length + ' favorites, ' + value.playlists.playlists.length + ' playlists, ' + (value.player.session?.queue.length || 0) + ' queued'
          : value.length + (name === 'userscripts' ? ' scripts; imported disabled' : ' saved links');
    return { id: name, label: LIBRARY_CATEGORIES[name], details };
  });
}
function union(first, second, max, label, identity = item => item) {
  const result = new Map(first.map(item => [identity(item), item]));
  for (const item of second) result.set(identity(item), item);
  if (result.size > max) fail(label + ' would exceed ' + max + ' entries. Remove some saved items before importing.');
  return [...result.values()];
}
function mergeTracks(first, second) {
  const map = new Map(first.map(item => [item.key, item]));
  for (const item of second) {
    const old = map.get(item.key);
    const variants = union(old?.variants || [], item.variants || [item], 10, 'Track variants', track => track.source + '|' + track.id);
    map.set(item.key, { ...item, variants });
  }
  if (map.size > 200) fail('A music collection would exceed 200 tracks.');
  return [...map.values()];
}
function mergeCategory(name, old, incoming) {
  if (name === 'preferences') return incoming;
  if (name === 'games') {
    const choices = { ...old.preferences.selectedSources, ...incoming.preferences.selectedSources };
    if (Object.keys(choices).length > 500) fail('Game source choices would exceed 500 entries.');
    return { favorites: union(old.favorites, incoming.favorites, 500, 'Game favorites'), recent: [...new Set([...incoming.recent, ...old.recent])].slice(0, 50), preferences: { ...old.preferences, ...incoming.preferences, selectedSources: choices } };
  }
  if (name === 'bookmarks') {
    const merged = new Map(old.map(item => [item.url, item]));
    const ids = new Set(old.map(item => item.id));
    for (const item of incoming) {
      let id = merged.get(item.url)?.id || item.id;
      if (!merged.has(item.url) && ids.has(id)) { let index = 1; while (ids.has('imported-bookmark-' + index)) index++; id = 'imported-bookmark-' + index; }
      ids.add(id); merged.set(item.url, { ...item, id });
    }
    if (merged.size > 40) fail('Bookmarks would exceed 40 entries.');
    return [...merged.values()];
  }
  if (name === 'userscripts') return union(old, userscripts(incoming, true), 50, 'Userscripts', item => item.id);
  const merged = [...old.playlists.playlists];
  for (const item of incoming.playlists.playlists) {
    const index = merged.findIndex(saved => saved.id === item.id || saved.name.toLocaleLowerCase() === item.name.toLocaleLowerCase());
    if (index < 0) merged.push(item);
    else merged[index] = { ...item, id: merged[index].id, tracks: mergeTracks(merged[index].tracks, item.tracks) };
  }
  if (merged.length > 30) fail('Music playlists would exceed 30 entries.');
  return { favorites: mergeTracks(old.favorites, incoming.favorites), playlists: { version: 1, playlists: merged }, player: incoming.player };
}
function valuesFor(name, value) {
  return name === 'games' ? [value.favorites, value.recent, value.preferences] : name === 'music' ? [value.favorites, value.playlists, value.player] : [value];
}
function writeTransaction(storage, changes) {
  const previous = new Map();
  try { for (const key of changes.keys()) previous.set(key, storage.getItem(key)); }
  catch { fail('Browser storage is blocked. Nothing was imported.'); }
  const written = [];
  try {
    for (const [key, value] of changes) {
      written.push(key);
      if (value === null) storage.removeItem(key); else storage.setItem(key, value);
    }
  } catch {
    let restored = true;
    for (const key of written.reverse()) {
      try { const value = previous.get(key); if (value === null) storage.removeItem(key); else storage.setItem(key, value); }
      catch { restored = false; }
    }
    fail(restored ? 'Saving failed: storage is full or blocked. Your previous library was restored.' : 'Saving and rollback failed. Some entries may have changed; keep your backup and allow site storage before retrying.');
  }
  return previous;
}
export function importLibraryBackup(storage, input, { selected } = {}) {
  const backup = parseLibraryBackup(typeof input === 'string' ? input : JSON.stringify(input));
  const names = selectedCategories(selected === undefined ? Object.keys(backup.categories) : selected).filter(name => Object.hasOwn(backup.categories, name));
  if (!names.length) fail('Choose a category present in this backup.');
  const changes = new Map();
  for (const name of names) {
    const merged = mergeCategory(name, category(name, readCategory(storage, name)), backup.categories[name]);
    valuesFor(name, merged).forEach((value, index) => changes.set(LIBRARY_KEYS[name][index], JSON.stringify(value)));
  }
  const previous = writeTransaction(storage, changes);
  let undone = false;
  return Object.freeze({ keys: Object.freeze([...changes.keys()]), undo() {
    if (undone) fail('This import has already been undone.');
    for (const [key, value] of changes) if (storage.getItem(key) !== value) fail('Your library changed after import. Undo was stopped to preserve those changes.');
    writeTransaction(storage, previous);
    undone = true;
    return [...previous.keys()];
  } });
}

export function mountLibraryBackup(parent, win, { notice = () => {} } = {}) {
  const doc = win.document;
  const panel = doc.createElement('div'); panel.className = 'library-backup'; panel.dataset.preferenceGroup = 'library-backup';
  const title = doc.createElement('h3'); title.textContent = 'Portable library';
  const description = doc.createElement('p'); description.className = 'setting-desc'; description.textContent = 'Move selected data between Mochii links. Saved logins, cookies and proxy sessions are excluded. Userscripts include their source when selected and import disabled.';
  const choices = doc.createElement('div'); choices.className = 'library-backup-choices';
  const checkboxes = new Map();
  for (const [id, label] of Object.entries(LIBRARY_CATEGORIES)) {
    const row = doc.createElement('label');
    const input = doc.createElement('input'); input.type = 'checkbox'; input.checked = id !== 'userscripts'; input.setAttribute('aria-label', 'Back up ' + label.toLowerCase());
    const text = doc.createElement('span'); text.textContent = label;
    row.append(input, text); choices.append(row); checkboxes.set(id, input);
  }
  const actions = doc.createElement('div'); actions.className = 'preference-actions';
  const preview = doc.createElement('div'); preview.className = 'library-backup-preview'; preview.hidden = true; preview.setAttribute('aria-live', 'polite');
  const summary = doc.createElement('p'); summary.className = 'setting-desc';
  const counts = doc.createElement('ul');
  const finalActions = doc.createElement('div'); finalActions.className = 'preference-actions';
  preview.append(summary, counts, finalActions);
  const status = doc.createElement('p'); status.className = 'setting-desc library-backup-status'; status.setAttribute('role', 'status');
  const file = doc.createElement('input'); file.type = 'file'; file.accept = 'application/json,.json'; file.hidden = true; file.setAttribute('aria-label', 'Import library JSON');
  let prepared;
  let mode;
  let transaction;
  let generation = 0;
  const selected = () => [...checkboxes].filter(([, input]) => input.checked).map(([id]) => id);
  function say(message) { status.textContent = message; notice(message); }
  function button(parent, label, action) { const node = doc.createElement('button'); node.type = 'button'; node.className = 'preference-button'; node.textContent = label; node.addEventListener('click', action); parent.append(node); return node; }
  function resetPreview() { prepared = null; preview.hidden = true; generation++; }
  function renderPreview() {
    counts.textContent = '';
    const names = selected().filter(id => Object.hasOwn(prepared.categories, id));
    for (const row of names.length ? previewLibraryBackup(prepared, names) : []) { const item = doc.createElement('li'); item.textContent = row.label + ': ' + row.details; counts.append(item); }
    summary.textContent = mode === 'import' ? 'Import merges saved items. Selected preferences and playback options replace their current values. Music never starts automatically.' : 'This file contains the categories below. Keep a copy somewhere you trust.';
    confirm.disabled = !names.length;
    confirm.textContent = mode === 'import' ? 'Import selected' : 'Download backup';
    preview.hidden = false;
  }
  const prepare = button(actions, 'Prepare export', () => {
    try { win.MochiiPrivacy?.flush?.(); prepared = createLibraryBackup(win.localStorage, { selected: selected() }); mode = 'export'; generation++; renderPreview(); say('Review the categories, then download your backup.'); }
    catch (error) { resetPreview(); say(error.message); }
  });
  const choose = button(actions, 'Choose backup', () => file.click());
  const undo = button(actions, 'Undo import', () => {
    try { const keys = transaction.undo(); transaction = null; undo.hidden = true; notify(keys); say('Import undone. Your previous library is restored.'); }
    catch (error) { say(error.message); }
  }); undo.hidden = true;
  function notify(keys) {
    if (keys.includes(LIBRARY_KEYS.preferences[0])) win.MochiiPrivacy?.sync?.(read(win.localStorage, LIBRARY_KEYS.preferences[0], defaults));
    win.dispatchEvent(new win.CustomEvent('mochii:library-import', { detail: { keys } }));
  }
  const confirm = button(finalActions, 'Download backup', () => {
    try {
      const names = selected().filter(id => Object.hasOwn(prepared.categories, id));
      if (!names.length) fail('Choose at least one category.');
      if (mode === 'import') {
        win.MochiiPrivacy?.flush?.();
        transaction = importLibraryBackup(win.localStorage, prepared, { selected: names });
        undo.hidden = false;
        notify(transaction.keys);
        resetPreview();
        say('Library imported. Userscripts stay disabled. Undo is available until these saved items change or this page closes.');
      } else {
        const output = { ...prepared, categories: Object.fromEntries(names.map(name => [name, prepared.categories[name]])) };
        const url = win.URL.createObjectURL(new Blob([JSON.stringify(output)], { type: 'application/json' }));
        const link = doc.createElement('a'); link.href = url; link.download = 'mochii-library-' + new Date().toISOString().slice(0, 10) + '.json'; doc.body.append(link); link.click(); link.remove(); win.setTimeout(() => win.URL.revokeObjectURL(url), 1000);
        say('Library backup downloaded.');
      }
    } catch (error) { say(error.message); }
  });
  button(finalActions, 'Cancel preview', () => { resetPreview(); say('Preview closed.'); });
  for (const input of checkboxes.values()) input.addEventListener('change', () => { if (prepared) { if (mode === 'export') { resetPreview(); say('Selection changed. Prepare another export to refresh the preview.'); } else renderPreview(); } });
  file.addEventListener('change', async () => {
    const current = ++generation;
    const chosen = file.files?.[0]; if (!chosen) return;
    prepared = null; preview.hidden = true; choose.disabled = prepare.disabled = true;
    try {
      if (chosen.size > MAX_BACKUP_BYTES) fail('Choose a Mochii library JSON file no larger than 8 MB.');
      const parsed = parseLibraryBackup(await chosen.text());
      if (current !== generation) return;
      prepared = parsed; mode = 'import';
      for (const [id, input] of checkboxes) input.checked = Object.hasOwn(prepared.categories, id);
      renderPreview(); say('Review this backup before importing.');
    } catch (error) { if (current === generation) say(error.message); }
    finally { file.value = ''; choose.disabled = prepare.disabled = false; }
  });
  panel.append(title, description, choices, actions, file, preview, status); parent.append(panel);
  return { panel };
}
