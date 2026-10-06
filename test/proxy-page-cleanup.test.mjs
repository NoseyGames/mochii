import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const worker = vm.createContext({ __uv$config: {}, importScripts() {}, UVServiceWorker: class {}, addEventListener() {} });
worker.self = worker;
vm.runInContext(source, worker, { filename: 'sw.js' });
assert.equal(typeof worker.proxyPageCleanup, 'function');
const injectedSource = `(${worker.proxyPageCleanup.toString()})();`;
const controllerKey = Symbol.for('monkeh.pageCleanup');

function style() {
  const properties = new Map();
  const writes = [];
  return {
    writes,
    getPropertyValue(name) { return properties.get(name)?.value || ''; },
    getPropertyPriority(name) { return properties.get(name)?.priority || ''; },
    setProperty(name, value, priority = '') {
      writes.push({ name, value, priority });
      properties.set(name, { value, priority });
    }
  };
}

function documentFixture({ body = true, root = true } = {}) {
  const elements = [];
  const frames = [];
  const queries = [];
  const doc = {
    nodeType: 9,
    body: body ? { style: style() } : null,
    documentElement: root ? { style: style() } : null,
    defaultView: null,
    querySelectorAll(selector) {
      queries.push(selector);
      const normalized = selector.replace(/\s+/g, '');
      if (normalized === 'iframe,frame') return [...frames];
      assert.equal(normalized, '[id^="securly"],[class^="securly"],#securly-overlay,.securly-ui-container');
      return elements.filter(element => !element.removed && (
        element.id.startsWith('securly') || element.className.startsWith('securly') ||
        element.id === 'securly-overlay' || element.className.split(/\s+/).includes('securly-ui-container')
      ));
    }
  };
  function addElement({ id = '', className = '' } = {}) {
    const element = { id, className, removed: false, remove() { this.removed = true; } };
    elements.push(element);
    return element;
  }
  function addFrame(childDoc) {
    const frame = { contentDocument: childDoc, contentWindow: childDoc?.defaultView || { document: childDoc } };
    frames.push(frame);
    return frame;
  }
  return { doc, elements, frames, queries, addElement, addFrame };
}

function page(doc = documentFixture().doc) {
  const intervals = new Map();
  const listeners = new Map();
  let nextTimer = 0;
  const win = {
    document: doc,
    setInterval(callback, delay) { const id = ++nextTimer; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); }
  };
  win.window = win;
  doc.defaultView = win;
  const context = vm.createContext(win);
  return {
    win, intervals, listeners,
    get controller() { return win[controllerKey]; },
    inject() { vm.runInContext(injectedSource, context, { filename: 'injected-page-cleanup.js' }); },
    tick() { for (const { callback } of [...intervals.values()]) callback(); },
    emit(type, event = {}) { for (const listener of [...listeners.get(type) || []]) listener({ type, ...event }); },
    replaceDocument(next) { win.document = next; next.defaultView = win; }
  };
}

function expectLayout(doc) {
  for (const [target, properties] of [[doc.body, { overflow: 'auto', position: 'static' }], [doc.documentElement, { overflow: 'auto' }]]) {
    if (!target) continue;
    for (const [name, value] of Object.entries(properties)) {
      assert.equal(target.style.getPropertyValue(name), value);
      assert.equal(target.style.getPropertyPriority(name), 'important');
    }
  }
}

test('injected cleanup removes the requested matches immediately and preserves unrelated elements', () => {
  const doc = documentFixture();
  const matches = [
    doc.addElement({ id: 'securly-overlay' }),
    doc.addElement({ id: 'securly-policy' }),
    doc.addElement({ className: 'securly-banner active' }),
    doc.addElement({ className: 'overlay securly-ui-container active' })
  ];
  const unrelated = [
    doc.addElement({ id: 'other-securly-overlay' }),
    doc.addElement({ className: 'app securly-banner' }),
    doc.addElement({ className: 'security-banner' })
  ];
  const app = page(doc.doc);
  app.inject();
  assert(matches.every(element => element.removed));
  assert(unrelated.every(element => !element.removed));
  expectLayout(doc.doc);
  assert.equal(app.controller.document, doc.doc);
  assert.equal(app.controller.active, true);
  assert.equal(app.intervals.size, 1);
  assert.equal([...app.intervals.values()][0].delay, 500);
  const later = doc.addElement({ id: 'securly-later' });
  assert.equal(later.removed, false);
  app.tick();
  assert.equal(later.removed, true);
});

