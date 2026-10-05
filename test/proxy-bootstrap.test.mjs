import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../browser-tools/proxy-bootstrap.js', import.meta.url), 'utf8');
const nonce = '1234567890abcdef1234567890abcdef';
const flush = () => new Promise(resolve => setImmediate(resolve));

function bootstrap({ controlled = true, reply = { ok: true, clientId: 'child-client' }, token = nonce } = {}) {
  const listeners = new Map();
  const timers = new Map();
  const channels = [];
  const requests = [];
  const sent = [];
  const controller = { postMessage(data, ports) { requests.push(data); if (reply !== null) ports[0].postMessage(reply); } };
  const serviceWorker = {
    controller: controlled ? controller : null,
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); }
  };
  let nextId = 0;
  const page = {
    URL, location: new URL('https://proxy.test/proxy-bootstrap.html?nonce=' + token), navigator: { serviceWorker },
    window: { parent: { postMessage(data, origin) { sent.push({ data, origin }); } } },
    setTimeout(callback) { const id = ++nextId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
    MessageChannel: class {
      constructor() {
        this.port1 = { onmessage: null, start() {}, close() { this.closed = true; } };
        this.port2 = { postMessage: data => this.port1.onmessage?.({ data }), close() { this.closed = true; } };
        channels.push(this);
      }
    }
  };
  vm.runInNewContext(source, page);
  return { requests, sent, timers, channels, listeners, control() { serviceWorker.controller = controller; listeners.get('controllerchange')?.(); } };
}

test('bootstrap waits for control and sends only the validated client identity to its same-origin parent', async () => {
  const app = bootstrap({ controlled: false });
  assert.equal(app.requests.length, 0);
  app.control(); await flush();
  assert.equal(app.requests[0].type, 'monkeh:identity:client');
  assert.equal(app.requests[0].nonce, nonce);
  assert.equal(app.sent[0].origin, 'https://proxy.test');
  assert.equal(app.sent[0].data.clientId, 'child-client');
  assert.equal(app.sent[0].data.nonce, nonce);
  assert.equal(app.sent[0].data.type, 'monkeh-proxy:identity-ready');
  assert.equal(app.timers.size, 0);
  assert.equal(app.listeners.size, 0);
  assert(app.channels.every(channel => channel.port1.closed && channel.port2.closed));
});

test('bootstrap bounds worker/control waits and closes channels after rejection', async () => {
  for (const options of [{ controlled: false }, { reply: null }, { reply: { ok: false } }]) {
    const app = bootstrap(options);
    if (app.timers.size) [...app.timers.values()][0]();
    await flush();
    assert.equal(app.sent.length, 1);
    assert.equal(app.sent[0].data.failed, true);
    assert.equal(app.sent[0].data.clientId, undefined);
    assert.equal(app.timers.size, 0);
    assert.equal(app.listeners.size, 0);
    assert(app.channels.every(channel => channel.port1.closed && channel.port2.closed));
  }
});

test('bootstrap rejects invalid tokens without contacting the worker or parent', async () => {
  for (const token of ['', 'short', 'x'.repeat(32), 'a'.repeat(33)]) {
    const app = bootstrap({ token }); await flush();
    assert.equal(app.requests.length, 0);
    assert.equal(app.sent.length, 0);
    assert.equal(app.timers.size, 0);
  }
});
