import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const origin = 'https://proxy.test';
const shell = 'https://shell.test';
const target = 'https://games.example/game/index.html';
const nonce = 'a'.repeat(32);
const nextNonce = 'b'.repeat(32);
const sources = Object.fromEntries(['sw.js', 'ultrav/uv.sw.js', 'ultrav/uv.bundle.js'].map(path => [path, readFileSync(new URL('../' + path, import.meta.url), 'utf8')]));
const proxied = value => origin + '/service/' + encodeURIComponent(value);
const staged = value => origin + '/__monkeh_game__/' + value;
const sourceHtml = '<!doctype html><html><head><title>A game</title></head><body><script src="engine.js"></script><img src="assets/icon.png"><script>window.gameStarted = true;</script></body></html>';

async function fixture(options = {}) {
  const listeners = new Map();
  const requests = [];
  const cached = new Map();
  const timers = new Map();
  let now = 10000;
  let nextTimer = 0;
  const clients = new Map([
    ['host-a', { id: 'host-a', url: origin + '/proxy-host.html?ua=GameBrowser%2F1' }],
    ['host-b', { id: 'host-b', url: origin + '/proxy-host.html' }],
    ['child-a', { id: 'child-a', url: origin + '/proxy-bootstrap.html?nonce=' + nonce }],
    ['child-b', { id: 'child-b', url: origin + '/proxy-bootstrap.html?nonce=' + nextNonce }],
    ['remote', { id: 'remote', url: proxied('https://remote.example/') }],
    ['shell', { id: 'shell', url: shell + '/proxy-host.html' }],
  ]);
  const cache = {
    async match(key) { return cached.has(key) ? new Response(cached.get(key)) : undefined; },
    async put(key, response) { cached.set(key, await response.text()); },
    async keys() { return [...cached.keys()].map(url => ({ url })); },
    async delete(key) { return cached.delete(typeof key === 'string' ? key : key.url); },
  };
  const context = vm.createContext({
    URL, URLSearchParams, Response, Request, Headers, ReadableStream, Uint8Array, TextEncoder, TextDecoder,
    Proxy, Reflect, EventTarget, Event, AbortController, AbortSignal, MessagePort, WebSocket, atob, btoa,
    SharedWorker: class {}, localStorage: {}, fetch,
    navigator: { userAgent: 'Real Browser' }, crossOriginIsolated: false,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    __uv$config: { prefix: '/service/', encodeUrl: encodeURIComponent, decodeUrl: decodeURIComponent },
    MonkehConfig: { async fetchConfig() { return { proxyOrigin: origin, shellOrigins: [shell] }; } },
    location: { origin },
    caches: { async open() { return cache; } },
    clients: { async get(id) { return clients.get(id); }, async matchAll() { return [...clients.values()]; }, async claim() {} },
    addEventListener(name, listener) { listeners.set(name, listener); },
    importScripts(path) { if (path === '/ultrav/uv.sw.js') vm.runInContext(sources['ultrav/uv.sw.js'], context); },
  });
  context.self = context;
  vm.runInContext(sources['ultrav/uv.bundle.js'], context);
  const Original = context.Ultraviolet;
  context.Ultraviolet = class extends Original {
    static BareClient = class {
      async fetch(url, init) {
        url = String(url);
        requests.push({ url, ...init });
        const response = await (options.fetcher?.(url, init, requests.length) ?? new Response(sourceHtml, { headers: { 'Content-Type': 'text/plain' } }));
        response.rawHeaders = Object.fromEntries(response.headers);
        response.finalURL = url;
        return response;
      }
    };
    constructor(config) {
      super(config);
      this.cookie = { db: async () => ({}), getCookies: async () => [], serialize: () => '', setCookies: async () => {} };
    }
  };
  vm.runInContext(sources['sw.js'], context);
  async function message(sender, data, usePort = true) {
    let result;
    let pending;
    const ports = usePort ? [{ postMessage(value) { result = value; }, close() {} }] : [];
    listeners.get('message')({ source: { id: sender }, data, ports, waitUntil(value) { pending = value; } });
    await pending;
    return result;
  }
  async function navigate(clientId = 'child-a', url = staged(nonce), destination = 'iframe', resultingClientId = 'game-a') {
    const request = new Request(url);
    Object.defineProperty(request, 'destination', { value: destination });
    let result;
    listeners.get('fetch')({ request, clientId, resultingClientId, respondWith(value) { result = value; } });
    return await result;
  }
  await message('host-a', { type: 'monkeh:identity:bind', clientId: 'child-a', nonce });
  await message('host-b', { type: 'monkeh:identity:bind', clientId: 'child-b', nonce: nextNonce });
  return {
    context, requests, clients, cached, message, navigate,
    prepare(sender = 'host-a', url = target, token = nonce) { return message(sender, { type: 'monkeh:game:prepare', url, nonce: token }); },
    cancel(sender = 'host-a', token = nonce) { return message(sender, { type: 'monkeh:game:cancel', nonce: token }, false); },
    size() { return vm.runInContext('gameStages.size', context); },
    bytes() { return vm.runInContext('gameBytes', context); },
    async tick(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of timers) if (timer.due <= now) { timers.delete(id); timer.callback(); }
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('game preparation uses the real UV HTML pipeline once, preserves assets and maps the consuming client identity', async () => {
  const app = await fixture();
  assert.deepEqual(JSON.parse(JSON.stringify(await app.prepare())), { ok: true, url: staged(nonce), canonicalUrl: proxied(target) });
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].headers['user-agent'], 'GameBrowser/1');
  assert.equal(app.requests[0].redirect, 'manual');
  assert.ok(app.requests[0].signal instanceof AbortSignal);
  assert.equal(app.size(), 1);
  const response = await app.navigate();
  const body = await response.text();
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(body.includes(proxied('https://games.example/game/engine.js')));
  assert.ok(body.includes(proxied('https://games.example/game/assets/icon.png')));
  assert.ok(body.includes('self.__uv$cookies'));
  assert.ok(body.includes('GameBrowser/1'));
  assert.ok(body.includes('<meta name="monkeh-game-code" content="fetched">'));
  const firstScript = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(body)[1];
  let canonical;
  vm.runInNewContext(firstScript, { history: { replaceState(state, title, url) { canonical = url; } } });
  assert.equal(canonical, proxied(target));
  assert.ok(body.indexOf('history.replaceState') < body.indexOf('self.__uv$cookies'));
  assert.equal(app.requests.length, 1);
  assert.equal(app.size(), 0);
  assert.equal(app.bytes(), 0);
  app.clients.set('game-a', { id: 'game-a', url: proxied(target) });
  await app.navigate('game-a', proxied('https://games.example/game/engine.js'), 'script', '');
  assert.equal(app.requests.at(-1).headers['user-agent'], 'GameBrowser/1');
  assert.equal((await app.navigate()).status, 410);
  await app.navigate('game-a', proxied(target));
  assert.equal(app.requests.length, 3);
  assert.ok([...app.cached.keys()].every(key => key.includes('/__monkeh_identity__/')));
});

