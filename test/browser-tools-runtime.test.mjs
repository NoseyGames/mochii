import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { attachRuntime, formatValue } from '../browser-tools/runtime.js';

class EventHub {
  listeners = new Map();
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  dispatch(type, details = {}) {
    const event = {
      prevented: false, stopped: false,
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
      ...details,
    };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    return event;
  }
}

function environment() {
  const page = new EventHub();
  const document = new EventHub();
  const originals = {};
  const nativeCalls = [];
  page.console = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'clear', 'assert', 'table']) {
    originals[level] = page.console[level] = function (...args) {
      assert.equal(this, page.console, 'native console receiver is preserved');
      nativeCalls.push({ level, args });
    };
  }
  function element(tag = 'div', text = '') {
    const styles = new Map();
    let ownText = text;
    const node = {
      nodeType: 1, ownerDocument: document, localName: tag, tagName: tag.toUpperCase(),
      id: '', parentElement: null, children: [], attributes: [],
      get parentNode() { return this.parentElement; },
      get childNodes() { return this.children; },
      get nextSibling() { const siblings = this.parentElement?.children || []; return siblings[siblings.indexOf(this) + 1] || null; },
      get textContent() { return ownText + this.children.map(child => child.textContent).join(''); },
      set textContent(value) { ownText = value; this.replaceChildren(); },
      outerHTML: `<${tag}>${text}</${tag}>`,
      style: {
        setProperty(name, value, priority = '') { styles.set(name, { value, priority }); },
        removeProperty(name) { styles.delete(name); },
        getPropertyValue(name) { return styles.get(name)?.value || ''; },
        getPropertyPriority(name) { return styles.get(name)?.priority || ''; },
        *[Symbol.iterator]() { yield* styles.keys(); },
      },
      setAttribute(name, value) { this.removeAttribute(name); this.attributes.push({ name, value }); },
      getAttribute(name) { return this.attributes.find(attribute => attribute.name === name)?.value ?? null; },
      removeAttribute(name) { this.attributes = this.attributes.filter(attribute => attribute.name !== name); },
      appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
      replaceChildren(...children) {
        for (const child of this.children) child.parentElement = null;
        this.children = [];
        if (children.length) ownText = '';
        children.forEach(child => this.appendChild(child));
      },
      insertBefore(child, next) {
        const index = this.children.indexOf(next);
        if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
        child.parentElement = this;
      },
      remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = null;
      },
      getBoundingClientRect() { return { left: 10, top: 20, width: 150, height: 40 }; },
    };
    return node;
  }
  document.documentElement = element('html');
  document.body = document.documentElement.appendChild(element('body'));
  document.createElement = tag => element(tag);
  document.elementFromPoint = () => document.hit || document.body;
  page.document = document;
  page.getComputedStyle = node => ({ getPropertyValue: name => node.style.getPropertyValue(name) || (name === 'display' ? 'block' : '') });
  page.CSS = { supports: (property, value) => property.startsWith('--') || (['color', 'font-size'].includes(property) && value !== 'invalid') };
  const context = vm.createContext(page);
  page.eval = source => vm.runInContext(source, context);
  return { page, document, element, originals, nativeCalls };
}

test('formatValue handles cycles, BigInts, errors and the length limit without running getters', () => {
  let getterCalls = 0;
  const value = { count: 12n };
  Object.defineProperty(value, 'trap', { enumerable: true, get() { getterCalls++; throw new Error('Should never execute'); } });
  value.self = value;
  assert.match(formatValue(value), /count: 12n/);
  assert.match(formatValue(value), /trap: \[Getter\]/);
  assert.match(formatValue(value), /self: \[Circular\]/);
  assert.equal(getterCalls, 0);
  assert.equal(formatValue(new Error('Useful message')), 'Error: Useful message');
  assert.equal(formatValue(-0), '-0');
  assert.ok(formatValue({ text: 'A'.repeat(10000) }).length <= 5000);
  assert.ok(formatValue('A'.repeat(10000)).length <= 5000);
  assert.equal(formatValue(new Proxy({}, { ownKeys() { throw new Error('No access'); } })), '[Uninspectable object]');
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.doesNotThrow(() => formatValue(revoked.proxy));
});

