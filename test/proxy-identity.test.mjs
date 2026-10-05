import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { cleanUserAgent, proxyViewUrl } from '../browser-tools/proxy-identity.js';

const origin = 'https://proxy.test';
const source = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const uvSource = readFileSync(new URL('../ultrav/uv.sw.js', import.meta.url), 'utf8');
const bundleSource = readFileSync(new URL('../ultrav/uv.bundle.js', import.meta.url), 'utf8');
const proxied = target => origin + '/service/' + encodeURIComponent(target);

function worker(clients = new Map(), stored = new Map(), options = {}) {
  const responseBody = options.body || '<!doctype html><html><body>Test</body></html>';
  const events = new Map();
  const requests = [];
  const responses = [];
  const injections = [];
  const cacheCalls = { reads: 0, writes: 0, opens: 0 };
  const cache = {
    async match(key) { cacheCalls.reads++; key = typeof key === 'string' ? key : key.url; return stored.has(key) ? new Response(stored.get(key)) : undefined; },
    async put(key, response) { cacheCalls.writes++; if (options.failWrite) throw new Error('Quota exceeded'); stored.set(key, await response.text()); },
    async keys() { return [...stored.keys()].map(url => ({ url })); },
    async delete(key) { return stored.delete(typeof key === 'string' ? key : key.url); }
  };
  class Ultraviolet {
    static EventEmitter = EventEmitter;
    static BareClient = class { async fetch(url, options) {
      requests.push({ url, ...options });
      const response = new Response(responseBody, { headers: { 'Content-Type': 'text/html' } });
      response.rawHeaders = Object.fromEntries(response.headers); response.finalURL = String(url); return response;
    } };
    constructor() {
      this.meta = {};
      this.cookie = { db: async () => ({}), getCookies: async () => [], serialize: () => '' };
      this.createHtmlInject = () => [];
      this.createJsInject = () => '';
      this.js = { rewrite: value => value };
    }
    sourceUrl(value) { return value.startsWith(origin + '/service/') ? decodeURIComponent(value.slice((origin + '/service/').length)) : value; }
    rewriteHtml(value, options) { injections.push(options.injectHead); return value; }
  }
  const context = vm.createContext({
    URL, URLSearchParams, Response, Request, Headers, ReadableStream, Uint8Array, TextEncoder, TextDecoder, Proxy, Reflect, EventTarget, Event, atob, btoa, fetch, MessagePort, WebSocket,
    SharedWorker: class {}, localStorage: {},
    navigator: { userAgent: 'Real browser' }, crossOriginIsolated: false, console,
    __uv$config: { prefix: '/service/', encodeUrl: encodeURIComponent, decodeUrl: decodeURIComponent },
    MonkehConfig: { async fetchConfig() { return { proxyOrigin: origin }; } },
    Ultraviolet, location: { origin }, caches: { async open() { cacheCalls.opens++; if (options.failOpen) throw new Error('Storage unavailable'); return cache; } },
    clients: { async get(id) { return clients.get(id); }, async matchAll() { return [...clients.values()]; }, async claim() {} },
    addEventListener(name, listener) { events.set(name, listener); },
    importScripts(path) { if (path === '/ultrav/uv.sw.js') vm.runInContext(uvSource, context); }
  });
  context.self = context;
  if (options.realRewriter) {
    vm.runInContext(bundleSource, context);
    const OriginalUltraviolet = context.Ultraviolet;
    context.Ultraviolet = class extends OriginalUltraviolet {
      static BareClient = Ultraviolet.BareClient;
      constructor(config) {
        super(config);
        this.cookie = { db: async () => ({}), getCookies: async () => [], serialize: () => '' };
      }
    };
  }
  vm.runInContext(source, context);
  async function request(clientId, resultingClientId = '', destination = 'iframe', path = proxied('https://example.com/')) {
    const req = new Request(path, { headers: { 'sec-ch-ua': 'Real browser hints', 'X-Test': 'preserved' } });
    Object.defineProperty(req, 'destination', { value: destination });
    let response;
    events.get('fetch')({ request: req, clientId, resultingClientId, respondWith(value) { response = value; } });
    responses.push(await (await response).text());
    return requests.at(-1);
  }
  async function message(id, data) {
    let result;
    let pending;
    const reply = { postMessage(value) { result = value; }, close() {} };
    events.get('message')({ source: { id }, data, ports: [reply], waitUntil(value) { pending = value; } });
    await pending;
    return result;
  }
  return { request, message, requests, responses, injections, context, cacheCalls };
}