test('default-UA views use staged documents and another view or asset fetch cannot consume them', async () => {
  const app = await fixture();
  await app.prepare('host-b', target, nextNonce);
  assert.equal((await app.navigate('child-a', staged(nextNonce))).status, 403);
  assert.equal((await app.navigate('child-b', staged(nextNonce), 'script')).status, 403);
  assert.equal(app.size(), 1);
  assert.equal(app.requests.length, 1);
  const body = await (await app.navigate('child-b', staged(nextNonce))).text();
  assert.ok(body.includes('<title>A game</title>'));
  assert.equal(app.requests.length, 1);
  assert.equal(app.size(), 0);
});

test('game preparation follows bounded manual redirects using the final URL for relative asset rewriting', async () => {
  const final = 'https://cdn.example/releases/game.html';
  const app = await fixture({ fetcher: url => url === target
    ? new Response(null, { status: 302, headers: { Location: final } })
    : new Response(sourceHtml, { headers: { 'Content-Type': 'application/octet-stream' } }) });
  const result = await app.prepare();
  assert.equal(result.ok, true);
  assert.equal(result.url, staged(nonce));
  assert.equal(result.canonicalUrl, proxied(final));
  assert.equal(app.requests.length, 2);
  const body = await (await app.navigate('child-a', result.url)).text();
  assert.ok(body.includes(proxied('https://cdn.example/releases/engine.js')));
  assert.equal(app.requests.length, 2);
});

test('untrusted senders, malformed requests and redirects into app origins never stage game code', async () => {
  const app = await fixture({ fetcher: () => new Response(null, { status: 302, headers: { Location: shell + '/math' } }) });
  for (const sender of ['remote', 'shell', 'missing']) assert.equal((await app.prepare(sender)).ok, false);
  for (const url of ['data:text/html,hi', 'https://user:pass@games.example/', shell + '/math', origin + '/sw.js']) assert.equal((await app.prepare('host-a', url)).ok, false);
  assert.equal(app.requests.length, 0);
  assert.equal((await app.prepare()).ok, false);
  assert.equal(app.requests.length, 1);
  assert.equal(app.size(), 0);
});

