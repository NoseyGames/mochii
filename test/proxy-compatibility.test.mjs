import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const origin = 'https://proxy.test';
const proxied = url => origin + '/service/' + encodeURIComponent(url);

function worker({ clientUrl = proxied('https://game.test/play/index.html'), configuredOrigin = origin, failClients = false, staticMode = false, upstreamResponse } = {}) {
  const events = new Map();
  const forwarded = [];
  const direct = [];
  const context = vm.createContext({
    URL, Response, Proxy, Reflect,
    importScripts() {},
    __uv$config: { prefix: '/service/', encodeUrl: encodeURIComponent, decodeUrl: decodeURIComponent },
    MonkehConfig: { async fetchConfig() { return staticMode ? { mode: 'static' } : { proxyOrigin: configuredOrigin }; } },
    UVServiceWorker: class {
      route({ request }) { return request.url.startsWith(origin + '/service/'); }
      async fetch({ request }) { forwarded.push(request); return upstreamResponse || new Response('proxied'); }
    },
    async fetch(request) { direct.push(request); return new Response('direct'); },
    self: {
      location: { origin },
      clients: { async get() { if (failClients) throw new Error('Unavailable'); return clientUrl ? { url: clientUrl } : undefined; } },
      addEventListener(name, listener) { events.set(name, listener); }
    }
  });
  vm.runInContext(source, context);
  function request(url, options = {}, extra = {}) {
    const request = new Request(url, options);
    if (extra.destination) Object.defineProperty(request, 'destination', { value: extra.destination });
    let response;
    events.get('fetch')({ request, clientId: 'page-1', ...extra, respondWith(value) { response = value; } });
    return response;
  }
  return { request, forwarded, direct };
}

test('escaped same-origin paths resolve against the original game origin and retain query strings', async () => {
  const app = worker();
  assert.equal((await app.request(origin + '/assets/level.json?level=2')).status, 200);
  assert.equal(app.forwarded[0].url, proxied('https://game.test/assets/level.json?level=2'));
  assert.equal(app.forwarded[0].referrer, 'about:client');
  assert.equal(app.direct.length, 0);
});

test('escaped third-party requests go through UV without changing their destination type', async () => {
  const app = worker();
  await app.request('https://cdn.test/game.js', {}, { destination: 'script' });
  assert.equal(app.forwarded[0].url, proxied('https://cdn.test/game.js'));
  assert.equal(app.forwarded[0].destination, 'script');
  assert.equal(app.direct.length, 0);
});

test('compatibility routing preserves POST bodies, headers, methods and cancellation without replay', async () => {
  const app = worker();
  const controller = new AbortController();
  await app.request('https://api.test/save', {
    method: 'POST', body: 'progress=12', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: controller.signal
  });
  assert.equal(app.forwarded.length, 1);
  const request = app.forwarded[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.get('Content-Type'), 'application/x-www-form-urlencoded');
  assert.equal(await request.text(), 'progress=12');
  controller.abort();
  assert.equal(request.signal.aborted, true);
  assert.equal(app.direct.length, 0);
});

test('range requests retain the Range header for video players', async () => {
  const app = worker();
  await app.request('https://video.test/stream.mp4', { headers: { Range: 'bytes=1024-2047' } }, { destination: 'video' });
  assert.equal(app.forwarded[0].headers.get('Range'), 'bytes=1024-2047');
  assert.equal(app.forwarded[0].destination, 'video');
});

test('compatibility routing preserves an explicit no-referrer privacy policy', async () => {
  const app = worker();
  await app.request('https://video.test/stream.mp4', { referrer: '', referrerPolicy: 'no-referrer' });
  assert.equal(app.forwarded[0].referrer, '');
  assert.equal(app.forwarded[0].referrerPolicy, 'no-referrer');
});

test('UV runtime assets and proxy pages are left to the local host', () => {
  const app = worker();
  for (const path of ['/ultrav/uv.handler.js', '/ultrav/uv.config.js', '/bearmux/worker.js', '/bearmux/index.js?v=2.1.9', '/bearmux/epoxy/index.mjs', '/bearmux/epoxy/index.mjs?v=2.1.28', '/browser-tools/runtime.js', '/proxy-host.html', '/proxy-host', '/proxy-bootstrap.html', '/proxy-bootstrap', '/sw.js', '/flyflix-provider.html']) {
    assert.equal(app.request(origin + path), undefined, path);
  }
  assert.equal(app.forwarded.length, 0);
  assert.equal(app.direct.length, 0);
});

