import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../math.html', import.meta.url), 'utf8');
const configSource = readFileSync(new URL('../browser-tools/config.js', import.meta.url), 'utf8');
const configResponse = config => new Response(JSON.stringify(config), { headers: { 'Content-Type': 'application/json' } });
const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(([, attributes]) => !/\bsrc\s*=/i.test(attributes))
  .map(([, , source]) => source);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

                                                                                
function createPage({ protocol = 'http:', storageUnavailable = false } = {}) {
  const elements = new Map();
  const serviceWorkerListeners = new Map();
  const ready = deferred();
  const calls = { registrations: 0, transports: [], sockets: [] };

  function makeElement() {
    const classes = new Set();
    return {
      value: '', innerHTML: '', textContent: '', src: 'about:blank', srcdoc: '', children: [],
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); }
      },
      removeAttribute(name) { this[name] = ''; },
      setAttribute(name, value) { this[name] = value; },
      getAttribute(name) { return this[name] || null; },
      appendChild(child) { this.children.push(child); },
      getContext() { return null; },
      addEventListener() {}
    };
  }

  function element(id) {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  }

  const serviceWorker = {
    controller: null,
    ready: ready.promise,
    async register() { calls.registrations++; },
    addEventListener(type, callback) { serviceWorkerListeners.set(type, callback); },
    removeEventListener(type) { serviceWorkerListeners.delete(type); }
  };
  const page = {
    MonkehUseBackendConfig: true,
    console: { log() {}, warn() {}, error() {} },
    URL, TextEncoder, TextDecoder, AbortSignal, AbortController, setTimeout, clearTimeout,
    requestAnimationFrame() {},
    localStorage: {
      getItem() {
        if (storageUnavailable) throw new Error('Storage disabled');
        return null;
      },
      setItem() {}
    },
    navigator: { serviceWorker },
    document: {
      activeElement: null,
      getElementById: element,
      createElement: makeElement,
      createDocumentFragment: makeElement,
      addEventListener() {}
    },
    location: new URL(`${protocol}//localhost:3000/math.html`),
    isSecureContext: true,
    SharedWorker: function SharedWorker() {},
    innerWidth: 100,
    innerHeight: 100,
    addEventListener() {},
    async fetch() { return configResponse({ proxyOrigin: `${protocol}//localhost:3001`, wispEndpoints: [{ name: 'Primary', url: '/wisp/' }] }); },
    createMonkehNetwork({ endpoints, activate, onStatus }) {
      let active = null;
      return {
        async connect() {
          if (!active) { await activate(endpoints[0]); active = endpoints[0]; }
          onStatus({ status: 'connected', activeEndpoint: active, configuredCount: endpoints.length });
          return active;
        },
        async setOnline() {}, dispose() {}
      };
    },
    WebSocket: class {
      constructor(url) {
        calls.sockets.push(url);
        queueMicrotask(() => this.onopen?.());
      }
      close() {}
    },
    BareMux: {
      BareMuxConnection: class {
        async setTransport(path, options) { calls.transports.push({ path, options }); }
      }
    }
  };
  page.window = page;
  vm.createContext(page);
  vm.runInContext(configSource, page, { filename: 'browser-tools/config.js' });
  for (const source of inlineScripts) vm.runInContext(source, page, { filename: 'math.html' });

  return {
    page, calls, element,
    activateWorker() { ready.resolve({ active: {} }); },
    controlPage() {
      serviceWorker.controller = {};
      serviceWorkerListeners.get('controllerchange')?.();
    }
  };
}

test('shell configuration shares concurrent initialization and never creates a shell-origin worker', async () => {
  const { page, calls } = createPage();
  const first = page.initializeNetwork();
  assert.equal(first, page.initializeNetwork());
  assert.equal(await first, true);
  assert.equal(page.MonkehProxyOrigin, 'http://localhost:3001');
  assert.equal(calls.registrations, 0);
  assert.equal(calls.transports.length, 0);
});