test('user-agent values are bounded ASCII header text and stay outside the encoded destination', () => {
  for (const value of ['x\r\nCookie: bad', '\u0000', 'x'.repeat(513), 'é', {}, null]) assert.equal(cleanUserAgent(value), '');
  assert.equal(cleanUserAgent('  Custom Browser/1.0 '), 'Custom Browser/1.0');
  const url = new URL(proxyViewUrl(origin, 'https://example.com/?a=1#two', 'Custom Browser/1.0'));
  assert.equal(url.searchParams.get('ua'), 'Custom Browser/1.0');
  assert.equal(decodeURIComponent(url.hash.slice(1)), 'https://example.com/?a=1#two');
});

test('controlled child bootstrap binds Chromium first navigation to the correct owner without leaking bootstrap state', async () => {
  const nonce = '1234567890abcdef1234567890abcdef';
  const clients = new Map([
    ['host-a', { id: 'host-a', url: proxyViewUrl(origin, 'https://example.com/', 'Browser A/1') }],
    ['host-b', { id: 'host-b', url: proxyViewUrl(origin, 'https://example.com/', 'Browser B/2') }],
    ['bootstrap-a', { id: 'bootstrap-a', url: origin + '/proxy-bootstrap.html?nonce=' + nonce }],
    ['bootstrap-b', { id: 'bootstrap-b', url: origin + '/proxy-bootstrap.html?nonce=' + 'a'.repeat(32) }]
  ]);
  const stored = new Map();
  const app = worker(clients, stored);
  assert.equal((await app.message('bootstrap-a', { type: 'monkeh:identity:client', nonce })).clientId, 'bootstrap-a');
  assert.equal((await app.message('host-a', { type: 'monkeh:identity:bind', clientId: 'bootstrap-a', nonce })).ok, true);
  assert.equal((await app.message('host-b', { type: 'monkeh:identity:bind', clientId: 'bootstrap-b', nonce: 'a'.repeat(32) })).ok, true);
  const restarted = worker(clients, stored);
  await Promise.all([restarted.request('bootstrap-a', 'page-a'), restarted.request('bootstrap-b', 'page-b')]);
  const requests = restarted.requests;
  assert.deepEqual(requests.map(request => request.headers['user-agent']).sort(), ['Browser A/1', 'Browser B/2']);
  assert(requests.every(request => String(request.url) === 'https://example.com/'));
  assert(requests.every(request => !JSON.stringify(request).includes(nonce)));
  clients.set('page-a', { id: 'page-a', url: proxied('https://example.com/') });
  assert.equal((await restarted.request('page-a', '', 'script')).headers['user-agent'], 'Browser A/1');
});

test('bootstrap messages reject remote senders, wrong nonces and already navigated children', async () => {
  const nonce = '1234567890abcdef1234567890abcdef';
  const clients = new Map([
    ['host', { id: 'host', url: proxyViewUrl(origin, 'https://example.com/', 'Chosen/1') }],
    ['child', { id: 'child', url: origin + '/proxy-bootstrap.html?nonce=' + nonce }],
    ['remote', { id: 'remote', url: proxied('https://example.com/') }]
  ]);
  const app = worker(clients);
  const bind = { type: 'monkeh:identity:bind', clientId: 'child', nonce };
  for (const [sender, data] of [
    ['remote', bind], ['host', { ...bind, nonce: 'b'.repeat(32) }], ['host', { ...bind, clientId: 'remote' }],
    ['remote', { type: 'monkeh:identity:client', nonce: null }], ['missing', bind]
  ]) assert.equal((await app.message(sender, data)).ok, false);
  assert.equal((await app.request('remote', '', 'script')).headers['user-agent'], 'Real browser');
});

