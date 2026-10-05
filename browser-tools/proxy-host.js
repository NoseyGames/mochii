import { createProxyNetwork } from './proxy-network.js';
import { attachRuntime, formatValue } from './runtime.js';
import './config.js';

                                                                            
                                                                             
const frame = document.getElementById('page');
const status = document.getElementById('status');
const retry = document.getElementById('retry');
let config;
let port;
let runtime;
let network;
let transport;
let starting;
let workerConfigured = false;
let latestNetwork;
let latestPage;
let documentGeneration = 0;
const activeRequests = new Set();
let navigationGeneration = 0;
let requestedUrl = null;
let lastGetAddress = null;
let disposed = false;
let nodes = new Map();
let ids = new WeakMap();
let nextNodeId = 0;
let documentWatchTimer;
let documentDeadlineTimer;
let documentWatchGeneration = 0;
let observedDocument;
let readyListener;
let contentObserver;
let blankDocument;
let pageFailure = null;
let switching = null;
let identityStarting;
let identityReady = false;
let cancelIdentity;
let cancelGameCode;
const loadCode = new URL(location.href).searchParams.get('loadCode') === '1';

function httpUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid page address.');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) address without embedded login details.');
  return url.href;
}

function send(event, data) {
  try { port?.postMessage({ event, data }); } catch {                                        }
}

function clearDiagnostic() {
  document.getElementById('switch-retry').hidden = true;
  document.getElementById('status-retry-note').hidden = true;
  document.getElementById('status-details').hidden = true;
  document.getElementById('status-details').open = false;
  document.getElementById('status-trace').textContent = '';
}

function showError(error) {
  clearDiagnostic();
  status.hidden = false;
  document.getElementById('status-title').textContent = 'Unable to open this page';
  document.getElementById('status-message').textContent = error.message || String(error);
  retry.hidden = false;
}

function showProgress(message) {
  clearDiagnostic();
  status.hidden = false;
  document.getElementById('status-title').textContent = 'Opening page';
  document.getElementById('status-message').textContent = message;
  retry.hidden = true;
}

function pageDiagnostic(doc) {
  const title = doc.getElementById('errorTitle');
  const trace = doc.getElementById('errorTrace');
  if (title?.textContent?.trim() !== 'Error processing your request' || trace?.localName !== 'textarea') return null;
  const details = String(trace.value || trace.textContent || '').slice(0, 6000);
  if (!details) return null;
                                                                         
                                                                             
  return { document: doc, details, tls: /tls|ssl|certificate|handshake/i.test(details),
    endpoint: network?.activeEndpoint || latestNetwork?.activeEndpoint || null,
    address: lastGetAddress };
}

function showDiagnostic(failure, switchError = '') {
  clearDiagnostic();
  status.hidden = false;
  retry.hidden = true;
  document.getElementById('status-title').textContent = switchError ? 'No alternative server connected' : failure.slow ? 'This page is taking longer than expected' : failure.tls ? 'Secure connection interrupted' : 'The proxy could not open this page';
  document.getElementById('status-message').textContent = switchError || (failure.slow
    ? 'The page may still load. You can keep waiting or switch proxy servers and reopen the entered address.'
    : failure.tls
    ? 'The secure connection closed before it was ready. Another proxy server may have a working route to this site. The site may also be temporarily unavailable.'
    : 'Try another proxy server. If the problem continues, check the address or try the site again later.');
  const note = document.getElementById('status-retry-note');
  note.hidden = !failure.address;
  note.textContent = `Retry opens the last address you entered as a new page request: ${(failure.address || '').slice(0, 180)}. Form submissions are not repeated.`;
  document.getElementById('switch-retry').hidden = !failure.address;
  document.getElementById('status-details').hidden = false;
  document.getElementById('status-trace').textContent = failure.details;
}

