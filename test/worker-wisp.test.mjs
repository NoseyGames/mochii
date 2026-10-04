import test from 'node:test';
import assert from 'node:assert/strict';
import { attachWisp, packet, LIMITS } from '../workers/wisp/protocol.mjs';
import { allowedOrigin, admitConnection, destinationHostname, isPublicAddress, resolvePublicAddress } from '../workers/wisp/policy.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const text = value => new TextEncoder().encode(value);
const connectPacket = (id = 1, host = 'example.com', port = 80, type = 1) => {
  const body = new Uint8Array(3 + text(host).length);
  body[0] = type;
  new DataView(body.buffer).setUint16(1, port, true);
  body.set(text(host), 3);
  return packet(1, id, body);
};
class Socket extends EventTarget {
  readyState = 1; sent = []; code = null;
  send(value) { this.sent.push(new Uint8Array(value)); }
  close(code) { this.code = code; this.readyState = 3; }
  receive(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
}
function fixture(t, options = {}) {
  const ws = new Socket(), calls = [], writes = [], sockets = [], timers = new Map();
  let timer = 0;
  const connect = (address, config) => {
    calls.push({ address, config });
    let reader, finish;
    const tcp = {
      opened: Promise.resolve(), closed: new Promise(resolve => { finish = resolve; }),
      readable: new ReadableStream({ start(controller) { reader = controller; } }),
      writable: new WritableStream({ write(data) { writes.push(new Uint8Array(data)); } }),
      close() { if (!tcp.ended) { tcp.ended = true; try { reader.close(); } catch {} finish(); } return Promise.resolve(); },
      push(data) { reader.enqueue(data); }, end() { reader.close(); tcp.ended = true; finish(); },
    };
    sockets.push(tcp);
    return tcp;
  };
  const session = attachWisp(ws, { connect, resolve: async () => '93.184.215.14',
    setTimer(fn, ms) { timers.set(++timer, { fn, ms }); return timer; }, clearTimer(id) { timers.delete(id); }, ...options });
  t.after(() => session.close());
  return { ws, calls, writes, sockets, timers, session };
}

test('Worker Wisp policy rejects local, special, numeric and malformed destinations', () => {
  for (const host of ['localhost', 'a.local', 'x.internal', 'x.home.arpa', 'a.onion', '127.0.0.1', '2130706433', '0177.0.0.1', '::1', 'a..com', 'a.com/', 'a.com\n', 'a.com:80', '-x.com']) {
    assert.equal(destinationHostname(text(host)), null, host);
  }
  assert.equal(destinationHostname(text('Example.COM')), 'example.com');
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '100.64.0.1', '::1', 'fc00::1', '::ffff:127.0.0.1', '224.0.0.1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('93.184.215.14'), true);
});

test('Worker Wisp origin allowlist is exact, requires configuration and rejects null, credentials and paths', () => {
  const env = { WISP_ALLOWED_ORIGINS: '["https://proxy.example"]' };
  const request = origin => new Request('https://proxy.example/wisp/', { headers: { Origin: origin } });
  assert(allowedOrigin(request('https://proxy.example'), env));
  for (const origin of ['null', 'https://proxy.example/', 'https://user@proxy.example', 'https://proxy.example.attacker.test', 'http://proxy.example']) assert.equal(allowedOrigin(request(origin), env), false);
  assert.equal(allowedOrigin(request('https://proxy.example'), {}), false);
});

test('Worker Wisp DNS pins only a validated public answer and bounds resolver responses', async () => {
  let requested;
  const result = await resolvePublicAddress('example.com', undefined, async (url, options) => {
    requested = { url, options };
    return Response.json({ Status: 0, Answer: [{ type: 1, data: '127.0.0.1' }, { type: 1, data: '93.184.215.14' }] });
  });
  assert.equal(result, '93.184.215.14');
  assert.equal(new URL(requested.url).hostname, 'cloudflare-dns.com');
  assert.equal(requested.options.redirect, 'manual');
  await assert.rejects(resolvePublicAddress('example.com', undefined, async () => Response.json({ Status: 0, Answer: [{ type: 1, data: '10.1.1.1' }] })), /not public/);
  await assert.rejects(resolvePublicAddress('example.com', undefined, async () => new Response('x'.repeat(32769))), /too large/);
});

test('Worker Wisp upgrade rate limits fail closed and stop per-IP abuse before using the shared budget', async () => {
  const request = new Request('https://proxy.example/wisp/', { headers: { 'CF-Connecting-IP': '203.0.113.2' } });
  const calls = [];
  const rate = success => ({ async limit({ key }) { calls.push(key); return { success }; } });
  assert.equal(await admitConnection(request, {}), 503);
  assert.equal(await admitConnection(new Request(request.url), { WISP_RATE: rate(true), WISP_GLOBAL_RATE: rate(true) }), 503);
  assert.equal(await admitConnection(request, { WISP_RATE: rate(false), WISP_GLOBAL_RATE: rate(true) }), 429);
  assert.deepEqual(calls, ['203.0.113.2']);
  calls.length = 0;
  assert.equal(await admitConnection(request, { WISP_RATE: rate(true), WISP_GLOBAL_RATE: rate(false) }), 429);
  assert.deepEqual(calls, ['203.0.113.2', 'wisp-upgrades']);
  assert.equal(await admitConnection(request, { WISP_RATE: rate(true), WISP_GLOBAL_RATE: rate(true) }), 0);
  assert.equal(await admitConnection(request, { WISP_RATE: { limit() { throw new Error('unavailable'); } }, WISP_GLOBAL_RATE: rate(true) }), 503);
});

test('Worker Wisp v1 passes TCP bytes through a pinned literal, replenishes credit, and releases all resources', async t => {
  const app = fixture(t);
  assert.equal(app.ws.sent[0][0], 3);
  app.ws.receive(connectPacket());
  app.ws.receive(packet(2, 1, text('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n')));
  await tick();
  assert.deepEqual(app.calls[0], { address: { hostname: '93.184.215.14', port: 80 }, config: { secureTransport: 'off', allowHalfOpen: false } });
  assert.match(new TextDecoder().decode(app.writes[0]), /^GET/);
  app.sockets[0].push(text('HTTP/1.1 200 OK\r\n\r\nExample Domain'));
  for (let i = 1; i < LIMITS.window; i++) app.ws.receive(packet(2, 1, text('x')));
  await tick();
  assert.equal(app.writes.length, LIMITS.window);
  assert(app.ws.sent.some(data => data[0] === 2 && new TextDecoder().decode(data.subarray(5)).includes('200 OK')));
  const grant = app.ws.sent.find(data => data[0] === 3 && data[1] === 1);
  assert.equal(new DataView(grant.buffer).getUint32(5, true), LIMITS.window);
  app.ws.receive(packet(4, 1, Uint8Array.of(2)));
  assert.equal(app.session.state.streams, 0);
  assert.equal(app.session.state.queued, 0);
  assert(app.sockets[0].ended);
  app.session.close();
  assert.equal(app.timers.size, 0);
});

test('Worker Wisp v2 negotiates before stream traffic and rejects malformed extensions', t => {
  const app = fixture(t, { version2: true });
  assert.deepEqual([...app.ws.sent[0]], [5, 0, 0, 0, 0, 2, 0]);
  app.ws.receive(packet(5, 0, Uint8Array.of(2, 0)));
  assert.equal(app.ws.sent[1][0], 3);
  const bad = fixture(t, { version2: true });
  bad.ws.receive(packet(5, 0, Uint8Array.of(2, 0, 1)));
  assert.equal(bad.ws.code, 1002);
  const early = fixture(t, { version2: true });
  early.ws.receive(connectPacket());
  assert.equal(early.calls.length, 0);
  assert.equal(early.ws.code, 1002);
});

test('Worker Wisp blocks UDP, non-web ports, private DNS and duplicate IDs before unwanted TCP connects', async t => {
  const app = fixture(t);
  for (const data of [connectPacket(1, 'example.com', 22), connectPacket(2, 'example.com', 80, 2), connectPacket(3, '127.0.0.1')]) app.ws.receive(data);
  assert.equal(app.calls.length, 0);
  assert(app.ws.sent.slice(1).every(data => data[0] === 4 && data[5] === 0x48));
  const privateApp = fixture(t, { resolve: async () => '169.254.169.254' });
  privateApp.ws.receive(connectPacket());
  await tick();
  assert.equal(privateApp.calls.length, 0);
  assert.equal(privateApp.ws.sent.at(-1)[5], 0x48);
  app.ws.receive(connectPacket());
  app.ws.receive(connectPacket());
  assert.equal(app.ws.code, 1002);
  await tick();
  assert.equal(app.calls.length, 0);
});

test('Worker Wisp closes and cancels pending DNS without reopening a socket', async t => {
  let finish, signal;
  const app = fixture(t, { resolve: (_, pendingSignal) => { signal = pendingSignal; return new Promise(resolve => { finish = resolve; }); } });
  app.ws.receive(connectPacket());
  app.ws.receive(packet(2, 1, text('queued')));
  app.ws.receive(packet(4, 1, Uint8Array.of(2)));
  assert(signal.aborted);
  assert.equal(app.session.state.queued, 0);
  finish('93.184.215.14');
  await tick();
  assert.equal(app.calls.length, 0);
});

test('Worker Wisp enforces concurrent streams, lifetime opened-stream budget, frame and flow limits', async t => {
  const app = fixture(t, { resolve: () => new Promise(() => {}) });
  for (let id = 1; id <= LIMITS.streams + 1; id++) app.ws.receive(connectPacket(id));
  assert.equal(app.session.state.streams, LIMITS.streams);
  assert.equal(app.ws.sent.at(-1)[5], 0x49);
  for (let count = 0; count <= LIMITS.window; count++) app.ws.receive(packet(2, 1, text('x')));
  assert.equal(app.ws.code, 1008);
  assert.equal(app.session.state.queued, 0);
  const frame = fixture(t);
  frame.ws.receive(new Uint8Array(LIMITS.frame + 1));
  assert.equal(frame.ws.code, 1009);
  const budget = fixture(t, { limits: { ...LIMITS, openedStreams: 1 } });
  budget.ws.receive(connectPacket());
  budget.ws.receive(packet(4, 1, Uint8Array.of(2)));
  budget.ws.receive(connectPacket(2));
  assert.equal(budget.session.state.opened, 1);
  assert.equal(budget.ws.sent.at(-1)[5], 0x49);
});

test('Worker Wisp bounds pending input bytes, total transfer and idle session lifetime', async t => {
  const queued = fixture(t, { resolve: () => new Promise(() => {}), limits: { ...LIMITS, queued: 3 } });
  queued.ws.receive(connectPacket());
  queued.ws.receive(packet(2, 1, text('four')));
  assert.equal(queued.ws.code, 1008);
  const transfer = fixture(t, { limits: { ...LIMITS, transfer: 3 } });
  transfer.ws.receive(connectPacket());
  await tick();
  transfer.sockets[0].push(text('four'));
  await tick();
  assert.equal(transfer.ws.code, 1008);
  const idle = fixture(t);
  [...idle.timers.values()].find(timer => timer.ms === LIMITS.lifetime).fn();
  assert.equal(idle.ws.code, 1000);
  assert.equal(idle.timers.size, 0);
});

test('Worker Wisp connect failures close just the affected stream and timeout cancels DNS', async t => {
  const failed = fixture(t, { connect: () => { throw new Error('TCP unavailable'); } });
  failed.ws.receive(connectPacket());
  await tick();
  assert.equal(failed.ws.sent.at(-1)[5], 3);
  assert.equal(failed.session.state.closed, false);
  const stalled = fixture(t, { resolve: () => new Promise(() => {}) });
  stalled.ws.receive(connectPacket());
  [...stalled.timers.values()].find(timer => timer.ms === LIMITS.connectTimeout).fn();
  assert.equal(stalled.session.state.streams, 0);
  assert.equal(stalled.ws.sent.at(-1)[5], 3);
});
