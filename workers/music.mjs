export const MUSIC_UPSTREAM = 'https://h35d5a9.jfs-autoelevadores.com.ar';
const SOURCES = new Set(['qobuz', 'tidal', 'ytm', 'scdlp', 'soundcloud']);
const MAX_JSON = 2 * 1024 * 1024;

export function musicUpstreamUrl(input) {
  const incoming = new URL(input);
  const path = incoming.pathname;
  if (!['/api/music/search', '/api/music/browse', '/api/music/stream'].includes(path)) throw new Error('Unknown music route.');
  const target = new URL(path, MUSIC_UPSTREAM);
  const allowed = path.endsWith('/search') ? ['q', 'limit', 'source'] : path.endsWith('/stream') ? ['id', 'source', 'title', 'artist', 'isrc', 'duration'] : [];
  for (const [key, value] of incoming.searchParams) {
    if (!allowed.includes(key) || incoming.searchParams.getAll(key).length !== 1 || value.length > (key === 'id' ? 512 : 240) || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid music parameters.');
    target.searchParams.set(key, value);
  }
  if (path.endsWith('/search')) {
    const query = target.searchParams.get('q')?.trim();
    if (!query || query.length > 200) throw new Error('Enter a search up to 200 characters.');
    target.searchParams.set('q', query);
    const limit = target.searchParams.get('limit') || '40';
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 60) throw new Error('Invalid search limit.');
    target.searchParams.set('limit', limit);
  }
  if (path.endsWith('/stream') && !target.searchParams.get('id')) throw new Error('A track is required.');
  if (!path.endsWith('/browse') && !SOURCES.has(target.searchParams.get('source'))) throw new Error('Select a supported music source.');
  const trackId = target.searchParams.get('id');
  if (trackId && !/^[A-Za-z0-9_-]{1,128}$/.test(trackId)) throw new Error('Invalid music track identifier.');
  const duration = target.searchParams.get('duration');
  if (duration !== null && (!/^\d+(\.\d+)?$/.test(duration) || Number(duration) > 86400)) throw new Error('Invalid track duration.');
  return target;
}

function musicOrigin(request, env) {
  const origin = request.headers.get('origin');
  try {
    const allowed = JSON.parse(env.MUSIC_ALLOWED_ORIGINS || env.ASSIST_ALLOWED_ORIGINS || '[]');
    const parsed = origin ? new URL(origin) : null;
    const localHttp = parsed?.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (Array.isArray(allowed) && allowed.includes(origin) && parsed?.origin === origin && (parsed.protocol === 'https:' || localHttp)) return origin;
    if (origin === new URL(request.url).origin) return origin;
    if (!origin && request.headers.get('sec-fetch-site') === 'same-origin') return new URL(request.url).origin;
  } catch {}
  return null;
}

async function boundedJson(response, signal) {
  if (Number(response.headers.get('content-length')) > MAX_JSON) { void response.body?.cancel().catch(() => {}); throw new Error('The music catalog is too large.'); }
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) { void response.body?.cancel().catch(() => {}); throw new Error('The music provider returned a non-JSON response.'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The music provider returned an empty response.');
  const chunks = [];
  let length = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error('The music provider timed out.');
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_JSON) throw new Error('The music catalog is too large.');
      chunks.push(value);
    }
    if (signal.aborted) throw new Error('The music provider timed out.');
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

export async function handleMusic(request, env = {}, fetcher = fetch) {
  const origin = musicOrigin(request, env);
  const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'cross-origin', Vary: 'Origin' });
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Range');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  }
  const error = (status, message) => Response.json({ error: message }, { status, headers });
  if (!origin) return error(403, 'This origin cannot use music.');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (!['GET', 'HEAD'].includes(request.method)) return error(405, 'Use GET to load music.');
  let target;
  try { target = musicUpstreamUrl(request.url); } catch (failure) { return error(400, failure.message); }
  const range = request.headers.get('range');
  if (range && (!/^bytes=(?:\d+-\d*|-\d+)$/.test(range) || range.length > 80)) return error(400, 'Use one valid byte range.');
  if (env.MUSIC_RATE?.limit) {
    const key = request.headers.get('cf-connecting-ip');
    if (!key) return error(503, 'Music is unavailable on this deployment.');
    try { if (!(await env.MUSIC_RATE.limit({ key })).success) return error(429, 'Too many music requests. Try again in a minute.'); }
    catch { return error(503, 'Music is temporarily unavailable.'); }
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) controller.abort();
  const timer = setTimeout(abort, 18000);
  try {
    const upstream = await fetcher(target.href, { method: request.method, headers: range ? { Range: range } : {}, credentials: 'omit', redirect: 'manual', signal: controller.signal });
    if (upstream.status >= 300 && upstream.status < 400) { void upstream.body?.cancel().catch(() => {}); return error(502, 'The music provider returned an unsupported redirect.'); }
    if (!upstream.ok) {
      void upstream.body?.cancel().catch(() => {});
      if (upstream.headers.has('retry-after')) headers.set('Retry-After', upstream.headers.get('retry-after').slice(0, 80));
      return error(upstream.status, 'The music provider returned HTTP ' + upstream.status + '.');
    }
    if (target.pathname.endsWith('/stream')) {
      const type = upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
      if (!['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/x-flac', 'audio/ogg', 'audio/wav', 'audio/webm', 'video/mp4', 'application/octet-stream'].includes(type)) {
        void upstream.body?.cancel().catch(() => {});
        return error(502, 'The music provider did not return an audio stream.');
      }
      for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (upstream.headers.has(key)) headers.set(key, upstream.headers.get(key));
      return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
    }
    if (request.method === 'HEAD') return new Response(null, { status: upstream.status, headers });
    return Response.json(await boundedJson(upstream, controller.signal), { headers });
  } catch (failure) {
    const known = ['The music catalog is too large.', 'The music provider returned a non-JSON response.', 'The music provider returned an empty response.'];
    return error(controller.signal.aborted ? 504 : 502, controller.signal.aborted ? 'The music provider timed out.' : known.includes(failure?.message) ? failure.message : 'Cannot read the music provider response.');
  } finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); }
}