test('similarly named remote runtime paths still use UV', async () => {
  const app = worker();
  await app.request('https://game.test/browser-tools/game.js');
  assert.equal(app.forwarded[0].url, proxied('https://game.test/browser-tools/game.js'));
});

test('shell clients, missing clients and malformed encoded origins are never promoted to proxy clients', async () => {
  for (const clientUrl of [origin + '/proxy-host.html', origin + '/math.html', '', origin + '/service/%', proxied('javascript:alert(1)'), proxied('https://user:secret@game.test/')]) {
    const app = worker({ clientUrl });
    await app.request('https://cdn.test/image.png');
    assert.equal(app.forwarded.length, 0, clientUrl);
    assert.equal(app.direct.length, 1, clientUrl);
  }
});

test('navigation requests without a controlled client and non-HTTP resources are left alone', () => {
  const app = worker();
  assert.equal(app.request('https://game.test/', {}, { clientId: '' }), undefined);
  assert.equal(app.request('data:text/plain,test'), undefined);
});

test('unavailable client lookup fails closed without leaking the request directly', async () => {
  const app = worker({ failClients: true });
  const response = await app.request('https://cdn.test/image.png');
  assert.equal(response.type, 'error');
  assert.equal(app.forwarded.length, 0);
  assert.equal(app.direct.length, 0);
});

test('compatibility routing honors the isolated proxy origin before contacting a destination', async () => {
  const app = worker({ configuredOrigin: 'https://different-proxy.test' });
  assert.equal((await app.request('https://cdn.test/image.png')).status, 403);
  assert.equal(app.forwarded.length, 0);
  assert.equal(app.direct.length, 0);
});

test('already rewritten requests run through UV exactly once', async () => {
  const app = worker();
  await app.request(proxied('https://game.test/next'));
  assert.equal(app.forwarded.length, 1);
  assert.equal(app.forwarded[0].url, proxied('https://game.test/next'));
  assert.equal(app.direct.length, 0);
});


test('shared-origin shell and app clients keep their own pages, data and API requests local', async () => {
  for (const path of ['/math.html', '/apps/mochii-cloud.html', '/proxy-host.html']) {
    const app = worker({ clientUrl: origin + path, staticMode: true });
    const requested = ['/math', '/api/music/browse', '/data/games.json', '/assets/icon.png'].map(path => origin + path);
    for (const url of requested) assert.equal(await (await app.request(url)).text(), 'direct');
    assert.equal(app.forwarded.length, 0, path);
    assert.deepEqual(app.direct.map(request => request.url), requested, path);
  }
});

test('shared-origin proxy clients still route escaped app-like paths to the original website', async () => {
  const app = worker({ staticMode: true });
  for (const path of ['/math.html', '/api/music/browse', '/assets/level.json?level=2']) {
    assert.equal(await (await app.request(origin + path)).text(), 'proxied');
    assert.equal(app.forwarded.at(-1).url, proxied('https://game.test' + path));
  }
  const controller = new AbortController();
  await app.request(origin + '/api/save?slot=2', {
    method: 'POST', body: 'progress=12', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: controller.signal,
  });
  const request = app.forwarded.at(-1);
  assert.equal(request.url, proxied('https://game.test/api/save?slot=2'));
  assert.equal(request.method, 'POST');
  assert.equal(await request.text(), 'progress=12');
  assert.equal(request.headers.get('Content-Type'), 'application/x-www-form-urlencoded');
  controller.abort();
  assert.equal(request.signal.aborted, true);
  assert.equal(app.forwarded.length, 4);
  assert.equal(app.direct.length, 0);
});


test('static music streams preserve byte ranges and partial audio without buffering', async () => {
  const audio = new Uint8Array([1, 2, 3, 4]);
  const app = worker({ staticMode: true, clientUrl: origin + '/math.html', upstreamResponse: new Response(audio, { status: 206, headers: { 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes 1024-1027/5000', 'Accept-Ranges': 'bytes' } }) });
  const target = proxied('https://music.example/api/music/stream?id=123&source=tidal');
  const response = await app.request(target, { headers: { Range: 'bytes=1024-1027' } }, { destination: 'audio' });
  assert.equal(app.forwarded.length, 1);
  assert.equal(app.direct.length, 0);
  assert.equal(app.forwarded[0].url, target);
  assert.equal(app.forwarded[0].headers.get('Range'), 'bytes=1024-1027');
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Range'), 'bytes 1024-1027/5000');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), audio);
});
