import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createServer as createTcpServer, createConnection } from 'node:net';
import { request } from 'node:http';
import WebSocket from 'ws';
import { createAppServer, createProxyServer } from '../server.mjs';
import { loadServerConfig } from '../server-config.mjs';

async function fixture(t, options = {}) {
  const server = createAppServer({ env: {}, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); });
  return { server, origin, url: `${origin.replace('http:', 'ws:')}/wisp/` };
}

async function open(t, fixture, options = {}, protocol) {
  const ws = new WebSocket(fixture.url, protocol, { origin: fixture.origin, handshakeTimeout: 3000, ...options });
  t.after(() => ws.terminate());
  await once(ws, 'message', { signal: AbortSignal.timeout(3000) });
  return ws;
}

function connectPacket(id = 1, hostname = 'example.test', port = 443, type = 1) {
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32LE(id, 1);
  header[5] = type;
  header.writeUInt16LE(port, 6);
  return Buffer.concat([header, Buffer.from(hostname)]);
}

function dataPacket(id, body) {
  const header = Buffer.alloc(5);
  header[0] = 2;
  header.writeUInt32LE(id, 1);
  return Buffer.concat([header, Buffer.from(body)]);
}

function closePacket(id) {
  const data = Buffer.from([4, 0, 0, 0, 0, 2]);
  data.writeUInt32LE(id, 1);
  return data;
}

async function rejected(fixture, options = {}, protocol) {
  const ws = new WebSocket(fixture.url, protocol, { origin: fixture.origin, handshakeTimeout: 3000, ...options });
  ws.on('error', () => {});
  try {
    return await new Promise((resolve, reject) => {
      ws.once('open', () => reject(new Error('Upgrade unexpectedly accepted')));
      ws.once('unexpected-response', (_, response) => { response.resume(); resolve(response.statusCode); });
      ws.once('error', reject);
    });
  } finally { ws.terminate(); }
}

test('server defaults to loopback and refuses accidental unauthenticated public binding', () => {
  assert.equal(loadServerConfig({}).host, '127.0.0.1');
  assert.throws(() => loadServerConfig({ HOST: '0.0.0.0' }), /Public binding requires/);
  assert.equal(loadServerConfig({ HOST: '0.0.0.0', ALLOW_PUBLIC_PROXY: 'true', PUBLIC_ORIGIN: 'https://app.example', PROXY_ORIGIN: 'https://proxy.example' }).host, '0.0.0.0');
  assert.throws(() => loadServerConfig({ PROXY_AUTH_TOKEN: 'short' }), /at least 16/);
  assert.throws(() => loadServerConfig({ PUBLIC_ORIGIN: 'https://host.example/path' }), /origin/);
  assert.throws(() => loadServerConfig({ HOST: '0.0.0.0', ALLOW_PUBLIC_PROXY: 'true' }), /PUBLIC_ORIGIN and PROXY_ORIGIN/);
  assert.throws(() => loadServerConfig({ PUBLIC_ORIGIN: 'https://same.example', PROXY_ORIGIN: 'https://same.example' }), /different/);
  assert.throws(() => loadServerConfig({ PORT: '3000', PROXY_PORT: '3000' }), /different/);
  assert.throws(() => loadServerConfig({ PORT: '65535' }), /PROXY_PORT/);
});

test('implicit proxy origins follow localhost and IPv6 listener addresses', () => {
  assert.equal(loadServerConfig({ HOST: 'localhost' }).publicConfig.proxyOrigin, 'http://localhost:3001');
  for (const host of ['::1', '[::1]']) {
    const config = loadServerConfig({ HOST: host });
    assert.equal(config.host, '::1');
    assert.equal(config.publicConfig.proxyOrigin, 'http://[::1]:3001');
    assert.ok(config.publicConfig.shellOrigins.includes('http://[::1]:3000'));
  }
  assert.equal(loadServerConfig({ HOST: '127.0.0.1' }).publicConfig.proxyOrigin, 'http://127.0.0.1:3001');
});

