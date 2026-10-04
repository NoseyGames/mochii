import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { once } from 'node:events';
import { request } from 'node:http';
import WebSocket from 'ws';
import { createAppServer } from '../server.mjs';
import '../browser-tools/config.js';

let server;
let origin;
let websocketOrigin;

before(async () => {
  server = createAppServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  websocketOrigin = origin.replace('http:', 'ws:');
});

after(async () => {
  if (!server) return;
  server.closeIdleConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function get(path, options = {}) {
  return fetch(`${origin}${path}`, { ...options, signal: AbortSignal.timeout(5000) });
}

function rawGet(path) {
  return new Promise((resolve, reject) => {
    const req = request(origin, { path }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('HTTP request timed out')));
    req.end();
  });
}

test('health reports the same-origin Wisp endpoint', async () => {
  const response = await get('/api/health');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/i);
  assert.deepEqual(await response.json(), { status: 'ok', wispPath: '/wisp/' });
});

test('the frontend config reader accepts the real backend response', async () => {
  const config = await globalThis.MonkehConfig.fetchBackendConfig({ fetch: (url, options) => get(url, options) });
  assert.equal(typeof config.proxyOrigin, 'string');
  assert(config.wispEndpoints.length > 0);
});

test('public pages and proxy dependencies are served with browser-usable types', async t => {
  const assets = [
    ['/', /text\/html/i],
    ['/index.html', /text\/html/i],
    ['/math.html', /text\/html/i],
    ['/history.html', /text\/html/i],
    ['/flyflix.html', /text\/html/i],
    ['/apps/auk.html', /text\/html/i],
    ['/apps/vox.html', /text\/html/i],
    ['/style.css', /text\/css/i],
    ['/browser-tools/tools.css', /text\/css/i],
    ['/browser-tools/tools.js', /(?:text|application)\/javascript/i],
    ['/browser-tools/config.js', /(?:text|application)\/javascript/i],
    ['/browser-tools/runtime.js', /(?:text|application)\/javascript/i],
    ['/browser-tools/userscripts.js', /(?:text|application)\/javascript/i],
    ['/sw.js', /(?:text|application)\/javascript/i],
    ['/ultrav/uv.bundle.js', /(?:text|application)\/javascript/i],
    ['/ultrav/uv.config.js', /(?:text|application)\/javascript/i],
    ['/ultrav/uv.sw.js', /(?:text|application)\/javascript/i],
    ['/ultrav/uv.handler.js', /(?:text|application)\/javascript/i],
    ['/ultrav/uv.client.js', /(?:text|application)\/javascript/i],
    ['/bearmux/index.js', /(?:text|application)\/javascript/i],
    ['/bearmux/worker.js', /(?:text|application)\/javascript/i],
    ['/bearmux/epoxy/index.mjs', /(?:text|application)\/javascript/i],
  ];
  for (const [path, contentType] of assets) {
    await t.test(path, async () => {
      const response = await get(path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), contentType);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      const body = new Uint8Array(await response.arrayBuffer());
      assert.ok(body.length > 0, `${path} must not be empty`);
    });
  }
});

test('the local Epoxy transport contains a valid embedded WebAssembly module', async () => {
  const response = await get('/bearmux/epoxy/index.mjs');
  const module = await response.text();
  const embedded = module.match(/atob\("([A-Za-z0-9+/=]+)"\)/);
  assert.ok(embedded, 'transport must bundle its WASM without requiring a missing epoxy.wasm file');
  const wasm = Buffer.from(embedded[1], 'base64');
  assert.deepEqual([...wasm.subarray(0, 4)], [0, 97, 115, 109]);
  assert.equal(WebAssembly.validate(wasm), true);
});

test('static queries and HEAD use the same resource without sending a HEAD body', async () => {
  const [plain, query, head] = await Promise.all([
    get('/sw.js'),
    get('/sw.js?v=cache-bust'),
    get('/sw.js', { method: 'HEAD' }),
  ]);
  assert.equal(query.status, 200);
  assert.equal(head.status, 200);
  assert.equal(await query.text(), await plain.text());
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('content-type'), plain.headers.get('content-type'));
});

test('private files and unknown paths cannot be fetched through the static server', async t => {
  const paths = [
    '/server.js',
    '/server.mjs',
    '/server-network.mjs',
    '/package.json',
    '/pnpm-lock.yaml',
    '/.env',
    '/.git/config',
    '/test/server.test.mjs',
    '/scripts/check-syntax.mjs',
    '/node_modules/ws/package.json',
    '/unknown.html',
    '/bearmux/missing.js',
    '/ultrav/missing.js',
    '/apps/missing.html',
    '/api/missing',
  ];
  for (const path of paths) {
    await t.test(path, async () => {
      const response = await get(path);
      assert.equal(response.status, 404);
      await response.arrayBuffer();
    });
  }
});