test('console capture preserves native calls and restores only its own wrappers', () => {
  const { page, originals, nativeCalls } = environment();
  const events = [];
  const runtime = attachRuntime(page, { onConsole: event => events.push(event) });
  const logged = { example: true };
  page.console.log('hello', logged);
  page.console.assert(true, 'silent');
  page.console.assert(false, 'failure');
  page.console.clear();
  assert.deepEqual(events.map(event => event.level), ['log', 'error', 'clear']);
  assert.equal(events[0].args[1], logged);
  assert.ok(Number.isFinite(events[0].time));
  assert.deepEqual(events[1].args, ['Assertion failed:', 'failure']);
  assert.equal(nativeCalls.length, 4);
  const replacement = () => {};
  page.console.warn = replacement;
  runtime.dispose();
  assert.equal(page.console.log, originals.log);
  assert.equal(page.console.warn, replacement, 'do not undo subsequent page edits');
  page.console.log('after dispose');
  assert.equal(events.length, 3);
});

test('capture reports browser errors and promise rejections without cancelling them', () => {
  const { page } = environment();
  const events = [];
  const runtime = attachRuntime(page, { onConsole: event => events.push(event) });
  const error = new Error('boom');
  assert.equal(page.dispatch('error', { error }).prevented, false);
  assert.equal(page.dispatch('unhandledrejection', { reason: 'rejected' }).prevented, false);
  assert.equal(events[0].args[0], error);
  assert.deepEqual(events[1].args, ['Uncaught (in promise)', 'rejected']);
  runtime.dispose();
  page.dispatch('error', { error });
  assert.equal(events.length, 2);
});

test('inspector edits attributes and text, and undo restores original child nodes', () => {
  const { page, document, element } = environment();
  const target = document.body.appendChild(element('section'));
  const child = target.appendChild(element('button', 'Original'));
  child.clickHandler = () => 'still alive';
  const runtime = attachRuntime(page);
  runtime.editNode(target, { kind: 'attribute', name: 'data-label', value: 'Changed' });
  assert.equal(target.getAttribute('data-label'), 'Changed');
  runtime.editNode(target, { kind: 'text', value: '<strong>Literal text</strong>' });
  assert.equal(target.textContent, '<strong>Literal text</strong>');
  assert.equal(target.children.length, 0, 'text editing never parses HTML');
  assert.equal(runtime.describe(target).canUndo, true);
  assert.equal(runtime.undo(), target);
  assert.equal(target.children[0], child, 'undo restores node identity and event handlers');
  assert.equal(child.clickHandler(), 'still alive');
  runtime.editNode(target, { kind: 'removeAttribute', name: 'data-label' });
  assert.equal(target.getAttribute('data-label'), null);
  runtime.undo();
  assert.equal(target.getAttribute('data-label'), 'Changed');
  runtime.undo();
  assert.equal(target.getAttribute('data-label'), null);
  assert.equal(runtime.describe(target).canUndo, false);
  runtime.dispose();
});

test('inspector delete selects its parent and undo restores the element at its previous position', () => {
  const { page, document, element } = environment();
  const first = document.body.appendChild(element('p', 'First'));
  const removed = document.body.appendChild(element('p', 'Second'));
  const last = document.body.appendChild(element('p', 'Third'));
  const runtime = attachRuntime(page);
  assert.equal(runtime.editNode(removed, { kind: 'delete' }), document.body);
  assert.deepEqual(document.body.children, [first, last]);
  assert.equal(runtime.undo(), removed);
  assert.deepEqual(document.body.children, [first, removed, last]);
  assert.throws(() => runtime.editNode(document.documentElement, { kind: 'delete' }), /root/);
  runtime.dispose();
});

