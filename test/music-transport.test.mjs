import test from 'node:test';
import assert from 'node:assert/strict';
import { createMusicApi, musicProviderUrl } from '../browser-tools/music-transport.js';
import { createLocalProxy, controlLocalWorker } from '../browser-tools/local-proxy.js';
import { musicUpstreamUrl } from '../workers/music.mjs';

const config = { mode: 'static', wispEndpoints: [{ url: 'wss://wisp.example.test/' }] };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ existing = '', networkError = false } = {}) {
  const calls = [];
  let selected = existing;
  const worker = { state: 'activated' };
  const serviceWorker = Object.assign(new EventTarget(), {
    controller: worker,
    ready: Promise.resolve(),
    register: async (...args) => { calls.push(['register', ...args]); return { active: worker }; },
  });
  const win = {
    isSecureContext: true,
    location: { origin: 'https://new-mirror.example', href: 'https://new-mirror.example/math' },
    navigator: { serviceWorker, onLine: true, locks: { request: async (name, options, action) => { calls.push(['lock', name]); return action(); } } },
    SharedWorker: class {},
    BareMux: { BareMuxConnection: class {
      constructor(path) { calls.push(['connection', path]); }
      async getTransport() { calls.push(['get']); return selected; }
      async setTransport(path, options) { calls.push(['set', path, options]); selected = path; }
    } },
    Ultraviolet: {},
    __uv$config: { prefix: '/service/', encodeUrl: encodeURIComponent },
  };
  const createNetwork = options => {
    calls.push(['network', options.endpoints, options.fallbackEndpoints]);
    return {
      async connect() { if (networkError) throw new Error('Wisp unavailable'); await options.activate(options.endpoints[0]); },
      dispose() { calls.push(['dispose']); },
    };
  };
  return { win, calls, createNetwork };
}

test('static music routes all catalog requests and audio streams through the local proxy', async () => {
  const requests = [];
  const api = createMusicApi({ getConfig: async () => config, proxy: { url: async (url, received) => { requests.push([url, received]); return '/service/' + encodeURIComponent(url); } } });
  const paths = ['/api/music/browse', '/api/music/search?q=Song&source=tidal', '/api/music/stream?id=123&source=tidal&title=Song'];
  for (const path of paths) {
    const result = await api.resolve(path);
    assert.equal(decodeURIComponent(result.slice('/service/'.length)), musicUpstreamUrl('https://local.test' + path).href);
  }
  assert.equal(requests.length, 3);
  assert(requests.every(([, received]) => received === config));
});

test('stream route stays a local address for native audio seeking without buffering the track', async () => {
  const { win, createNetwork } = fixture();
  win.fetch = () => { throw new Error('Track bytes must not be downloaded during URL resolution'); };
  const proxy = createLocalProxy({ win, createNetwork });
  const api = createMusicApi({ win, getConfig: async () => config, proxy });
  const resolved = new URL(await api.resolve('/api/music/stream?id=123&source=qobuz'));
  assert.equal(resolved.origin, win.location.origin);
  assert.equal(decodeURIComponent(resolved.pathname.slice('/service/'.length)), 'https://h35d5a9.jfs-autoelevadores.com.ar/api/music/stream?id=123&source=qobuz');
  assert.equal(resolved.protocol, 'https:');
});

test('music retains configured backend routes without initializing Wisp', async () => {
  let initialized = false;
  const api = createMusicApi({ getConfig: async () => ({ mode: 'backend', proxyOrigin: 'https://backend.example' }), proxy: { url: async () => { initialized = true; } } });
  assert.equal(await api.resolve('/api/music/browse'), 'https://backend.example/api/music/browse');
  assert.equal(await api.artwork('https://resources.tidal.com/images/a.jpg'), 'https://resources.tidal.com/images/a.jpg');
  assert.equal(initialized, false);
});

