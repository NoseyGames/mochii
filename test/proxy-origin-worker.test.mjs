import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const configSource = readFileSync(new URL('../browser-tools/config.js', import.meta.url), 'utf8');

function worker(origin, configuredOrigin) {
  const events = new Map();
  let proxyFetches = 0;
  let configFails = false;
  let configResponse;
  const context = vm.createContext({
    MonkehUseBackendConfig: true,
    Response, TextEncoder, TextDecoder, AbortSignal,
    importScripts(path) {
      if (path === '/browser-tools/config.js') vm.runInContext(configSource, context);
    },
    __uv$config: {},
    UVServiceWorker: class {
      route(event) { return event.request.url.includes('/service/'); }
      fetch() { proxyFetches++; return new Response('proxied page'); }
    },
    fetch: async () => {
      if (configFails) throw new Error('Network unavailable');
      return configResponse || new Response(JSON.stringify({ proxyOrigin: configuredOrigin }), { headers: { 'Content-Type': 'application/json' } });
    },
    self: { location: { origin }, addEventListener(name, listener) { events.set(name, listener); } }
  });
  vm.runInContext(source, context);
  return {
    setFail(value) { configFails = value; },
    setConfigResponse(response) { configResponse = response; },
    get proxyFetches() { return proxyFetches; },
    request(url) {
      let response;
      events.get('fetch')({ request: { url }, respondWith(value) { response = value; } });
      return response;
    }
  };
}

test('an old shell-origin worker refuses to proxy documents after migration', async () => {
  const shell = worker('https://app.example', 'https://proxy.example');
  const response = await shell.request('https://app.example/service/encoded');
  assert.equal(response.status, 403);
  assert.equal(shell.proxyFetches, 0);
});

test('the isolated worker handles proxy pages and leaves unrelated assets alone', async () => {
  const proxy = worker('https://proxy.example', 'https://proxy.example');
  assert.equal((await proxy.request('https://proxy.example/service/encoded')).status, 200);
  assert.equal(proxy.proxyFetches, 1);
  assert.equal(proxy.request('https://proxy.example/bearmux/worker.js'), undefined);
});

test('worker origin checks fail closed and retry after configuration recovers', async () => {
  const proxy = worker('https://proxy.example', 'https://proxy.example');
  proxy.setFail(true);
  assert.equal((await proxy.request('https://proxy.example/service/encoded')).status, 403);
  assert.equal(proxy.proxyFetches, 0);
  proxy.setFail(false);
  assert.equal((await proxy.request('https://proxy.example/service/encoded')).status, 200);
});

test('worker rejects an HTML fallback for configuration and recovers when the API returns JSON', async () => {
  const proxy = worker('https://proxy.example', 'https://proxy.example');
  proxy.setConfigResponse(new Response('<!DOCTYPE html><title>Monkeh</title>', { headers: { 'Content-Type': 'text/html' } }));
  assert.equal((await proxy.request('https://proxy.example/service/encoded')).status, 403);
  assert.equal(proxy.proxyFetches, 0);
  proxy.setConfigResponse(null);
  assert.equal((await proxy.request('https://proxy.example/service/encoded')).status, 200);
  assert.equal(proxy.proxyFetches, 1);
});
