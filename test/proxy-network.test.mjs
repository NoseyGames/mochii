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
  for (const endpoints of [[], Array(33).fill(primary), ['https://wrong.example/'], ['wss://user:secret@example.com/'], ['wss://example.com/#fragment'], ['wss://example.com/\n']]) {
    assert.throws(() => network({ endpoints }), TypeError);
  }
  const { manager } = network({ endpoints: [primary, primary] });
  assert.equal(manager.state.configuredCount, 1);
  assert(Object.isFrozen(manager.state));
  manager.dispose();
  for (const fallbackEndpoints of [null, ['wss://not-configured.example/'], Array(33).fill(primary)]) {
    assert.throws(() => network({ fallbackEndpoints }), /subset/);
  }
});

test('network races all 32 endpoint slots and activates only a proven endpoint', async () => {
  const endpoints = Array.from({ length: 32 }, (_, index) => `wss://proxy-${index}.example/wisp/`);
  const attempted = [];
  const app = network({ endpoints, probe: async url => { attempted.push(url); if (url !== endpoints[31]) throw new Error('failed'); } });
  assert.equal(await app.manager.connect(), endpoints[31]);
  assert.deepEqual(attempted, endpoints);
  assert.deepEqual(app.activated, [endpoints[31]]);
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
  assert.equal(app.probed.length, 2);
  gate.resolve();
  assert.equal(await first, primary);
  assert.equal(await app.manager.connect(), primary);
  assert.equal(app.probed.length, 2);
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
  assert.deepEqual(attempts, [primary, backup, primary, primary, backup]);
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
  assert.equal(attempts, 4);
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
  assert.deepEqual(attempts, [primary, backup, primary, backup]);
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
  assert.deepEqual(app.probed, [primary, backup, primary, backup]);
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
    if (attempts.length === 3) return gate.promise;
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
  assert.deepEqual(attempts, [primary, backup, primary, primary, backup]);
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
  assert.equal(app.probed.length, 2);
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

test('a fast valid backup beats a stalled primary and cancels every losing handshake', async () => {
  const time = clock();
  const { Socket, instances } = sockets();
  const manager = createProxyNetwork({ endpoints: [primary, backup], activate: async () => {}, probe: (url, options) => probeWisp(url, { ...options, WebSocketCtor: Socket }), probeTimeoutMs: 20, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
  const pending = manager.connect();
  await flush();
  instances[0].fire('open');
  assert.equal(instances.length, 2);
  await time.advance(5);
  instances[1].fire('message', greeting());
  assert.equal(await pending, backup);
  assert(instances.every(socket => socket.closed === 1 && socket.listenerCount === 0));
  assert.equal(time.count, 1, 'only periodic health timer remains');
  manager.dispose();
  assert.equal(time.count, 0);
});

test('a JSON WebSocket relay cannot win before a slower valid Wisp handshake', async () => {
  const time = clock();
  const { Socket, instances } = sockets();
  const activated = [];
  const manager = createProxyNetwork({ endpoints: [primary, backup], activate: async url => activated.push(url),
    probe: (url, options) => probeWisp(url, { ...options, WebSocketCtor: Socket }),
    now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
  const pending = manager.connect();
  await flush();
  instances[0].fire('open');
  instances[0].fire('message', '["NOTICE","Welcome to this relay"]');
  await flush();
  assert.deepEqual(activated, []);
  instances[1].fire('message', greeting());
  assert.equal(await pending, backup);
  assert.deepEqual(activated, [backup]);
  assert(instances.every(socket => socket.closed === 1 && socket.listenerCount === 0));
  manager.dispose();
  assert.equal(time.count, 0);
});

test('failed activation continues through verified candidates while slower probes remain pending', async () => {
  const third = 'wss://third.example/relay';
  const probes = new Map([primary, backup, third].map(url => [url, deferred()]));
  const activation = deferred(), activated = [], signals = new Map();
  let running = 0;
  const app = network({ endpoints: [primary, backup, third],
    probe(url, { signal }) { signals.set(url, signal); return probes.get(url).promise; },
    async activate(url) {
      assert.equal(++running, 1);
      activated.push(url);
      try { if (url === primary) await activation.promise; }
      finally { running--; }
    },
  });
  const pending = app.manager.connect();
  await flush();
  probes.get(primary).resolve();
  await flush();
  probes.get(backup).resolve();
  await flush();
  assert.deepEqual(activated, [primary], 'verified candidates must wait for prior activation');
  activation.reject(new Error('Activation failed'));
  assert.equal(await pending, backup);
  assert.deepEqual(activated, [primary, backup]);
  assert(signals.get(third).aborted, 'pending slow probe must be canceled after successful activation');
  probes.get(third).reject(new Error('late losing failure'));
  await flush();
  assert.equal(app.manager.activeEndpoint, backup);
  app.manager.dispose();
});

test('a failed fast activation waits for a slower valid probe instead of exhausting early', async () => {
  const slow = deferred();
  const activated = [];
  const app = network({ probe: url => url === backup ? slow.promise : Promise.resolve(),
    activate: async url => { activated.push(url); if (url === primary) throw new Error('bad transport'); } });
  const pending = app.manager.connect();
  await flush();
  assert.deepEqual(activated, [primary]);
  assert.equal(app.manager.activeEndpoint, null);
  slow.resolve();
  assert.equal(await pending, backup);
  assert.deepEqual(activated, [primary, backup]);
  app.manager.dispose();
});

test('limited fallbacks never outrun a pending ordinary endpoint', async () => {
  const ordinary = deferred();
  const attempted = [];
  const app = network({ fallbackEndpoints: [backup], probe: url => { attempted.push(url); return url === primary ? ordinary.promise : Promise.resolve(); } });
  const pending = app.manager.connect();
  await flush();
  assert.deepEqual(attempted, [primary]);
  ordinary.resolve();
  assert.equal(await pending, primary);
  assert.deepEqual(attempted, [primary], 'fallback has no handshake traffic while an ordinary server succeeds');
  app.manager.dispose();
});

test('limited fallback runs after every ordinary activation fails and preserves exact endpoint paths', async () => {
  const endpoints = ['wss://first.example/wisp', 'wss://second.example/relay', 'wss://fallback.example/'];
  const attempted = [], activated = [];
  const app = network({ endpoints, fallbackEndpoints: [endpoints[2]],
    probe: async url => attempted.push(url),
    activate: async url => { activated.push(url); if (url !== endpoints[2]) throw new Error('unavailable'); },
  });
  assert.equal(await app.manager.connect(), endpoints[2]);
  assert.deepEqual(attempted, endpoints);
  assert.deepEqual(activated, endpoints);
  app.manager.dispose();
});

for (const action of ['dispose', 'offline']) {
  test(`${action} cancels all in-flight real handshakes and releases timers without waiting for timeouts`, async () => {
    const time = clock();
    const { Socket, instances } = sockets();
    const manager = createProxyNetwork({ endpoints: [primary, backup], activate: async () => { assert.fail('late activation'); },
      probe: (url, options) => probeWisp(url, { ...options, WebSocketCtor: Socket }),
      now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
    const assertion = assert.rejects(manager.connect(), { name: 'AbortError' });
    await flush();
    assert.equal(instances.length, 2);
    if (action === 'dispose') manager.dispose(); else await manager.setOnline(false);
    await assertion;
    assert.equal(time.count, 0);
    assert(instances.every(socket => socket.closed === 1 && socket.listenerCount === 0));
    manager.dispose();
  });
}

test('cancellation ignores probes that never settle so reconnect does not wait for dead promises', async () => {
  let recover = false;
  const app = network({ probe: () => recover ? Promise.resolve() : new Promise(() => {}) });
  const assertion = assert.rejects(app.manager.connect(), { name: 'AbortError' });
  await flush();
  await app.manager.setOnline(false);
  recover = true;
  const retry = app.manager.setOnline(true);
  await assertion;
  assert.equal(await retry, primary);
  assert.equal(app.time.count, 1);
  app.manager.dispose();
});

test('all simultaneous real handshake timeouts produce one retry timer', async () => {
  const time = clock();
  const { Socket, instances } = sockets();
  const manager = createProxyNetwork({ endpoints: [primary, backup], activate: async () => { assert.fail('no valid greeting'); },
    probe: (url, options) => probeWisp(url, { ...options, WebSocketCtor: Socket }), probeTimeoutMs: 20,
    now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
  const assertion = assert.rejects(manager.connect(), /None of the configured/);
  await flush();
  await time.advance(20);
  await assertion;
  assert(instances.every(socket => socket.closed === 1 && socket.listenerCount === 0));
  assert.equal(time.count, 1);
  manager.dispose();
  assert.equal(time.count, 0);
});

test('explicit switch excludes a healthy greeting after a destination fault without globally penalizing that server', async () => {
  let backupDown = false;
  const attempted = [];
  const app = network({ failureThreshold: 1, probe: async url => {
    attempted.push(url);
    if (backupDown && url === backup) throw new Error('backup down');
  } });
  await app.manager.connect();
  attempted.length = 0;
  assert.equal(await app.manager.switchEndpoint(), backup);
  assert.deepEqual(attempted, [backup], 'the failed destination endpoint cannot immediately win the latency race again');
  assert.equal(app.manager.state.healthFailures, 0);
  backupDown = true;
  assert.equal(await app.manager.reportFailure(), primary, 'a destination-specific fault must not cool down a globally healthy proxy');
  assert.deepEqual(app.activated, [primary, backup, primary]);
  app.manager.dispose();
});

test('switching without an available alternative rejects instead of returning the excluded endpoint', async () => {
  const app = network({ endpoints: [primary] });
  await app.manager.connect();
  await assert.rejects(app.manager.switchEndpoint(), /No alternative proxy/);
  assert.deepEqual(app.probed, [primary]);
  assert.deepEqual(app.activated, [primary]);
  assert.equal(app.manager.activeEndpoint, null);
  assert.equal(app.time.count, 1, 'normal future recovery remains scheduled without replaying a page');
  app.manager.dispose();
});

test('repeated switches, navigation connects and monitors coalesce while alternate activation is pending', async () => {
  const gate = deferred();
  const activated = [];
  const app = network({ activate: async url => { activated.push(url); if (url === backup) await gate.promise; } });
  await app.manager.connect();
  const first = app.manager.switchEndpoint();
  assert.equal(app.manager.switchEndpoint({ failedEndpoint: primary }), first);
  assert.equal(app.manager.connect(), first);
  assert.equal(app.manager.reportFailure(), first);
  await flush();
  assert.deepEqual(activated, [primary, backup]);
  assert.equal(app.time.count, 0);
  gate.resolve();
  assert.equal(await first, backup);
  assert.equal(app.time.count, 1);
  app.manager.dispose();
});

test('switch waits for an existing health check and then excludes its still-healthy endpoint', async () => {
  const gate = deferred();
  let monitor = false;
  const attempted = [];
  const app = network({ probe: url => { attempted.push(url); return monitor && url === primary ? gate.promise : Promise.resolve(); } });
  await app.manager.connect();
  monitor = true;
  const health = app.manager.reportFailure();
  await flush();
  const change = app.manager.switchEndpoint({ failedEndpoint: primary });
  await flush();
  assert.deepEqual(app.activated, [primary]);
  gate.resolve();
  await health;
  assert.equal(await change, backup);
  assert.deepEqual(attempted, [primary, backup, primary, backup]);
  assert.equal(app.time.count, 1);
  app.manager.dispose();
});

test('a queued switch accepts a different endpoint already chosen by the preceding health failure', async () => {
  const gate = deferred();
  let monitor = false;
  const app = network({ failureThreshold: 1, probe: url => monitor && url === primary ? gate.promise : Promise.resolve() });
  await app.manager.connect();
  monitor = true;
  const health = app.manager.reportFailure();
  await flush();
  const change = app.manager.switchEndpoint({ failedEndpoint: primary });
  gate.reject(new Error('down'));
  assert.equal(await health, backup);
  assert.equal(await change, backup);
  assert.deepEqual(app.activated, [primary, backup], 'the queued switch must not rotate away from a newly recovered endpoint');
  app.manager.dispose();
});

test('offline and reconnect during switching wait for the old activation without overlapping mutations', async () => {
  const gate = deferred();
  let activations = 0, running = 0;
  const app = network({ activate: async () => {
    assert.equal(++running, 1);
    try { if (++activations === 2) await gate.promise; }
    finally { running--; }
  } });
  await app.manager.connect();
  const change = app.manager.switchEndpoint();
  const rejected = assert.rejects(change, { name: 'AbortError' });
  await flush();
  await app.manager.setOnline(false);
  const recovered = app.manager.setOnline(true);
  await flush();
  assert.equal(activations, 2);
  gate.resolve();
  await rejected;
  assert.equal(await recovered, primary);
  assert.equal(activations, 3);
  assert.equal(app.time.count, 1);
  app.manager.dispose();
});

test('disposing a queued switch prevents late alternate selection', async () => {
  const gate = deferred();
  let monitor = false;
  const app = network({ probe: () => monitor ? gate.promise : Promise.resolve() });
  await app.manager.connect();
  monitor = true;
  const health = app.manager.reportFailure();
  const healthRejected = assert.rejects(health, { name: 'AbortError' });
  await flush();
  const changeRejected = assert.rejects(app.manager.switchEndpoint(), { name: 'AbortError' });
  app.manager.dispose();
  gate.resolve();
  await Promise.all([healthRejected, changeRejected]);
  assert.deepEqual(app.activated, [primary]);
  assert.equal(app.time.count, 0);
  assert.equal(app.manager.state.status, 'disposed');
});

test('switch preserves fallback priority and validates an explicitly captured failed endpoint', async () => {
  const limited = 'wss://limited.example/wisp/';
  const app = network({ endpoints: [primary, backup, limited], fallbackEndpoints: [limited] });
  await app.manager.connect();
  await assert.rejects(app.manager.switchEndpoint({ failedEndpoint: 'wss://unconfigured.example/' }), /configured/);
  await assert.rejects(app.manager.switchEndpoint({ failedEndpoint: 'https://wrong.example/' }), /ws\/wss/);
  assert.equal(app.manager.activeEndpoint, primary);
  assert.equal(await app.manager.switchEndpoint({ failedEndpoint: primary }), backup);
  assert.deepEqual(app.probed, [primary, backup, backup], 'limited fallback is not probed while an ordinary alternative works');
  app.manager.dispose();
});
