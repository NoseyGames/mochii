import { createProxyNetwork } from './proxy-network.js';
import { attachRuntime, formatValue } from './runtime.js';
import './config.js';

// This entire document is on the expendable proxy origin. It never receives
// shell storage, credentials, or saved scripts unless the user runs a draft.
const frame = document.getElementById('page');
const status = document.getElementById('status');
const retry = document.getElementById('retry');
let config;
let port;
let runtime;
let network;
let transport;
let starting;
let latestNetwork;
let latestPage;
let documentGeneration = 0;
const activeRequests = new Set();
let navigationGeneration = 0;
let disposed = false;
let nodes = new Map();
let ids = new WeakMap();
let nextNodeId = 0;

function httpUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid page address.');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) address without embedded login details.');
  return url.href;
}

function send(event, data) {
  try { port?.postMessage({ event, data }); } catch { /* A closing shell has no receiver. */ }
}

function showError(error) {
  status.hidden = false;
  document.getElementById('status-title').textContent = 'Unable to open this page';
  document.getElementById('status-message').textContent = error.message || String(error);
  retry.hidden = false;
}

function nodeId(node) {
  if (!node || node.nodeType !== 1) throw new Error('Select an element first.');
  if (!ids.has(node)) {
    if (nodes.size >= 5000) throw new Error('Inspector limit reached. Reload this page to start again.');
    const id = String(++nextNodeId);
    nodes.set(id, node);
    ids.set(node, id);
  }
  return ids.get(node);
}

function treeSnapshot() {
  if (!runtime) throw new Error('Wait for the page to load.');
  const root = runtime.document.documentElement;
  const queue = [root];
  const records = [];
  const included = new Set();
  while (queue.length && records.length < 800) {
    const node = queue.shift();
    const id = nodeId(node);
    if (included.has(id)) continue;
    included.add(id);
    const children = runtime.getChildren(node).slice(0, Math.max(0, 800 - records.length - queue.length - 1));
    queue.push(...children);
    records.push({ id, localName: String(node.localName || 'element').slice(0, 80), elementId: String(node.id || '').slice(0, 500), className: String(typeof node.className === 'string' ? node.className : node.getAttribute?.('class') || '').slice(0, 500), children: children.map(nodeId) });
  }
  return { rootId: nodeId(root), nodes: records };
}

function selectedNode(params) {
  if (!runtime) throw new Error('Wait for the page to load.');
  const node = typeof params.selector === 'string'
    ? runtime.document.querySelector(params.selector.slice(0, 2000))
    : nodes.get(String(params.id));
  if (!node || node.ownerDocument !== runtime.document) throw new Error('No matching element in this page.');
  return node;
}

function requireRuntime() {
  if (!runtime) throw new Error('Wait for the page to load.');
  return runtime;
}

async function command(method, params) {
  switch (method) {
    case 'evaluate':
      if (typeof params.code !== 'string' || params.code.length > 110000) throw new Error('The script is too large.');
      return formatValue(await requireRuntime().evaluate(params.code)).slice(0, 12000);
    case 'tree': return treeSnapshot();
    case 'describe': return requireRuntime().describe(selectedNode(params));
    case 'select': {
      const node = selectedNode(params);
      runtime.select(node);
      return { id: nodeId(node), info: runtime.describe(node) };
    }
    case 'pick':
      if (params.active === true) requireRuntime().startPicking();
      else runtime?.stopPicking();
      return null;
    case 'style': {
      const node = selectedNode(params);
      if (typeof params.property !== 'string' || params.property.length > 200 || typeof params.value !== 'string' || params.value.length > 4000) throw new Error('Invalid CSS declaration.');
      runtime.setStyle(node, params.property, params.value);
      return runtime.describe(node);
    }
    case 'reload':
      if (runtime) frame.contentWindow.location.reload();
      else await navigate();
      return null;
    case 'reconnect': await network?.connect({ force: true }); return null;
    default: throw new Error('Unsupported browser command.');
  }
}

async function receive(event) {
  const request = event.data;
  if (!request || typeof request.id !== 'string' && typeof request.id !== 'number' || typeof request.method !== 'string') return;
  const id = request.id;
  if (String(id).length > 100 || activeRequests.size >= 32) return;
  const requestToken = {};
  activeRequests.add(requestToken);
  const replyPort = port;
  const generation = documentGeneration;
  try {
    const result = await deadline(command(request.method, request.params && typeof request.params === 'object' ? request.params : {}), 'The command timed out. Reload the page if its script is unresponsive.');
    if (!disposed && generation === documentGeneration && replyPort === port) replyPort?.postMessage({ id, result });
  } catch (error) {
    if (!disposed && generation === documentGeneration && replyPort === port) replyPort?.postMessage({ id, error: String(error.message || error).slice(0, 2000) });
  } finally { activeRequests.delete(requestToken); }
}

window.addEventListener('message', event => {
  if (!event.isTrusted || !config || event.source !== window.parent || !config.shellOrigins.includes(event.origin) || event.data?.type !== 'monkeh-proxy:init' || event.ports.length !== 1) return;
  port?.close();
  port = event.ports[0];
  port.onmessage = receive;
  port.start();
  send('ready', {});
  if (latestNetwork) send('network', latestNetwork);
  if (latestPage) send('page', latestPage);
});

