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
async function harness({ config: extraConfig = {}, evaluate = async code => `result: ${code}`, startup, fetchConfig } = {}) {
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
  const location = { origin: proxyOrigin, href: proxyOrigin + '/proxy-host.html#' + encodeURIComponent('https://example.com/'), hash: '#' + encodeURIComponent('https://example.com/') };
  const pageDoc = { title: 'Example', getElementById: () => null };
  const root = { nodeType: 1, localName: 'html', id: '', className: '', children: [], ownerDocument: pageDoc };
  pageDoc.documentElement = root;
  pageDoc.querySelector = () => root;
  const pageWindow = { document: pageDoc, location: { href: proxyOrigin + '/service/' + encodeURIComponent('https://example.com/'), reload() {} } };
  const frame = get('page');
  const navigations = [];
  Object.defineProperty(frame, 'src', { get() { return navigations.at(-1); }, set(value) { navigations.push(value); } });
  frame.contentWindow = pageWindow;
  frame.contentDocument = pageDoc;
  const evaluated = [];
  const runtimes = [];
  let activated = 0;
  let networkOptions;
  const network = { connects: 0, failures: 0, disposed: 0,
    async connect() { this.connects++; if (this.connects === 1) await networkOptions.activate('ws://127.0.0.1:3101/wisp/'); networkOptions.onStatus({ status: 'connected', activeEndpoint: 'ws://127.0.0.1:3101/wisp/', configuredCount: 1 }); return 'ws://127.0.0.1:3101/wisp/'; },
    async reportFailure() { this.failures++; }, async setOnline() {}, dispose() { this.disposed++; },
  };
  const sandbox = {
    window: contextWindow, document: doc, location, isSecureContext: true,
    navigator: { onLine: true, serviceWorker: { async register() {}, ready: Promise.resolve(), controller: {}, addEventListener() {}, removeEventListener() {} } },
    URL, AbortSignal, AbortController, TextEncoder, TextDecoder, Map, WeakMap, Set, decodeURIComponent, encodeURIComponent,
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
        getChildren(element) { return element.children; },
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
  return { contextWindow, doc, get, frame, pageWindow, pageDoc, root, network, timers, evaluated, runtimes, init, loadPage, location, navigations, get activated() { return activated; } };
}

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
  assert(page.tree.nodes.length <= 800);
  assert(page.tree.nodes.every(record => record.elementId.length <= 500));
  app.runtimes[0].callbacks.onConsole({ level: 'log', args: Array(100).fill('x'.repeat(13000)), time: Date.now() });
  const event = connection.messages.find(message => message.event === 'console').data;
  assert.equal(event.args.length, 50);
  assert(event.args.every(value => value.length <= 12000));
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
