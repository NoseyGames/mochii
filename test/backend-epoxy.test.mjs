import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import WebSocket from 'ws';
import { epoxyPath } from '@mercuryworkshop/epoxy-transport';
import { createAppServer } from '../server.mjs';

async function verifyEpoxy(t) {
  const destination = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); req.pipe(res); });
  destination.listen(0, '127.0.0.1');
  await once(destination, 'listening');
  const proxy = createAppServer({ env: {}, wispOptions: {
    resolve: async () => '8.8.8.8',
    connect: options => {
      assert.equal(options.host, '8.8.8.8');
      return createConnection({ host: '127.0.0.1', port: destination.address().port });
    },
  } });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  const sockets = new Set();
  const previous = { WebSocket: globalThis.WebSocket, Request: globalThis.Request, self: globalThis.self };
  globalThis.self = globalThis;
  // Browsers resolve Request("") against the document; Node needs an absolute URL.
  globalThis.Request = class extends previous.Request { constructor(url, options) { super(url === '' ? origin : url, options); } };
  globalThis.WebSocket = class extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols, { origin });
      sockets.add(this);
      this.on('close', () => sockets.delete(this));
    }
  };
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    globalThis.WebSocket = previous.WebSocket;
    globalThis.Request = previous.Request;
    if (previous.self === undefined) delete globalThis.self; else globalThis.self = previous.self;
    await new Promise(resolve => proxy.close(resolve));
    destination.closeAllConnections();
    await new Promise(resolve => destination.close(resolve));
  });
  const { default: EpoxyTransport } = await import(pathToFileURL(path.join(epoxyPath, 'index.mjs')).href);
  const transport = new EpoxyTransport({ wisp: `${origin.replace('http:', 'ws:')}/wisp/` });
  await transport.init();
  const body = 'Monkeh upload check.\n'.repeat(256 * 1024);
  const result = await transport.request(new URL('http://example.test/upload'), 'POST', new TextEncoder().encode(body).buffer, { 'content-type': 'text/plain' });
  assert.equal(result.status, 200);
  assert.equal(await new Response(result.body).text(), body);
  transport.client.free();
}

if (isMainThread) {
  test('the real Epoxy WASM transport streams a multi-megabyte upload through the bounded gateway', { timeout: 15000 }, async t => {
    // Epoxy keeps its WASM scheduler timers alive. Give it a worker lifecycle,
    // just as the browser does, and terminate that worker after verification.
    const worker = new Worker(new URL(import.meta.url));
    t.after(() => worker.terminate());
    const [result] = await once(worker, 'message');
    assert.equal(result.ok, true, result.error);
  });
} else {
  const cleanups = [];
  try {
    await verifyEpoxy({ after: cleanup => cleanups.push(cleanup) });
    for (const cleanup of cleanups) await cleanup();
    parentPort.postMessage({ ok: true });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error.stack || error.message });
  }
}