test('music endpoint validation rejects arbitrary destinations and unsupported query parameters', () => {
  for (const path of [
    'https://evil.example/api/music/browse', '//evil.example/api/music/browse', '/api/music/../config',
    '/api/music/browse?url=https://evil.example', '/api/music/search?q=one&q=two&source=tidal',
    '/api/music/stream?id=123&source=invalid', '/api/music/stream?id=123&source=tidal&duration=Infinity',
    '/api/music/search?q=hi&source=qobuz&limit=999', '/api/music/stream?id=https://evil.example&source=tidal',
    '/api/music/browse#fragment',
  ]) assert.throws(() => musicProviderUrl(path), undefined, path);
});

test('artwork uses the same static transport and rejects unapproved origins', async () => {
  const api = createMusicApi({ getConfig: async () => config, proxy: { url: async url => '/service/' + encodeURIComponent(url) } });
  assert.equal(await api.artwork('https://resources.tidal.com/images/a.jpg'), '/service/https%3A%2F%2Fresources.tidal.com%2Fimages%2Fa.jpg');
  await assert.rejects(api.artwork('https://evil.example/a.jpg'), /Unsupported/);
  await assert.rejects(api.artwork('https://user:pass@resources.tidal.com/a.jpg'), /Unsupported/);
});

test('lazy initialization coalesces parallel sources and covers, then reuses the connection', async () => {
  const { win, calls, createNetwork } = fixture();
  const proxy = createLocalProxy({ win, createNetwork });
  assert.equal(calls.length, 0);
  await Promise.all(Array.from({ length: 12 }, (_, i) => proxy.url('https://music.example/' + i, config)));
  await proxy.url('https://music.example/later', config);
  assert.equal(calls.filter(([name]) => name === 'register').length, 1);
  assert.equal(calls.filter(([name]) => name === 'network').length, 1);
  assert.deepEqual(calls.find(([name]) => name === 'set'), ['set', '/bearmux/epoxy/index.mjs?v=2.1.28', [{ wisp: 'wss://wisp.example.test/' }]]);
  assert.equal(calls.filter(([name]) => name === 'dispose').length, 1);
});

test('music reuses an already configured browser transport without probing or resetting it', async () => {
  const { win, calls, createNetwork } = fixture({ existing: '/bearmux/epoxy/index.mjs?v=2.1.28' });
  const proxy = createLocalProxy({ win, createNetwork });
  await proxy.url('https://music.example/a', config);
  assert.equal(calls.some(([name]) => ['set', 'network'].includes(name)), false);
  assert.equal(calls.filter(([name]) => name === 'get').length, 1);
});

test('standalone music lazily loads local runtime scripts in dependency order', async () => {
  const { win, createNetwork } = fixture();
  const runtime = { BareMux: win.BareMux, Ultraviolet: win.Ultraviolet, config: win.__uv$config };
  delete win.BareMux; delete win.Ultraviolet; delete win.__uv$config;
  const loaded = [];
  const proxy = createLocalProxy({ win, createNetwork, loadScript: async (_, path) => {
    loaded.push(path);
    if (path === '/bearmux/index.js?v=2.1.9') win.BareMux = runtime.BareMux;
    if (path === '/ultrav/uv.bundle.js') win.Ultraviolet = runtime.Ultraviolet;
    if (path === '/ultrav/uv.config.js') { assert(win.Ultraviolet); win.__uv$config = runtime.config; }
  } });
  assert.deepEqual(loaded, []);
  await proxy.url('https://music.example/a', config);
  assert.deepEqual(loaded, ['/bearmux/index.js?v=2.1.9', '/ultrav/uv.bundle.js', '/ultrav/uv.config.js']);
});