test('layout is restored without overlay matches and unchanged styles are not rewritten each tick', () => {
  const doc = documentFixture();
  doc.doc.body.style.setProperty('overflow', 'hidden', 'important');
  doc.doc.body.style.setProperty('position', 'static');
  const app = page(doc.doc);
  app.inject();
  expectLayout(doc.doc);
  const writes = [doc.doc.body.style.writes.length, doc.doc.documentElement.style.writes.length];
  app.tick(); app.tick();
  assert.deepEqual([doc.doc.body.style.writes.length, doc.doc.documentElement.style.writes.length], writes);
  doc.doc.body.style.setProperty('overflow', 'hidden', 'important');
  app.tick();
  expectLayout(doc.doc);
  assert.equal(doc.doc.body.style.writes.length, writes[0] + 2);
  assert.equal(doc.doc.documentElement.style.writes.length, writes[1]);
});

test('cleanup tolerates a missing body and applies to the body when parsing creates it', () => {
  const doc = documentFixture({ body: false });
  const app = page(doc.doc);
  app.inject();
  expectLayout(doc.doc);
  doc.doc.body = { style: style() };
  app.tick();
  expectLayout(doc.doc);
  const empty = documentFixture({ body: false, root: false });
  const next = page(empty.doc);
  assert.doesNotThrow(() => next.inject());
  assert.equal(next.intervals.size, 1);
  empty.doc.documentElement = { style: style() };
  empty.doc.body = { style: style() };
  next.tick();
  expectLayout(empty.doc);
});

test('accessible frames are cleaned recursively while blocked or malformed frames do not stop siblings', () => {
  const outer = documentFixture();
  const child = documentFixture();
  const nested = documentFixture();
  const childOverlay = child.addElement({ id: 'securly-child' });
  const nestedOverlay = nested.addElement({ className: 'securly-ui-container' });
  outer.frames.push(Object.defineProperty({}, 'contentDocument', { get() { throw new Error('Blocked by same-origin policy'); } }));
  outer.frames.push({ contentDocument: null, contentWindow: Object.defineProperty({}, 'document', { get() { throw new Error('Opaque sandbox document'); } }) });
  outer.frames.push({ contentDocument: null, contentWindow: null });
  outer.frames.push({ contentDocument: {} });
  outer.frames.push({ contentDocument: null, contentWindow: { document: child.doc } });
  child.addFrame(nested.doc);
  const app = page(outer.doc);
  assert.doesNotThrow(() => app.inject());
  assert.equal(childOverlay.removed, true);
  assert.equal(nestedOverlay.removed, true);
  expectLayout(child.doc);
  expectLayout(nested.doc);
});

test('frame discovery follows dynamic insertion and replacement without retaining detached documents', () => {
  const outer = documentFixture();
  const app = page(outer.doc);
  app.inject();
  const first = documentFixture();
  const firstOverlay = first.addElement({ id: 'securly-first' });
  const frame = outer.addFrame(first.doc);
  app.tick();
  assert.equal(firstOverlay.removed, true);
  const detachedOverlay = first.addElement({ id: 'securly-detached' });
  const second = documentFixture();
  const secondOverlay = second.addElement({ id: 'securly-second' });
  frame.contentDocument = second.doc;
  frame.contentWindow = { document: second.doc };
  app.tick();
  assert.equal(secondOverlay.removed, true);
  assert.equal(detachedOverlay.removed, false);
  outer.frames.length = 0;
  const removedFrameOverlay = second.addElement({ id: 'securly-removed-frame' });
  app.tick();
  assert.equal(removedFrameOverlay.removed, false);
});

test('a traversal visits a document once even when frame references repeat or form a cycle', () => {
  const outer = documentFixture();
  const child = documentFixture();
  outer.addFrame(child.doc);
  outer.addFrame(child.doc);
  child.addFrame(outer.doc);
  const app = page(outer.doc);
  app.inject();
  assert.equal(outer.queries.length, 2);
  assert.equal(child.queries.length, 2);
  app.tick();
  assert.equal(outer.queries.length, 4);
  assert.equal(child.queries.length, 4);
});

