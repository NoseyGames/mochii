import test from 'node:test';
import assert from 'node:assert/strict';
import { createDisplayMasker, maskCharacters, readDisplayText } from '../browser-tools/display-text.js';

function fixture() {
  let observer;
  let mutations = 0;
  class Node {
    constructor(type, value = '') { this.nodeType = type; this.tagName = type === 1 ? value : ''; this._data = type === 3 ? value : ''; this.childNodes = []; this.parentNode = null; this.attributes = new Map(); }
    get data() { return this._data; }
    set data(value) { this._data = value; notify({ type: 'characterData', target: this }); }
    get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
    get isConnected() { return this === doc || Boolean(this.parentNode?.isConnected); }
    get lastChild() { return this.childNodes.at(-1); }
    get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map(node => node.textContent).join(''); }
    set textContent(value) { if (this.nodeType === 3) { this.data = value; return; } for (const child of [...this.childNodes]) child.remove(); if (value) this.append(new Node(3, value)); }
    get className() { return this.attributes.get('class') || ''; }
    set className(value) { this.setAttribute('class', value); }
    get id() { return this.attributes.get('id') || ''; }
    set id(value) { this.setAttribute('id', value); }
    setAttribute(key, value) { this.attributes.set(key, value); notify({ type: 'attributes', target: this }); }
    hasAttribute(key) { return this.attributes.has(key); }
    removeAttribute(key) { this.attributes.delete(key); notify({ type: 'attributes', target: this }); }
    append(...nodes) { for (const node of nodes) { node.remove(); this.childNodes.push(node); node.parentNode = this; notify({ type: 'childList', target: this, addedNodes: [node], removedNodes: [] }); } }
    remove() { if (!this.parentNode) return; const parent = this.parentNode; parent.childNodes.splice(parent.childNodes.indexOf(this), 1); this.parentNode = null; notify({ type: 'childList', target: parent, addedNodes: [], removedNodes: [this] }); }
    replaceWith(node) { const parent = this.parentNode; const index = parent.childNodes.indexOf(this); node.remove(); parent.childNodes[index] = node; node.parentNode = parent; this.parentNode = null; notify({ type: 'childList', target: parent, addedNodes: [node], removedNodes: [this] }); }
    matches(selector) { return selector.split(',').some(part => { const s = part.trim(); return s.startsWith('[') ? this.hasAttribute(s.slice(1, -1)) : s.startsWith('.') ? this.className.split(' ').includes(s.slice(1)) : s.startsWith('#') ? this.id === s.slice(1) : this.tagName === s; }); }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
    querySelectorAll(selector) { return this.childNodes.flatMap(node => node.nodeType === 1 ? [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)] : []); }
    contains(node) { return node === this || this.childNodes.some(child => child.contains(node)); }
  }
  const doc = new Node(9);
  doc.createElement = tag => new Node(1, tag);
  doc.createTextNode = text => new Node(3, text);
  doc.getElementById = id => doc.querySelectorAll('#' + id)[0];
  doc.head = doc.createElement('head'); doc.body = doc.createElement('body'); doc.append(doc.head, doc.body);
  doc.defaultView = { MutationObserver: class {
    constructor(callback) { this.callback = callback; this.pending = []; observer = this; }
    observe(root) { this.root = root; }
    disconnect() { this.root = null; this.pending = []; }
  } };
  function notify(record) { if (observer?.root?.contains(record.target)) { observer.pending.push(record); mutations++; } }
  const element = (tag, text, parent = doc.body) => { const node = doc.createElement(tag); node.textContent = text; parent.append(node); return node; };
  return { doc, element, get mutations() { return mutations; }, async settle() { const changes = observer.pending; observer.pending = []; if (changes.length) observer.callback(changes); await Promise.resolve(); assert.equal(observer.pending.length, 0, 'own writes must not create an observer loop'); } };
}