function decodedPageUrl() {
  const url = new URL(frame.contentWindow.location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith(__uv$config.prefix)) return httpUrl(url.href);
  return httpUrl(__uv$config.decodeUrl(url.href.slice(location.origin.length + __uv$config.prefix.length)));
}

frame.addEventListener('load', () => {
  let doc;
  try {
    doc = frame.contentDocument;
    if (!doc?.documentElement || frame.contentWindow.location.href === 'about:blank') return;
    const generation = ++documentGeneration;
    activeRequests.clear();
    runtime?.dispose();
    nodes = new Map(); ids = new WeakMap(); nextNodeId = 0;
    runtime = attachRuntime(frame.contentWindow, {
      onConsole: event => {
        if (generation === documentGeneration) send('console', { level: event.level, args: event.args.slice(0, 50).map(value => formatValue(value).slice(0, 12000)), time: event.time });
      },
      onSelect: node => send('select', { id: nodeId(node), info: runtime.describe(node) }),
      onPickEnd: () => send('pickEnd', {}),
      onNavigate: () => {
        if (generation !== documentGeneration) return;
        runtime = null; latestPage = null;
        send('pagehide', {});
      }
    });
    const isError = Boolean(doc.getElementById('errorTrace') && doc.getElementById('errorTitle'));
    latestPage = { url: decodedPageUrl(), title: String(doc.title).slice(0, 300), isError, tree: treeSnapshot() };
    status.hidden = true;
    send('page', latestPage);
    if (isError) network?.reportFailure().catch(() => {});
  } catch (error) {
    runtime?.dispose(); runtime = null;
    send('pagehide', {});
    // A site may navigate directly to a different origin; the page can remain
    // visible, but it cannot expose tools through this origin's bridge.
    if (doc) showError(error);
  }
});

function deadline(promise, label, milliseconds = 15000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]).finally(() => clearTimeout(timer));
}

async function controlledWorker() {
  await deadline(navigator.serviceWorker.register('/sw.js', { scope: '/' }), 'Service worker registration timed out.');
  await deadline(navigator.serviceWorker.ready, 'Service worker activation timed out.');
  if (navigator.serviceWorker.controller) return;
  let listener;
  await deadline(new Promise(resolve => {
    listener = () => { if (navigator.serviceWorker.controller) resolve(); };
    navigator.serviceWorker.addEventListener('controllerchange', listener);
    listener();
  }), 'The proxy worker could not take control. Reload this page.').finally(() => navigator.serviceWorker.removeEventListener('controllerchange', listener));
}

async function start() {
  if (starting) return starting;
  starting = (async () => {
    if (!isSecureContext || !navigator.serviceWorker || !window.SharedWorker) throw new Error('Proxy browsing requires HTTPS or localhost and a browser with SharedWorker support.');
    if (!config) {
      const loadedConfig = await globalThis.MonkehConfig.fetchConfig();
      if (!Array.isArray(loadedConfig.shellOrigins) || loadedConfig.proxyOrigin !== location.origin ||
          !Array.isArray(loadedConfig.wispEndpoints) || loadedConfig.wispEndpoints.length < 1 || loadedConfig.wispEndpoints.length > 11) throw new Error('The isolated proxy origin is misconfigured.');
      config = loadedConfig;
      // Ask the shell to retry its init message now that allowed origins loaded.
      for (const origin of config.shellOrigins) window.parent.postMessage({ type: 'monkeh-proxy:ready' }, origin);
    }
    await controlledWorker();
    if (disposed) throw new Error('This browser view was closed.');
    if (!network) {
      if (!Array.isArray(config.wispEndpoints) || config.wispEndpoints.length < 1 || config.wispEndpoints.length > 11) throw new Error('Invalid server list.');
      const endpoints = config.wispEndpoints.map(entry => {
        const url = new URL(entry.url, location.href);
        if (url.protocol === 'http:') url.protocol = 'ws:';
        if (url.protocol === 'https:') url.protocol = 'wss:';
        return url.href;
      });
      transport = new BareMux.BareMuxConnection('/bearmux/worker.js');
      network = createProxyNetwork({ endpoints,
        // Preserve the actual promise: a timeout wrapper cannot cancel the
        // SharedWorker mutation and could let a stale activation win later.
        activate: url => transport.setTransport('/bearmux/epoxy/index.mjs', [{ wisp: url }]),
        onStatus: state => { latestNetwork = state; send('network', state); }
      });
      if (navigator.onLine === false) await network.setOnline(false);
    }
    await network.connect();
  })().finally(() => { starting = null; });
  return starting;
}

async function navigate() {
  const generation = ++navigationGeneration;
  try {
    if (disposed) return;
    status.hidden = false;
    retry.hidden = true;
    const targetUrl = httpUrl(decodeURIComponent(location.hash.slice(1)));
    await start();
    if (disposed || generation !== navigationGeneration) return;
    frame.src = __uv$config.prefix + __uv$config.encodeUrl(targetUrl);
  } catch (error) { if (!disposed && generation === navigationGeneration) showError(error); }
}

retry.addEventListener('click', () => navigate());
window.addEventListener('hashchange', () => navigate());
window.addEventListener('offline', () => network?.setOnline(false).catch(() => {}));
window.addEventListener('online', () => network?.setOnline(true).catch(() => {}));
window.addEventListener('pagehide', () => { disposed = true; navigationGeneration++; runtime?.dispose(); network?.dispose(); port?.close(); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
void navigate();
