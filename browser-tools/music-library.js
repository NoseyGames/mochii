import { normalizeCatalogTitle } from './catalog-identity.js';

export const MUSIC_SOURCES = Object.freeze([
  { id: 'qobuz', label: 'Qobuz' }, { id: 'tidal', label: 'Tidal' }, { id: 'ytm', label: 'YouTube Music' },
  { id: 'scdlp', label: 'SoundCloud alternative' }, { id: 'soundcloud', label: 'SoundCloud' }
].map(Object.freeze));
const SOURCE_IDS = new Set(MUSIC_SOURCES.map(source => source.id));
const ART_ORIGINS = new Set(['https://resources.tidal.com', 'https://static.qobuz.com', 'https://yt3.googleusercontent.com', 'https://i.ytimg.com', 'https://i1.sndcdn.com']);
const shortText = (value, max = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';

export function normalizeMusicEntries(input, sourceHint) {
  const entries = Array.isArray(input) ? input : Array.isArray(input?.items) ? input.items : [];
  const tracks = [];
  for (const entry of entries.slice(0, 1000)) {
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
    if (!item) { item = { ...track, key, variants: [] }; byName.set(key, item); identities.set(key, new Set()); }
    if (!identities.get(key).has(identity)) { identities.get(key).add(identity); item.variants.push(track); }
  }
  return [...byName.values()];
}

export function normalizeMusicFavorites(value) {
  if (!Array.isArray(value)) return [];
  const groups = value.slice(0, 200).map(track => normalizeMusicEntries([track, ...(Array.isArray(track?.variants) ? track.variants.slice(0, 10) : [])]));
  return mergeMusicTracks(groups).slice(0, 200).map(track => ({ ...track, variants: track.variants.slice(0, 10) }));
}

export function normalizeMusicPlaylists(value) {
  const ids = new Set();
  const playlists = [];
  if (value?.version === 1 && Array.isArray(value.playlists)) for (const item of value.playlists.slice(0, 30)) {
    const name = shortText(item?.name, 64);
    if (!name || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id)) continue;
    ids.add(item.id);
    playlists.push({ id: item.id, name, tracks: normalizeMusicFavorites(item.tracks) });
  }
  return { version: 1, playlists };
}

export function normalizeMusicPlayerSettings(value) {
  const settings = {
    volume: typeof value?.volume === 'number' && Number.isFinite(value.volume) ? Math.max(0, Math.min(1, value.volume)) : .7,
    shuffle: value?.shuffle === true,
    repeat: ['off', 'one', 'all'].includes(value?.repeat) ? value.repeat : 'off',
    remember: value?.remember === true,
  };
  if (settings.remember) {
    const track = normalizeMusicFavorites([value?.session?.track])[0];
    if (track) {
      let queue = normalizeMusicFavorites(value.session.queue);
      let index = queue.findIndex(item => item.key === track.key);
      if (index < 0) { queue = [track, ...queue].slice(0, 200); index = 0; }
      const position = typeof value.session.position === 'number' && Number.isFinite(value.session.position) ? Math.max(0, Math.min(86400, value.session.position)) : 0;
      settings.session = { track, queue, index, position };
    }
  }
  return settings;
}