test('inspector edits are bounded, reject foreign nodes, and retain at most twenty undo actions', () => {
  const { page, document, element } = environment();
  const target = document.body.appendChild(element('p'));
  const runtime = attachRuntime(page);
  assert.throws(() => runtime.editNode({ ...target, ownerDocument: {} }, { kind: 'delete' }), /current page/);
  assert.throws(() => runtime.editNode(target, { kind: 'attribute', name: 'bad name', value: 'x' }), /attribute name/);
  assert.throws(() => runtime.editNode(target, { kind: 'text', value: 'x'.repeat(10001) }), /10,000/);
  assert.throws(() => runtime.editNode(target, { kind: 'outerHTML', value: '<script>bad</script>' }), /Unsupported/);
  for (let index = 0; index < 25; index++) runtime.editNode(target, { kind: 'attribute', name: 'data-count', value: String(index) });
  for (let index = 0; index < 20; index++) runtime.undo();
  assert.equal(target.getAttribute('data-count'), '4');
  assert.throws(() => runtime.undo(), /no inspector edits/);
  target.children = Array.from({ length: 1000 }, () => element('i'));
  assert.throws(() => runtime.editNode(target, { kind: 'delete' }), /too large/);
  runtime.dispose();
  assert.throws(() => runtime.editNode(target, { kind: 'text', value: 'later' }), /page has changed/);
});

test('a broken or reentrant console renderer cannot break normal page logging', () => {
  const { page, nativeCalls } = environment();
  const runtime = attachRuntime(page, { onConsole() { page.console.log('renderer'); throw new Error('render failure'); } });
  assert.doesNotThrow(() => page.console.log('page'));
  assert.equal(nativeCalls.length, 2);
  runtime.dispose();
});

test('console evaluates in the page context and resolves promises; $0 follows selection and is restored', async () => {
  const { page, document, element } = environment();
  Object.defineProperty(page, '$0', { configurable: true, enumerable: true, writable: true, value: 'previous' });
  page.pageValue = 7;
  const selections = [];
  const runtime = attachRuntime(page, { onSelect: node => selections.push(node) });
  assert.equal(await runtime.evaluate('pageValue * 6'), 42);
  assert.equal(await runtime.evaluate('Promise.resolve(pageValue + 1)'), 8);
  const node = document.body.appendChild(element('button'));
  runtime.select(node);
  assert.equal(await runtime.evaluate('$0'), node);
  assert.deepEqual(selections, [node]);
  await assert.rejects(runtime.evaluate('throw new Error("bad expression")'), /bad expression/);
  runtime.dispose();
  assert.equal(page.$0, 'previous');
  assert.equal(Object.getOwnPropertyDescriptor(page, '$0').enumerable, true);
  await assert.rejects(runtime.evaluate('1'), /page has changed/);
});

test('picker overlay does not intercept pointers and selection suppresses the picked click only', () => {
  const { page, document, element } = environment();
  const selections = [];
  let pickEnds = 0;
  const runtime = attachRuntime(page, {
    onSelect: node => selections.push(node),
    onPickEnd: () => { pickEnds++; runtime.stopPicking(); },
  });
  const link = document.body.appendChild(element('a', 'Open this'));
  document.hit = link;
  runtime.startPicking();
  runtime.startPicking();
  const overlay = document.documentElement.children.at(-1);
  assert.equal(overlay.style.getPropertyValue('pointer-events'), 'none');
  assert.equal(runtime.getChildren(document.documentElement).includes(overlay), false);
  document.dispatch('pointermove', { target: link, clientX: 20, clientY: 30 });
  assert.equal(overlay.style.getPropertyValue('left'), '10px');
  assert.equal(overlay.style.getPropertyValue('width'), '150px');
  const picked = document.dispatch('click', { target: link, clientX: 20, clientY: 30 });
  assert.equal(picked.prevented, true);
  assert.equal(picked.stopped, true);
  assert.deepEqual(selections, [link]);
  assert.equal(pickEnds, 1, 'a picked click notifies the toolbar once, even when its callback stops picking again');
  assert.equal(document.documentElement.children.includes(overlay), false);
  assert.equal(document.dispatch('click', { target: link }).prevented, false);
  runtime.startPicking();
  assert.equal(document.dispatch('keydown', { key: 'Escape' }).prevented, true);
  assert.equal(pickEnds, 2, 'Escape within the inspected frame notifies the parent toolbar');
  assert.equal(document.documentElement.children.length, 1);
  runtime.dispose();
  assert.equal(pickEnds, 2, 'stopping an already stopped picker does not notify again');
});