test('search waits for isolated origin configuration and then navigates the remote host', async () => {
  const { page, element } = createPage({ protocol: 'https:' });
  const config = deferred();
  page.fetch = () => config.promise;
  const navigation = page.openViewer('Search', 'Web', 'https://example.com/', true);
  await nextTurn();
  assert.equal(element('viewer-frame').src, 'about:blank');
  assert.equal(element('viewer-frame').srcdoc, '', 'opening a page must not insert a full-page loading document');
  assert.equal(element('viewer-progress').hidden, false);
  config.resolve(configResponse({ proxyOrigin: 'https://proxy.example.org', wispEndpoints: [{ name: 'Primary', url: '/wisp/' }] }));
  await navigation;
  assert.equal(element('viewer-frame').src, 'https://proxy.example.org/proxy-host.html#https%3A%2F%2Fexample.com%2F');
});

test('preparing a new proxy page leaves the current local app interactive until navigation is ready', async () => {
  const { page, element } = createPage();
  const prepared = [];
  page.MonkehTools = { prepareNavigation: url => prepared.push(url), expectDocument() {} };
  await page.openViewer('Auk', '', '/apps/auk.html');
  const response = deferred();
  page.fetch = () => response.promise;
  const pending = page.openViewer('Web', '', 'https://example.com/', true);
  await nextTurn();
  assert.equal(element('viewer-frame').src, 'http://localhost:3000/apps/auk.html');
  assert.equal(element('viewer-frame').srcdoc, '');
  assert.deepEqual(prepared, ['/apps/auk.html'], 'current tools stay attached during preparation');
  response.resolve(configResponse({ proxyOrigin: 'http://localhost:3001', wispEndpoints: [{ url: '/wisp/' }] }));
  await pending;
  assert.equal(element('viewer-frame').src, 'http://localhost:3001/proxy-host.html#https%3A%2F%2Fexample.com%2F');
  assert.equal(element('viewer-progress').hidden, true);
});

test('a failed or timed-out catalog request preserves the current page and offers a retry', async () => {
  const { page, element } = createPage();
  const prepared = [];
  page.MonkehTools = { prepareNavigation: url => prepared.push(url), expectDocument() {} };
  await page.openViewer('Auk', '', '/apps/auk.html');
  const request = deferred();
  page.fetch = () => request.promise;
  const pending = page.openViewer('Slow game', '', 'https://cdn.example/game.html');
  assert.equal(element('viewer-frame').src, 'http://localhost:3000/apps/auk.html');
  request.resolve({ ok: false, status: 504 });
  await pending;
  assert.equal(element('viewer-frame').src, 'http://localhost:3000/apps/auk.html');
  assert.equal(element('viewer-frame').srcdoc, '');
  assert.deepEqual(prepared, ['/apps/auk.html']);
  assert.equal(element('viewer-progress').hidden, false);
  assert.equal(element('viewer-progress-retry').hidden, false);
  assert.match(element('viewer-progress-text').textContent, /504/);
});

test('accepted warm proxy navigation preserves the outer iframe and its document', async () => {
  const { page, element } = createPage();
  const prepared = [], navigated = [];
  page.MonkehTools = {
    prepareNavigation: url => prepared.push(url), expectDocument() {},
    async navigateRemote(url) { navigated.push(url); return true; },
  };
  await page.openViewer('First', 'Web', 'https://first.example/', true);
  const frame = element('viewer-frame');
  const originalSource = frame.src;
  Object.defineProperty(frame, 'src', {
    get: () => originalSource,
    set() { throw new Error('Warm navigation must not recreate the outer iframe'); },
  });
  await page.openViewer('Next', 'Web', 'https://next.example/path', true);
  assert.deepEqual(navigated, ['https://next.example/path']);
  assert.deepEqual(prepared, ['https://first.example/']);
  assert.equal(frame.src, originalSource);
  assert.equal(frame.srcdoc, '');
  assert.equal(element('viewer-title').textContent, 'Next');
});

