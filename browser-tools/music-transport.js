import { localProxyFor } from './local-proxy.js';

const MUSIC_UPSTREAM = 'https://h35d5a9.jfs-autoelevadores.com.ar';
const SOURCES = new Set(['qobuz', 'tidal', 'ytm', 'scdlp', 'soundcloud']);
const ART_ORIGINS = new Set(['https://resources.tidal.com', 'https://static.qobuz.com', 'https://yt3.googleusercontent.com', 'https://i.ytimg.com', 'https://i1.sndcdn.com']);

export function musicProviderUrl(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/music/') || path.length > 4096) throw new Error('Unknown music route.');
  const incoming = new URL(path, MUSIC_UPSTREAM);
  if (incoming.origin !== MUSIC_UPSTREAM || incoming.hash || !['/api/music/search', '/api/music/browse', '/api/music/stream'].includes(incoming.pathname)) throw new Error('Unknown music route.');
  const target = new URL(incoming.pathname, MUSIC_UPSTREAM);
  const allowed = target.pathname.endsWith('/search') ? ['q', 'limit', 'source'] : target.pathname.endsWith('/stream') ? ['id', 'source', 'title', 'artist', 'isrc', 'duration'] : [];
  for (const [key, value] of incoming.searchParams) {
    if (!allowed.includes(key) || incoming.searchParams.getAll(key).length !== 1 || value.length > (key === 'id' ? 512 : 240) || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid music parameters.');
    target.searchParams.set(key, value);
  }
  if (target.pathname.endsWith('/search')) {
    const query = target.searchParams.get('q')?.trim();
    if (!query || query.length > 200) throw new Error('Enter a search up to 200 characters.');
    target.searchParams.set('q', query);
    const limit = target.searchParams.get('limit') || '40';
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 60) throw new Error('Invalid search limit.');
    target.searchParams.set('limit', limit);
  }
  if (target.pathname.endsWith('/stream') && !target.searchParams.get('id')) throw new Error('A track is required.');
  if (!target.pathname.endsWith('/browse') && !SOURCES.has(target.searchParams.get('source'))) throw new Error('Select a supported music source.');
  const trackId = target.searchParams.get('id');
  if (trackId && !/^[A-Za-z0-9_-]{1,128}$/.test(trackId)) throw new Error('Invalid music track identifier.');
  const duration = target.searchParams.get('duration');
  if (duration !== null && (!/^\d+(\.\d+)?$/.test(duration) || Number(duration) > 86400)) throw new Error('Invalid track duration.');
  return target.href;
}

export function createMusicApi({ win = globalThis, getConfig = () => (win.MochiiConfig || win.MonkehConfig).fetchConfig(), proxy = localProxyFor(win) } = {}) {
  let pendingConfig;
  const configuration = () => pendingConfig ||= Promise.resolve().then(getConfig).catch(error => { pendingConfig = null; throw error; });
  return Object.freeze({
    async resolve(path) {
      const provider = musicProviderUrl(path);
      const config = await configuration();
      if (config.mode === 'static') return proxy.url(provider, config);
      const origin = new URL(config.proxyOrigin);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('The music backend address is invalid.');
      return new URL(path, origin.origin).href;
    },
    async artwork(value) {
      const target = new URL(value);
      if (!ART_ORIGINS.has(target.origin) || target.username || target.password || target.href.length >= 2048) throw new Error('Unsupported album artwork.');
      const config = await configuration();
      return config.mode === 'static' ? proxy.url(target.href, config) : target.href;
    },
  });
}