test('masking preserves controls, accessible originals and exact reversible source text', () => {
  const f = fixture(); const button = f.element('button', 'Games and apps'); const original = button.childNodes[0];
  button.focused = true;
  const controller = createDisplayMasker(f.doc); controller.setEnabled(true);
  assert.equal(button.childNodes.length, 1);
  const wrapper = button.childNodes[0];
  assert.equal(wrapper.childNodes[0].textContent, maskCharacters('Games and apps'));
  assert.equal(wrapper.childNodes[0].attributes.get('aria-hidden'), 'true');
  assert.equal(wrapper.lastChild.childNodes[0], original);
  assert.equal(readDisplayText(button), 'Games and apps');
  assert.equal(button.focused, true);
  controller.setEnabled(true);
  assert.equal(button.childNodes[0], wrapper);
  controller.setEnabled(false);
  assert.equal(button.childNodes[0], original);
  assert.equal(button.textContent, 'Games and apps');
  assert.equal(f.doc.head.childNodes.length, 1);
});

test('dynamic status replacements and held text nodes update once without feedback loops', async () => {
  const f = fixture(); const status = f.element('p', 'Loading games'); const held = status.childNodes[0];
  const controller = createDisplayMasker(f.doc); controller.setEnabled(true);
  held.data = 'Games ready'; await f.settle();
  assert.equal(status.childNodes[0].childNodes[0].textContent, maskCharacters('Games ready'));
  status.textContent = 'Search completed'; await f.settle();
  assert.equal(readDisplayText(status), 'Search completed');
  assert.equal(status.querySelectorAll('[data-display-mask]').length, 1);
  const card = f.element('button', 'Another game'); await f.settle();
  assert.equal(readDisplayText(card), 'Another game');
  controller.dispose();
  assert.equal(status.textContent, 'Search completed');
  assert.equal(card.textContent, 'Another game');
  controller.setEnabled(true);
  assert.equal(card.querySelectorAll('[data-display-mask]').length, 0);
});

test('editable content, code, icon ligatures, filenames and addresses remain exact', () => {
  const f = fixture();
  const plain = ['input', 'textarea', 'select', 'code', 'pre', 'script', 'style', 'iframe', 'svg'].map(tag => f.element(tag, 'Games unchanged'));
  for (const [attribute, value] of [['contenteditable', 'true'], ['data-display-plain', ''], ['class', 'material-icons'], ['class', 'editor-container'], ['id', 'sidebar-files-list'], ['id', 'tabs-list'], ['id', 'browser-tools']]) {
    const node = f.element('div', 'Games unchanged'); node.setAttribute(attribute, value); plain.push(node);
  }
  for (const value of ['https://games.example/path', 'user@example.com', '/service/abc', 'game.js', 'example.net']) plain.push(f.element('span', value));
  const before = plain.map(node => node.textContent);
  const controller = createDisplayMasker(f.doc); controller.setEnabled(true);
  assert.deepEqual(plain.map(node => node.textContent), before);
  assert.equal(f.doc.body.querySelectorAll('[data-display-mask]').length, 0);
});

test('detached catalog rows restore plain text and can be safely reused', async () => {
  const f = fixture(); const card = f.element('div', 'Favorite game');
  const controller = createDisplayMasker(f.doc); controller.setEnabled(true);
  card.remove(); await f.settle();
  assert.equal(card.textContent, 'Favorite game');
  assert.equal(card.querySelectorAll('[data-display-mask]').length, 0);
  f.doc.body.append(card); await f.settle();
  assert.equal(card.querySelectorAll('[data-display-mask]').length, 1);
  controller.dispose();
});

test('moving labels into an editor or toggling plain text restores them immediately', async () => {
  const f = fixture(); const label = f.element('span', 'Editable game'); const editor = f.element('div', ''); editor.setAttribute('contenteditable', 'true');
  const controller = createDisplayMasker(f.doc); controller.setEnabled(true);
  editor.append(label); await f.settle();
  assert.equal(label.textContent, 'Editable game');
  f.doc.body.append(label); await f.settle();
  label.setAttribute('data-display-plain', ''); await f.settle();
  assert.equal(label.textContent, 'Editable game');
  label.removeAttribute('data-display-plain'); await f.settle();
  assert.equal(label.querySelectorAll('[data-display-mask]').length, 1);
  controller.dispose();
});