test('the isolated proxy serves its engine but cannot expose the app shell, saved-script UI, or apps', async t => {
  const server = createProxyServer({ env: { PUBLIC_ORIGIN: 'https://app.example', PROXY_ORIGIN: 'https://proxy.example' } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const pathname of ['/math.html', '/index.html', '/history.html', '/browser-tools/tools.js', '/browser-tools/userscripts.js', '/apps/auk.html', '/server-config.mjs', '/']) {
    const response = await fetch(origin + pathname);
    assert.equal(response.status, 404, pathname);
    await response.text();
  }
  for (const pathname of ['/proxy-host.html', '/flyflix-provider.html', '/browser-tools/runtime.js', '/browser-tools/config.js', '/ultrav/uv.bundle.js', '/bearmux/worker.js', '/sw.js']) {
    const response = await fetch(origin + pathname);
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers.get('x-frame-options'), null);
    assert.equal(response.headers.get('content-security-policy'), 'frame-ancestors https://app.example https://proxy.example');
    await response.arrayBuffer();
  }
  const response = await fetch(origin + '/api/config');
  const config = await response.json();
  assert.equal(config.proxyOrigin, 'https://proxy.example');
  assert.deepEqual(config.shellOrigins, ['https://app.example']);
  const shell = await fixture(t);
  assert.equal((await fetch(shell.origin + '/flyflix-provider.html')).status, 404, 'third-party provider code must never execute on the shell origin');
});

test('thirty-one real administrator backup URLs are supported, validated, deduplicated, and exposed without secrets', async t => {
  const backups = Array.from({ length: 31 }, (_, i) => ({ name: `Backup ${i + 1}`, url: `wss://backup${i + 1}.example/wisp/` }));
  const config = loadServerConfig({ WISP_BACKUPS_JSON: JSON.stringify(backups) });
  assert.equal(config.publicConfig.wispEndpoints.length, 32);
  assert.deepEqual(config.publicConfig.wispEndpoints[0], { name: 'Primary', url: '/wisp/' });
  assert.equal(config.publicConfig.maxWispBackups, 31);
  assert.equal(loadServerConfig({ WISP_BACKUPS_JSON: JSON.stringify([backups[0], backups[0]]) }).publicConfig.wispEndpoints.length, 2);
  assert.throws(() => loadServerConfig({ WISP_BACKUPS_JSON: JSON.stringify([...backups, backups[0]]) }), /up to 31/);
  for (const url of ['ws://remote.example/wisp/', 'wss://user:secret@remote.example/wisp/', 'wss://remote.example/wisp/?token=secret', 'wss://remote.example/wisp/#secret', 'https://remote.example/wisp/']) {
    assert.throws(() => loadServerConfig({ WISP_BACKUPS_JSON: JSON.stringify([{ url }]) }), undefined, url);
  }
  assert.equal(loadServerConfig({ WISP_BACKUPS_JSON: '[{"url":"ws://localhost:3002/wisp/"}]' }).publicConfig.wispEndpoints.length, 2);
  for (const url of ['wss://remote.example/wisp', 'wss://remote.example/relay', 'wss://remote.example/']) {
    assert.equal(loadServerConfig({ WISP_BACKUPS_JSON: JSON.stringify([{ url }]) }).publicConfig.wispEndpoints[1].url, url);
  }
  const f = await fixture(t, { env: { WISP_BACKUPS_JSON: JSON.stringify(backups), WINDOWS_VM_URL: 'https://desktop.example/guacamole/#/', WINDOWS_VM_NAME: 'Work PC' } });
  const response = await fetch(`${f.origin}/api/config`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const json = await response.json();
  assert.equal(json.wispEndpoints.length, 32);
  assert.deepEqual(json.windowsVm, { url: 'https://desktop.example/guacamole/#/', label: 'Work PC' });
  assert.equal('authDigest' in json, false);
  assert.equal(json.requiresAuthentication, false);
  for (const url of ['http://desktop.example/', 'https://user:password@desktop.example/', 'https://desktop.example/?token=secret']) {
    assert.throws(() => loadServerConfig({ WINDOWS_VM_URL: url }));
  }
});

test('HTTP and WebSocket access use the same Basic authentication and never publish the token', async t => {
  const token = 'test-private-token-at-least16';
  const f = await fixture(t, { env: { PROXY_AUTH_TOKEN: token } });
  const denied = await fetch(`${f.origin}/api/config`);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate'), /^Basic/);
  await denied.text();
  const authorization = `Basic ${Buffer.from(`monkeh:${token}`).toString('base64')}`;
  const response = await fetch(`${f.origin}/api/config`, { headers: { authorization } });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, new RegExp(token));
  assert.equal(JSON.parse(text).requiresAuthentication, true);
  assert.equal(await rejected(f), 401);
  await open(t, f, { headers: { authorization } });
});