test('a child with its own active controller is not scanned twice by its parent', () => {
  const outer = documentFixture();
  const child = documentFixture();
  const childApp = page(child.doc);
  childApp.inject();
  outer.addFrame(child.doc);
  const overlay = child.addElement({ id: 'securly-owned-child' });
  const queries = child.queries.length;
  const app = page(outer.doc);
  app.inject(); app.tick();
  assert.equal(child.queries.length, queries);
  assert.equal(overlay.removed, false);
  childApp.tick();
  assert.equal(overlay.removed, true);
  childApp.emit('pagehide', { persisted: true });
  const pausedOverlay = child.addElement({ id: 'securly-paused-child' });
  app.tick();
  assert.equal(pausedOverlay.removed, true);
});

test('reinjection reuses the current document controller and replaces an old document controller', () => {
  const original = documentFixture();
  const app = page(original.doc);
  app.inject();
  const firstController = app.controller;
  app.inject(); app.inject();
  assert.equal(app.controller, firstController);
  assert.equal(app.intervals.size, 1);
  assert.equal(app.listeners.get('pagehide').size, 1);
  assert.equal(app.listeners.get('pageshow').size, 1);
  const oldOverlay = original.addElement({ id: 'securly-old-document' });
  const replacement = documentFixture();
  const newOverlay = replacement.addElement({ id: 'securly-new-document' });
  app.replaceDocument(replacement.doc);
  app.inject();
  assert.notEqual(app.controller, firstController);
  assert.equal(firstController.active, false);
  assert.equal(app.controller.document, replacement.doc);
  assert.equal(newOverlay.removed, true);
  assert.equal(oldOverlay.removed, false);
  assert.equal(app.intervals.size, 1);
  assert.equal(app.listeners.get('pagehide').size, 1);
  assert.equal(app.listeners.get('pageshow').size, 1);
});

test('back-forward cache suspension stops work and resumes with one timer', () => {
  const doc = documentFixture();
  const app = page(doc.doc);
  app.inject();
  const controller = app.controller;
  app.emit('pagehide', { persisted: true });
  assert.equal(controller.active, false);
  assert.equal(app.intervals.size, 0);
  const overlay = doc.addElement({ id: 'securly-after-restore' });
  app.tick();
  assert.equal(overlay.removed, false);
  app.emit('pageshow', { persisted: true });
  assert.equal(controller.active, true);
  assert.equal(overlay.removed, true);
  assert.equal(app.intervals.size, 1);
  app.emit('pageshow', { persisted: true });
  assert.equal(app.intervals.size, 1);
});

test('a timer stops after its window changes documents even before reinjection occurs', () => {
  const original = documentFixture();
  const app = page(original.doc);
  app.inject();
  const controller = app.controller;
  const overlay = original.addElement({ id: 'securly-abandoned' });
  const replacement = documentFixture();
  app.replaceDocument(replacement.doc);
  app.tick();
  assert.equal(controller.active, false);
  assert.equal(app.intervals.size, 0);
  assert.equal(overlay.removed, false);
  assert.equal(replacement.queries.length, 0);
  app.inject();
  assert.equal(app.controller.document, replacement.doc);
  assert.equal(app.intervals.size, 1);
  expectLayout(replacement.doc);
});

test('final pagehide and explicit disposal release timers and lifecycle listeners permanently', () => {
  for (const close of [app => app.emit('pagehide', { persisted: false }), app => app.controller.dispose()]) {
    const doc = documentFixture();
    const app = page(doc.doc);
    app.inject();
    const controller = app.controller;
    close(app);
    assert.equal(controller.active, false);
    assert.equal(app.intervals.size, 0);
    assert.equal(app.listeners.get('pagehide')?.size || 0, 0);
    assert.equal(app.listeners.get('pageshow')?.size || 0, 0);
    const overlay = doc.addElement({ id: 'securly-after-close' });
    app.emit('pageshow', { persisted: true });
    controller.start();
    app.tick();
    assert.equal(overlay.removed, false);
    assert.equal(app.intervals.size, 0);
    controller.dispose();
    assert.equal(app.intervals.size, 0);
  }
});
