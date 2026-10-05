import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMusic, musicUpstreamUrl, MUSIC_UPSTREAM } from '../workers/music.mjs';

const origin = 'https://monkeh-noseygames.netlify.app';
const env = { ASSIST_ALLOWED_ORIGINS: JSON.stringify([origin]) };
const request = (path, options = {}) => new Request('https://proxy.test' + path, { ...options, headers: { Origin: origin, ...options.headers } });

test('music relay accepts only fixed routes and bounded, single known parameters', () => {
  assert.equal(musicUpstreamUrl('https://proxy.test/api/music/search?q=hello&source=tidal').origin, MUSIC_UPSTREAM);
  for (const path of ['/api/music/admin', '/api/music/browse?url=https://evil.test', '/api/music/search?q=a&source=tidal&q=b', '/api/music/search?q=a&source=unknown', '/api/music/search?q=a&source=tidal&limit=99999', '/api/music/stream?source=ytm', '/api/music/stream?id=1&source=tidal&duration=-1', '/api/music/stream?id=https://evil.test/audio&source=scdlp']) assert.throws(() => musicUpstreamUrl('https://proxy.test' + path));
});

test('music CORS is exact and does not allow an arbitrary or null origin', async () => {
  let calls = 0; const fetcher = async () => { calls++; return Response.json({ items: [] }); };
  for (const value of ['https://evil.test', origin + '.evil.test', 'null']) assert.equal((await handleMusic(request('/api/music/browse', { headers: { Origin: value } }), env, fetcher)).status, 403);
  assert.equal(calls, 0);
  const preflight = await handleMusic(request('/api/music/search', { method: 'OPTIONS' }), env, fetcher);
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), origin); assert.equal(calls, 0);
});

test('explicit loopback HTTP origins support development ports and IPv6 without allowing other HTTP origins', async () => {
  const origins = ['http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000', 'http://127.0.0.1:3001', 'http://[::1]:3000', 'http://[::1]:3001'];
  const allowed = { MUSIC_ALLOWED_ORIGINS: JSON.stringify([...origins, 'http://remote.example:3000', 'http://localhost.evil.test:3000', 'http://192.168.0.1:3000']) };
  const fetcher = async () => Response.json({ items: [] });
  for (const value of origins) {
    const response = await handleMusic(request('/api/music/browse', { headers: { Origin: value } }), allowed, fetcher);
    assert.equal(response.status, 200, value);
    assert.equal(response.headers.get('access-control-allow-origin'), value);
  }
  for (const value of ['http://remote.example:3000', 'http://localhost.evil.test:3000', 'http://192.168.0.1:3000', 'http://localhost:3002', 'http://localhost:3000/', 'http://user@localhost:3000']) {
    assert.equal((await handleMusic(request('/api/music/browse', { headers: { Origin: value } }), allowed, fetcher)).status, 403, value);
  }
});

test('relay omits credentials, refuses redirects, and strips upstream cookies', async () => {
  const response = await handleMusic(request('/api/music/search?q=hi&source=qobuz', { headers: { Cookie: 'secret', Authorization: 'secret' } }), env, async (url, options) => {
    assert(url.startsWith(MUSIC_UPSTREAM + '/api/music/search?'));
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual'); assert.equal(options.headers.Cookie, undefined);
    return Response.json({ items: [] }, { headers: { 'Set-Cookie': 'upstream=secret' } });
  });
  assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await handleMusic(request('/api/music/stream?id=1&source=tidal'), env, async () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/' } }))).status, 502);
});

test('range audio streams without reading its body and retains seeking headers', async () => {
  let reads = 0;
  const body = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } }, { highWaterMark: 0 });
  const response = await handleMusic(request('/api/music/stream?id=1&source=tidal', { headers: { Range: 'bytes=0-2' } }), env, async (url, options) => {
    assert.equal(options.headers.Range, 'bytes=0-2');
    return new Response(body, { status: 206, headers: { 'Content-Type': 'audio/flac', 'Content-Range': 'bytes 0-2/99', 'Accept-Ranges': 'bytes', 'Content-Length': '3' } });
  });
  assert.equal(reads, 0); assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 0-2/99');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
});

test('relay rejects HTML and oversized JSON instead of leaking invalid parse errors', async () => {
  assert.equal((await handleMusic(request('/api/music/browse'), env, async () => new Response('<html>offline</html>', { headers: { 'Content-Type': 'text/html' } }))).status, 502);
  assert.equal((await handleMusic(request('/api/music/browse'), env, async () => Response.json({ items: [] }, { headers: { 'Content-Length': String(3 * 1024 * 1024) } }))).status, 502);
  assert.equal((await handleMusic(request('/api/music/stream?id=1&source=ytm'), env, async () => Response.json({ message: 'error' }))).status, 502);
});

test('provider HTTP errors are retained and multi-range requests are rejected', async () => {
  const unavailable = await handleMusic(request('/api/music/browse'), env, async () => Response.json({ error: 'secret detail' }, { status: 429, headers: { 'Retry-After': '60' } }));
  assert.equal(unavailable.status, 429); assert.equal(unavailable.headers.get('retry-after'), '60'); assert.equal((await unavailable.json()).error, 'The music provider returned HTTP 429.');
  assert.equal((await handleMusic(request('/api/music/stream?id=1&source=ytm', { headers: { Range: 'bytes=0-1,4-5' } }), env, async () => { throw new Error('Must not fetch'); })).status, 400);
});

test('configured rate limits stop upstream fanout', async () => {
  const response = await handleMusic(request('/api/music/browse', { headers: { 'cf-connecting-ip': '192.0.2.1' } }), { ...env, MUSIC_RATE: { limit: async () => ({ success: false }) } }, async () => { throw new Error('Must not fetch'); });
  assert.equal(response.status, 429);
});