function switchServer(retryFailure = null) {
  if (switching) return switching;
  const generation = navigationGeneration;
  const currentDocument = frame.contentDocument;
  const failedEndpoint = retryFailure?.endpoint || network?.activeEndpoint || latestNetwork?.activeEndpoint;
  const isCurrent = () => !disposed && generation === navigationGeneration && currentDocument === frame.contentDocument;
  switching = (async () => {
    try {
      if (!network) throw new Error('Open a proxied page before switching servers.');
      showProgress('Finding a different working proxy server…');
      await network.switchEndpoint({ failedEndpoint });
      if (!isCurrent()) return false;
      if (retryFailure) {
        if (pageFailure !== retryFailure || !retryFailure.address) return false;
                                                                              
                                                                               
        return await navigate(retryFailure.address);
      }
      showProgress('The server changed. New requests use the new connection. Open an address when you want to try the page again.');
      document.getElementById('status-title').textContent = 'Proxy server switched';
      return true;
    } catch (error) {
      if (isCurrent()) {
        if (retryFailure) showDiagnostic(retryFailure, String(error.message || error).slice(0, 1000));
        else showError(error);
      }
      return false;
    }
  })().finally(() => { switching = null; });
  return switching;
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
                                                                              
                                                                            
  for (const node of path.length ? path : [root]) include(node);
  while (queue.length) {
    const node = queue.shift();
    if (visited.has(node)) continue;
    visited.add(node);
    const record = included.get(node);
    let children = runtime.getChildren(node).slice(0, 250);
    const priority = pathChildren.get(node);
                                                                           
                                                                                
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
      if (loadCode) await navigate(lastGetAddress || requestedUrl);
      else if (runtime) frame.contentWindow.location.reload();
      else await navigate();
      return null;
    case 'navigate': {
      const target = httpUrl(params.url);
      if (!config || config.shellOrigins.includes(new URL(target).origin) || new URL(target).origin === location.origin) throw new Error('App pages cannot be opened as proxy destinations.');
      await navigate(target);
                                                                             
                                                                              
      return !disposed;
    }
    case 'reconnect': await network?.connect({ force: true }); return null;
    case 'switchServer': return await switchServer();
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
    const result = await deadline(command(request.method, request.params && typeof request.params === 'object' ? request.params : {}), 'The command timed out. Reload the page if its script is unresponsive.', ['navigate', 'reload'].includes(request.method) ? 60000 : request.method === 'switchServer' ? 25000 : 15000);
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

function stopDocumentWatch() {
  documentWatchGeneration++;
  clearTimeout(documentWatchTimer);
  clearTimeout(documentDeadlineTimer);
  documentWatchTimer = undefined;
  documentDeadlineTimer = undefined;
  observedDocument?.removeEventListener('DOMContentLoaded', readyListener);
  observedDocument = readyListener = undefined;
  contentObserver?.disconnect();
  contentObserver = blankDocument = undefined;
}

function hasPageContent(doc) {
  if (!doc.body) return doc.documentElement?.localName !== 'html';
  return doc.body.childElementCount > 0 || /\S/.test(doc.body.textContent || '');
}

function watchBlankContent(doc) {
  if (blankDocument === doc || typeof MutationObserver !== 'function') return;
  contentObserver?.disconnect();
  blankDocument = doc;
  const generation = documentWatchGeneration;
  contentObserver = new MutationObserver(() => {
    if (!disposed && generation === documentWatchGeneration && frame.contentDocument === doc && hasPageContent(doc)) connectDocument();
  });
  contentObserver.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
}

function connectDocument() {
  if (disposed) return false;
  let doc;
  try {
    doc = frame.contentDocument;
    if (!doc?.documentElement || frame.contentWindow.location.href === 'about:blank') return false;
    if (runtime?.document === doc) return true;
    if (!hasPageContent(doc)) { watchBlankContent(doc); return false; }
    stopDocumentWatch();
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
        documentGeneration++;
        activeRequests.clear();
        runtime = null; latestPage = null; pageFailure = null;
        send('pagehide', {});
        showProgress('The page is loading. You can use content as it appears.');
        watchDocument(doc);
      }
    });
    pageFailure = pageDiagnostic(doc);
    const isError = Boolean(pageFailure);
                                                                          
                                                                      
    latestPage = { url: decodedPageUrl(), title: String(doc.title).slice(0, 300), isError };
    clearDiagnostic();
    status.hidden = true;
    send('page', latestPage);
    if (pageFailure) showDiagnostic(pageFailure);
    return true;
  } catch (error) {
    runtime?.dispose(); runtime = null;
    send('pagehide', {});
                                                                              
                                                                        
    if (doc) showError(error);
    return false;
  }
}

