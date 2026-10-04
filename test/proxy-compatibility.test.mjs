import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const origin = 'https://proxy.test';
const proxied = url => origin + '/service/' + encodeURIComponent(url);

function worker({ clientUrl = proxied('https://game.test/play/index.html'), configuredOrigin = origin, failClients = false } = {}) {
  const events = new Map();
  const forwarded = [];
  const direct = [];
  const context = vm.createContext({
    URL, Response, Proxy, Reflect,
    importScripts() {},
    __uv$config: { prefix: '/service/', encodeUrl: encodeURIComponent, decodeUrl: decodeURIComponent },
    MonkehConfig: { async fetchConfig() { return { proxyOrigin: configuredOrigin }; } },
    UVServiceWorker: class {
      route({ request }) { return request.url.startsWith(origin + '/service/'); }
      async fetch({ request }) { forwarded.push(request); return new Response('proxied'); }
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
  for (const path of ['/ultrav/uv.handler.js', '/ultrav/uv.config.js', '/bearmux/worker.js', '/bearmux/epoxy/index.mjs', '/browser-tools/runtime.js', '/proxy-host.html', '/sw.js', '/flyflix-provider.html']) {
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
