import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { vendorFiles } from '../scripts/build-static.mjs';

const root = new URL('..', import.meta.url);
const runtimePaths = new Set(['bearmux/index.js', 'bearmux/worker.js', 'bearmux/epoxy/index.mjs']);
const canonical = text => text.replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]+\s*$/, '\n').replace(/\r\n/g, '\n').trimEnd();

test('raw static hosting uses the same pinned vendor runtimes as production builds', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  for (const [packageName, path, destination] of vendorFiles.filter(([, , destination]) => runtimePaths.has(destination))) {
    const installed = JSON.parse(await readFile(new URL('node_modules/' + packageName + '/package.json', root), 'utf8'));
    assert.equal(installed.version, manifest.dependencies[packageName], packageName);
    const expected = canonical(await readFile(new URL('node_modules/' + packageName + '/' + path, root), 'utf8'));
    const actual = canonical(await readFile(new URL(destination, root), 'utf8'));
    assert.equal(actual === expected, true, destination + ' must match its pinned package runtime');
  }
  assert.equal(await readFile(new URL('bearmux/LICENSE', root), 'utf8'), await readFile(new URL('node_modules/@mercuryworkshop/bare-mux/LICENSE', root), 'utf8'));
});

test('browser and music runtime references bypass old caches using the pinned package versions', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const versions = new Map([
    ['/bearmux/index.js', manifest.dependencies['@mercuryworkshop/bare-mux']],
    ['/bearmux/epoxy/index.mjs', manifest.dependencies['@mercuryworkshop/epoxy-transport']],
  ]);
  for (const [path, expectedCount] of [['proxy-host.html', 1], ['browser-tools/proxy-host.js', 1], ['browser-tools/local-proxy.js', 2]]) {
    const source = await readFile(new URL(path, root), 'utf8');
    const references = [...source.matchAll(/\/bearmux\/(?:index\.js|epoxy\/index\.mjs)(?:\?[^\s'"<>)]*)?/g)];
    assert.equal(references.length, expectedCount, path);
    for (const [reference] of references) {
      const url = new URL(reference, 'https://app.example');
      assert.equal(url.searchParams.get('v'), versions.get(url.pathname), path + ': ' + reference);
    }
  }
});

test('checked-in BareMux client configures its actual worker and streams a partial response', { timeout: 5000 }, async () => {
  class Port {
    postMessage(value) { queueMicrotask(() => this.peer.onmessage?.({ data: value })); }
    start() {}
    close() {}
  }
  class Channel {
    constructor() { this.port1 = new Port(); this.port2 = new Port(); this.port1.peer = this.port2; this.port2.peer = this.port1; }
  }
  const common = {
    MessagePort: Port, MessageChannel: Channel, ArrayBuffer, ReadableStream, Response, Request, Headers, URL, TextEncoder,
    Event, EventTarget, BroadcastChannel: class { postMessage() {} }, console: { debug() {}, warn() {}, error() {}, log() {} },
    setTimeout: (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; },
  };
  const worker = vm.createContext({ ...common });
  worker.self = worker;
  vm.runInContext(await readFile(new URL('bearmux/worker.js', root), 'utf8'), worker, { filename: 'bearmux/worker.js' });
  class SharedWorker {
    constructor(path, name) {
      assert.equal(path, '/bearmux/worker.js');
      assert.equal(name, 'bare-mux-worker');
      const channel = new Channel();
      this.port = channel.port1;
      worker.onconnect({ ports: [channel.port2] });
    }
  }
  class Socket { send() {} get readyState() { return 0; } }
  const client = vm.createContext({
    ...common, SharedWorker, WebSocket: Socket, localStorage: {}, navigator: { serviceWorker: { addEventListener() {} } },
    fetch: () => { throw new Error('This regression test must not use real network requests.'); },
  });
  client.self = client;
  vm.runInContext(await readFile(new URL('bearmux/index.js', root), 'utf8'), client, { filename: 'bearmux/index.js' });
  const connection = new client.BareMux.BareMuxConnection('/bearmux/worker.js');
  assert.equal(await connection.getTransport(), '');
  await connection.setManualTransport(`return [class FixtureTransport {
    constructor(options) { this.ready = true; this.text = options.text; }
    async request(url, method, body, headers) {
      return { status: 206, statusText: 'Partial Content', headers: {
        'content-type': 'text/plain', 'content-range': 'bytes 4-8/9', 'accept-ranges': 'bytes',
        'x-request-range': headers.range, 'x-request-url': url.href, 'x-request-method': method
      }, body: new Response(this.text).body };
    }
  }, 'fixture-transport'];`, [{ text: 'music' }]);
  assert.equal(await connection.getTransport(), 'fixture-transport');
  const fetcher = new client.BareMux.BareClient('/bearmux/worker.js');
  const response = await fetcher.fetch('https://music.example/track', { headers: { range: 'bytes=4-' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 4-8/9');
  assert.equal(response.headers.get('x-request-range'), 'bytes=4-');
  assert.equal(response.headers.get('x-request-url'), 'https://music.example/track');
  assert.equal(response.headers.get('x-request-method'), 'GET');
  assert.equal(await response.text(), 'music');
});