function watchDocument(previousDocument) {
  stopDocumentWatch();
  const watchGeneration = documentWatchGeneration;
  const navigation = navigationGeneration;
  const isCurrent = () => !disposed && watchGeneration === documentWatchGeneration && navigation === navigationGeneration;
  let attempts = 0;
  function ready() {
    try {
      const doc = frame.contentDocument;
      if (doc && doc !== previousDocument && doc.documentElement && frame.contentWindow.location.href !== 'about:blank') {
        if (doc.readyState !== 'loading') return connectDocument();
        if (observedDocument !== doc) {
          observedDocument?.removeEventListener('DOMContentLoaded', readyListener);
          observedDocument = doc;
          readyListener = () => { if (isCurrent() && frame.contentDocument === doc) connectDocument(); };
          doc.addEventListener('DOMContentLoaded', readyListener, { once: true });
        }
      }
    } catch {                                                                   }
    return false;
  }
  function check() {
    if (!isCurrent()) return;
    documentWatchTimer = undefined;
    if (ready() || observedDocument) return;
                                                                          
                                                                             
    if (++attempts <= 120) documentWatchTimer = setTimeout(check, attempts < 20 ? 100 : 500);
  }
  documentWatchTimer = setTimeout(check, 100);
  documentDeadlineTimer = setTimeout(() => {
    if (!isCurrent()) return;
    documentDeadlineTimer = undefined;
    if (ready()) return;
    clearTimeout(documentWatchTimer);
    documentWatchTimer = undefined;
    pageFailure = { document: frame.contentDocument, slow: true, tls: false,
      details: 'The page did not become ready within 45 seconds. Its current request has been left running.',
      endpoint: network?.activeEndpoint || latestNetwork?.activeEndpoint || null, address: lastGetAddress };
    showDiagnostic(pageFailure);
  }, 45000);
}

frame.addEventListener('load', () => {
  if (disposed || identityStarting) return;
  try { if (frame.contentWindow.location.href === 'about:blank' || new URL(frame.contentWindow.location.href).pathname === '/proxy-bootstrap.html') return; } catch {                                                        }
  connectDocument();
});

function deadline(promise, label, milliseconds = 15000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]).finally(() => clearTimeout(timer));
}

async function controlledWorker() {
  const registration = await deadline(navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }), 'Service worker registration timed out.');
  const updating = registration?.installing || registration?.waiting;
  if (updating) {
    let listener;
    await deadline(new Promise((resolve, reject) => {
      listener = () => {
        if (updating.state === 'activated') resolve();
        else if (updating.state === 'redundant') reject(new Error('The proxy worker update failed. Reload this page to try again.'));
      };
      updating.addEventListener('statechange', listener);
      listener();
    }), 'The proxy worker update timed out. Reload this page.').finally(() => updating.removeEventListener('statechange', listener));
  }
  await deadline(navigator.serviceWorker.ready, 'Service worker activation timed out.');
  const controlled = () => navigator.serviceWorker.controller && (!updating || navigator.serviceWorker.controller === updating);
  if (controlled()) return;
  let listener;
  await deadline(new Promise(resolve => {
    listener = () => { if (controlled()) resolve(); };
    navigator.serviceWorker.addEventListener('controllerchange', listener);
    listener();
  }), 'The proxy worker could not take control. Reload this page.').finally(() => navigator.serviceWorker.removeEventListener('controllerchange', listener));
}