test('Cloudflare extensionless host and bootstrap URLs retain exact identity checks', async () => {
  const nonce = '1234567890abcdef1234567890abcdef';
  const clients = new Map([
    ['host', { id: 'host', url: origin + '/proxy-host?ua=Clean%2F1' }],
    ['child', { id: 'child', url: origin + '/proxy-bootstrap?nonce=' + nonce }]
  ]);
  const app = worker(clients);
  assert.equal((await app.message('child', { type: 'monkeh:identity:client', nonce })).clientId, 'child');
  const bind = { type: 'monkeh:identity:bind', clientId: 'child', nonce };
  assert.equal((await app.message('host', bind)).ok, true);
  assert.equal((await app.request('child', 'page')).headers['user-agent'], 'Clean/1');
  for (const path of ['/proxy-host/', '/proxy-host-extra', '/apps/proxy-host']) {
    clients.set('host', { id: 'host', url: origin + path });
    assert.equal((await app.message('host', bind)).ok, false, path);
  }
  clients.set('host', { id: 'host', url: origin + '/proxy-host' });
  clients.set('child', { id: 'child', url: origin + '/proxy-bootstrap-extra?nonce=' + nonce });
  assert.equal((await app.message('host', bind)).ok, false);
});

test('concurrent proxy views retain their own header and early navigator identity', async () => {
  const clients = new Map([
    ['host-a', { id: 'host-a', url: proxyViewUrl(origin, 'https://example.com/', 'Browser A/1') }],
    ['host-b', { id: 'host-b', url: proxyViewUrl(origin, 'https://example.com/', 'Browser B/2') }]
  ]);
  const app = worker(clients);
  await Promise.all([app.request('host-a', 'page-a'), app.request('host-b', 'page-b')]);
  assert.deepEqual(app.requests.map(entry => entry.headers['user-agent']).sort(), ['Browser A/1', 'Browser B/2']);
  for (const entry of app.requests) { assert.equal(entry.headers['sec-ch-ua'], undefined); assert.equal(entry.headers['x-test'], 'preserved'); }
  const sandbox = { navigator: {} };
  vm.runInNewContext(app.injections[0].at(-1).childNodes[0].value, sandbox);
  assert.equal(sandbox.navigator.userAgent, 'Browser A/1');
  clients.set('page-a', { id: 'page-a', url: proxied('https://example.com/') });
  assert.equal((await app.request('page-a', '', 'script')).headers['user-agent'], 'Browser A/1');
  assert.equal((await app.request('page-a', '', 'image', 'https://images.example/picture.png')).headers['user-agent'], 'Browser A/1');
});

test('identity survives worker suspension and expires when its owner view closes', async () => {
  const clients = new Map([['host-a', { id: 'host-a', url: proxyViewUrl(origin, 'https://example.com/', 'Browser A/1') }]]);
  const stored = new Map();
  await worker(clients, stored).request('host-a', 'page-a');
  clients.set('page-a', { id: 'page-a', url: proxied('https://example.com/') });
  const restarted = worker(clients, stored);
  assert.equal((await restarted.request('page-a', '', 'script')).headers['user-agent'], 'Browser A/1');
  clients.delete('host-a');
  assert.equal((await restarted.request('page-a', '', 'script')).headers['user-agent'], 'Real browser');
});

test('untrusted clients cannot select another browser identity through their destination URL', async () => {
  const clients = new Map([['page', { url: proxied('https://proxy.test/proxy-host.html?ua=Fake') }]]);
  const app = worker(clients);
  assert.equal((await app.request('page')).headers['user-agent'], 'Real browser');
  assert.equal(app.injections[0].length, 0);
});

test('failed persistence never changes the resolved navigation identity', async () => {
  for (const options of [{ failOpen: true }, { failWrite: true }]) {
    const clients = new Map([['host', { id: 'host', url: proxyViewUrl(origin, 'https://example.com/', 'Chosen Browser/1') }]]);
    const app = worker(clients, new Map(), options);
    assert.equal((await app.request('host', 'page')).headers['user-agent'], 'Chosen Browser/1');
    clients.set('page', { id: 'page', url: proxied('https://example.com/') });
    assert.equal((await app.request('page', '', 'script')).headers['user-agent'], 'Chosen Browser/1');
    assert.equal(app.injections[0].length, 1);
  }
});