test('loopback HTTP rejects DNS-rebinding hosts and WebSockets require a strict same origin', async t => {
  const f = await fixture(t);
  for (const host of ['attacker.example', 'localhost@attacker.example', '127.0.0.1/hidden']) {
    const status = await new Promise((resolve, reject) => {
      const req = request(`${f.origin}/api/health`, { headers: { host } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 421, host);
  }
  for (const origin of [undefined, 'null', 'https://attacker.example', `${f.origin}/path`, `${f.origin}/`]) {
    assert.equal(await rejected(f, { origin }), 403, String(origin));
  }
  assert.equal(await rejected(f, {}, 'unrecognized'), 400);
});

test('concurrent WebSocket limit rejects excess clients and releases slots after close', async t => {
  const f = await fixture(t, { env: { WISP_MAX_CONNECTIONS_PER_IP: '1' } });
  const first = await open(t, f);
  assert.equal(await rejected(f), 429);
  const ended = once(first, 'close');
  first.close();
  await ended;
  await nextTurn();
  await open(t, f);
});

test('malformed Wisp messages and oversized payloads close only the offending client', async t => {
  const f = await fixture(t);
  for (const data of ['text', Buffer.from([1]), Buffer.from([9, 1, 0, 0, 0]), connectPacket(0), connectPacket(1, '')]) {
    const ws = await open(t, f);
    const closed = once(ws, 'close', { signal: AbortSignal.timeout(3000) });
    ws.send(data);
    assert.equal((await closed)[0], 1002);
  }
  const huge = await open(t, f);
  const ended = once(huge, 'close', { signal: AbortSignal.timeout(3000) });
  huge.send(Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.equal((await ended)[0], 1009);
  const alive = await fetch(`${f.origin}/api/health`);
  assert.equal(alive.status, 200);
  await alive.text();
});

test('Wisp v2 validates version and extension lengths before accepting stream traffic', async t => {
  const f = await fixture(t);
  for (const data of [Buffer.from([5, 0, 0, 0, 0, 1, 0]), Buffer.from([5, 0, 0, 0, 0, 2, 0, 1, 255, 255, 255, 255]), connectPacket()]) {
    const ws = await open(t, f, {}, 'wisp-v2');
    const closed = once(ws, 'close', { signal: AbortSignal.timeout(3000) });
    ws.send(data);
    assert.equal((await closed)[0], 1002);
  }
});

test('dangerous destinations, non-web ports, and UDP are rejected before DNS or TCP', async t => {
  let lookups = 0;
  const f = await fixture(t, { wispOptions: { resolve: async () => { lookups++; return '8.8.8.8'; }, connect: () => { throw new Error('must not connect'); } } });
  const ws = await open(t, f);
  for (const data of [connectPacket(1, '127.0.0.1'), connectPacket(2, '::ffff:127.0.0.1'), connectPacket(3, 'example.test', 22), connectPacket(4, 'example.test', 443, 2), connectPacket(5, 'example.test', 443, 3), connectPacket(6, 'host\0evil.test')]) {
    const reply = once(ws, 'message', { signal: AbortSignal.timeout(3000) });
    ws.send(data);
    const [result] = await reply;
    assert.equal(result[0], 4);
    assert.equal(result[5], 0x48);
  }
  assert.equal(lookups, 0);
});

test('private DNS answers are rechecked immediately before connecting', async t => {
  let connections = 0;
  const f = await fixture(t, { wispOptions: { resolve: async () => '::ffff:169.254.169.254', connect: () => { connections++; } } });
  const ws = await open(t, f);
  const reply = once(ws, 'message', { signal: AbortSignal.timeout(3000) });
  ws.send(connectPacket());
  assert.equal((await reply)[0][5], 0x48);
  assert.equal(connections, 0);
});

test('closing a stream or connection during DNS cannot reopen a TCP socket', async t => {
  for (const closeConnection of [false, true]) {
    let finishLookup;
    let startedLookup;
    const started = new Promise(resolve => { startedLookup = resolve; });
    let connections = 0;
    const f = await fixture(t, { wispOptions: {
      resolve: () => { startedLookup(); return new Promise(resolve => { finishLookup = resolve; }); },
      connect: () => { connections++; throw new Error('must not connect'); },
    } });
    const ws = await open(t, f);
    ws.send(connectPacket());
    await started;
    if (closeConnection) {
      const closed = once(ws, 'close');
      ws.close();
      await closed;
    } else {
                                                                            
      ws.send(closePacket(1));
      const barrier = once(ws, 'message');
      ws.send(connectPacket(2, '127.0.0.1'));
      await barrier;
    }
    finishLookup('8.8.8.8');
    await nextTurn();
    assert.equal(connections, 0);
  }
});

test('duplicate stream IDs close the client instead of orphaning pending work', async t => {
  let finishLookup;
  let startedLookup;
  const started = new Promise(resolve => { startedLookup = resolve; });
  let connections = 0;
  const f = await fixture(t, { wispOptions: {
    resolve: () => { startedLookup(); return new Promise(resolve => { finishLookup = resolve; }); },
    connect: () => { connections++; },
  } });
  const ws = await open(t, f);
  ws.send(connectPacket());
  await started;
  const closed = once(ws, 'close', { signal: AbortSignal.timeout(3000) });
  ws.send(connectPacket());
  assert.equal((await closed)[0], 1002);
  finishLookup('8.8.8.8');
  await nextTurn();
  assert.equal(connections, 0);
});

test('clients cannot queue more than their flow-control window while DNS is pending', async t => {
  let finishLookup;
  const f = await fixture(t, { wispOptions: { resolve: () => new Promise(resolve => { finishLookup = resolve; }) } });
  const ws = await open(t, f);
  const closed = once(ws, 'close', { signal: AbortSignal.timeout(3000) });
  ws.send(connectPacket());
  for (let i = 0; i < 129; i++) ws.send(dataPacket(1, 'x'));
  assert.equal((await closed)[0], 1006);
  finishLookup('8.8.8.8');
});

test('per-host stream caps count pending connections and return throttling without throwing', async t => {
  const resolutions = [];
  const f = await fixture(t, { wispOptions: { resolve: () => new Promise(resolve => resolutions.push(resolve)) } });
  const ws = await open(t, f);
  const reply = once(ws, 'message', { signal: AbortSignal.timeout(3000) });
  for (let id = 1; id <= 17; id++) ws.send(connectPacket(id));
  const [closed] = await reply;
  assert.equal(closed[0], 4);
  assert.equal(closed.readUInt32LE(1), 17);
  assert.equal(closed[5], 0x49);
  assert.equal(resolutions.length, 16);
  for (const resolve of resolutions) resolve('127.0.0.1');
});

test('closing streams cannot bypass the global limit on unfinished DNS work', async t => {
  const resolutions = [];
  const f = await fixture(t, { wispOptions: { resolve: () => new Promise(resolve => resolutions.push(resolve)) } });
  const ws = await open(t, f);
  const reply = once(ws, 'message', { signal: AbortSignal.timeout(3000) });
  for (let id = 1; id <= 64; id++) { ws.send(connectPacket(id)); ws.send(closePacket(id)); }
  ws.send(connectPacket(65));
  const [closed] = await reply;
  assert.equal(closed.readUInt32LE(1), 65);
  assert.equal(closed[5], 0x49);
  assert.equal(resolutions.length, 64);
  for (const resolve of resolutions) resolve('127.0.0.1');
});

test('TCP data passes through the validated literal and flow control replenishes after writes', async t => {
  const tcp = createTcpServer(socket => socket.pipe(socket));
  tcp.listen(0, '127.0.0.1');
  await once(tcp, 'listening');
  t.after(() => new Promise(resolve => tcp.close(resolve)));
  let connectedAddress;
  const f = await fixture(t, { wispOptions: {
    resolve: async () => '8.8.8.8',
    connect: options => { connectedAddress = options; return createConnection({ host: '127.0.0.1', port: tcp.address().port }); },
  } });
  const ws = await open(t, f);
  let output = '';
  let sawFlow = false;
  const finished = new Promise(resolve => ws.on('message', data => {
    if (data[0] === 2) output += data.subarray(5).toString();
    if (data[0] === 3 && data.readUInt32LE(1) === 1) { assert.ok(data.readUInt32LE(5) > 0); sawFlow = true; }
    if (output.length === 128 && sawFlow) resolve();
  }));
  ws.send(connectPacket());
  for (let i = 0; i < 128; i++) ws.send(dataPacket(1, 'x'));
  await Promise.race([finished, new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('TCP forwarding timed out')), 3000); timeout.unref(); })]);
  assert.deepEqual(connectedAddress, { host: '8.8.8.8', port: 443, allowHalfOpen: false });
  assert.equal(output, 'x'.repeat(128));
  const ended = once(ws, 'close');
  ws.close();
  await ended;
});