async function prepareIdentity(force = false) {
  const userAgent = new URL(location.href).searchParams.get('ua') || '';
  if (identityReady || !force && (!userAgent || userAgent.length > 512 || !/^[\x20-\x7e]+$/.test(userAgent))) return;
  if (identityStarting) return identityStarting;
  let listener;
  let timer;
  let channel;
  let active = true;
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  identityStarting = new Promise((resolve, reject) => {
    cancelIdentity = () => reject(new Error('Browser identity setup was cancelled.'));
    timer = setTimeout(() => reject(new Error('Browser identity setup timed out. Use Try again.')), 12000);
    let binding = false;
    listener = event => {
      if (!active || !event.isTrusted || event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== 'monkeh-proxy:identity-ready' || event.data.nonce !== nonce || binding) return;
      if (event.data.failed || typeof event.data.clientId !== 'string' || event.data.clientId.length > 128) { reject(new Error('Browser identity setup failed. Use Try again.')); return; }
      binding = true;
      channel = new MessageChannel();
      channel.port1.onmessage = ({ data }) => {
        if (!active) return;
        if (data?.ok === true) { identityReady = true; resolve(); }
        else reject(new Error('Browser identity setup was rejected. Use Try again.'));
      };
      channel.port1.start();
      try { navigator.serviceWorker.controller.postMessage({ type: 'monkeh:identity:bind', clientId: event.data.clientId, nonce }, [channel.port2]); }
      catch { reject(new Error('Browser identity setup could not reach the proxy worker. Use Try again.')); }
    };
    window.addEventListener('message', listener);
    frame.src = '/proxy-bootstrap.html?nonce=' + nonce;
  }).finally(() => {
    active = false;
    clearTimeout(timer);
    window.removeEventListener('message', listener);
    channel?.port1.close();
    channel?.port2.close();
    cancelIdentity = null;
    identityStarting = null;
  });
  return identityStarting;
}

function prepareGameCode(targetUrl) {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const channel = new MessageChannel();
  const controller = navigator.serviceWorker.controller;
  let timer;
  let active = true;
  let cancel;
  return new Promise((resolve, reject) => {
    cancel = message => {
      if (!active) return;
      try { controller.postMessage({ type: 'monkeh:game:cancel', nonce }); } catch {}
      active = false;
      reject(new Error(message || 'Game loading was cancelled.'));
    };
    cancelGameCode = cancel;
    timer = setTimeout(() => cancel('Fetching game code timed out. Use Try again or switch proxy servers.'), 35000);
    channel.port1.onmessage = ({ data }) => {
      if (!active) return;
      try {
        if (data?.ok !== true) throw new Error(typeof data?.error === 'string' ? data.error.slice(0, 1000) : 'The game code could not be fetched. Use Try again.');
        const prepared = new URL(data.url);
        const canonical = new URL(data.canonicalUrl);
        if (prepared.href !== location.origin + '/__monkeh_game__/' + nonce || canonical.origin !== location.origin || !canonical.pathname.startsWith(__uv$config.prefix)) throw new Error('The proxy returned an invalid game document.');
        const target = new URL(httpUrl(__uv$config.decodeUrl(canonical.href.slice(location.origin.length + __uv$config.prefix.length))));
        if (target.origin === location.origin || config.shellOrigins.includes(target.origin)) throw new Error('App pages cannot be opened as proxy destinations.');
        active = false;
        resolve(prepared.href);
      } catch (error) { cancel(error.message); }
    };
    channel.port1.start();
    try { controller.postMessage({ type: 'monkeh:game:prepare', url: targetUrl, nonce }, [channel.port2]); }
    catch { cancel('The proxy worker could not fetch the game code. Use Try again.'); }
  }).finally(() => {
    active = false;
    clearTimeout(timer);
    channel.port1.close();
    channel.port2.close();
    if (cancelGameCode === cancel) cancelGameCode = null;
  });
}