test('redirect loops and excessive chains are rejected without fetching forbidden destinations', async () => {
  const loop = await fixture({ fetcher: () => new Response(null, { status: 302, headers: { Location: target } }) });
  assert.match((await loop.prepare()).error, /redirect loop/);
  assert.equal(loop.requests.length, 1);
  const chain = await fixture({ fetcher: (url, init, count) => new Response(null, { status: 302, headers: { Location: 'https://games.example/' + count } }) });
  assert.match((await chain.prepare()).error, /too many/);
  assert.equal(chain.requests.length, 7);
  const missing = await fixture({ fetcher: () => new Response(null, { status: 302 }) });
  assert.match((await missing.prepare()).error, /invalid redirect/);
  assert.equal(missing.requests.length, 1);
});

test('declared legacy HTML encodings are decoded before UTF-8 rewriting', async () => {
  const bytes = Uint8Array.from(Buffer.from('<!doctype html><html><title>Caf\xe9</title><body>Pr\xe9t</body></html>', 'latin1'));
  const app = await fixture({ fetcher: () => new Response(bytes, { headers: { 'Content-Type': 'text/html; charset=iso-8859-1' } }) });
  assert.equal((await app.prepare()).ok, true);
  const response = await app.navigate();
  const body = await response.text();
  assert.ok(body.includes('Café'));
  assert.ok(body.includes('Prét'));
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
});

