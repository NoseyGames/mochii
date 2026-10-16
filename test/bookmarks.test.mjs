import test from 'node:test';
import assert from 'node:assert/strict';
import { bookmarkUrl, normalizeBookmarks, createBookmarkStore, restoreDeletedBookmark, upsertBookmark } from '../browser-tools/bookmarks.js';
import { bindOverlay } from '../browser-tools/dialog-controller.js';

test('bookmark data rejects executable and credential URLs, bounds entries and keeps unique IDs', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'https://user:pass@example.com/', 'https://example.com/ bad', 'https://example.com/\n']) assert.throws(() => bookmarkUrl(url));
  const data = normalizeBookmarks([
    { id: 'same', title: '<img src=x>', url: 'https://example.com/' },
    { id: 'same', url: 'https://example.com/next' },
    { url: 'https://example.com/' },
    { url: 'javascript:alert(1)' }
  ]);
  assert.equal(data.length, 2);
  assert.equal(new Set(data.map(item => item.id)).size, 2);
  assert.equal(data[0].title, '<img src=x>');
  assert.equal(normalizeBookmarks(Array.from({ length: 50 }, (_, i) => ({ url: `https://example.com/${i}` }))).length, 40);
});

test('a failed bookmark write preserves current data and reload reads a library import', () => {
  let value = '[{"id":"one","title":"One","url":"https://example.com/"}]', blocked = false;
  const store = createBookmarkStore({ getItem: () => value, setItem: (_key, text) => { if (blocked) throw new Error('quota'); value = text; } });
  blocked = true;
  assert.throws(() => store.save([]), /could not be saved/);
  assert.equal(store.list().length, 1);
  blocked = false;
  store.save([{ id: 'two', title: 'Two', url: 'https://two.example/' }]);
  assert.equal(JSON.parse(value)[0].id, 'two');
  value = '[]'; store.reload(); assert.deepEqual(store.list(), []);
});

test('catalog dialog restores focus and traps keyboard navigation without clearing its contents', () => {
  const handlers = new Map(), classes = new Set(), doc = { activeElement: null };
  const opener = { isConnected: true, focus() { doc.activeElement = this; } };
  const first = { disabled: false, tabIndex: 0, getClientRects: () => [1], focus() { doc.activeElement = this; } };
  const last = { ...first, focus() { doc.activeElement = this; } };
  const element = {
    classList: { contains: key => classes.has(key), add: key => classes.add(key), remove: key => classes.delete(key) },
    addEventListener: (name, fn) => handlers.set(name, fn), setAttribute(name, value) { this[name] = value; },
    querySelector: () => first, querySelectorAll: () => [first, last], contains: node => [first, last].includes(node)
  };
  const controller = bindOverlay({ document: doc }, { element, initialFocus: () => first });
  assert.equal(element.inert, true);
  doc.activeElement = opener; controller.open(); assert.equal(doc.activeElement, first);
  let prevented = false;
  handlers.get('keydown')({ key: 'Tab', shiftKey: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(doc.activeElement, last);
  handlers.get('keydown')({ key: 'Tab', preventDefault() {} }); assert.equal(doc.activeElement, first);
  handlers.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(controller.isOpen(), false); assert.equal(element.inert, true); assert.equal(doc.activeElement, opener);
  controller.open(); handlers.get('click')({ target: element }); assert.equal(controller.isOpen(), false);
});

test('undo bookmark deletion preserves later additions and edited replacements without exceeding limits', () => {
  const old = { id: 'old', title: 'Old', url: 'https://old.example/' };
  const added = { id: 'new', title: 'New', url: 'https://new.example/' };
  assert.deepEqual(restoreDeletedBookmark([added], { item: old, index: 0 }), [old, added]);
  const edited = { ...old, title: 'Updated' };
  assert.deepEqual(restoreDeletedBookmark([edited, added], { item: old, index: 0 }), [edited, added]);
  assert.throws(() => restoreDeletedBookmark(Array.from({ length: 40 }, (_, i) => ({ id: String(i) })), { item: old, index: 0 }), /limit/);
});

test('editing a bookmark rejects another saved address in either list order without changing either entry', () => {
  const a = Object.freeze({ id: 'a', title: 'A', url: 'https://a.example/' });
  const b = Object.freeze({ id: 'b', title: 'B', url: 'https://b.example/' });
  for (const entries of [Object.freeze([a, b]), Object.freeze([b, a])]) {
    assert.throws(() => upsertBookmark(entries, { editing: 'b', title: 'Changed B', url: a.url }), /already saved/);
    assert.equal(entries.find(item => item.id === 'a'), a);
    assert.equal(entries.find(item => item.id === 'b'), b);
    const updated = upsertBookmark(entries, { editing: 'b', title: 'Changed B', url: 'https://c.example/' });
    assert.equal(updated.find(item => item.id === 'a'), a);
    assert.deepEqual(updated.find(item => item.id === 'b'), { id: 'b', title: 'Changed B', url: 'https://c.example/' });
    assert.equal(updated.length, 2);
  }
});

test('bookmark saves reject stale edits and keep duplicate additions within the bookmark limit', () => {
  const entries = Array.from({ length: 40 }, (_, i) => ({ id: String(i), title: String(i), url: `https://example.com/${i}` }));
  assert.throws(() => upsertBookmark(entries, { editing: 'removed', title: 'Draft', url: entries[0].url }), /no longer available/);
  assert.throws(() => upsertBookmark(entries, { title: 'New', url: 'https://new.example/' }), /up to 40/);
  const updated = upsertBookmark(entries, { title: 'Renamed', url: entries[0].url });
  assert.equal(updated.length, 40);
  assert.deepEqual(updated[0], { ...entries[0], title: 'Renamed' });
  assert.equal(entries[0].title, '0');
});
