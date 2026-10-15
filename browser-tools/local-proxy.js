import { createProxyNetwork } from './proxy-network.js';

const clients = new WeakMap();

function bounded(promise, message, timeout) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); })]).finally(() => clearTimeout(timer));
}

function script(doc, path, timeout) {
  return new Promise((resolve, reject) => {
    const node = doc.createElement('script');
    const finish = error => {
      clearTimeout(timer);
      node.onload = node.onerror = null;
      if (error) { node.remove(); reject(error); } else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Loading the local proxy runtime timed out.')), timeout);
    node.src = path;
    node.async = true;
    node.onload = () => finish();
    node.onerror = () => finish(new Error('The local proxy runtime could not load. Reload this page to retry.'));
    doc.head.append(node);
  });
}

export async function controlLocalWorker(win, timeout = 12000) {
  const service = win.navigator.serviceWorker;
  const registration = await bounded(service.register('/sw.js', { scope: '/', updateViaCache: 'none' }), 'Starting the local proxy worker timed out.', timeout);
  if (registration?.update && !registration.installing && !registration.waiting) await bounded(registration.update(), 'The local proxy worker update check timed out. Reload this page.', timeout);
  const updating = registration?.installing || registration?.waiting || (registration?.active !== service.controller ? registration?.active : null);
  if (updating) {
    let listener;
    await bounded(new Promise((resolve, reject) => {
      listener = () => {
        if (updating.state === 'activated') resolve();
        else if (updating.state === 'redundant') reject(new Error('The local proxy worker could not activate. Reload this page to retry.'));
      };
      updating.addEventListener('statechange', listener);
      listener();
    }), 'The local proxy worker update timed out.', timeout).finally(() => updating.removeEventListener('statechange', listener));
  }
  await bounded(service.ready, 'The local proxy worker did not become ready.', timeout);
  const controlled = () => service.controller && (!updating || service.controller === updating);
  if (controlled()) return;
  let listener;
  await bounded(new Promise(resolve => {
    listener = () => { if (controlled()) resolve(); };
    service.addEventListener('controllerchange', listener);
    listener();
  }), 'The local proxy worker could not take control. Reload this page to retry.', timeout).finally(() => service.removeEventListener('controllerchange', listener));
}

export function createLocalProxy({ win = window, doc = win.document, createNetwork = createProxyNetwork, loadScript = script, timeout = 12000, startupTimeout = 25000 } = {}) {
  let starting;
  let connecting;
  let transport;
  let ready = false;
  const loadRuntime = async () => {
    await Promise.all([
      win.BareMux?.BareMuxConnection ? null : loadScript(doc, '/bearmux/index.js?v=2.1.9', timeout),
      win.Ultraviolet ? null : loadScript(doc, '/ultrav/uv.bundle.js', timeout),
    ]);
    if (!win.__uv$config) await loadScript(doc, '/ultrav/uv.config.js', timeout);
    if (typeof win.BareMux?.BareMuxConnection !== 'function' || typeof win.__uv$config?.encodeUrl !== 'function' || win.__uv$config.prefix !== '/service/') throw new Error('The local proxy runtime is incomplete. Reload this page to retry.');
  };
  const initializeTransport = async config => {
    transport ||= new win.BareMux.BareMuxConnection('/bearmux/worker.js');
    const currentTransport = () => bounded(transport.getTransport(), 'The shared proxy connection did not respond.', timeout);
    const initialize = async () => {
      if (await currentTransport()) return;
      if (!Array.isArray(config?.wispEndpoints) || !config.wispEndpoints.length || config.wispEndpoints.length > 32) throw new Error('No supported Wisp servers are configured.');
      const endpoints = config.wispEndpoints.map(entry => {
        const url = new URL(entry.url, win.location.href);
        if (url.protocol === 'http:') url.protocol = 'ws:';
        if (url.protocol === 'https:') url.protocol = 'wss:';
        return url.href;
      });
      const network = createNetwork({
        endpoints,
        fallbackEndpoints: endpoints.filter((_, index) => config.wispEndpoints[index].fallback === true),
        online: win.navigator.onLine !== false,
        activate: async url => {
          if (await currentTransport()) return;
          await transport.setTransport('/bearmux/epoxy/index.mjs?v=2.1.28', [{ wisp: url }]);
        },
      });
      try { await network.connect(); }
      finally { network.dispose(); }
    };
    if (!win.navigator.locks?.request) return initialize();
    const controller = new AbortController();
    const error = new Error('Another proxy connection is still starting. Wait briefly or reload this page.');
    const timer = setTimeout(() => controller.abort(error), timeout);
    try {
      await win.navigator.locks.request('mochii-local-proxy-transport', { signal: controller.signal }, async () => {
        clearTimeout(timer);
        if (controller.signal.aborted) throw error;
        await initialize();
      });
    } catch (failure) { throw controller.signal.aborted ? error : failure; }
    finally { clearTimeout(timer); }
  };
  const connect = config => connecting ||= initializeTransport(config).finally(() => { connecting = null; });
  const waitForStart = () => bounded(starting, 'The proxy connection is still starting. Wait briefly or reload this page.', startupTimeout);
  const ensure = config => {
    if (starting) return waitForStart();
    if (!win.isSecureContext || !win.navigator?.serviceWorker || !win.SharedWorker) return Promise.reject(new Error('Music proxying requires HTTPS or localhost and a browser with SharedWorker support.'));
    if (ready && win.navigator.serviceWorker.controller) return Promise.resolve();
    starting = Promise.all([controlLocalWorker(win, timeout), loadRuntime().then(() => connect(config))]).then(() => { ready = true; }).finally(() => { starting = null; });
    return waitForStart();
  };
  return Object.freeze({
    ensure,
    async url(value, config) {
      const target = new URL(value);
      if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.href.length > 8192 || target.origin === win.location.origin) throw new Error('Invalid proxy destination.');
      await ensure(config);
      return new URL(win.__uv$config.prefix + win.__uv$config.encodeUrl(target.href), win.location.origin).href;
    },
  });
}

export function localProxyFor(win = window) {
  if (!clients.has(win)) clients.set(win, createLocalProxy({ win }));
  return clients.get(win);
}