test('encoded traversal and malformed paths cannot expose server source', async t => {
  const paths = [
    '/%2e%2e/server.js',
    '/apps/%2e%2e/server.js',
    '/bearmux/%2e%2e/%2e%2e/server.js',
    '/bearmux/%2e%2e%2f%2e%2e%2fserver.js',
    '/apps/..%5cserver.js',
    '/%2eenv',
    '/%00',
    '/%zz',
  ];
  for (const path of paths) {
    await t.test(path, async () => {
      const response = await rawGet(path);
      assert.ok([400, 404].includes(response.status), `${path}: unexpected status ${response.status}`);
      assert.doesNotMatch(response.body, /createAppServer|node:http|process\.env/);
    });
  }
});

test('static routes reject writes', async () => {
  const response = await get('/math.html', { method: 'POST', body: 'overwrite' });
  assert.equal(response.status, 405);
  assert.match(response.headers.get('allow') ?? '', /GET/);
  assert.match(response.headers.get('allow') ?? '', /HEAD/);
  await response.arrayBuffer();
});

test('Wisp HTTP requests require a WebSocket upgrade', async () => {
  const response = await get('/wisp/');
  assert.equal(response.status, 426);
  await response.arrayBuffer();
});

test('Wisp accepts canonical and query URLs with its initial flow-control packet', { timeout: 15000 }, async t => {
  for (const path of ['/wisp/', '/wisp/?v=1', '/%77isp/']) {
    await t.test(path, async () => {
      const socket = new WebSocket(`${websocketOrigin}${path}`, { origin, handshakeTimeout: 5000 });
      try {
        const [message, isBinary] = await once(socket, 'message', { signal: AbortSignal.timeout(5000) });
        assert.equal(isBinary, true);
        assert.equal(message[0], 0x03, 'Wisp v1 starts with a CONTINUE packet');
        assert.equal(message.readUInt32LE(1), 0, 'initial flow control belongs to the connection');
        assert.ok(message.readUInt32LE(5) > 0, 'server grants a nonzero packet buffer');
      } finally {
        socket.terminate();
      }
    });
  }
});

test('Wisp v2 completes protocol negotiation before sending flow control', { timeout: 10000 }, async () => {
  const socket = new WebSocket(`${websocketOrigin}/wisp/`, 'wisp-v2', { origin, handshakeTimeout: 5000 });
  try {
    const [info, binary] = await once(socket, 'message', { signal: AbortSignal.timeout(5000) });
    assert.equal(binary, true);
    assert.equal(info[0], 0x05, 'Wisp v2 begins with an INFO packet');
    assert.equal(info.readUInt32LE(1), 0);
    assert.equal(info[5], 2);
    const continued = once(socket, 'message', { signal: AbortSignal.timeout(5000) });
    socket.send(Buffer.from([0x05, 0, 0, 0, 0, 2, 0]));
    const [flow] = await continued;
    assert.equal(flow[0], 0x03);
    assert.ok(flow.readUInt32LE(5) > 0);
  } finally {
    socket.terminate();
  }
});

test('Wisp rejects direct IP streams, including IPv6 forms that can hide private hosts', { timeout: 15000 }, async t => {
  for (const hostname of ['127.0.0.1', 'fc00::1', '::ffff:127.0.0.1']) {
    await t.test(hostname, async () => {
      const socket = new WebSocket(`${websocketOrigin}/wisp/`, { origin, handshakeTimeout: 5000 });
      try {
        await once(socket, 'message', { signal: AbortSignal.timeout(5000) });
        const header = Buffer.alloc(8);
        header[0] = 0x01;           
        header.writeUInt32LE(1, 1);             
        header[5] = 0x01;       
        header.writeUInt16LE(80, 6);
        const closed = once(socket, 'message', { signal: AbortSignal.timeout(5000) });
        socket.send(Buffer.concat([header, Buffer.from(hostname)]));
        const [packet] = await closed;
        assert.equal(packet[0], 0x04, 'blocked streams receive a CLOSE packet');
        assert.equal(packet.readUInt32LE(1), 1);
        assert.equal(packet[5], 0x48, 'the close reason must be HostBlocked');
      } finally {
        socket.terminate();
      }
    });
  }
});

test('unrecognized WebSocket routes reject the upgrade', { timeout: 10000 }, async t => {
  for (const path of ['/math.html', '/api/health', '/wisp/not-a-route']) {
    await t.test(path, async () => {
      const socket = new WebSocket(`${websocketOrigin}${path}`, { origin });
      try {
        const status = await new Promise((resolve, reject) => {
          socket.on('error', reject);
          socket.once('open', () => reject(new Error(`${path} unexpectedly accepted a WebSocket`)));
          socket.once('unexpected-response', (req, response) => {
            response.resume();
            resolve(response.statusCode);
          });
        });
        assert.equal(status, 404);
      } finally {
        socket.terminate();
      }
    });
  }
});

test('Wisp rejects WebSockets initiated by a different site', { timeout: 10000 }, async () => {
  const socket = new WebSocket(`${websocketOrigin}/wisp/`, { origin: 'https://unrelated.example' });
  try {
    const status = await new Promise((resolve, reject) => {
      socket.on('error', reject);
      socket.once('open', () => reject(new Error('A foreign origin unexpectedly opened the proxy')));
      socket.once('unexpected-response', (req, response) => {
        response.resume();
        resolve(response.statusCode);
      });
    });
    assert.equal(status, 403);
  } finally {
    socket.terminate();
  }
});
