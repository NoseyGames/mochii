import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('../browser-tools/proxy-host.js', import.meta.url), 'utf8')).replace(/^import .+;\r?\n/gm, '');
const configSource = await readFile(new URL('../browser-tools/config.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const proxyOrigin = 'http://127.0.0.1:3101';
const shellOrigin = 'http://localhost:3100';
function node() {
  const listeners = new Map();
  return {
    hidden: false, textContent: '', listeners,
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    fire(type, event = {}) { for (const callback of [...listeners.get(type) || []]) callback(event); },
  };
}
function port() {
  return { messages: [], starts: 0, closes: 0, postMessage(message) { this.messages.push(message); }, start() { this.starts++; }, close() { this.closes++; }, async request(message) { await this.onmessage?.({ data: message }); await flush(); } };
}
async function harness({ config: extraConfig = {}, evaluate = async code => `result: ${code}`, startup, fetchConfig, workerReady = Promise.resolve(), workerRegistration, workerController = {}, userAgent = '', loadCode = false, bindIdentity, prepareGame } = {}) {
  const allNodes = new Map();
  const get = id => {
    if (!allNodes.has(id)) allNodes.set(id, node());
    return allNodes.get(id);
  };
  const doc = { getElementById: get };
  const timers = new Map();
  let timerId = 0;
  const contextWindow = node();
  contextWindow.SharedWorker = class {};
  contextWindow.parent = { sent: [], postMessage(data, origin) { this.sent.push({ data, origin }); } };
  const hostUrl = new URL('/proxy-host.html', proxyOrigin);
  if (userAgent) hostUrl.searchParams.set('ua', userAgent);
  if (loadCode) hostUrl.searchParams.set('loadCode', '1');
  hostUrl.hash = encodeURIComponent('https://example.com/');
  const location = { origin: proxyOrigin, href: hostUrl.href, hash: hostUrl.hash };
  const pageDoc = { ...node(), title: 'Example', readyState: 'complete', body: { childElementCount: 1, textContent: 'Example' }, getElementById: () => null };
  const root = { nodeType: 1, localName: 'html', id: '', className: '', children: [], ownerDocument: pageDoc };
  pageDoc.documentElement = root;
  pageDoc.querySelector = () => root;
  const pageWindow = { document: pageDoc, location: { href: proxyOrigin + '/service/' + encodeURIComponent('https://example.com/'), reloads: 0, reload() { this.reloads++; } } };
  const frame = get('page');
  const navigations = [];
  Object.defineProperty(frame, 'src', { get() { return navigations.at(-1); }, set(value) { navigations.push(value); } });
  frame.contentWindow = pageWindow;
  frame.contentDocument = pageDoc;
  const evaluated = [];
  const runtimes = [];
  const observers = [];
  let activated = 0;
  let registrations = 0;
  let treeReads = 0;
  let networkOptions;
  const identityRequests = [];
  const identityChannels = [];
  const gameRequests = [];
  const gameCancels = [];
  const workerMessages = [];
  if (workerController && !workerController.postMessage) workerController.postMessage = (data, ports) => {
    workerMessages.push(data);
    if (data.type === 'monkeh:identity:bind') {
      identityRequests.push(data);
      if (bindIdentity) bindIdentity(data, ports);
      else ports[0].postMessage({ ok: true });
    } else if (data.type === 'monkeh:game:prepare') {
      const request = { data, ports, reply: result => ports[0].postMessage(result) };
      gameRequests.push(request);
      prepareGame?.(request);
    } else if (data.type === 'monkeh:game:cancel') gameCancels.push({ data, ports });
  };
  const serviceWorker = { ...node(), async register() { registrations++; return workerRegistration; }, ready: workerReady, controller: workerController };
  const network = { connects: 0, failures: 0, disposed: 0, switches: [], activeEndpoint: 'ws://127.0.0.1:3101/wisp/',
    async connect() { this.connects++; if (this.connects === 1) await networkOptions.activate('ws://127.0.0.1:3101/wisp/'); networkOptions.onStatus({ status: 'connected', activeEndpoint: 'ws://127.0.0.1:3101/wisp/', configuredCount: 1 }); return 'ws://127.0.0.1:3101/wisp/'; },
    async reportFailure() { this.failures++; }, async setOnline() {}, dispose() { this.disposed++; },
    async switchEndpoint(options) { this.switches.push(options); this.activeEndpoint = 'wss://other.example/wisp/'; return this.activeEndpoint; },
  };
  const sandbox = {
    MonkehUseBackendConfig: true,
    window: contextWindow, document: doc, location, isSecureContext: true,
    navigator: { onLine: true, serviceWorker },
    URL, AbortSignal, AbortController, TextEncoder, TextDecoder, Map, WeakMap, Set, decodeURIComponent, encodeURIComponent, Uint8Array, crypto,
    MessageChannel: class {
      constructor() {
        this.port1 = { onmessage: null, start() {}, close() { this.closed = true; } };
        this.port2 = { postMessage: data => this.port1.onmessage?.({ data }), close() { this.closed = true; } };
        identityChannels.push(this);
      }
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target) { this.target = target; }
      disconnect() { this.disconnected = true; }
    },
    fetch: fetchConfig || (async () => new Response(JSON.stringify({ shellOrigins: [shellOrigin], proxyOrigin, wispEndpoints: [{ name: 'Primary', url: '/wisp/' }], ...extraConfig }), { headers: { 'Content-Type': 'application/json' } })),
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    BareMux: { BareMuxConnection: class { async setTransport() { activated++; if (startup) await startup; } } },
    createProxyNetwork(options) { networkOptions = options; return network; },
    __uv$config: { prefix: '/service/', encodeUrl: encodeURIComponent, decodeUrl: decodeURIComponent },
    formatValue: value => String(value),
    attachRuntime(target, callbacks) {
      const runtime = {
        document: target.document, callbacks, disposed: false,
        async evaluate(code) { evaluated.push(code); return evaluate(code); },
        describe() { return { tag: 'html', attributes: [], styles: [], rect: { width: 10, height: 20 }, text: '', html: '' }; },
        select(element) { callbacks.onSelect(element); },
        getChildren(element) { treeReads++; return element.children; },
        setStyle() {}, startPicking() {}, stopPicking() {}, dispose() { this.disposed = true; },
      };
      runtimes.push(runtime);
      return runtime;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(configSource, sandbox, { filename: 'browser-tools/config.js' });
  vm.runInContext(source, sandbox, { filename: 'browser-tools/proxy-host.js' });
  await flush();
  function init(connection = port(), changes = {}) {
    contextWindow.fire('message', { isTrusted: true, source: contextWindow.parent, origin: shellOrigin, data: { type: 'monkeh-proxy:init' }, ports: [connection], ...changes });
    return connection;
  }
  function loadPage() { frame.fire('load'); }
  function bindChild() {
    const nonce = new URL(frame.src, proxyOrigin).searchParams.get('nonce');
    contextWindow.fire('message', { isTrusted: true, source: pageWindow, origin: proxyOrigin, data: { type: 'monkeh-proxy:identity-ready', nonce, clientId: 'bootstrap-child' } });
  }
  function replaceDocument(readyState = 'complete') {
    const next = { ...node(), title: 'Next', readyState, body: { childElementCount: 1, textContent: 'Next' }, getElementById: () => null };
    next.documentElement = { nodeType: 1, localName: 'html', id: '', className: '', children: [], ownerDocument: next };
    next.querySelector = () => next.documentElement;
    frame.contentDocument = pageWindow.document = next;
    return next;
  }
  function tickWatch() {
    const match = [...timers].find(([, timer]) => timer.ms <= 500);
    if (!match) return false;
    const [id, timer] = match;
    timers.delete(id); timer.fn();
    return true;
  }
  function expireReadiness() {
    const match = [...timers].find(([, timer]) => timer.ms === 45000);
    if (!match) return false;
    const [id, timer] = match;
    timers.delete(id); timer.fn();
    return true;
  }
  return { contextWindow, doc, get, frame, pageWindow, pageDoc, root, network, timers, evaluated, runtimes, observers, serviceWorker, init, loadPage, bindChild, replaceDocument, tickWatch, expireReadiness, location, navigations, identityRequests, identityChannels, gameRequests, gameCancels, workerMessages, get networkOptions() { return networkOptions; }, get treeReads() { return treeReads; }, get activated() { return activated; }, get registrations() { return registrations; } };
}

const preparedUrl = target => proxyOrigin + '/service/' + encodeURIComponent(target);
const stagedUrl = request => proxyOrigin + '/__monkeh_game__/' + request.data.nonce;
const preparedGame = (request, target = 'https://example.com/') => ({ ok: true, url: stagedUrl(request), canonicalUrl: preparedUrl(target) });

test('ordinary browsing navigates directly without binding or preparing game code', async () => {
  const app = await harness();
  assert.deepEqual(app.navigations, ['/service/' + encodeURIComponent('https://example.com/')]);
  assert.equal(app.identityRequests.length, 0);
  assert.equal(app.gameRequests.length, 0);
  const connection = app.init(); app.loadPage();
  await connection.request({ id: 1, method: 'reload' });
  assert.equal(app.pageWindow.location.reloads, 1);
  assert.equal(app.gameRequests.length, 0);
  app.contextWindow.fire('pagehide');
  assert.equal(app.gameCancels.length, 0);
});

test('game preparation starts without identity bootstrap for both default and custom browser identities', async () => {
  for (const userAgent of ['', 'Chosen Browser/1']) {
    const app = await harness({ loadCode: true, userAgent });
    assert.equal(app.navigations.length, 0, 'the game does not depend on a bootstrap navigation');
    assert.equal(app.identityRequests.length, 0);
    assert.equal(app.gameRequests.length, 1);
    assert.equal(new URL(app.location.href).searchParams.get('ua') || '', userAgent, 'the worker can derive identity from the requesting host URL');
    assert.deepEqual(app.workerMessages.map(message => message.type), ['monkeh:game:prepare']);
    const pending = app.gameRequests[0];
    assert.equal(pending.data.url, 'https://example.com/');
    assert.match(pending.data.nonce, /^[a-f0-9]{32}$/);
    assert.equal(pending.ports.length, 1);
    assert.equal(app.navigations.length, 0, 'an unprepared target cannot execute');
    pending.reply(preparedGame(pending, 'https://example.com/redirected?game=1'));
    await flush();
    assert.equal(app.frame.src, stagedUrl(pending));
    assert.notEqual(app.frame.src, preparedUrl('https://example.com/redirected?game=1'), 'navigation must consume staged HTML instead of fetching the canonical address again');
    assert.equal(app.navigations.length, 1);
    assert.equal(app.identityRequests.length, 0);
    assert(app.identityChannels.every(channel => channel.port1.closed && channel.port2.closed));
    assert.equal([...app.timers.values()].some(timer => timer.ms === 35000 || timer.ms === 12000), false);
    app.contextWindow.fire('pagehide');
  }
});

test('superseded game preparation is cancelled and stale success cannot navigate the frame', async () => {
  const app = await harness({ loadCode: true });
  const first = app.gameRequests[0];
  app.location.hash = '#' + encodeURIComponent('https://next.example/game.html');
  app.contextWindow.fire('hashchange'); await flush();
  assert.equal(app.gameCancels.length, 1);
  assert.equal(app.gameCancels[0].data.nonce, first.data.nonce);
  assert.equal(app.gameCancels[0].ports?.length || 0, 0);
  assert.equal(app.gameRequests.length, 2);
  const next = app.gameRequests[1];
  assert.notEqual(next.data.nonce, first.data.nonce);
  assert.equal(next.data.url, 'https://next.example/game.html');
  assert.equal(app.identityRequests.length, 0, 'game navigation never starts a separate identity bootstrap');
  first.reply(preparedGame(first, 'https://example.com/stale.html')); await flush();
  assert.equal(app.navigations.length, 0);
  next.reply(preparedGame(next, 'https://next.example/game.html')); await flush();
  assert.equal(app.navigations.length, 1);
  assert.equal(app.frame.src, stagedUrl(next));
  app.contextWindow.fire('pagehide');
});

test('closing or timing out game preparation cancels its worker reservation and ignores late replies', async () => {
  for (const close of [true, false]) {
    const app = await harness({ loadCode: true });
    const pending = app.gameRequests[0];
    const timeout = [...app.timers].find(([, timer]) => timer.ms === 35000);
    assert.ok(timeout);
    if (close) app.contextWindow.fire('pagehide');
    else { app.timers.delete(timeout[0]); timeout[1].fn(); }
    await flush();
    assert.equal(app.gameCancels.length, 1);
    assert.equal(app.gameCancels[0].data.nonce, pending.data.nonce);
    assert.equal(app.gameCancels[0].ports?.length || 0, 0);
    assert.equal(app.timers.size, 0);
    assert(app.identityChannels.every(channel => channel.port1.closed && channel.port2.closed));
    pending.reply(preparedGame(pending)); await flush();
    assert.equal(app.navigations.length, 0);
    assert.equal(app.runtimes.length, 0);
    if (!close) {
      assert.equal(app.get('retry').hidden, false);
      assert.match(app.get('status-message').textContent, /timed out/i);
      app.contextWindow.fire('pagehide');
    }
  }
});

test('game preparation requires its exact staging token and an external HTTP canonical proxy URL', async () => {
  const invalidReplies = [
    () => ({ ok: false, error: 'The game source could not be fetched.' }),
    () => ({ ok: true }),
    request => ({ ...preparedGame(request), canonicalUrl: undefined }),
    request => ({ ...preparedGame(request), url: proxyOrigin + '/__monkeh_game__/' + (request.data.nonce[0] === '0' ? '1' : '0') + request.data.nonce.slice(1) }),
    request => ({ ...preparedGame(request), url: proxyOrigin + '/wrong-path/' + request.data.nonce }),
    request => ({ ...preparedGame(request), url: 'https://other-proxy.example/__monkeh_game__/' + request.data.nonce }),
    request => ({ ...preparedGame(request), url: stagedUrl(request) + '?unexpected=1' }),
    request => ({ ...preparedGame(request), url: stagedUrl(request) + '#unexpected' }),
    request => ({ ...preparedGame(request), url: preparedUrl('https://example.com/') }),
    request => ({ ...preparedGame(request), canonicalUrl: 'https://example.com/raw.html' }),
    request => ({ ...preparedGame(request), canonicalUrl: 'https://other-proxy.example/service/' + encodeURIComponent('https://example.com/') }),
    request => ({ ...preparedGame(request), canonicalUrl: proxyOrigin + '/proxy-host.html' }),
    request => preparedGame(request, 'javascript:alert(1)'),
    request => preparedGame(request, 'https://user:secret@example.com/'),
    request => preparedGame(request, shellOrigin + '/math.html'),
    request => preparedGame(request, proxyOrigin + '/proxy-host.html'),
    request => ({ ...preparedGame(request), canonicalUrl: proxyOrigin + '/service/%zz' }),
  ];
  for (const makeReply of invalidReplies) {
    const app = await harness({ loadCode: true });
    const pending = app.gameRequests[0];
    const reply = makeReply(pending);
    pending.reply(reply); await flush();
    assert.equal(app.navigations.length, 0, JSON.stringify(reply));
    assert.equal(app.get('retry').hidden, false);
    assert.equal(app.get('status').hidden, false);
    assert.equal(app.timers.size, 0);
    assert(app.identityChannels.every(channel => channel.port1.closed && channel.port2.closed));
    app.contextWindow.fire('pagehide');
  }
});

test('game reload fetches the last entered address again instead of reloading the consumed document', async () => {
  const app = await harness({ loadCode: true });
  const connection = app.init();
  app.gameRequests[0].reply(preparedGame(app.gameRequests[0], 'https://example.com/redirected')); await flush();
  app.loadPage();
  app.pageWindow.location.href = preparedUrl('https://example.com/page-controlled-navigation');
  const reload = connection.request({ id: 1, method: 'reload' });
  await flush();
  assert.equal(app.pageWindow.location.reloads, 0);
  assert.equal(app.gameRequests.length, 2);
  assert.equal([...app.timers.values()].some(timer => timer.ms === 60000), true);
  assert.equal([...app.timers.values()].some(timer => timer.ms === 15000), false);
  assert.equal(app.gameRequests[1].data.url, 'https://example.com/');
  assert.equal(app.navigations.length, 1);
  app.gameRequests[1].reply(preparedGame(app.gameRequests[1], 'https://example.com/redirected-again'));
  await reload;
  assert.equal(app.frame.src, stagedUrl(app.gameRequests[1]));
  assert.notEqual(stagedUrl(app.gameRequests[1]), stagedUrl(app.gameRequests[0]), 'reload receives a fresh one-use document URL');
  assert.equal(connection.messages.find(message => message.id === 1).result, null);
  assert.equal(app.identityRequests.length, 0);
  app.contextWindow.fire('pagehide');
});

test('custom identities wait for a validated controlled child binding before target navigation', async () => {
  const app = await harness({ userAgent: 'Chosen Browser/1' });
  assert.equal(app.navigations.length, 1);
  assert.match(app.navigations[0], /^\/proxy-bootstrap\.html\?nonce=[a-f0-9]{32}$/);
  assert.doesNotMatch(app.navigations[0], /Chosen|example/);
  app.loadPage();
  assert.equal(app.runtimes.length, 0);
  const nonce = new URL(app.frame.src, proxyOrigin).searchParams.get('nonce');
  const message = { isTrusted: true, source: app.pageWindow, origin: proxyOrigin, data: { type: 'monkeh-proxy:identity-ready', nonce, clientId: 'bootstrap-child' } };
  for (const changes of [{ isTrusted: false }, { source: {} }, { origin: shellOrigin }, { data: { ...message.data, nonce: 'a'.repeat(32) } }]) app.contextWindow.fire('message', { ...message, ...changes });
  assert.equal(app.identityRequests.length, 0);
  app.contextWindow.fire('message', message);
  await flush();
  assert.equal(app.identityRequests[0].clientId, 'bootstrap-child');
  assert.equal(app.navigations.length, 2);
  assert.equal(app.navigations[1], '/service/' + encodeURIComponent('https://example.com/'));
  assert(app.identityChannels.every(channel => channel.port1.closed && channel.port2.closed));
  assert.equal([...app.timers.values()].some(timer => timer.ms === 12000), false);
  app.location.hash = '#' + encodeURIComponent('https://next.example/');
  app.contextWindow.fire('hashchange'); await flush();
  assert.equal(app.navigations.length, 3);
  assert.equal(app.identityRequests.length, 1);
  app.contextWindow.fire('pagehide');
});

test('identity bootstrap times out or cancels without navigating with the wrong identity', async () => {
  for (const close of [false, true]) {
    const app = await harness({ userAgent: 'Chosen Browser/1' });
    if (close) app.contextWindow.fire('pagehide');
    else [...app.timers.values()].find(timer => timer.ms === 12000).fn();
    await flush();
    assert.equal(app.navigations.length, 1);
    assert.equal(app.identityRequests.length, 0);
    assert.equal(app.timers.size, 0);
    if (!close) {
      assert.match(app.get('status-message').textContent, /identity setup timed out/);
      assert.equal(app.get('retry').hidden, false);
      app.get('retry').fire('click'); await flush();
      assert.equal(app.navigations.length, 2);
      assert.notEqual(app.navigations[0], app.navigations[1]);
      app.contextWindow.fire('pagehide'); await flush();
    }
  }
});

test('proxy host accepts bridge transfer only from the allowed shell window and origin', async () => {
  const app = await harness();
  for (const changes of [{ source: {} }, { origin: 'https://attacker.example' }, { data: { type: 'evaluate', code: 'alert(1)' } }, { ports: [] }, { ports: [port(), port()] }]) {
    const connection = app.init(port(), changes);
    assert.equal(connection.starts, 0);
  }
  assert.deepEqual(app.evaluated, []);
  const accepted = app.init();
  assert.equal(accepted.starts, 1);
  assert(accepted.messages.some(message => message.event === 'ready'));
  app.contextWindow.fire('pagehide');
  assert.equal(accepted.closes, 1);
});

test('proxy host rejects a synthetic message forged by its same-origin viewed page', async () => {
  const app = await harness();
  const forged = app.init(port(), { isTrusted: false });
  assert.equal(forged.starts, 0, 'a child can forge source/origin on dispatchEvent, but cannot forge isTrusted');
  app.contextWindow.fire('pagehide');
});

test('proxy host evaluates code only on its transferred port after a page runtime is attached', async () => {
  const app = await harness();
  const connection = app.init();
  await connection.request({ id: 1, method: 'evaluate', params: { code: '1 + 1' } });
  assert.match(connection.messages.find(message => message.id === 1).error, /Wait for the page/);
  app.loadPage();
  await connection.request({ id: 2, method: 'evaluate', params: { code: '1 + 1' } });
  assert.equal(connection.messages.find(message => message.id === 2).result, 'result: 1 + 1');
  assert.deepEqual(app.evaluated, ['1 + 1']);
  app.contextWindow.fire('message', { isTrusted: true, source: app.contextWindow.parent, origin: shellOrigin, data: { id: 3, method: 'evaluate', params: { code: 'shell injection' } }, ports: [] });
  assert.deepEqual(app.evaluated, ['1 + 1']);
  app.contextWindow.fire('pagehide');
});

test('proxy host enforces command length and method bounds', async () => {
  const app = await harness();
  const connection = app.init();
  app.loadPage();
  await connection.request({ id: 1, method: 'evaluate', params: { code: 'x'.repeat(110001) } });
  assert.match(connection.messages.find(message => message.id === 1).error, /large/);
  await connection.request({ id: 2, method: '__proto__' });
  assert.match(connection.messages.find(message => message.id === 2).error, /Unsupported/);
  await connection.request({ id: 'x'.repeat(101), method: 'evaluate', params: { code: 'bad' } });
  assert.equal(app.evaluated.length, 0);
  app.contextWindow.fire('pagehide');
});

test('proxy host bounds returned console values, document metadata, and tree nodes', async () => {
  const app = await harness();
  app.pageDoc.title = 'x'.repeat(1000);
  app.root.children = Array.from({ length: 2000 }, () => ({ nodeType: 1, localName: 'p', id: 'x'.repeat(2000), className: '', children: [], ownerDocument: app.pageDoc }));
  const connection = app.init();
  app.loadPage();
  const page = connection.messages.find(message => message.event === 'page').data;
  assert.equal(page.title.length, 300);
  assert.equal(page.tree, undefined, 'initial page readiness does not traverse the DOM');
  assert.equal(app.treeReads, 0);
  await connection.request({ id: 1, method: 'tree' });
  const tree = connection.messages.find(message => message.id === 1).result;
  assert(tree.nodes.length <= 800);
  assert(tree.nodes.every(record => record.elementId.length <= 500));
  app.runtimes[0].callbacks.onConsole({ level: 'log', args: Array(100).fill('x'.repeat(13000)), time: Date.now() });
  const event = connection.messages.find(message => message.event === 'console').data;
  assert.equal(event.args.length, 50);
  assert(event.args.every(value => value.length <= 12000));
  app.contextWindow.fire('pagehide');
});

test('picking an element outside the initial tree reserves its full ancestor path within the node cap', async () => {
  const app = await harness();
  app.root.children = Array.from({ length: 1200 }, (_, index) => ({ nodeType: 1, localName: 'section', id: `section-${index}`, className: '', children: [], parentElement: app.root, ownerDocument: app.pageDoc }));
  const parent = app.root.children[1100];
  const picked = { nodeType: 1, localName: 'button', id: 'picked', className: '', children: [], parentElement: parent, ownerDocument: app.pageDoc };
  parent.children.push(picked);
  const connection = app.init();
  app.loadPage();
  await connection.request({ id: 1, method: 'tree' });
  assert(!connection.messages.find(message => message.id === 1).result.nodes.some(record => record.elementId === 'picked'));
  app.runtimes[0].callbacks.onSelect(picked);
  const selection = connection.messages.find(message => message.event === 'select').data;
  assert(selection.tree.nodes.length <= 800);
  const rootRecord = selection.tree.nodes.find(record => record.id === selection.tree.rootId);
  const parentRecord = selection.tree.nodes.find(record => record.elementId === 'section-1100');
  const pickedRecord = selection.tree.nodes.find(record => record.elementId === 'picked');
  assert(rootRecord.children.includes(parentRecord.id));
  assert(parentRecord.children.includes(pickedRecord.id));
  const childNames = rootRecord.children.map(id => selection.tree.nodes.find(record => record.id === id).elementId);
  assert.equal(childNames[0], 'section-0');
  assert.equal(childNames.at(-1), 'section-1100', 'reserved selections preserve real sibling order');
  assert.equal(selection.id, pickedRecord.id);
  app.contextWindow.fire('pagehide');
});

test('selection snapshots preserve head/body and sibling order while revealing an ordinary node', async () => {
  const app = await harness();
  const make = (name, parent) => ({ nodeType: 1, localName: name, id: name, className: '', children: [], parentElement: parent, ownerDocument: app.pageDoc });
  const head = make('head', app.root);
  const body = make('body', app.root);
  app.root.children = [head, body];
  const style = make('style', body), svg = make('svg', body), paragraph = make('p', body);
  body.children = [style, svg, paragraph];
  const connection = app.init(); app.loadPage();
  app.runtimes[0].callbacks.onSelect(paragraph);
  const { tree } = connection.messages.find(message => message.event === 'select').data;
  const names = record => record.children.map(id => tree.nodes.find(node => node.id === id).localName);
  assert.deepEqual(Array.from(names(tree.nodes.find(node => node.id === tree.rootId))), ['head', 'body']);
  assert.deepEqual(Array.from(names(tree.nodes.find(node => node.localName === 'body'))), ['style', 'svg', 'p']);
  app.contextWindow.fire('pagehide');
});

test('warm navigation RPC reuses the active proxy transport and service worker', async () => {
  const app = await harness();
  const connection = app.init(); app.loadPage();
  await connection.request({ id: 1, method: 'navigate', params: { url: 'https://other.example/new?q=one' } });
  assert.equal(connection.messages.find(message => message.id === 1).result, true);
  assert.equal(app.frame.src, '/service/' + encodeURIComponent('https://other.example/new?q=one'));
  assert.equal(app.activated, 1);
  assert.equal(app.registrations, 1);
  assert.equal(app.runtimes.length, 1, 'navigation does not replace the host itself');
  for (const [id, url] of [[2, 'javascript:bad()'], [3, shellOrigin + '/math.html'], [4, proxyOrigin + '/math.html'], [5, 'https://user:secret@example.com/']]) {
    await connection.request({ id, method: 'navigate', params: { url } });
    assert.equal(typeof connection.messages.find(message => message.id === id).error, 'string');
  }
  assert.equal(app.activated, 1);
  assert.equal(app.registrations, 1);
  app.contextWindow.fire('pagehide');
});

test('proxy configuration permits thirty-two endpoints and rejects larger pools', async () => {
  const endpoints = Array.from({ length: 32 }, (_, index) => ({ url: `wss://proxy-${index}.example/wisp/` }));
  const app = await harness({ config: { wispEndpoints: endpoints } });
  assert.equal(app.activated, 1);
  app.contextWindow.fire('pagehide');
  const tooMany = await harness({ config: { wispEndpoints: [...endpoints, { url: 'wss://extra.example/wisp/' }] } });
  assert.equal(tooMany.activated, 0);
  assert.match(tooMany.get('status-message').textContent, /misconfigured/);
  tooMany.contextWindow.fire('pagehide');
});

test('host passes the marked fallback subset without changing relay paths', async () => {
  const app = await harness({ config: { wispEndpoints: [
    { url: 'wss://first.example/wisp' }, { url: 'wss://second.example/relay' },
    { url: 'wss://third.example/' }, { url: '/wisp/', fallback: true },
  ] } });
  assert.deepEqual(Array.from(app.networkOptions.endpoints), [
    'wss://first.example/wisp', 'wss://second.example/relay', 'wss://third.example/', 'ws://127.0.0.1:3101/wisp/',
  ]);
  assert.deepEqual(Array.from(app.networkOptions.fallbackEndpoints), ['ws://127.0.0.1:3101/wisp/']);
  app.contextWindow.fire('pagehide');
});

test('DOM readiness connects tools before slow subresources load and full load preserves the runtime', async () => {
  const app = await harness();
  const connection = app.init();
  const next = app.replaceDocument('loading');
  assert.equal(app.tickWatch(), true);
  assert.equal(app.runtimes.length, 0);
  assert.equal(next.listeners.get('DOMContentLoaded').size, 1);
  next.readyState = 'interactive';
  next.fire('DOMContentLoaded');
  assert.equal(app.runtimes.length, 1);
  assert.equal(app.get('status').hidden, true);
  assert.equal(app.treeReads, 0);
  await connection.request({ id: 1, method: 'evaluate', params: { code: 'pageIsUsable()' } });
  assert.equal(connection.messages.find(message => message.id === 1).result, 'result: pageIsUsable()');
  assert.equal(app.timers.size, 0);
  next.readyState = 'complete';
  app.loadPage();
  assert.equal(app.runtimes.length, 1, 'late image load must not reset inspector edits or console capture');
  assert.equal(app.runtimes[0].disposed, false);
  assert.equal(connection.messages.filter(message => message.event === 'page').length, 1);
  app.contextWindow.fire('pagehide');
});

test('readiness expiry offers recovery without replacing, stopping, or retrying the slow page', async () => {
  const app = await harness();
  const source = app.frame.src;
  let ticks = 0;
  while (app.tickWatch()) { ticks++; assert(ticks < 150, 'document discovery must be bounded'); }
  assert(ticks > 100);
  assert.equal(app.expireReadiness(), true);
  assert.deepEqual(app.navigations, [source]);
  assert.equal(app.frame.srcdoc, undefined);
  assert.equal(app.get('retry').hidden, true);
  assert.equal(app.get('status').hidden, false);
  assert.equal(app.get('status-title').textContent, 'This page is taking longer than expected');
  assert.match(app.get('status-message').textContent, /may still load/);
  assert.match(app.get('status-trace').textContent, /45 seconds/);
  assert.equal(app.get('switch-retry').hidden, false);
  assert.match(app.get('status-retry-note').textContent, /https:\/\/example.com\//);
  assert.deepEqual(app.network.switches, []);
  assert.equal(app.pageWindow.location.reloads, 0);
  app.replaceDocument(); app.loadPage();
  assert.equal(app.runtimes.length, 1, 'native load remains a fallback after discovery expires');
  assert.equal(app.get('status').hidden, true);
  assert.equal(app.get('switch-retry').hidden, true);
  assert.equal(app.get('status-trace').textContent, '');
  assert.equal(app.timers.size, 0);
  app.contextWindow.fire('pagehide');
});

test('a blank slow page requires a trusted click before switching and retrying the entered address', async () => {
  const app = await harness();
  app.pageWindow.location.href = 'about:blank';
  assert.equal(app.expireReadiness(), true);
  const before = [...app.navigations];
  assert.equal(app.get('switch-retry').hidden, false);
  app.get('switch-retry').fire('click', { isTrusted: false }); await flush();
  assert.deepEqual(app.network.switches, []);
  assert.deepEqual(app.navigations, before);
  app.get('switch-retry').fire('click', { isTrusted: true }); await flush();
  assert.equal(app.network.switches.length, 1);
  assert.equal(app.network.switches[0].failedEndpoint, 'ws://127.0.0.1:3101/wisp/');
  assert.equal(app.navigations.length, before.length + 1);
  assert.equal(app.frame.src, '/service/' + encodeURIComponent('https://example.com/'));
  assert.equal(app.pageWindow.location.reloads, 0);
  assert.match(app.get('status-message').textContent, /loading/);
  app.contextWindow.fire('pagehide');
});

test('an empty completed UV document cannot cancel the deadline or hide server recovery', async () => {
  const app = await harness();
  const blank = app.replaceDocument('complete');
  blank.title = '';
  blank.body = { childElementCount: 0, textContent: '' };
  app.loadPage();
  assert.equal(app.runtimes.length, 0);
  assert.equal(app.get('status').hidden, false);
  assert.equal(app.observers.length, 1);
  app.loadPage();
  assert.equal(app.observers.length, 1, 'repeated empty load events reuse one observer');
  assert.equal(app.expireReadiness(), true);
  assert.equal(app.get('status').hidden, false);
  assert.equal(app.get('switch-retry').hidden, false);
  assert.match(app.get('status-trace').textContent, /45 seconds/);
  assert.equal(app.navigations.length, 1);
  assert.deepEqual(app.network.switches, []);
  blank.body.childElementCount = 1;
  app.observers[0].callback();
  assert.equal(app.runtimes.length, 1, 'late rendering remains usable without replaying the request');
  assert.equal(app.get('status').hidden, true);
  assert.equal(app.get('switch-retry').hidden, true);
  assert.equal(app.observers[0].disconnected, true);
  assert.equal(app.timers.size, 0);
  app.contextWindow.fire('pagehide');
});

test('DOMContentLoaded with an empty body waits for content and supports late text-only rendering', async () => {
  const app = await harness();
  const blank = app.replaceDocument('loading');
  blank.body = { childElementCount: 0, textContent: ' \n ' };
  app.tickWatch();
  blank.readyState = 'interactive';
  blank.fire('DOMContentLoaded');
  assert.equal(app.runtimes.length, 0);
  assert.equal(app.expireReadiness(), true);
  assert.equal(app.get('switch-retry').hidden, false);
  blank.body.textContent = 'Connection error from the remote site';
  app.observers[0].callback();
  assert.equal(app.runtimes.length, 1);
  assert.equal(app.get('status').hidden, true);
  assert.equal(app.navigations.length, 1);
  app.contextWindow.fire('pagehide');
});

test('stale blank-document observers cannot hide a newer navigation or revive a closed host', async () => {
  for (const close of [false, true]) {
    const app = await harness();
    const blank = app.replaceDocument('complete');
    blank.body = { childElementCount: 0, textContent: '' };
    app.loadPage();
    const observer = app.observers[0];
    if (close) app.contextWindow.fire('pagehide');
    else {
      app.location.hash = '#' + encodeURIComponent('https://next.example/');
      app.contextWindow.fire('hashchange');
      await flush();
    }
    assert.equal(observer.disconnected, true);
    blank.body.childElementCount = 1;
    observer.callback();
    assert.equal(app.runtimes.length, 0);
    if (!close) {
      assert.equal(app.expireReadiness(), true);
      assert.match(app.get('status-retry-note').textContent, /https:\/\/next.example\//);
      app.contextWindow.fire('pagehide');
    }
  }
});

test('pending DOM readiness times out but its late content can still clear the diagnostic', async () => {
  const app = await harness();
  const next = app.replaceDocument('loading');
  app.tickWatch();
  assert.equal(next.listeners.get('DOMContentLoaded').size, 1);
  assert.equal(app.expireReadiness(), true);
  assert.equal(app.get('switch-retry').hidden, false);
  assert.equal(app.runtimes.length, 0);
  assert.equal(next.listeners.get('DOMContentLoaded').size, 1);
  assert.equal(app.timers.size, 0);
  next.readyState = 'interactive'; next.fire('DOMContentLoaded');
  assert.equal(app.runtimes.length, 1);
  assert.equal(app.get('status').hidden, true);
  assert.equal(next.listeners.get('DOMContentLoaded').size, 0);
  assert.equal(app.get('switch-retry').hidden, true);
  assert.equal(app.get('status-trace').textContent, '');
  assert.deepEqual(app.network.switches, []);
  app.contextWindow.fire('pagehide');
});

test('the readiness deadline follows a redirected loading document and drops the old readiness listener', async () => {
  const app = await harness();
  const first = app.replaceDocument('loading'); app.tickWatch();
  const redirected = app.replaceDocument('loading');
  app.expireReadiness();
  assert.equal(first.listeners.get('DOMContentLoaded').size, 0);
  assert.equal(redirected.listeners.get('DOMContentLoaded').size, 1);
  first.readyState = 'interactive'; first.fire('DOMContentLoaded');
  assert.equal(app.runtimes.length, 0);
  redirected.readyState = 'interactive'; redirected.fire('DOMContentLoaded');
  assert.equal(app.runtimes.length, 1);
  assert.equal(app.get('status').hidden, true);
  app.contextWindow.fire('pagehide');
});

test('stale readiness timers cannot replace a newer navigation diagnostic or clear its deadline', async () => {
  const app = await harness();
  const oldDeadline = [...app.timers.values()].find(timer => timer.ms === 45000).fn;
  const oldPoll = [...app.timers.values()].find(timer => timer.ms <= 500).fn;
  app.location.hash = '#' + encodeURIComponent('https://new.example/');
  app.contextWindow.fire('hashchange'); await flush();
  const timers = [...app.timers.keys()];
  oldDeadline(); oldPoll();
  assert.deepEqual([...app.timers.keys()], timers);
  assert.equal(app.get('switch-retry').hidden, true);
  assert.equal(app.expireReadiness(), true);
  assert.match(app.get('status-retry-note').textContent, /https:\/\/new.example\//);
  assert.doesNotMatch(app.get('status-retry-note').textContent, /https:\/\/example.com\//);
  app.contextWindow.fire('pagehide');
});

test('ready or disposed hosts clear deadlines and ignore callbacks already queued before cleanup', async () => {
  for (const disposed of [false, true]) {
    const app = await harness();
    const callbacks = [...app.timers.values()].map(timer => timer.fn);
    if (disposed) app.contextWindow.fire('pagehide');
    else { app.replaceDocument(); app.loadPage(); }
    const before = app.get('status-title').textContent;
    assert.equal(app.timers.size, 0);
    callbacks.forEach(callback => callback());
    assert.equal(app.timers.size, 0);
    assert.equal(app.get('status-title').textContent, before);
    assert.equal(app.get('switch-retry').hidden, true);
    assert.deepEqual(app.network.switches, []);
    if (!disposed) app.contextWindow.fire('pagehide');
  }
});

test('a late usable page cancels slow-page retry navigation while a requested server switch is pending', async () => {
  const app = await harness();
  app.expireReadiness();
  let finish;
  app.network.switchEndpoint = () => new Promise(resolve => { finish = resolve; });
  app.get('switch-retry').fire('click', { isTrusted: true });
  app.replaceDocument(); app.loadPage();
  const before = [...app.navigations];
  finish('wss://other.example/wisp/'); await flush();
  assert.deepEqual(app.navigations, before);
  assert.equal(app.get('status').hidden, true);
  assert.equal(app.runtimes.length, 1);
  app.contextWindow.fire('pagehide');
});

test('closing the host cancels document observation and ignores late readiness or load', async () => {
  const app = await harness();
  const next = app.replaceDocument('loading');
  app.tickWatch();
  app.contextWindow.fire('pagehide');
  assert.equal(next.listeners.get('DOMContentLoaded').size, 0);
  assert.equal(app.timers.size, 0);
  next.fire('DOMContentLoaded'); app.loadPage();
  assert.equal(app.runtimes.length, 0);
});

test('a failed warm connection preserves the current page and acknowledges its retry notice', async () => {
  const app = await harness();
  const connection = app.init(); app.loadPage();
  const source = app.frame.src;
  const connect = app.network.connect;
  app.network.connect = async () => { throw new Error('No proxy is available'); };
  await connection.request({ id: 1, method: 'navigate', params: { url: 'https://next.example/' } });
  assert.equal(connection.messages.find(message => message.id === 1).result, true);
  assert.equal(app.frame.src, source);
  assert.equal(app.runtimes[0].disposed, false);
  assert.match(app.get('status-message').textContent, /No proxy/);
  assert.equal(connection.messages.filter(message => message.event === 'page').length, 2, 'restore shell controls for the preserved page');
  assert.equal(connection.messages.filter(message => message.event === 'page').at(-1).data.url, 'https://example.com/');
  assert.equal(app.get('retry').hidden, false);
  app.network.connect = connect;
  app.get('retry').fire('click'); await flush();
  assert.equal(app.frame.src, '/service/' + encodeURIComponent('https://next.example/'));
  assert.equal(app.get('status-title').textContent, 'Opening page');
  assert.equal(app.get('retry').hidden, true);
  app.contextWindow.fire('pagehide');
});

test('endpoint selection starts while the service worker activates, but navigation waits for both', async () => {
  let ready;
  const app = await harness({ workerReady: new Promise(resolve => { ready = resolve; }) });
  assert.equal(app.activated, 1);
  assert.equal(app.navigations.length, 0);
  ready(); await flush();
  assert.equal(app.navigations.length, 1);
  app.contextWindow.fire('pagehide');
});

test('an existing old controller cannot navigate until an installing proxy update activates and takes control', async () => {
  const updating = { ...node(), state: 'installing' };
  const app = await harness({ workerRegistration: { installing: updating } });
  assert.equal(app.network.connects, 1, 'Wisp connects in parallel with the worker update');
  assert.equal(app.navigations.length, 0);
  assert.equal(updating.listeners.get('statechange').size, 1);
  updating.state = 'activated'; updating.fire('statechange'); await flush();
  assert.equal(updating.listeners.get('statechange').size, 0);
  assert.equal(app.navigations.length, 0, 'an activated update must claim this host before its first page');
  assert.equal(app.serviceWorker.listeners.get('controllerchange').size, 1);
  app.serviceWorker.fire('controllerchange'); await flush();
  assert.equal(app.navigations.length, 0, 'unrelated controller events do not release navigation');
  app.serviceWorker.controller = updating;
  app.serviceWorker.fire('controllerchange'); await flush();
  assert.equal(app.navigations.length, 1);
  assert.equal(app.serviceWorker.listeners.get('controllerchange').size, 0);
  assert.equal(app.registrations, 1);
  assert.equal(app.network.connects, 1);
  app.contextWindow.fire('pagehide');
});

test('a waiting proxy update that already claims the host finishes without another navigation or listener', async () => {
  const updating = { ...node(), state: 'installed' };
  const app = await harness({ workerRegistration: { waiting: updating } });
  assert.equal(app.navigations.length, 0);
  app.serviceWorker.controller = updating;
  updating.state = 'activated'; updating.fire('statechange'); await flush();
  assert.equal(app.navigations.length, 1);
  assert.equal(updating.listeners.get('statechange').size, 0);
  assert.equal(app.serviceWorker.listeners.get('controllerchange'), undefined);
  app.contextWindow.fire('pagehide');
});

test('failed and stalled proxy updates clean up and cannot reuse the old worker on retry', async () => {
  for (const timeout of [false, true]) {
    const updating = { ...node(), state: 'installing' };
    const registration = { installing: updating };
    const app = await harness({ workerRegistration: registration });
    if (timeout) {
      const entry = [...app.timers].find(([, timer]) => timer.ms === 15000);
      assert.ok(entry);
      app.timers.delete(entry[0]); entry[1].fn();
    } else { updating.state = 'redundant'; updating.fire('statechange'); }
    await flush();
    assert.equal(app.navigations.length, 0);
    assert.match(app.get('status-message').textContent, timeout ? /update timed out/ : /update failed/);
    assert.equal(updating.listeners.get('statechange').size, 0);
    const replacement = { ...node(), state: 'installing' };
    registration.installing = replacement;
    app.get('retry').fire('click'); await flush();
    assert.equal(app.registrations, 2, 'retry registers again instead of using the cached old controller');
    assert.equal(app.navigations.length, 0);
    app.serviceWorker.controller = replacement;
    replacement.state = 'activated'; replacement.fire('statechange'); await flush();
    assert.equal(app.navigations.length, 1);
    assert.equal(replacement.listeners.get('statechange').size, 0);
    app.contextWindow.fire('pagehide');
  }
});

const tlsFailure = 'Error: Hyper client: Connect: Custom { kind: UnexpectedEof, error: "tls handshake eof" }';
function makeErrorPage(app, trace = tlsFailure) {
  app.pageDoc.title = 'Error';
  app.pageDoc.getElementById = id => ({
    errorTitle: { textContent: 'Error processing your request' },
    errorTrace: { localName: 'textarea', value: trace },
    fetchedURL: { textContent: 'https://untrusted-error-text.example/never-open-this' },
  })[id] || null;
}

test('TLS diagnostic keeps technical details and never rotates or retries from page-controlled markers', async () => {
  const app = await harness();
  const connection = app.init();
  makeErrorPage(app);
  const before = [...app.navigations];
  app.loadPage();
  assert.equal(app.get('status').hidden, false);
  assert.equal(app.get('status-title').textContent, 'Secure connection interrupted');
  assert.match(app.get('status-message').textContent, /Another proxy server/);
  assert.match(app.get('status-retry-note').textContent, /last address you entered/);
  assert.match(app.get('status-retry-note').textContent, /Form submissions are not repeated/);
  assert.equal(app.get('status-trace').textContent, tlsFailure);
  assert.equal(app.get('status-details').hidden, false);
  assert.equal(app.get('switch-retry').hidden, false);
  assert.equal(connection.messages.find(message => message.event === 'page').data.isError, true);
  assert.equal(app.network.failures, 0, 'error-page DOM is not authority to alter network state');
  assert.deepEqual(app.network.switches, []);
  assert.deepEqual(app.navigations, before);
  app.loadPage();
  assert.equal(app.get('status').hidden, false, 'late load does not dismiss an actionable error');
  app.contextWindow.fire('pagehide');
});

test('ordinary pages with similarly named elements do not trigger the proxy error notice', async () => {
  const app = await harness();
  app.pageDoc.getElementById = id => id === 'errorTitle' ? { textContent: 'My site message' } : id === 'errorTrace' ? { localName: 'div', textContent: tlsFailure } : null;
  const connection = app.init(); app.loadPage();
  assert.equal(connection.messages.find(message => message.event === 'page').data.isError, false);
  assert.equal(app.get('status').hidden, true);
  assert.equal(app.network.failures, 0);
  app.contextWindow.fire('pagehide');
});

test('explicit error recovery excludes the failed server and opens only the entered address as a new GET', async () => {
  const app = await harness();
  makeErrorPage(app, tlsFailure + '<img src=x onerror=attack()>' + 'x'.repeat(7000));
                                                                           
                                                                         
  app.pageWindow.location.href = proxyOrigin + '/service/' + encodeURIComponent('https://example.com/payment-submit');
  app.loadPage();
  assert.equal(app.get('status-trace').textContent.length, 6000);
  const initialCount = app.navigations.length;
  app.get('switch-retry').fire('click', { isTrusted: false }); await flush();
  assert.equal(app.network.switches.length, 0, 'synthetic clicks cannot authorize retry');
  app.get('switch-retry').fire('click', { isTrusted: true }); await flush();
  assert.equal(app.network.switches.length, 1);
  assert.equal(app.network.switches[0].failedEndpoint, 'ws://127.0.0.1:3101/wisp/');
  assert.equal(app.navigations.length, initialCount + 1);
  assert.equal(app.frame.src, '/service/' + encodeURIComponent('https://example.com/'));
  assert.equal(app.pageWindow.location.reloads, 0);
  app.contextWindow.fire('pagehide');
});

test('generic server switching preserves the current document without reloading or submitting a form', async () => {
  const app = await harness();
  const connection = app.init(); app.loadPage();
  const before = [...app.navigations];
  await connection.request({ id: 1, method: 'switchServer', params: { url: 'https://untrusted.example/', method: 'POST' } });
  assert.equal(connection.messages.find(message => message.id === 1).result, true);
  assert.equal(app.network.switches.length, 1);
  assert.deepEqual(app.navigations, before);
  assert.equal(app.pageWindow.location.reloads, 0);
  assert.equal(app.runtimes[0].disposed, false);
  assert.equal(app.get('status-title').textContent, 'Proxy server switched');
  app.contextWindow.fire('pagehide');
});

test('a rejected app-origin destination never replaces the recorded GET recovery address', async () => {
  const app = await harness();
  app.location.hash = '#' + encodeURIComponent(shellOrigin + '/math.html');
  app.contextWindow.fire('hashchange'); await flush();
  assert.equal(app.navigations.length, 1);
  assert.match(app.get('status-message').textContent, /App pages/);
  makeErrorPage(app); app.loadPage();
  app.get('switch-retry').fire('click', { isTrusted: true }); await flush();
  assert.equal(app.frame.src, '/service/' + encodeURIComponent('https://example.com/'));
  assert.equal(app.navigations.length, 2);
  app.contextWindow.fire('pagehide');
});

test('failed server switching keeps the error document, original details, and retry action', async () => {
  const app = await harness();
  makeErrorPage(app); app.loadPage();
  const before = [...app.navigations];
  app.network.switchEndpoint = async () => { throw new Error('No alternative proxy is available'); };
  app.get('switch-retry').fire('click', { isTrusted: true }); await flush();
  assert.deepEqual(app.navigations, before);
  assert.equal(app.get('status-title').textContent, 'No alternative server connected');
  assert.match(app.get('status-message').textContent, /No alternative proxy/);
  assert.equal(app.get('status-trace').textContent, tlsFailure);
  assert.equal(app.get('switch-retry').hidden, false);
  app.contextWindow.fire('pagehide');
});

test('a late retry switch cannot replace a newer address and repeated clicks coalesce', async () => {
  const app = await harness();
  makeErrorPage(app); app.loadPage();
  let finish;
  let switches = 0;
  app.network.switchEndpoint = () => { switches++; return new Promise(resolve => { finish = resolve; }); };
  app.get('switch-retry').fire('click', { isTrusted: true });
  app.get('switch-retry').fire('click', { isTrusted: true });
  assert.equal(switches, 1);
  app.location.hash = '#' + encodeURIComponent('https://new.example/');
  app.contextWindow.fire('hashchange'); await flush();
  const before = [...app.navigations];
  finish('wss://other.example/wisp/'); await flush();
  assert.deepEqual(app.navigations, before);
  assert.equal(app.frame.src, '/service/' + encodeURIComponent('https://new.example/'));
  app.contextWindow.fire('pagehide');
});

test('element edit and undo RPCs mutate only a node from the viewed document and return a fresh selection', async () => {
  const app = await harness();
  const connection = app.init();
  app.loadPage();
  const calls = [];
  app.runtimes[0].editNode = (element, change) => { calls.push({ element, kind: change.kind, value: change.value }); return element; };
  app.runtimes[0].undo = () => app.root;
  await connection.request({ id: 0, method: 'tree' });
  const id = connection.messages.find(message => message.id === 0).result.rootId;
  await connection.request({ id: 1, method: 'edit', params: { id, kind: 'attribute', name: 'class', value: 'updated' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].element, app.root);
  assert.equal(calls[0].value, 'updated');
  assert.equal(connection.messages.find(message => message.id === 1).result.id, id);
  await connection.request({ id: 2, method: 'edit', params: { id: 'not-in-page', kind: 'delete' } });
  assert.match(connection.messages.find(message => message.id === 2).error, /No matching element/);
  assert.equal(calls.length, 1);
  await connection.request({ id: 3, method: 'undo' });
  assert.equal(connection.messages.find(message => message.id === 3).result.tree.rootId, id);
  app.contextWindow.fire('pagehide');
});

test('proxy host prevents non-HTTP destination navigation', async () => {
  const app = await harness();
  const previous = app.frame.src;
  app.location.hash = '#' + encodeURIComponent('javascript:alert(1)');
  app.contextWindow.fire('hashchange');
  await flush();
  assert.equal(app.frame.src, previous);
  assert.match(app.get('status-message').textContent, /HTTP/);
  assert.equal(app.get('retry').hidden, false);
  app.contextWindow.fire('pagehide');
});

test('proxy host rejects configuration naming a different proxy origin', async () => {
  const app = await harness({ config: { proxyOrigin: 'https://wrong.example' } });
  assert.equal(app.activated, 0);
  assert.match(app.get('status-message').textContent, /misconfigured/);
  app.contextWindow.fire('pagehide');
});

test('proxy host reports HTML config without starting transport, and retries after routing recovers', async () => {
  let failed = true;
  const app = await harness({ fetchConfig: async () => failed
    ? new Response('<!DOCTYPE html><h1>Fallback</h1>', { headers: { 'Content-Type': 'text/html' } })
    : new Response(JSON.stringify({ shellOrigins: [shellOrigin], proxyOrigin, wispEndpoints: [{ url: '/wisp/' }] }), { headers: { 'Content-Type': 'application/json' } }) });
  assert.equal(app.activated, 0);
  assert.equal(app.navigations.length, 0);
  assert.match(app.get('status-message').textContent, /proxy backend is not connected/);
  assert.doesNotMatch(app.get('status-message').textContent, /Unexpected token/);
  failed = false;
  app.get('retry').fire('click');
  await flush();
  assert.equal(app.activated, 1);
  assert.equal(app.navigations.length, 1);
  app.contextWindow.fire('pagehide');
});

test('invalid configuration is not cached across retry', async () => {
  let failed = true;
  const app = await harness({ fetchConfig: async () => new Response(JSON.stringify({ shellOrigins: [shellOrigin], proxyOrigin: failed ? 'https://wrong.example' : proxyOrigin, wispEndpoints: [{ url: '/wisp/' }] }), { headers: { 'Content-Type': 'application/json' } }) });
  assert.equal(app.activated, 0);
  failed = false;
  app.get('retry').fire('click');
  await flush();
  assert.equal(app.activated, 1);
  app.contextWindow.fire('pagehide');
});

test('proxy host releases the previous runtime when the viewed document changes', async () => {
  const app = await harness();
  app.init();
  app.loadPage();
  const first = app.runtimes[0];
  app.replaceDocument();
  app.loadPage();
  assert.equal(first.disposed, true);
  assert.equal(app.runtimes.length, 2);
  app.contextWindow.fire('pagehide');
  assert.equal(app.runtimes[1].disposed, true);
  assert.equal(app.network.disposed, 1);
});

test('proxy host releases command slots after timeouts instead of disabling tools permanently', async () => {
  const app = await harness({ evaluate: code => code === 'hang' ? new Promise(() => {}) : Promise.resolve('ok') });
  const connection = app.init();
  app.loadPage();
  const requests = Array.from({ length: 32 }, (_, id) => connection.onmessage({ data: { id, method: 'evaluate', params: { code: 'hang' } } }));
  await flush();
  await connection.request({ id: 33, method: 'evaluate', params: { code: 'overflow' } });
  assert.equal(app.evaluated.length, 32);
  for (const timer of [...app.timers.values()]) timer.fn();
  await Promise.all(requests);
  assert.equal(connection.messages.filter(message => typeof message.error === 'string' && /timed out/.test(message.error)).length, 32);
  await connection.request({ id: 34, method: 'evaluate', params: { code: 'working' } });
  assert.equal(connection.messages.find(message => message.id === 34).result, 'ok');
  assert.equal(app.timers.size, 0);
  app.contextWindow.fire('pagehide');
});

test('a new document frees old command slots and ignores late replies', async () => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const app = await harness({ evaluate: code => code === 'hang' ? gate : Promise.resolve('new document') });
  const connection = app.init();
  app.loadPage();
  const requests = Array.from({ length: 32 }, (_, id) => connection.onmessage({ data: { id, method: 'evaluate', params: { code: 'hang' } } }));
  await flush();
  app.replaceDocument();
  app.loadPage();
  await connection.request({ id: 33, method: 'evaluate', params: { code: 'working' } });
  assert.equal(connection.messages.find(message => message.id === 33).result, 'new document');
  finish('stale document');
  await Promise.all(requests);
  assert.equal(connection.messages.filter(message => Number.isInteger(message.id) && message.id < 32).length, 0);
  assert.equal(app.timers.size, 0);
  app.contextWindow.fire('pagehide');
});

test('slow transport activation is serialized without a timeout pretending it was cancelled', async () => {
  let finish;
  const startup = new Promise(resolve => { finish = resolve; });
  const app = await harness({ startup });
  assert.equal(app.activated, 1);
  assert.equal(app.timers.size, 0, 'activation must preserve the true mutation promise');
  app.location.hash = '#' + encodeURIComponent('https://second.example/');
  app.contextWindow.fire('hashchange');
  app.location.hash = '#' + encodeURIComponent('https://third.example/');
  app.contextWindow.fire('hashchange');
  await flush();
  assert.equal(app.activated, 1);
  assert.equal(app.navigations.length, 0);
  finish();
  await flush();
  assert.deepEqual(app.navigations, ['/service/' + encodeURIComponent('https://third.example/')]);
  app.contextWindow.fire('pagehide');
});

test('closing a host during slow activation never performs late page navigation', async () => {
  let finish;
  const app = await harness({ startup: new Promise(resolve => { finish = resolve; }) });
  app.contextWindow.fire('pagehide');
  finish();
  await flush();
  assert.deepEqual(app.navigations, []);
  assert.equal(app.network.disposed, 1);
});
