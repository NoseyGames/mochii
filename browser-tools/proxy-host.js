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
let requestedUrl = null;
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

function treeSnapshot(focus = null) {
  if (!runtime) throw new Error('Wait for the page to load.');
  const root = runtime.document.documentElement;
  const path = [];
  for (let current = focus; current && path.length < 64; current = current.parentElement) {
    path.unshift(current);
    if (current === root) break;
  }
  if (path[0] !== root) path.length = 0;
  const pathChildren = new Map(path.slice(0, -1).map((node, index) => [node, path[index + 1]]));
  const queue = [root];
  const records = [];
  const included = new Map();
  const visited = new Set();
  function include(node) {
    const id = nodeId(node);
    if (!included.has(node)) {
      const record = { id, localName: String(node.localName || 'element').slice(0, 80), elementId: String(node.id || '').slice(0, 500), className: String(typeof node.className === 'string' ? node.className : node.getAttribute?.('class') || '').slice(0, 500), children: [] };
      included.set(node, record);
      records.push(record);
    }
    return included.get(node);
  }
  // Reserve the picked node's ancestor chain before filling the bounded tree.
  // A node beyond the first 800 elements must still be revealed accurately.
  for (const node of path.length ? path : [root]) include(node);
  while (queue.length) {
    const node = queue.shift();
    if (visited.has(node)) continue;
    visited.add(node);
    const record = included.get(node);
    let children = runtime.getChildren(node).slice(0, 250);
    const priority = pathChildren.get(node);
    // getChildren returns the first siblings in document order. Reserve an
    // omitted picked-path child at the end; never move it before real siblings.
    if (priority && !children.includes(priority)) children = [...children.slice(0, 249), priority];
    for (const child of children) {
      if (!included.has(child) && records.length >= 800) continue;
      const childRecord = include(child);
      if (!record.children.includes(childRecord.id)) record.children.push(childRecord.id);
      if (!visited.has(child)) queue.push(child);
    }
  }
  return { rootId: nodeId(root), nodes: records };
}

function selectionSnapshot(node) {
  return { id: nodeId(node), info: runtime.describe(node), tree: treeSnapshot(node) };
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
    case 'tree': return treeSnapshot(params.id === undefined ? null : selectedNode(params));
    case 'describe': return requireRuntime().describe(selectedNode(params));
    case 'select': {
      const node = selectedNode(params);
      runtime.select(node);
      return selectionSnapshot(node);
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
    case 'edit': {
      const node = requireRuntime().editNode(selectedNode(params), params);
      runtime.select(node);
      return selectionSnapshot(node);
    }
    case 'undo': {
      const node = requireRuntime().undo();
      runtime.select(node);
      return selectionSnapshot(node);
    }
    case 'reload':
      if (runtime) frame.contentWindow.location.reload();
      else await navigate();
      return null;
    case 'navigate': {
      const target = httpUrl(params.url);
      if (!config || config.shellOrigins.includes(new URL(target).origin) || new URL(target).origin === location.origin) throw new Error('App pages cannot be opened as proxy destinations.');
      return await navigate(target);
    }
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
    if (!disposed && (request.method === 'navigate' || generation === documentGeneration) && replyPort === port) replyPort?.postMessage({ id, result });
  } catch (error) {
    if (!disposed && (request.method === 'navigate' || generation === documentGeneration) && replyPort === port) replyPort?.postMessage({ id, error: String(error.message || error).slice(0, 2000) });
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
      onSelect: node => send('select', selectionSnapshot(node)),
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
    if (network && navigator.serviceWorker.controller) {
      await network.connect();
      return;
    }
    if (!config) {
      const loadedConfig = await globalThis.MonkehConfig.fetchConfig();
      if (!Array.isArray(loadedConfig.shellOrigins) || loadedConfig.proxyOrigin !== location.origin ||
          !Array.isArray(loadedConfig.wispEndpoints) || loadedConfig.wispEndpoints.length < 1 || loadedConfig.wispEndpoints.length > 15) throw new Error('The isolated proxy origin is misconfigured.');
      config = loadedConfig;
      // Ask the shell to retry its init message now that allowed origins loaded.
      for (const origin of config.shellOrigins) window.parent.postMessage({ type: 'monkeh-proxy:ready' }, origin);
    }
    await controlledWorker();
    if (disposed) throw new Error('This browser view was closed.');
    if (!network) {
      if (!Array.isArray(config.wispEndpoints) || config.wispEndpoints.length < 1 || config.wispEndpoints.length > 15) throw new Error('Invalid server list.');
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

async function navigate(url = null) {
  const generation = ++navigationGeneration;
  try {
    if (disposed) return false;
    status.hidden = false;
    retry.hidden = true;
    const targetUrl = httpUrl(url ?? requestedUrl ?? decodeURIComponent(location.hash.slice(1)));
    requestedUrl = targetUrl;
    await start();
    if (disposed || generation !== navigationGeneration) return false;
    if (url !== null) window.history?.replaceState(null, '', '#' + encodeURIComponent(targetUrl));
    frame.src = __uv$config.prefix + __uv$config.encodeUrl(targetUrl);
    return true;
  } catch (error) {
    if (!disposed && generation === navigationGeneration) showError(error);
    return false;
  }
}

retry.addEventListener('click', () => navigate());
window.addEventListener('hashchange', () => { requestedUrl = null; void navigate(); });
window.addEventListener('offline', () => network?.setOnline(false).catch(() => {}));
window.addEventListener('online', () => network?.setOnline(true).catch(() => {}));
window.addEventListener('pagehide', () => { disposed = true; navigationGeneration++; runtime?.dispose(); network?.dispose(); port?.close(); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
void navigate();