test('inspector describes current elements, bounds output and validates CSS edits', () => {
  const { page, document, element } = environment();
  const runtime = attachRuntime(page);
  const node = document.body.appendChild(element('p', 'A'.repeat(10000)));
  node.id = 'title:main';
  node.setAttribute('title', 'A'.repeat(10000));
  runtime.setStyle(node, 'color', 'red !important');
  assert.equal(node.style.getPropertyValue('color'), 'red');
  assert.equal(node.style.getPropertyPriority('color'), 'important');
  const details = runtime.describe(node);
  assert.equal(details.tag, 'p');
  assert.equal(details.selector, '#title\\3a main');
  assert.deepEqual(details.rect, { width: 150, height: 40 });
  assert.ok(details.text.length <= 5000);
  assert.ok(details.html.length <= 5000);
  assert.ok(details.attributes[0].value.length <= 5000);
  assert.equal(details.styles.find(style => style.name === 'color').value, 'red');
  assert.throws(() => runtime.setStyle(node, 'color', 'invalid'), /does not support/);
  assert.throws(() => runtime.setStyle(node, 'color; background', 'red'), /valid CSS property/);
  runtime.setStyle(node, 'color', '');
  assert.equal(node.style.getPropertyValue('color'), '');
  runtime.setStyle(node, '--accent', '#123');
  assert.equal(node.style.getPropertyValue('--accent'), '#123');
  assert.throws(() => runtime.describe(environment().element()), /current page/);
  for (let count = 0; count < 300; count++) node.appendChild(element('span'));
  assert.equal(runtime.getChildren(node).length, 250);
  runtime.dispose();
});

test('document replacement retires listeners, console capture and selection exactly once', async () => {
  const { page, document, originals } = environment();
  let navigations = 0;
  const runtime = attachRuntime(page, { onNavigate: () => { navigations++; } });
  runtime.startPicking();
  page.document = environment().document;
  await assert.rejects(runtime.evaluate('1'), /page has changed/);
  assert.equal(navigations, 1);
  assert.equal(page.console.log, originals.log);
  assert.equal(document.documentElement.children.length, 1);
  assert.equal('$0' in page, false);
  page.dispatch('pagehide');
  assert.equal(navigations, 1);
  runtime.dispose();
});

test('pagehide releases the runtime, and inaccessible documents produce a helpful error', async () => {
  const { page } = environment();
  let navigations = 0;
  const runtime = attachRuntime(page, { onNavigate: () => { navigations++; } });
  page.dispatch('pagehide');
  assert.equal(navigations, 1);
  await assert.rejects(runtime.evaluate('1'), /page has changed/);
  assert.throws(() => attachRuntime({ get document() { throw new Error('Denied'); } }), /Reload it through the Monkeh browser/);
});

test('cleanup tolerates a WindowProxy becoming inaccessible after a cross-origin navigation', async () => {
  const { page, originals } = environment();
  let navigations = 0;
  const runtime = attachRuntime(page, { onNavigate: () => { navigations++; } });
  Object.defineProperty(page, 'document', { get() { throw new Error('Blocked by same-origin policy'); } });
  Object.defineProperty(page, 'removeEventListener', { get() { throw new Error('Blocked by same-origin policy'); } });
  await assert.rejects(runtime.evaluate('1'), /page has changed/);
  assert.equal(navigations, 1);
  assert.equal(page.console.log, originals.log);
  assert.doesNotThrow(() => runtime.dispose());
});