test('changed popup or download sandbox permissions force a cold proxy navigation', async () => {
  const { page, element } = createPage();
  let policy = 'allow-scripts allow-same-origin allow-forms allow-pointer-lock';
  page.MonkehPrivacy = { get: () => ({ httpsOnly: true }), sandbox: () => policy };
  const prepared = [];
  let reused = 0;
  page.MonkehTools = {
    prepareNavigation: url => prepared.push(url), expectDocument() {},
    async navigateRemote() { reused++; return true; },
  };
  await page.openViewer('First', '', 'https://first.example/', true);
  policy += ' allow-downloads';
  await page.openViewer('Next', '', 'https://next.example/', true);
  assert.equal(reused, 0);
  assert.deepEqual(prepared, ['https://first.example/', 'https://next.example/']);
  assert.equal(element('viewer-frame').sandbox, policy);
  assert.equal(element('viewer-frame').src, 'http://localhost:3001/proxy-host.html#https%3A%2F%2Fnext.example%2F');
});

test('stale asynchronous warm reuse cannot replace a newer local app or its retry target', async () => {
  const { page, element } = createPage();
  const result = deferred();
  let attempts = 0;
  page.MonkehTools = {
    prepareNavigation() {}, expectDocument() {},
    navigateRemote() { attempts++; return result.promise; },
  };
  await page.openViewer('First', '', 'https://first.example/', true);
  const stale = page.openViewer('Old destination', '', 'https://old.example/', true);
  await nextTurn();
  assert.equal(attempts, 1);
  await page.openViewer('Auk', '', '/apps/auk.html');
  result.resolve(false);
  await stale;
  assert.equal(element('viewer-frame').src, 'http://localhost:3000/apps/auk.html');
  assert.equal(element('viewer-frame').srcdoc, '');
  assert.equal(element('viewer-title').textContent, 'Auk');
  await page.retryViewerNavigation();
  assert.equal(element('viewer-frame').src, 'http://localhost:3000/apps/auk.html');
  assert.equal(attempts, 1);
});

test('an unavailable warm bridge falls back to a fresh isolated host', async () => {
  const { page, element } = createPage();
  let prepared = 0, attempts = 0;
  page.MonkehTools = {
    prepareNavigation() { prepared++; }, expectDocument() {},
    async navigateRemote() { attempts++; return false; },
  };
  await page.openViewer('First', '', 'https://first.example/', true);
  await page.openViewer('Next', '', 'https://next.example/', true);
  assert.equal(attempts, 1);
  assert.equal(prepared, 2);
  assert.equal(element('viewer-frame').src, 'http://localhost:3001/proxy-host.html#https%3A%2F%2Fnext.example%2F');
});

test('shell refuses a proxy configured on its own origin', async () => {
  const { page } = createPage();
  page.fetch = async () => configResponse({ proxyOrigin: 'http://localhost:3000', wispEndpoints: [{ url: '/wisp/' }] });
  assert.equal(await page.initializeNetwork(), false);
  assert.equal(page.MonkehProxyOrigin, undefined);
});

test('HTML from a missing API route shows a deployment error, blocks browsing, and can recover', async () => {
  const { page, element } = createPage();
  const workingFetch = page.fetch;
  page.fetch = async () => new Response('<!DOCTYPE html><html>App fallback</html>', { headers: { 'Content-Type': 'text/html' } });
  await page.openViewer('Search', 'Web', 'https://example.com/', true);
  assert.equal(element('viewer-frame').src, 'about:blank');
  assert.match(element('viewer-frame').srcdoc, /proxy backend is not connected/);
  assert.match(element('connection-status').innerHTML, /Proxy unavailable/);
  assert.match(element('network-detail').textContent, /api\/config/);
  assert.doesNotMatch(element('viewer-frame').srcdoc, /Unexpected token|App fallback/);
  assert.equal(page.MonkehProxyOrigin, undefined);
  page.fetch = workingFetch;
  await page.retryViewerNavigation();
  assert.equal(element('viewer-frame').src, 'http://localhost:3001/proxy-host.html#https%3A%2F%2Fexample.com%2F');
  assert.equal(element('viewer-frame').srcdoc, '');
});

