import assert from 'node:assert/strict';
import test from 'node:test';
import { createProxyNetwork, probeWisp } from '../browser-tools/proxy-network.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const primary = 'wss://primary.example/wisp/';
const backup = 'wss://backup.example/wisp/';
const greeting = () => new Uint8Array([3, 0, 0, 0, 0, 128, 0, 0, 0]);
const unavailable = () => Promise.reject(new Error('unavailable'));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clock() {
  let time = 1000;
  let id = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(callback, delay) { const key = ++id; timers.set(key, { callback, at: time + delay }); return key; },
    clearTimer(key) { timers.delete(key); },
    get count() { return timers.size; },
    get nextAt() { return Math.min(...[...timers.values()].map(timer => timer.at)); },
    async advance(ms) {
      time += ms;
      // Newly scheduled timers run on subsequent advances, as actual tasks do.
      for (const [key, timer] of [...timers]) {
        if (timer.at <= time && timers.delete(key)) timer.callback();
      }
      await flush();
    },
  };
}
function sockets() {
  const instances = [];
  class Socket {
    constructor(...args) {
      this.args = args;
      this.listeners = new Map();
      this.closed = 0;
      this.sent = [];
      instances.push(this);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    fire(type, data) { for (const fn of [...this.listeners.get(type) || []]) fn({ data }); }
    send(data) { this.sent.push(data); }
    close() { this.closed += 1; }
    get listenerCount() { return [...this.listeners.values()].reduce((total, list) => total + list.size, 0); }
  }
  return { Socket, instances };
}
function network(options = {}) {
  const time = clock();
  const probed = [];
  const activated = [];
  const statuses = [];
  const manager = createProxyNetwork({
    endpoints: [primary, backup],
    probe: async url => { probed.push(url); },
    activate: async url => { activated.push(url); },
    onStatus: status => { statuses.push(status); },
    now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    monitorIntervalMs: 100, cooldownMs: 1000, maxCooldownMs: 4000, retryMs: 500, maxRetryMs: 2000,
    ...options,
  });
  return { manager, time, probed, activated, statuses };
}

test('Wisp probe waits past WebSocket open for a valid CONTINUE and cleans up', async () => {
  const time = clock();
  const { Socket, instances } = sockets();
  let settled = false;
  const result = probeWisp(primary, { WebSocketCtor: Socket, setTimer: time.setTimer, clearTimer: time.clearTimer }).then(value => { settled = true; return value; });
  const socket = instances[0];
  assert.deepEqual(socket.args, [primary], 'v1 probe must not request a WebSocket subprotocol');
  assert.equal(socket.binaryType, 'arraybuffer');
  socket.fire('open');
  await flush();
  assert.equal(settled, false);
  socket.fire('message', greeting().buffer);
  assert.deepEqual(await result, { endpoint: primary, version: 1, bufferSize: 128 });
  assert.equal(time.count, 0);
  assert.equal(socket.listenerCount, 0);
  assert.equal(socket.closed, 1);
});

test('Wisp INFO requires a subsequent valid CONTINUE', async () => {
  const time = clock();
  const { Socket, instances } = sockets();
  let settled = false;
  const result = probeWisp(primary, { WebSocketCtor: Socket, setTimer: time.setTimer, clearTimer: time.clearTimer }).then(value => { settled = true; return value; });
  const socket = instances[0];
  socket.fire('message', new Uint8Array([5, 0, 0, 0, 0, 2, 1, 1, 0, 0, 0, 0]));
  await flush();
  assert.equal(settled, false);
  assert.deepEqual(socket.sent, [new Uint8Array([5, 0, 0, 0, 0, 2, 1])]);
  socket.fire('message', greeting());
  assert.equal((await result).version, 2);
  assert.equal(time.count, 0);
  assert.equal(socket.listenerCount, 0);
});

const invalidGreetings = [
  ['text', 'not a proxy'],
  ['short header', new Uint8Array([3, 0])],
  ['short CONTINUE', new Uint8Array([3, 0, 0, 0, 0, 128])],
  ['long CONTINUE', new Uint8Array([...greeting(), 0])],
  ['nonzero stream', new Uint8Array([3, 1, 0, 0, 0, 128, 0, 0, 0])],
  ['empty buffer', new Uint8Array([3, 0, 0, 0, 0, 0, 0, 0, 0])],
  ['unknown packet', new Uint8Array([9, 0, 0, 0, 0])],
  ['CLOSE packet', new Uint8Array([4, 0, 0, 0, 0, 0x49])],
  ['short INFO', new Uint8Array([5, 0, 0, 0, 0])],
  ['unsupported version', new Uint8Array([5, 0, 0, 0, 0, 99, 0])],
  ['short extension', new Uint8Array([5, 0, 0, 0, 0, 2, 0, 1])],
  ['oversized extension', new Uint8Array([5, 0, 0, 0, 0, 2, 0, 4, 255, 255, 255, 255])],
  ['duplicate extension', new Uint8Array([5, 0, 0, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0])],
  ['malformed auth', new Uint8Array([5, 0, 0, 0, 0, 2, 0, 2, 0, 0, 0, 0])],
  ['required auth', new Uint8Array([5, 0, 0, 0, 0, 2, 0, 2, 1, 0, 0, 0, 1])],
  ['excessive greeting', new Uint8Array(65537)],
];
for (const [label, data] of invalidGreetings) {
  test(`Wisp probe rejects ${label} and closes every resource`, async () => {
    const time = clock();
    const { Socket, instances } = sockets();
    const result = probeWisp(primary, { WebSocketCtor: Socket, setTimer: time.setTimer, clearTimer: time.clearTimer });
    const assertion = assert.rejects(result);
    instances[0].fire('message', data);
    await assertion;
    assert.equal(instances[0].listenerCount, 0);
    assert.equal(instances[0].closed, 1);
    assert.equal(time.count, 0);
  });
}

for (const event of ['error', 'close', 'timeout', 'abort']) {
  test(`Wisp probe releases listeners and timeout after ${event}`, async () => {
    const time = clock();
    const controller = new AbortController();
    const { Socket, instances } = sockets();
    const result = probeWisp(primary, { WebSocketCtor: Socket, signal: controller.signal, timeoutMs: 50, setTimer: time.setTimer, clearTimer: time.clearTimer });
    const assertion = assert.rejects(result, event === 'abort' ? { name: 'AbortError' } : Error);
    if (event === 'timeout') await time.advance(50);
    else if (event === 'abort') controller.abort();
    else instances[0].fire(event);
    await assertion;
    assert.equal(instances[0].listenerCount, 0);
    assert.equal(instances[0].closed, 1);
    assert.equal(time.count, 0);
    controller.abort();
    assert.equal(instances[0].closed, 1);
  });
}

test('Wisp probe handles pre-aborted signals, unavailable API, and constructor exceptions', async () => {
  const { Socket, instances } = sockets();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(probeWisp(primary, { signal: controller.signal, WebSocketCtor: Socket }), { name: 'AbortError' });
  assert.equal(instances.length, 0);
  await assert.rejects(probeWisp(primary, { WebSocketCtor: null }), /unavailable/);
  await assert.rejects(probeWisp(primary, { WebSocketCtor: class { constructor() { throw new Error('blocked'); } } }), /blocked/);
  await assert.rejects(probeWisp('https://primary.example/'), /ws\/wss/);
});

test('network validates admin endpoint configuration and deduplicates URLs', async () => {
  for (const endpoints of [[], Array(16).fill(primary), ['https://wrong.example/'], ['wss://user:secret@example.com/'], ['wss://example.com/#fragment'], ['wss://example.com/\n']]) {
    assert.throws(() => network({ endpoints }), TypeError);
  }
  const { manager } = network({ endpoints: [primary, primary] });
  assert.equal(manager.state.configuredCount, 1);
  assert(Object.isFrozen(manager.state));
  manager.dispose();
});

test('network exhaustively tries primary plus fourteen backups and activates only a proven endpoint', async () => {
  const endpoints = Array.from({ length: 15 }, (_, index) => `wss://proxy-${index}.example/wisp/`);
  const attempted = [];
  const app = network({ endpoints, probe: async url => { attempted.push(url); if (url !== endpoints[14]) throw new Error('failed'); } });
  assert.equal(await app.manager.connect(), endpoints[14]);
  assert.deepEqual(attempted, endpoints);
  assert.deepEqual(app.activated, [endpoints[14]]);
  assert.equal(app.manager.state.status, 'connected');
  assert.equal(app.time.count, 1);
  app.manager.dispose();
  assert.equal(app.time.count, 0);
});

test('simultaneous connects coalesce and await transport activation', async () => {
  const gate = deferred();
  const app = network({ activate: () => gate.promise });
  const first = app.manager.connect();
  const second = app.manager.connect();
  assert.equal(first, second);
  await flush();
  assert.equal(app.manager.activeEndpoint, null);
  assert.equal(app.time.count, 0);
  assert.equal(app.probed.length, 1);
  gate.resolve();
  assert.equal(await first, primary);
  assert.equal(await app.manager.connect(), primary);
  assert.equal(app.probed.length, 1);
  assert.equal(app.time.count, 1);
  app.manager.dispose();
});

test('activation failure selects the next backup', async () => {
  const activated = [];
  const app = network({ activate: async url => { activated.push(url); if (url === primary) throw new Error('transport unavailable'); } });
  assert.equal(await app.manager.connect(), backup);
  assert.deepEqual(activated, [primary, backup]);
  app.manager.dispose();
});

test('health monitoring switches only after two consecutive failures', async () => {
  const down = new Set();
  const attempts = [];
  const app = network({ probe: async url => { attempts.push(url); if (down.has(url)) throw new Error('down'); } });
  await app.manager.connect();
  down.add(primary);
  await app.time.advance(100);
  assert.equal(app.manager.activeEndpoint, primary);
  assert.equal(app.manager.state.status, 'degraded');
  await app.time.advance(100);
  assert.equal(app.manager.activeEndpoint, backup);
  assert.deepEqual(attempts, [primary, primary, primary, backup]);
  assert.deepEqual(app.activated, [primary, backup]);
  assert.equal(app.time.count, 1);
  app.manager.dispose();
});

test('a healthy probe after a destination failure preserves transport and resets consecutive failures', async () => {
  let down = false;
  const app = network({ probe: async () => { if (down) throw new Error('down'); } });
  await app.manager.connect();
  await app.manager.reportFailure();
  assert.deepEqual(app.activated, [primary]);
  down = true;
  await app.manager.reportFailure();
  assert.equal(app.manager.state.healthFailures, 1);
  down = false;
  await app.manager.reportFailure();
  assert.equal(app.manager.state.healthFailures, 0);
  down = true;
  await app.manager.reportFailure();
  assert.equal(app.manager.activeEndpoint, primary);
  assert.deepEqual(app.activated, [primary]);
  app.manager.dispose();
});

test('concurrent failure reports produce one probe and one failure count', async () => {
  const gate = deferred();
  let probing = false;
  const app = network({ probe: () => probing ? gate.promise : Promise.resolve() });
  await app.manager.connect();
  probing = true;
  const first = app.manager.reportFailure();
  const second = app.manager.reportFailure();
  assert.equal(first, second);
  await app.time.advance(10000);
  assert.equal(app.time.count, 0, 'monitoring may not overlap a pending check');
  gate.reject(new Error('down'));
  await first;
  assert.equal(app.manager.state.healthFailures, 1);
  assert.equal(app.time.count, 1);
  app.manager.dispose();
});

test('all endpoints down uses one bounded backoff timer and automatically recovers', async () => {
  let down = true;
  let attempts = 0;
  const app = network({ probe: async () => { attempts += 1; if (down) throw new Error('down'); } });
  await assert.rejects(app.manager.connect(), /None of the configured/);
  assert.equal(app.manager.state.status, 'unavailable');
  assert.equal(app.time.count, 1);
  assert.equal(attempts, 2);
  await assert.rejects(app.manager.connect(), /None of the configured/);
  assert.equal(attempts, 2, 'cooldown prevents immediate repeated probes');
  assert.equal(app.time.count, 1);
  assert(app.time.nextAt - app.time.now() <= 2000);
  down = false;
  await app.time.advance(2000);
  assert.equal(app.manager.activeEndpoint, primary);
  assert.equal(app.time.count, 1);
  assert.equal(attempts, 3);
  app.manager.dispose();
});

test('an explicit forced retry can recover before cooldown expires', async () => {
  let down = true;
  const app = network({ probe: async () => { if (down) throw new Error('down'); } });
  await assert.rejects(app.manager.connect());
  down = false;
  assert.equal(await app.manager.connect({ force: true }), primary);
  assert.equal(app.time.count, 1);
  app.manager.dispose();
});

test('explicit retry immediately replaces a dead active endpoint without waiting for the monitor', async () => {
  const attempts = [];
  let primaryDown = false;
  const app = network({ probe: async url => {
    attempts.push(url);
    if (primaryDown && url === primary) throw new Error('down');
  } });
  await app.manager.connect();
  primaryDown = true;
  assert.equal(await app.manager.connect({ force: true }), backup);
  assert.deepEqual(attempts, [primary, primary, backup]);
  assert.deepEqual(app.activated, [primary, backup]);
  assert.equal(app.manager.state.status, 'connected');
  assert.equal(app.time.count, 1);
  app.manager.dispose();
});

test('explicit retry rebuilds a healthy endpoint transport and simultaneous retries coalesce', async () => {
  const gate = deferred();
  const activated = [];
  const app = network({ activate: async url => {
    activated.push(url);
    if (activated.length === 2) await gate.promise;
  } });
  await app.manager.connect();
  const retry = app.manager.connect({ force: true });
  const repeatedRetry = app.manager.connect({ force: true });
  assert.equal(retry, repeatedRetry);
  await flush();
  assert.deepEqual(app.probed, [primary, primary]);
  assert.deepEqual(activated, [primary, primary]);
  assert.equal(app.manager.activeEndpoint, null);
  gate.resolve();
  assert.equal(await retry, primary);
  assert.equal(app.time.count, 1);
  app.manager.dispose();
});

test('explicit retry queued during a health check still reconnects after its first failure', async () => {
  const gate = deferred();
  const attempts = [];
  let primaryDown = false;
  const app = network({ probe: async url => {
    attempts.push(url);
    if (attempts.length === 2) return gate.promise;
    if (primaryDown && url === primary) throw new Error('down');
  } });
  await app.manager.connect();
  const monitor = app.manager.reportFailure();
  await flush();
  const retry = app.manager.connect({ force: true });
  const repeatedRetry = app.manager.connect({ force: true });
  primaryDown = true;
  gate.reject(new Error('down'));
  await monitor;
  assert.equal(await retry, backup);
  assert.equal(await repeatedRetry, backup);
  assert.deepEqual(attempts, [primary, primary, primary, backup]);
  assert.deepEqual(app.activated, [primary, backup]);
  assert.equal(app.time.count, 1);
  app.manager.dispose();
});

test('offline pauses probes and online resumes after a connection failure', async () => {
  const app = network({ online: false });
  assert.equal(app.manager.state.status, 'offline');
  await assert.rejects(app.manager.connect(), /offline/);
  assert.equal(app.probed.length, 0);
  assert.equal(await app.manager.setOnline(true), primary);
  await app.manager.setOnline(false);
  assert.equal(app.manager.activeEndpoint, null);
  assert.equal(app.time.count, 0);
  await app.time.advance(10000);
  assert.equal(app.probed.length, 1);
  assert.equal(await app.manager.setOnline(true), backup);
  assert.equal(app.time.count, 1);
  app.manager.dispose();
});

test('dispose during a late probe prevents activation and retry timers', async () => {
  const gate = deferred();
  const app = network({ probe: () => gate.promise });
  const pending = app.manager.connect();
  const assertion = assert.rejects(pending, { name: 'AbortError' });
  await flush();
  app.manager.dispose();
  gate.resolve();
  await assertion;
  assert.deepEqual(app.activated, []);
  assert.equal(app.time.count, 0);
  assert.equal(app.manager.activeEndpoint, null);
  assert.equal(app.manager.state.status, 'disposed');
  await assert.rejects(app.manager.connect(), { name: 'AbortError' });
});

test('dispose during activation never marks a late activation connected', async () => {
  const gate = deferred();
  const app = network({ activate: () => gate.promise });
  const pending = app.manager.connect();
  const assertion = assert.rejects(pending, { name: 'AbortError' });
  await flush();
  app.manager.dispose();
  gate.resolve();
  await assertion;
  assert.equal(app.manager.state.status, 'disposed');
  assert.equal(app.manager.activeEndpoint, null);
  assert.equal(app.time.count, 0);
});

test('offline/online during slow activation serializes the stale and replacement transports', async () => {
  const gate = deferred();
  let running = 0;
  let activations = 0;
  const app = network({ activate: async () => {
    running += 1;
    activations += 1;
    assert.equal(running, 1, 'transport replacements must never overlap');
    if (activations === 1) await gate.promise;
    running -= 1;
  } });
  const first = app.manager.connect();
  const firstAssertion = assert.rejects(first, { name: 'AbortError' });
  await flush();
  await app.manager.setOnline(false);
  const recovered = app.manager.setOnline(true);
  const alsoRecovered = app.manager.connect();
  await flush();
  assert.equal(activations, 1);
  gate.resolve();
  await firstAssertion;
  assert.equal(await recovered, primary);
  assert.equal(await alsoRecovered, primary);
  assert.equal(activations, 2);
  assert.equal(app.time.count, 1);
  app.manager.dispose();
});

test('UI status callback failures do not abort failover', async () => {
  const app = network({ onStatus() { throw new Error('display failed'); } });
  assert.equal(await app.manager.connect(), primary);
  app.manager.dispose();
});

test('disposing from a retry status subscriber cannot leave a reconnect timer', async () => {
  const app = network({
    probe: unavailable,
    onStatus(status) { if (status.retryAt !== null) app.manager.dispose(); },
  });
  await assert.rejects(app.manager.connect(), /None of the configured/);
  assert.equal(app.manager.state.status, 'disposed');
  assert.equal(app.time.count, 0);
});

test('a real handshake timeout selects a working backup without leaked sockets', async () => {
  const time = clock();
  const { Socket, instances } = sockets();
  const manager = createProxyNetwork({ endpoints: [primary, backup], activate: async () => {}, probe: (url, options) => probeWisp(url, { ...options, WebSocketCtor: Socket }), probeTimeoutMs: 20, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
  const pending = manager.connect();
  await flush();
  instances[0].fire('open');
  await time.advance(20);
  assert.equal(instances.length, 2);
  instances[1].fire('message', greeting());
  assert.equal(await pending, backup);
  assert(instances.every(socket => socket.closed === 1 && socket.listenerCount === 0));
  assert.equal(time.count, 1, 'only periodic health timer remains');
  manager.dispose();
  assert.equal(time.count, 0);
});
