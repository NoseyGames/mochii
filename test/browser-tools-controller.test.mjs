import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createUserscriptStore, matchesUrl, USERSCRIPTS_STORAGE_KEY } from '../browser-tools/userscripts.js';
import { formatValue } from '../browser-tools/runtime.js';

const source = (await readFile(new URL('../browser-tools/tools.js', import.meta.url), 'utf8')).replace(/^import .+;\r?\n/gm, '');
const flush = () => new Promise(resolve => setImmediate(resolve));

// Minimal host only: controller behavior is real, while runtime and browser DOM
// operations are substituted. Runtime evaluation/cleanup have separate tests.
function harness(saved = []) {
  const allNodes = [];
  function node() {
    const listeners = new Map();
    const attrs = new Map();
    const classes = new Set();
    const result = {
      children: [], dataset: {}, hidden: false, value: '', checked: false, textContent: '',
      className: '', localName: 'html', scrollHeight: 0, scrollTop: 0, clientHeight: 0,
      style: { setProperty() {} },
      classList: { contains: name => classes.has(name), toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
      addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
      removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
      async fire(type, detail = {}) {
        const event = { target: this, preventDefault() {}, ...detail };
        await Promise.all([...listeners.get(type) || []].map(listener => listener(event)));
        await flush();
      },
      setAttribute(name, value) { attrs.set(name, value); },
      getAttribute: name => attrs.get(name) ?? null,
      hasAttribute: name => attrs.has(name),
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      getBoundingClientRect: () => ({ height: 370 }),
      focus() {},
    };
    allNodes.push(result);
    return result;
  }
  const ids = new Map();
  const get = id => { if (!ids.has(id)) ids.set(id, node()); return ids.get(id); };
  const tabs = ['console', 'inspector', 'scripts'].map(name => ({ ...node(), dataset: { toolTab: name } }));
  const document = {
    getElementById: get, createElement: node, createDocumentFragment: node,
    querySelectorAll: selector => selector === '[data-tool-tab]' ? tabs : allNodes.filter(item => item.className === 'bt-tree-node'),
  };
  let storageValue = JSON.stringify(saved);
  let failWrites = false;
  const storage = {
    getItem: key => key === USERSCRIPTS_STORAGE_KEY ? storageValue : null,
    setItem(key, value) { if (failWrites) throw new Error('Storage is full'); storageValue = value; },
  };
  const location = new URL('https://monkeh.test/math.html');
  const window = node();
  window.localStorage = storage;
  window.MonkehProxyOrigin = 'https://proxy.monkeh.test';
  const sessions = [];
  const confirmations = [];
  let confirmResult = true;
  function createRemoteRuntime(_frame, _origin, callbacks) {
    const session = {
      document: { documentElement: node() }, callbacks, evaluated: [], disposed: false, isRemote: true, hasHandshake: false,
      evaluate(code) { this.evaluated.push(code); return this.result; },
      dispose() { this.disposed = true; },
      getChildren: () => [], stopPicking() {}, async startPicking() {}, async refreshTree() {}, async reload() { this.reloaded = true; }, async reconnect() { this.reconnected = true; },
    };
    sessions.push(session);
    return session;
  }
  get('console-level').value = 'all';
  vm.runInNewContext(source, {
    document, window, location, innerHeight: 900, URL, Date, Event,
    createRemoteRuntime, formatValue, createUserscriptStore, matchesUrl,
    confirm(message) { confirmations.push(message); return confirmResult; },
  }, { filename: 'browser-tools/tools.js' });
  async function connect(url, existingDocument = null, details = {}) {
    const proxied = `https://proxy.monkeh.test/proxy-host.html#${encodeURIComponent(url)}`;
    const pageDocument = existingDocument || { documentElement: node(), ...details };
    get('viewer-frame').src = proxied;
    get('viewer-frame').contentWindow = { get document() { throw new Error('Cross-origin DOM reads are forbidden'); } };
    window.MonkehTools.expectDocument(url, true);
    await get('viewer-frame').fire('load');
    if (!existingDocument && sessions.length) {
      const session = sessions[sessions.length - 1];
      session.hasHandshake = true;
      session.callbacks.onPage({ url, title: details.title || 'Example', isError: details.title === 'Error' });
      await flush();
    }
    return pageDocument;
  }
  function text(item) { return item.textContent + item.children.map(text).join(' '); }
  return {
    window, get, connect, sessions, storage, confirmations,
    text: id => text(get(id)),
    blockWrites() { failWrites = true; },
    rejectDiscard() { confirmResult = false; },
  };
}

const script = (extra = {}) => ({ id: 'example-script', name: 'Example', match: '*://*.example.com/*', code: 'window.scriptRuns++;', enabled: true, ...extra });

test('proxy error documents remain inspectable without disclosing automatic userscripts', async () => {
  const app = harness([script()]);
  await app.connect('https://example.com/', null, {
    title: 'Error',
    getElementById(id) {
      if (id === 'errorTitle') return { textContent: 'Error processing your request' };
      if (id === 'errorTrace') return {};
      return null;
    },
  });
  assert.equal(app.sessions.length, 1);
  assert.equal(app.sessions[0].evaluated.length, 0);
  assert.match(app.text('console-output'), /Automatic userscripts are paused/);
});

test('isolated page metadata never causes automatic disclosure of stored userscripts', async () => {
  const app = harness([script(), script({ id: 'disabled', enabled: false }), script({ id: 'other-host', match: 'https://other.test/*' })]);
  app.window.MonkehTools.prepareNavigation('https://example.com/', true);
  const firstDocument = await app.connect('https://example.com/');
  assert.equal(app.sessions.length, 1);
  assert.equal(app.sessions[0].evaluated.length, 0);
  assert.equal(app.get('browser-url').value, 'https://example.com/');
  assert.equal(app.get('tools-connection').dataset.connected, 'true');
  await app.connect('https://example.com/', firstDocument);
  assert.equal(app.sessions.length, 1, 'a duplicate load event does not reattach or rerun');
  app.sessions[0].callbacks.onNavigate();
  assert.equal(app.get('console-input').disabled, true);
  await app.connect('https://example.com/');
  assert.equal(app.sessions.length, 1, 'navigation within the host keeps its channel');
  assert.equal(app.sessions[0].evaluated.length, 0, 'even a matching new document cannot obtain script code');
  await app.get('userscript-run').fire('click');
  assert.equal(app.sessions[0].evaluated.length, 1, 'the user may explicitly run the selected script');
});

test('controller retires stale console results and callbacks during navigation', async () => {
  const app = harness();
  app.window.MonkehTools.prepareNavigation('https://example.com/', true);
  await app.connect('https://example.com/');
  let finish;
  app.sessions[0].result = new Promise(resolve => { finish = resolve; });
  app.get('console-input').value = 'pendingResult()';
  const submission = app.get('console-form').fire('submit');
  app.window.MonkehTools.prepareNavigation('https://other.test/', true);
  await app.connect('https://other.test/');
  finish('STALE RESULT');
  await submission;
  app.sessions[0].callbacks.onConsole({ level: 'error', args: ['STALE LOG'] });
  assert.doesNotMatch(app.text('console-output'), /STALE RESULT|STALE LOG/);
  app.sessions[1].callbacks.onConsole({ level: 'log', args: ['CURRENT LOG'] });
  assert.match(app.text('console-output'), /CURRENT LOG/);
});

test('controller keeps unsaved edits after a storage error and honors discard cancellation', async () => {
  const app = harness([script({ enabled: false })]);
  app.get('userscript-code').value = 'console.log("keep this draft")';
  await app.get('userscript-code').fire('input');
  app.blockWrites();
  await app.get('userscript-save').fire('click');
  assert.match(app.get('userscript-status').textContent, /Unable to save/);
  assert.equal(app.get('userscript-status').dataset.error, 'true');
  assert.equal(createUserscriptStore(app.storage).list()[0].code, 'window.scriptRuns++;');
  app.rejectDiscard();
  await app.get('userscript-new').fire('click');
  assert.equal(app.confirmations.length, 1);
  assert.equal(app.get('userscript-code').value, 'console.log("keep this draft")');
  assert.equal(app.get('userscript-name').value, 'Example');
});

test('closing the viewer disconnects tools and ignores subsequent iframe loads', async () => {
  const app = harness([script()]);
  app.window.MonkehTools.prepareNavigation('https://example.com/', true);
  await app.connect('https://example.com/');
  app.window.MonkehTools.closeViewer();
  assert.equal(app.sessions[0].disposed, true);
  assert.equal(app.get('browser-tools').hidden, true);
  assert.equal(app.get('userscript-run').disabled, true);
  await app.get('viewer-frame').fire('load');
  assert.equal(app.sessions.length, 1);
});

test('local app and shell documents never receive tools or wildcard autoruns', async () => {
  const app = harness([script({ match: '*' })]);
  for (const pathname of ['/', '/index.html', '/math.html', '/history.html', '/browser-tools/tools.js', '/apps/auk.html']) {
    const url = `https://monkeh.test${pathname}`;
    app.window.MonkehTools.prepareNavigation(url, true);
    app.get('viewer-frame').src = url;
    app.window.MonkehTools.expectDocument(url);
    await app.get('viewer-frame').fire('load');
    assert.equal(app.sessions.length, 0, `must not attach or evaluate inside ${pathname}`);
    assert.equal(app.get('tools-connection').textContent, 'Local app · tools paused');
    assert.equal(app.get('userscript-run').disabled, true);
    assert.equal(app.get('console-input').disabled, true);
  }
  await app.connect('https://example.com/math.html');
  assert.equal(app.sessions.length, 1, 'the same filename at another destination is not the app shell');
  assert.equal(app.sessions[0].evaluated.length, 0);
});

test('spoofed host-ready messages cannot establish or replace an isolated tools channel', async () => {
  const app = harness();
  app.window.MonkehTools.prepareNavigation('https://example.com/');
  app.window.MonkehTools.expectDocument('https://example.com/');
  const viewer = app.get('viewer-frame');
  viewer.src = 'https://proxy.monkeh.test/proxy-host.html#https%3A%2F%2Fexample.com';
  viewer.contentWindow = {};
  const ready = { type: 'monkeh-proxy:ready' };
  await app.window.fire('message', { source: viewer.contentWindow, origin: 'https://evil.test', data: ready });
  await app.window.fire('message', { source: {}, origin: 'https://proxy.monkeh.test', data: ready });
  assert.equal(app.sessions.length, 0);
  await app.window.fire('message', { source: viewer.contentWindow, origin: 'https://proxy.monkeh.test', data: ready });
  assert.equal(app.sessions.length, 1);
  app.sessions[0].hasHandshake = true;
  await app.window.fire('message', { source: viewer.contentWindow, origin: 'https://proxy.monkeh.test', data: ready });
  assert.equal(app.sessions.length, 1, 'an established channel ignores redundant ready events');
});

test('reload uses the proxy RPC without accessing a cross-origin Location object', async () => {
  const app = harness();
  app.window.MonkehTools.prepareNavigation('https://example.com/');
  await app.connect('https://example.com/');
  await app.get('browser-reload').fire('click');
  assert.equal(app.sessions[0].reloaded, true);
});

test('the network retry action reaches the isolated host through the narrow reconnect method', async () => {
  const app = harness();
  app.window.MonkehTools.prepareNavigation('https://example.com/');
  await app.connect('https://example.com/');
  assert.equal(await app.window.MonkehTools.reconnect(), true);
  assert.equal(app.sessions[0].reconnected, true);
});

test('runtime picker completion resets the button and permits starting again on one click', async () => {
  const app = harness();
  app.window.MonkehTools.prepareNavigation('https://example.com/', true);
  await app.connect('https://example.com/');
  const picker = app.get('inspector-pick');
  await picker.fire('click');
  assert.equal(picker.getAttribute('aria-pressed'), 'true');
  assert.match(picker.textContent, /Esc to cancel/);
  app.sessions[0].callbacks.onPickEnd();
  assert.equal(picker.getAttribute('aria-pressed'), 'false');
  assert.equal(picker.textContent, 'Pick element');
  await picker.fire('click');
  assert.equal(picker.getAttribute('aria-pressed'), 'true');
});