test('HTML source downloads become inline executable game documents after preparation', async () => {
  const app = await fixture({ fetcher: () => new Response(sourceHtml, { headers: { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="game.html"' } }) });
  assert.equal((await app.prepare()).ok, true);
  const response = await app.navigate('', staged(nonce));
  assert.equal(response.headers.get('content-disposition'), 'inline');
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.ok((await response.text()).includes('monkeh-game-code'));
  assert.equal(app.requests.length, 1);
});

test('failed, binary and non-HTML source responses are rejected before any frame executes', async () => {
  for (const [body, status, type, expected] of [
    ['not found', 404, 'text/html', /HTTP 404/],
    ['{"game":"data"}', 200, 'application/json', /HTML game page/],
    ['\u0000asm', 200, 'application/wasm', /HTML game page/],
    ['<html>\u0000bad</html>', 200, 'application/octet-stream', /HTML game page/],
  ]) {
    const app = await fixture({ fetcher: () => new Response(body, { status, headers: { 'Content-Type': type } }) });
    const result = await app.prepare();
    assert.equal(result.ok, false);
    assert.match(result.error, expected);
    assert.equal(app.size(), 0);
    assert.equal(app.bytes(), 0);
  }
});

test('bounded game readers reject declared and streamed oversize code and account for the shared budget', async () => {
  const app = await fixture({ fetcher: () => new Response(sourceHtml, { headers: { 'Content-Length': String(32 * 1024 * 1024 + 1) } }) });
  assert.match((await app.prepare()).error, /size limit/);
  app.context.testResponse = new Response('12345');
  assert.equal(await vm.runInContext(`(async()=>{
    const record = { owner:'unit', nonce:'unit', bytes:0, controller:new AbortController() };
    gameStages.set(record.owner,record);
    try { await readGameBytes(testResponse,4,record); return false; }
    catch(error) { return error.gamePreparation && error.message.includes('size limit'); }
    finally { discardGameStage(record); }
  })()`, app.context), true);
  assert.equal(vm.runInContext(`(()=>{
    const record = { owner:'unit', nonce:'unit', bytes:0, controller:new AbortController() };
    gameStages.set(record.owner,record);
    try { reserveGameBytes(record,gameLimits.total+1); return false; }
    catch(error) { return error.gamePreparation && error.message.includes('large games'); }
    finally { discardGameStage(record); }
  })()`, app.context), true);
  assert.equal(app.bytes(), 0);
});

test('cancellation signals the upstream fetch and stale completion cannot replace a newer game', async () => {
  let release;
  const app = await fixture({ fetcher: (url, init, count) => count === 1 ? new Promise(resolve => { release = () => resolve(new Response(sourceHtml)); }) : new Response(sourceHtml) });
  const old = app.prepare();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const fresh = await app.prepare('host-a', 'https://games.example/new.html', nextNonce);
  assert.equal(fresh.ok, true);
  assert.equal((await old).ok, false);
  assert.equal(app.requests[0].signal.aborted, true);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.size(), 1);
  await app.cancel('host-a', nonce);
  assert.equal(app.size(), 1);
  await app.cancel('host-b', nextNonce);
  assert.equal(app.size(), 1);
  await app.cancel('host-a', nextNonce);
  assert.equal(app.size(), 0);
  assert.equal(app.bytes(), 0);
});

test('a transport ignoring abort cannot accumulate unlimited in-flight game fetches', async () => {
  const releases = [];
  const app = await fixture({ fetcher: () => new Promise(resolve => releases.push(() => resolve(new Response(sourceHtml)))) });
  for (let index = 0; index < 8; index++) {
    const pending = app.prepare();
    while (app.requests.length <= index) await new Promise(resolve => setImmediate(resolve));
    await app.cancel();
    assert.equal((await pending).ok, false);
  }
  assert.match((await app.prepare()).error, /requests are still loading/);
  assert.equal(app.requests.length, 8);
  releases.forEach(release => release());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vm.runInContext('gameFetches', app.context), 0);
  assert.equal(app.size(), 0);
});

test('stalled fetches time out, completed stages expire, and closed owners cannot consume them', async () => {
  const slow = await fixture({ fetcher: () => new Promise(() => {}) });
  const pending = slow.prepare();
  while (!slow.requests.length) await new Promise(resolve => setImmediate(resolve));
  await slow.tick(30000);
  assert.match((await pending).error, /too long/);
  assert.equal(slow.requests[0].signal.aborted, true);
  assert.equal(slow.size(), 0);
  const expired = await fixture();
  await expired.prepare();
  await expired.tick(30000);
  assert.equal(expired.size(), 0);
  assert.equal((await expired.navigate()).status, 410);
  assert.equal(expired.requests.length, 1);
  const closed = await fixture();
  await closed.prepare();
  closed.clients.delete('host-a');
  assert.equal((await closed.navigate()).status, 410);
  assert.equal(closed.requests.length, 1);
  assert.equal(closed.size(), 0);
});

test('a slow successful preparation still receives the full retention window', async () => {
  let release;
  const app = await fixture({ fetcher: () => new Promise(resolve => { release = () => resolve(new Response(sourceHtml)); }) });
  const pending = app.prepare();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await app.tick(29000);
  release();
  assert.equal((await pending).ok, true);
  await app.tick(2000);
  assert.equal(app.size(), 1);
  await app.navigate();
  assert.equal(app.requests.length, 1);
});

test('navigation with an empty clientId consumes the capability once and binds resultingClientId', async () => {
  const app = await fixture();
  const ready = await app.prepare();
  const response = await app.navigate('', ready.url, 'iframe', 'new-game');
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes('monkeh-game-code'));
  assert.equal(app.requests.length, 1);
  app.clients.set('new-game', { id: 'new-game', url: ready.canonicalUrl });
  await app.navigate('new-game', proxied('https://games.example/game/engine.js'), 'script', '');
  assert.equal(app.requests.at(-1).headers['user-agent'], 'GameBrowser/1');
  assert.equal((await app.navigate('', ready.url)).status, 410);
  assert.equal(app.requests.length, 2);
});

test('capabilities cannot collide across owners and unknown stage URLs never reach the upstream', async () => {
  const app = await fixture();
  await app.prepare();
  assert.equal((await app.prepare('host-b', target, nonce)).ok, false);
  assert.equal(app.size(), 1);
  assert.equal((await app.navigate('', staged(nextNonce))).status, 410);
  assert.equal((await app.navigate('', staged(nonce) + '?extra=1')).status, 410);
  assert.equal(app.requests.length, 1);
  assert.equal((await app.navigate('', staged(nonce))).status, 200);
});

test('Cloudflare extensionless host and bootstrap clients can prepare and execute a game', async () => {
  const app = await fixture();
  app.clients.set('host-a', { id: 'host-a', url: origin + '/proxy-host?ua=Cloudflare%2F1&loadCode=1' });
  app.clients.set('child-a', { id: 'child-a', url: origin + '/proxy-bootstrap?nonce=' + nonce });
  assert.equal((await app.message('host-a', { type: 'monkeh:identity:bind', clientId: 'child-a', nonce })).ok, true);
  const ready = await app.prepare();
  assert.equal(ready.ok, true);
  assert.equal(app.requests[0].headers['user-agent'], 'Cloudflare/1');
  const response = await app.navigate('', ready.url);
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes('monkeh-game-code'));
  assert.equal(app.requests.length, 1);
});