test('closing and reopening the viewer prevents an old remote load from replacing a local app', async () => {
  const { page, element } = createPage();
  const pendingResponse = deferred();
  let signal;
  page.fetch = (_url, options) => {
    signal = options.signal;
                                                                               
    return pendingResponse.promise;
  };
  const oldNavigation = page.openViewer('Old game', '', 'https://example.com/old.html');
  page.closeViewer();
  assert.equal(signal.aborted, true);
  await page.openViewer('Auk', '', '/apps/auk.html');
  pendingResponse.resolve({ ok: true, text: async () => '<h1>Old content</h1>' });
  await oldNavigation;

  assert.equal(element('viewer-frame').src, 'http://localhost:3000/apps/auk.html');
  assert.equal(element('viewer-frame').srcdoc, '');
  assert.equal(element('zone-viewer').classList.contains('active'), true);
});

test('local viewer keeps the app URL so its relative assets resolve correctly', async () => {
  const { page, element } = createPage();
  page.fetch = () => { throw new Error('Local apps should use native iframe navigation'); };
  await page.openViewer('Auk', '', '/apps/auk.html');
  assert.equal(element('viewer-frame').src, 'http://localhost:3000/apps/auk.html');
  assert.equal(element('viewer-frame').srcdoc, '');
});

test('search distinguishes addresses from phrases and normalizes uppercase protocols', () => {
  const { page } = createPage();
  for (const [query, expected] of [
    ['HTTPS://EXAMPLE.COM/a?b=2#c', 'https://example.com/a?b=2#c'],
    ['example.com', 'https://example.com/'],
    ['localhost:8080/a', 'https://localhost:8080/a'],
    ['http://[::1]:8080/path', 'http://[::1]:8080/path'],
    ['  two words  ', 'https://duckduckgo.com/?q=two%20words'],
    ['javascript:alert(1)', 'https://duckduckgo.com/?q=javascript%3Aalert(1)']
  ]) assert.equal(page.getSearchUrl(query), expected);
});

test('viewer rejects script URLs and reports the error as text', async () => {
  const { page, element } = createPage();
  await page.openViewer('Invalid entry', '', 'javascript:alert(1)');
  assert.equal(element('viewer-frame').src, 'about:blank');
  assert.match(element('viewer-frame').srcdoc, /Only HTTP and HTTPS/);
});

test('blocked settings storage does not disable search or local apps', async () => {
  const { page, element } = createPage({ storageUnavailable: true });
  assert.equal(page.getSearchUrl('example.com'), 'https://example.com/');
  await page.openViewer('Auk', '', '/apps/auk.html');
  assert.equal(element('viewer-frame').src, 'http://localhost:3000/apps/auk.html');
});

test('Auk is available from the local catalog before remote requests complete', async () => {
  const { page } = createPage();
  const remoteCatalog = deferred();
  page.fetch = () => remoteCatalog.promise;
  page.openAppsPopover();
  assert.ok(page.rawApps.some(app => app.name === 'Auk' && app.url === '/apps/auk.html'));
  remoteCatalog.resolve({ ok: true, text: async () => '[]' });
  await nextTurn();
  assert.equal(page.appsLoaded, true);
});

test('catalog input is bounded and malformed records are ignored', () => {
  const { page } = createPage();
  assert.equal(page.catalogEntries('invalid').length, 0);
  assert.equal(page.catalogEntries([null, [], 'bad', { name: 'x'.repeat(1000) }]).length, 1);
  assert.equal(page.catalogEntries([{ name: 'x'.repeat(1000) }])[0].name.length, 200);
  assert.equal(page.catalogEntries(Array.from({ length: 10001 }, () => ({}))).length, 10000);
});

