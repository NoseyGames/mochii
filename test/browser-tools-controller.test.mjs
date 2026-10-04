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
      style: { values: new Map(), setProperty(name, value) { this.values.set(name, value); } },
      classList: { contains: name => classes.has(name), toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
      addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
      removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
      async fire(type, detail = {}) {
        const event = { target: this, preventDefault() {}, ...detail };
        await Promise.all([...listeners.get(type) || []].map(listener => listener(event)));
        await flush();
      },
      setAttribute(name, value) { attrs.set(name, value); },
      removeAttribute(name) { attrs.delete(name); },
      getAttribute: name => attrs.get(name) ?? null,
      hasAttribute: name => attrs.has(name),
      append(...children) {
        for (const child of children) {
          if (child.isFragment) { this.append(...child.children.slice()); continue; }
          child.remove(); child.parentNode = this; this.children.push(child);
        }
      },
      replaceChildren(...children) {
        for (const child of this.children) child.parentNode = null;
        this.children = []; this.append(...children);
      },
      remove() {
        if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
        this.parentNode = null;
      },
      getBoundingClientRect() { return { height: 370, width: parseFloat(this.style.values.get('--tools-width')) || 420 }; },
      scrollIntoView(options) { this.scrolled = options; },
      setPointerCapture() {},
      focus() {},
    };
    allNodes.push(result);
    return result;
  }
  const ids = new Map();
  const get = id => { if (!ids.has(id)) ids.set(id, node()); return ids.get(id); };
  const tabs = ['console', 'inspector', 'scripts'].map(name => ({ ...node(), dataset: { toolTab: name } }));
  const document = {
    getElementById: get, createElement: node, createDocumentFragment: () => Object.assign(node(), { isFragment: true }),
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
      getChildren: item => item.children || [], stopPicking() {}, async startPicking() {},
      async refreshTree() { this.refreshes = (this.refreshes || 0) + 1; this.document.documentElement ||= node(); },
      async reload() { this.reloaded = true; }, async reconnect() { this.reconnected = true; },
      async switchServer() { this.switched = (this.switched || 0) + 1; return true; },
      async describe(item) { return item.info || { tag: item.localName, selector: item.id || item.localName, attributes: [], styles: [], text: 'Original', rect: { width: 10, height: 20 }, canDelete: true, canUndo: false }; },
      async navigate(url) { this.navigated = url; return true; },
    };
    sessions.push(session);
    return session;
  }
  get('console-level').value = 'all';
  vm.runInNewContext(source, {
    document, window, location, innerWidth: 1280, innerHeight: 900, URL, Date, Event,
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
      if (details.withoutTree) session.document.documentElement = null;
      session.callbacks.onPage({ url, title: details.title || 'Example', isError: details.title === 'Error' });
      await flush();
    }
    return pageDocument;
  }
  function text(item) { return item.textContent + item.children.map(text).join(' '); }
  return {
    window, get, connect, sessions, storage, confirmations, node,
    tab: name => tabs.find(tab => tab.dataset.toolTab === name),
    createdNodes: () => allNodes.length,
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

test('toolbar server switching changes only the transport and leaves the viewed page untouched', async () => {
  const app = harness();
  assert.equal(app.get('browser-switch-server').disabled, true);
  await app.connect('https://example.com/checkout');
  assert.equal(app.get('browser-switch-server').disabled, false);
  const source = app.get('viewer-frame').src;
  await app.get('browser-switch-server').fire('click');
  assert.equal(app.sessions[0].switched, 1);
  assert.equal(app.sessions[0].reloaded, undefined);
  assert.equal(app.sessions[0].navigated, undefined);
  assert.equal(app.get('viewer-frame').src, source);
  assert.equal(app.get('browser-switch-server').disabled, false);
  assert.match(app.text('console-output'), /form submissions were not repeated/);
});

test('toolbar server switching coalesces clicks while an alternative is connecting', async () => {
  const app = harness();
  await app.connect('https://example.com/');
  let finish;
  let attempts = 0;
  app.sessions[0].switchServer = () => { attempts++; return new Promise(resolve => { finish = resolve; }); };
  const first = app.get('browser-switch-server').fire('click');
  await app.get('browser-switch-server').fire('click');
  assert.equal(attempts, 1);
  finish(true); await first;
  assert.equal(app.get('browser-switch-server').disabled, false);
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

test('reload delegates srcdoc games and error placeholders to the shell retry navigation', async () => {
  const app = harness();
  let retries = 0;
  app.window.retryViewerNavigation = async () => { retries++; };
  app.window.MonkehTools.prepareNavigation('https://cdn.example/game.html');
  const frame = app.get('viewer-frame');
  frame.srcdoc = '<h1>Game or error placeholder</h1>';
  Object.defineProperty(frame, 'src', {
    get: () => 'about:blank',
    set() { throw new Error('Reassigning src cannot reload a srcdoc document'); },
  });
  await app.get('browser-reload').fire('click');
  assert.equal(retries, 1);
  assert.doesNotMatch(app.text('console-output'), /Reassigning src/);
});

test('warm navigation reuses a connected proxy host and falls back when no valid bridge exists', async () => {
  const app = harness();
  assert.equal(await app.window.MonkehTools.navigateRemote('https://next.example/'), false);
  await app.connect('https://example.com/');
  const originalSource = app.get('viewer-frame').src;
  assert.equal(await app.window.MonkehTools.navigateRemote('https://next.example/path'), true);
  assert.equal(app.sessions[0].navigated, 'https://next.example/path');
  assert.equal(app.sessions.length, 1);
  assert.equal(app.sessions[0].disposed, false);
  assert.equal(app.get('viewer-frame').src, originalSource);
  assert.equal(app.get('browser-url').value, 'https://next.example/path');
  assert.equal(await app.window.MonkehTools.navigateRemote('https://monkeh.test/math.html'), false);
  assert.equal(await app.window.MonkehTools.navigateRemote('https://proxy.monkeh.test/math.html'), false);
  assert.equal(await app.window.MonkehTools.navigateRemote('javascript:bad()'), false);
  app.window.MonkehTools.closeViewer();
  assert.equal(await app.window.MonkehTools.navigateRemote('https://later.example/'), false);
});

test('a late warm navigation response cannot overwrite a newer destination or closed viewer', async () => {
  const app = harness();
  await app.connect('https://example.com/');
  let finish;
  app.sessions[0].navigate = () => new Promise(resolve => { finish = resolve; });
  const first = app.window.MonkehTools.navigateRemote('https://first.example/');
  app.sessions[0].navigate = async () => true;
  assert.equal(await app.window.MonkehTools.navigateRemote('https://latest.example/'), true);
  finish(true);
  assert.equal(await first, false);
  assert.equal(app.get('browser-url').value, 'https://latest.example/');
  app.sessions[0].navigate = () => new Promise(resolve => { finish = resolve; });
  const pending = app.window.MonkehTools.navigateRemote('https://closed.example/');
  app.window.MonkehTools.closeViewer(); finish(true);
  assert.equal(await pending, false);
});

test('reload recreates the host when popup or download permissions changed', async () => {
  const app = harness();
  await app.connect('https://example.com/');
  let coldReloads = 0;
  app.window.retryViewerNavigation = async () => { coldReloads++; };
  app.window.MonkehPrivacy = { sandbox: () => 'allow-scripts allow-same-origin allow-downloads' };
  app.get('viewer-frame').setAttribute('sandbox', 'allow-scripts allow-same-origin');
  await app.get('browser-reload').fire('click');
  assert.equal(coldReloads, 1);
  assert.equal(app.sessions[0].reloaded, undefined);
  app.get('viewer-frame').setAttribute('sandbox', app.window.MonkehPrivacy.sandbox(true));
  await app.get('browser-reload').fire('click');
  assert.equal(app.sessions[0].reloaded, true);
  assert.equal(coldReloads, 1);
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

test('picking reveals the selected DOM row, expands its ancestors and opens Inspect', async () => {
  const app = harness();
  await app.connect('https://example.com/');
  const session = app.sessions[0];
  let parent = session.document.documentElement;
  for (let depth = 0; depth < 6; depth++) {
    const child = app.node();
    child.localName = depth === 5 ? 'button' : 'section';
    child.remoteId = `node-${depth}`;
    child.id = depth === 5 ? 'picked-button' : '';
    parent.children.push(child);
    parent = child;
  }
  session.callbacks.onSelect(parent);
  await flush();
  const rows = [];
  function visit(item, hidden = false) {
    hidden ||= item.hidden;
    if (item.getAttribute?.('aria-selected') === 'true') rows.push({ item, hidden });
    for (const child of item.children) visit(child, hidden);
  }
  visit(app.get('inspector-tree'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hidden, false);
  assert.match(rows[0].item.textContent, /picked-button/);
  assert.equal(rows[0].item.scrolled.block, 'nearest');
  assert.equal(rows[0].item.classList.contains('bt-tree-selected'), true);
  assert.equal(app.get('inspector-tree').getAttribute('aria-activedescendant'), rows[0].item.id);
  assert.equal(app.get('tool-inspector').hidden, false);
  assert.equal(app.get('tool-console').hidden, true);
  assert.equal(app.get('browser-tools').hidden, false);
  await app.get('tools-close').fire('click');
  assert.equal(app.get('browser-tools').hidden, true);
});

test('inspector text, attribute, delete and undo buttons edit only the selected remote node', async () => {
  const app = harness();
  await app.connect('https://example.com/');
  const session = app.sessions[0];
  const selected = app.node(); selected.localName = 'p'; selected.remoteId = 'selected';
  session.document.documentElement.children.push(selected);
  const edits = [];
  session.editNode = async (node, change) => {
    assert.equal(node, selected);
    edits.push(change.kind);
    node.info = { ...(await session.describe(node)), text: change.value || 'Changed', canUndo: true };
    return node;
  };
  session.undo = async () => { edits.push('undo'); selected.info.canUndo = false; return selected; };
  session.callbacks.onSelect(selected);
  await flush();
  app.get('inspector-text').value = 'Updated paragraph';
  await app.get('inspector-text-form').fire('submit');
  assert.equal(app.get('inspector-text').value, 'Updated paragraph');
  assert.equal(app.get('inspector-undo').disabled, false);
  app.get('inspector-attribute-name').value = 'data-label';
  app.get('inspector-attribute-value').value = 'Changed';
  await app.get('inspector-attribute-form').fire('submit');
  await app.get('inspector-attribute-remove').fire('click');
  await app.get('inspector-delete').fire('click');
  assert.match(app.get('inspector-edit-status').textContent, /deleted/);
  await app.get('inspector-undo').fire('click');
  assert.deepEqual(edits, ['text', 'attribute', 'removeAttribute', 'delete', 'undo']);
  assert.equal(app.get('inspector-undo').disabled, true);
  assert.match(app.get('inspector-edit-status').textContent, /undone/);
});

test('right dock width resizes horizontally by drag and keyboard and releases pointer cleanup', async () => {
  const app = harness();
  const handle = app.get('tools-resize');
  const panel = app.get('browser-tools');
  assert.equal(panel.style.values.get('--tools-width'), '420px');
  assert.equal(handle.getAttribute('aria-orientation'), 'vertical');
  await handle.fire('pointerdown', { button: 0, clientX: 900, pointerId: 1 });
  assert.equal(app.get('viewer-frame').style.pointerEvents, 'none');
  await handle.fire('pointermove', { clientX: 820 });
  assert.equal(panel.style.values.get('--tools-width'), '500px');
  await handle.fire('pointercancel');
  assert.equal(app.get('viewer-frame').style.pointerEvents, '');
  await handle.fire('keydown', { key: 'ArrowLeft' });
  assert.equal(panel.style.values.get('--tools-width'), '524px');
  await handle.fire('keydown', { key: 'ArrowRight' });
  assert.equal(panel.style.values.get('--tools-width'), '500px');
});

test('closing clears console logs by default and honors the explicit retain preference', async () => {
  const app = harness();
  await app.connect('https://example.com/');
  app.sessions[0].callbacks.onConsole({ level: 'log', args: ['private log'] });
  app.get('console-input').value = 'private command';
  app.window.MonkehTools.closeViewer();
  assert.doesNotMatch(app.text('console-output'), /private log/);
  assert.equal(app.get('console-input').value, '');
  await app.connect('https://example.com/');
  app.window.MonkehPrivacy = { get: () => ({ clearConsoleOnClose: false }) };
  app.sessions.at(-1).callbacks.onConsole({ level: 'log', args: ['retained log'] });
  app.window.MonkehTools.closeViewer();
  await app.get('browser-tools-toggle').fire('click');
  assert.match(app.text('console-output'), /retained log/);
  app.window.MonkehTools.clearConsole();
  assert.doesNotMatch(app.text('console-output'), /retained log/);
});

test('hidden console captures only the newest 500 messages without scheduling or rendering rows', async () => {
  const app = harness();
  await app.get('tools-close').fire('click');
  await app.connect('https://example.com/');
  const scheduled = [];
  app.window.requestAnimationFrame = callback => scheduled.push(callback);
  const initialNodes = app.createdNodes();
  for (let index = 0; index < 600; index++) {
    app.sessions[0].callbacks.onConsole({ level: 'log', args: [`captured-${index}`] });
  }
  assert.equal(scheduled.length, 0);
  assert.equal(app.createdNodes(), initialNodes);
  assert.doesNotMatch(app.text('console-output'), /captured-/);
  await app.get('browser-tools-toggle').fire('click');
  assert.equal(app.get('console-output').children.length, 500);
  assert.doesNotMatch(app.text('console-output'), /captured-99\b/);
  assert.match(app.text('console-output'), /captured-100\b/);
  assert.match(app.text('console-output'), /captured-599\b/);

  await app.tab('scripts').fire('click');
  const scriptTabNodes = app.createdNodes();
  app.sessions[0].callbacks.onConsole({ level: 'error', args: ['captured-in-another-tab'] });
  assert.equal(app.createdNodes(), scriptTabNodes);
  assert.equal(scheduled.length, 0);
  await app.tab('console').fire('click');
  assert.match(app.text('console-output'), /captured-in-another-tab/);
  assert.equal(app.get('console-output').children.length, 500);
});

test('visible console appends rows, retains existing row identity and scroll position, and updates filters', async () => {
  const app = harness();
  await app.connect('https://example.com/');
  app.window.MonkehTools.clearConsole();
  const output = app.get('console-output');
  output.scrollHeight = 1000; output.clientHeight = 100; output.scrollTop = 30;
  const log = (text, level = 'log') => app.sessions[0].callbacks.onConsole({ level, args: [text] });
  log('first');
  const firstRow = output.children[0];
  log('second', 'error');
  const secondRow = output.children[1];
  assert.equal(output.children[0], firstRow, 'new messages must not recreate existing rows');
  assert.equal(output.scrollTop, 30, 'reading older messages must not jump to the bottom');
  for (let index = 0; index < 499; index++) log(`later-${index}`);
  assert.equal(output.children.length, 500);
  assert.equal(output.children[0], secondRow, 'trimming removes only the expired row');
  assert.equal(firstRow.parentNode, null);

  app.get('console-level').value = 'error';
  await app.get('console-level').fire('change');
  assert.equal(output.children.length, 1);
  assert.match(app.text('console-output'), /second/);
  app.get('console-filter').value = 'missing';
  await app.get('console-filter').fire('input');
  assert.match(app.text('console-output'), /No messages match/);
  app.get('console-level').value = 'all';
  app.get('console-filter').value = 'LATER-498';
  await app.get('console-filter').fire('input');
  assert.match(app.text('console-output'), /later-498/);
  assert.equal(output.children.length, 1);
});

test('a queued console frame stays dormant after closing and privacy clear cannot resurrect logs', async () => {
  const app = harness();
  await app.connect('https://example.com/');
  app.window.MonkehTools.clearConsole();
  const scheduled = [];
  app.window.requestAnimationFrame = callback => scheduled.push(callback);
  app.sessions[0].callbacks.onConsole({ level: 'log', args: ['private pending message'] });
  assert.equal(scheduled.length, 1);
  await app.get('tools-close').fire('click');
  const initialNodes = app.createdNodes();
  scheduled.shift()();
  assert.equal(app.createdNodes(), initialNodes);
  app.window.MonkehTools.clearConsole();
  await app.get('browser-tools-toggle').fire('click');
  assert.doesNotMatch(app.text('console-output'), /private pending message/);
});

test('inspector loads an omitted tree only on demand, including navigation with Inspect already open', async () => {
  const app = harness();
  await app.get('tools-close').fire('click');
  await app.connect('https://example.com/', null, { withoutTree: true });
  const session = app.sessions[0];
  assert.equal(session.refreshes, undefined);
  await app.get('browser-tools-toggle').fire('click');
  assert.equal(session.refreshes, undefined, 'opening Console must not ask the page for a DOM snapshot');
  await app.tab('inspector').fire('click');
  assert.equal(session.refreshes, 1);
  assert.match(app.text('inspector-tree'), /html/);

  session.document.documentElement = null;
  session.callbacks.onPage({ url: 'https://example.com/next', title: 'Next' });
  await flush();
  assert.equal(session.refreshes, 2, 'the selected inspector must fetch the new page tree');
  await app.get('tools-close').fire('click');
  session.document.documentElement = null;
  session.callbacks.onPage({ url: 'https://example.com/last', title: 'Last' });
  await flush();
  assert.equal(session.refreshes, 2, 'a hidden inspector must defer navigation snapshots');
  await app.get('browser-tools-toggle').fire('click');
  assert.equal(session.refreshes, 3);
});

test('inspector coalesces pending snapshots and skips rendering when the user leaves Inspect', async () => {
  const app = harness();
  await app.connect('https://example.com/', null, { withoutTree: true });
  const session = app.sessions[0];
  let finish;
  let requests = 0;
  session.refreshTree = () => {
    requests++;
    return new Promise(resolve => { finish = () => { session.document.documentElement = app.node(); resolve(); }; });
  };
  await app.tab('inspector').fire('click');
  await app.tab('inspector').fire('click');
  assert.equal(requests, 1);
  await app.tab('scripts').fire('click');
  const priorTree = app.get('inspector-tree').children[0];
  finish();
  await flush();
  assert.equal(app.get('inspector-tree').children[0], priorTree);
  await app.tab('inspector').fire('click');
  assert.equal(requests, 1, 'a completed snapshot can render when Inspect returns');
  assert.match(app.text('inspector-tree'), /html/);
});