async function start() {
  if (starting) return starting;
  starting = (async () => {
    if (!isSecureContext || !navigator.serviceWorker || !window.SharedWorker) throw new Error('Proxy browsing requires HTTPS or localhost and a browser with SharedWorker support.');
    if (network && workerConfigured && navigator.serviceWorker.controller) {
      await network.connect();
      return;
    }
    if (!config) {
      const loadedConfig = await globalThis.MonkehConfig.fetchConfig();
      if (!Array.isArray(loadedConfig.shellOrigins) || loadedConfig.proxyOrigin !== location.origin ||
          !Array.isArray(loadedConfig.wispEndpoints) || loadedConfig.wispEndpoints.length < 1 || loadedConfig.wispEndpoints.length > 32) throw new Error('The isolated proxy origin is misconfigured.');
      config = loadedConfig;
                                                                                 
      for (const origin of config.shellOrigins) window.parent.postMessage({ type: 'monkeh-proxy:ready' }, origin);
    }
    if (disposed) throw new Error('This browser view was closed.');
    if (!network) {
      if (!Array.isArray(config.wispEndpoints) || config.wispEndpoints.length < 1 || config.wispEndpoints.length > 32) throw new Error('Invalid server list.');
      const endpoints = config.wispEndpoints.map(entry => {
        const url = new URL(entry.url, location.href);
        if (url.protocol === 'http:') url.protocol = 'ws:';
        if (url.protocol === 'https:') url.protocol = 'wss:';
        return url.href;
      });
      transport = new BareMux.BareMuxConnection('/bearmux/worker.js');
      const fallbackEndpoints = endpoints.filter((_, index) => config.wispEndpoints[index].fallback === true);
      network = createProxyNetwork({ endpoints, fallbackEndpoints,
                                                                           
                                                                            
        activate: url => transport.setTransport('/bearmux/epoxy/index.mjs', [{ wisp: url }]),
        onStatus: state => { latestNetwork = state; send('network', state); }
      });
      if (navigator.onLine === false) await network.setOnline(false);
    }
                                                                         
    await Promise.all([controlledWorker().then(() => { workerConfigured = true; }), network.connect()]);
  })().finally(() => { starting = null; });
  return starting;
}

async function navigate(url = null) {
  const generation = ++navigationGeneration;
  cancelGameCode?.();
  stopDocumentWatch();
  try {
    if (disposed) return false;
    showProgress('Connecting to the fastest available proxy…');
    const targetUrl = httpUrl(url ?? requestedUrl ?? decodeURIComponent(location.hash.slice(1)));
    requestedUrl = targetUrl;
    await start();
    if (disposed || generation !== navigationGeneration) return false;
    if (config.shellOrigins.includes(new URL(targetUrl).origin) || new URL(targetUrl).origin === location.origin) throw new Error('App pages cannot be opened as proxy destinations.');
    await prepareIdentity(loadCode);
    if (disposed || generation !== navigationGeneration) return false;
    if (url !== null) window.history?.replaceState(null, '', '#' + encodeURIComponent(targetUrl));
    let frameUrl = __uv$config.prefix + __uv$config.encodeUrl(targetUrl);
    if (loadCode) {
      showProgress('Fetching game code through the proxy…');
      frameUrl = await prepareGameCode(targetUrl);
      if (disposed || generation !== navigationGeneration) return false;
    }
    const previousDocument = frame.contentDocument;
    pageFailure = null;
    lastGetAddress = targetUrl;
    frame.src = frameUrl;
    showProgress('The page is loading. You can use content as it appears.');
    watchDocument(previousDocument);
    return true;
  } catch (error) {
    if (!disposed && generation === navigationGeneration) {
      showError(error);
                                                                          
                                                                      
      if (runtime && latestPage) send('page', latestPage);
    }
    return false;
  }
}

retry.addEventListener('click', () => navigate());
document.getElementById('switch-retry').addEventListener('click', event => {
  if (event.isTrusted && pageFailure) void switchServer(pageFailure);
});
document.getElementById('dismiss-status').addEventListener('click', () => { status.hidden = true; });
window.addEventListener('hashchange', () => { requestedUrl = null; void navigate(); });
window.addEventListener('offline', () => network?.setOnline(false).catch(() => {}));
window.addEventListener('online', () => network?.setOnline(true).catch(() => {}));
window.addEventListener('pagehide', () => { disposed = true; navigationGeneration++; cancelGameCode?.(); cancelIdentity?.(); stopDocumentWatch(); runtime?.dispose(); network?.dispose(); port?.close(); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
void navigate();