test('reserved clients survive periodic pruning and worker suspension without subresource writes', async () => {
  const clients = new Map([['host', { id: 'host', url: proxyViewUrl(origin, 'https://example.com/', 'Chosen Browser/1') }]]);
  const stored = new Map();
  const app = worker(clients, stored);
  for (let index = 0; index < 32; index++) await app.request('host', `page-${index}`);
  assert.equal(stored.size, 32);
  clients.set('page-31', { id: 'page-31', url: proxied('https://example.com/') });
  const restarted = worker(clients, stored);
  for (const destination of ['script', 'image', 'style']) assert.equal((await restarted.request('page-31', '', destination)).headers['user-agent'], 'Chosen Browser/1');
  assert.equal(restarted.cacheCalls.reads, 1);
  assert.equal(restarted.cacheCalls.writes, 0);
  assert.equal(restarted.cacheCalls.opens, 1);
});

test('pruning expires abandoned clients and closed owners while retaining live clients within the cache bound', async () => {
  const clients = new Map([['host', { id: 'host', url: proxyViewUrl(origin, 'https://example.com/', 'Chosen Browser/1') }]]);
  const stored = new Map();
  const app = worker(clients, stored);
  for (let index = 0; index < 270; index++) {
    const id = `page-${index}`;
    clients.set(id, { id, url: proxied('https://example.com/') });
    await app.request('host', id);
  }
  assert.equal(stored.size, 256);
  const keys = [...stored.keys()];
  const activeKey = keys[0];
  const abandonedKey = keys[1];
  for (const key of [activeKey, abandonedKey]) {
    const record = JSON.parse(stored.get(key)); record.createdAt = 0; stored.set(key, JSON.stringify(record));
  }
  clients.delete(decodeURIComponent(abandonedKey.split('/').at(-1)));
  await app.context.pruneIdentities();
  assert.equal(stored.has(activeKey), true);
  assert.equal(stored.has(abandonedKey), false);
  clients.delete('host');
  await app.context.pruneIdentities();
  assert.equal(stored.size, 0);
});

test('custom user-agent script text cannot terminate its injection element', async () => {
  const value = 'Browser </script><script>bad()</script>';
  const app = worker(new Map([['host', { url: proxyViewUrl(origin, 'https://example.com/', value) }]]));
  await app.request('host');
  const script = app.injections[0].at(-1).childNodes[0].value;
  assert.doesNotMatch(script, /<\/script>/);
  const sandbox = { navigator: {} }; vm.runInNewContext(script, sandbox);
  assert.equal(sandbox.navigator.userAgent, value);
});

test('real UV HTML serialization preserves executable identity code before destination scripts', async () => {
  const value = 'Selected Browser/1 & </script><script>bad()</script>';
  const app = worker(new Map([['host', { id: 'host', url: proxyViewUrl(origin, 'https://example.com/', value) }]]), new Map(), {
    realRewriter: true,
    body: '<!doctype html><html><head><script>globalThis.observedUA = navigator.userAgent;</script></head><body>Page</body></html>'
  });
  await app.request('host', 'page');
  const response = app.responses[0];
  const scripts = [...response.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(([, attributes]) => !/\bsrc=/.test(attributes)).map(([, , code]) => code);
  const identityIndex = scripts.findIndex(code => code.includes("Object.defineProperty(navigator,'userAgent'"));
  const pageIndex = scripts.findIndex(code => code.includes('observedUA'));
  assert(identityIndex >= 0 && pageIndex > identityIndex);
  assert.doesNotMatch(scripts[identityIndex], /&gt;|&amp;|&lt;|<\/script>/);
  const page = vm.createContext({ navigator: { userAgent: 'Real browser' } });
  vm.runInContext(scripts[identityIndex], page);
  vm.runInContext(scripts[pageIndex], page);
  assert.equal(page.observedUA, value);
  assert.equal(page.navigator.userAgentData, undefined);
});