test('remote downloads enforce declared and streamed size limits and cancel oversized streams', async () => {
  const { page } = createPage();
  await assert.rejects(page.readResponseText({ headers: { get: () => '1000' } }, 100), /size limit/);
  let cancelled = false;
  let released = false;
  const response = { body: { getReader: () => ({
    read: async () => ({ done: false, value: new Uint8Array(101) }),
    cancel: async () => { cancelled = true; }, releaseLock() { released = true; }
  }) } };
  await assert.rejects(page.readResponseText(response, 100), /size limit/);
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

test('viewer rejects untrusted local navigation and credential-bearing URLs', async () => {
  const { page, element } = createPage();
  await page.openViewer('Invalid', '', '/math.html');
  assert.match(element('viewer-frame').srcdoc, /trusted app list/);
  await page.openViewer('Invalid', '', 'https://user:password@example.com/');
  assert.match(element('viewer-frame').srcdoc, /login details/);
  await page.openViewer('Invalid', '', 'http://localhost:3000/math.html', true);
  assert.match(element('viewer-frame').srcdoc, /App pages cannot be opened/);
});

test('Mochii Cloud is available offline from the app catalog and opens as a local app', async () => {
  const { page, element } = createPage({ storageUnavailable: true });
  const remoteCatalog = deferred();
  page.fetch = () => remoteCatalog.promise;
  page.openAppsPopover();
  assert.ok(page.rawApps.some(app => app.name === 'Mochii Cloud' && app.url === '/apps/mochii-cloud.html'));
  await page.openViewer('Mochii Cloud', '', '/apps/mochii-cloud.html');
  assert.equal(element('viewer-frame').src, 'http://localhost:3000/apps/mochii-cloud.html');
  assert.equal(element('viewer-frame').sandbox, '');
  remoteCatalog.resolve({ ok: true, text: async () => '[]' });
  await nextTurn();
});

test('external catalog HTML runs in an opaque sandbox and a local app clears that sandbox', async () => {
  const { page, element } = createPage();
  page.fetch = async () => ({ ok: true, url: 'https://cdn.example/game.html', text: async () => '<script>parent.attack()</script>' });
  page.DOMParser = class {
    parseFromString(source) {
      return { querySelector: () => null, createElement: () => ({ getAttribute: () => null }),
        head: { prepend() {} }, documentElement: { outerHTML: source } };
    }
  };
  await page.openViewer('Game', '', 'https://cdn.example/game.html');
  const frame = element('viewer-frame');
  assert.match(frame.sandbox, /allow-scripts/);
  assert.doesNotMatch(frame.sandbox, /allow-same-origin|allow-top-navigation/);
  await page.openViewer('Auk', '', '/apps/auk.html');
  assert.equal(frame.sandbox, '');
});

test('retry reloads a catalog srcdoc from its original URL and retains its isolation', async () => {
  const { page, element } = createPage();
  const requests = [];
  page.fetch = async url => {
    requests.push(url);
    return { ok: true, url, text: async () => `<h1>Game load ${requests.length}</h1>` };
  };
  page.DOMParser = class {
    parseFromString(source) {
      return { querySelector: () => null, createElement: () => ({ getAttribute: () => null }),
        head: { prepend() {} }, documentElement: { outerHTML: source } };
    }
  };
  await page.openViewer('Game', 'Author', 'https://cdn.example/game.html');
  assert.match(element('viewer-frame').srcdoc, /Game load 1/);
  await page.retryViewerNavigation();
  assert.deepEqual(requests, ['https://cdn.example/game.html', 'https://cdn.example/game.html']);
  assert.match(element('viewer-frame').srcdoc, /Game load 2/);
  assert.doesNotMatch(element('viewer-frame').sandbox, /allow-same-origin|allow-top-navigation/);
  assert.equal(element('viewer-title').textContent, 'Game');
  assert.equal(element('viewer-author').textContent, 'by Author');
  page.closeViewer();
  await page.retryViewerNavigation();
  assert.equal(requests.length, 2, 'closing clears the saved retry target');
  assert.equal(element('zone-viewer').classList.contains('active'), false);
});