test('failed Wisp initialization releases probes and can be retried', async () => {
  const { win, calls } = fixture();
  let attempts = 0;
  const proxy = createLocalProxy({ win, createNetwork: options => ({
    async connect() { if (++attempts === 1) throw new Error('All servers failed'); await options.activate(options.endpoints[0]); },
    dispose() { calls.push(['dispose']); },
  }) });
  await assert.rejects(proxy.url('https://music.example/a', config), /All servers failed/);
  assert.match(await proxy.url('https://music.example/a', config), /^https:\/\/new-mirror\.example\/service\//);
  assert.equal(calls.filter(([name]) => name === 'dispose').length, 2);
});

test('worker startup waits for its new controller and does not accept stale control', async () => {
  const { win } = fixture();
  const updating = Object.assign(new EventTarget(), { state: 'installing' });
  const service = win.navigator.serviceWorker;
  service.register = async () => ({ installing: updating });
  let ready = false;
  const startup = controlLocalWorker(win).then(() => { ready = true; });
  await tick();
  updating.state = 'activated'; updating.dispatchEvent(new Event('statechange'));
  await tick();
  assert.equal(ready, false);
  service.controller = updating; service.dispatchEvent(new Event('controllerchange'));
  await startup;
  assert.equal(ready, true);
});

test('worker update checks finish before accepting a newly active controller', async () => {
  const { win } = fixture();
  const service = win.navigator.serviceWorker;
  const updated = Object.assign(new EventTarget(), { state: 'activated' });
  let finishUpdate;
  const registration = { active: service.controller, update: () => new Promise(resolve => { finishUpdate = () => { registration.active = updated; resolve(); }; }) };
  service.register = async () => registration;
  let ready = false;
  const startup = controlLocalWorker(win).then(() => { ready = true; });
  await tick();
  assert.equal(ready, false);
  finishUpdate();
  await tick();
  assert.equal(ready, false);
  service.controller = updated;
  service.dispatchEvent(new Event('controllerchange'));
  await startup;
  assert.equal(ready, true);
});

test('failed or timed out worker update checks never approve an old controller', async () => {
  const { win } = fixture();
  const service = win.navigator.serviceWorker;
  service.register = async () => ({ active: service.controller, update: async () => { throw new Error('Update failed'); } });
  await assert.rejects(controlLocalWorker(win), /Update failed/);
  service.register = async () => ({ active: service.controller, update: () => new Promise(() => {}) });
  await assert.rejects(controlLocalWorker(win, 5), /update check timed out/);
});

test('waiting for a held transport lock aborts without selecting another transport', async () => {
  const { win, calls, createNetwork } = fixture();
  let aborted = false;
  win.navigator.locks.request = (_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  });
  const proxy = createLocalProxy({ win, createNetwork, timeout: 5 });
  await assert.rejects(proxy.url('https://music.example/a', config), /Another proxy connection/);
  assert.equal(aborted, true);
  assert.equal(calls.some(([name]) => ['set', 'network'].includes(name)), false);
});

test('a slow transport mutation retains its lock and is not duplicated after a caller times out', async () => {
  const { win, createNetwork } = fixture();
  let finish;
  let mutations = 0;
  let releases = 0;
  let selected = '';
  win.BareMux.BareMuxConnection = class {
    async getTransport() { return selected; }
    setTransport(path) { mutations++; return new Promise(resolve => { finish = () => { selected = path; resolve(); }; }); }
  };
  win.navigator.locks.request = async (_, options, action) => { try { return await action(); } finally { releases++; } };
  const proxy = createLocalProxy({ win, createNetwork, startupTimeout: 5 });
  await assert.rejects(proxy.url('https://music.example/a', config), /still starting/);
  assert.equal(mutations, 1);
  assert.equal(releases, 0);
  await assert.rejects(proxy.url('https://music.example/b', config), /still starting/);
  assert.equal(mutations, 1);
  assert.equal(releases, 0);
  finish();
  await tick();
  assert.match(await proxy.url('https://music.example/c', config), /\/service\//);
  assert.equal(mutations, 1);
  assert.equal(releases, 1);
});

test('invalid proxy destinations and unsupported browsers fail before network startup', async () => {
  const { win, calls, createNetwork } = fixture();
  const proxy = createLocalProxy({ win, createNetwork });
  for (const url of ['javascript:alert(1)', 'https://user:pass@music.example/', 'https://new-mirror.example/math']) await assert.rejects(proxy.url(url, config), /Invalid proxy destination/);
  win.isSecureContext = false;
  await assert.rejects(proxy.url('https://music.example/a', config), /HTTPS/);
  assert.equal(calls.length, 0);
});
