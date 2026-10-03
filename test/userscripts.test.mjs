import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserscriptStore, matchesUrl, validatePatterns, USERSCRIPTS_STORAGE_KEY } from '../browser-tools/userscripts.js';

function memoryStorage(value = null) {
  const items = new Map(value === null ? [] : [[USERSCRIPTS_STORAGE_KEY, value]]);
  return {
    getItem(key) { return items.get(key) ?? null; },
    setItem(key, next) { items.set(key, next); },
  };
}

const draft = (extra = {}) => ({ name: 'Example script', match: 'https://example.com/*', code: 'console.log("hello");', ...extra });

test('userscripts persist, edit with the same ID, and remove', () => {
  const storage = memoryStorage();
  const store = createUserscriptStore(storage);
  const original = store.save(draft());
  assert.ok(original.id);
  assert.equal(original.enabled, false);
  assert.deepEqual(createUserscriptStore(storage).list(), [original]);
  const edited = store.save({ ...original, name: 'Edited', enabled: true });
  assert.equal(edited.id, original.id);
  assert.deepEqual(store.list(), [edited]);
  assert.equal(store.remove(original.id), true);
  assert.equal(store.remove(original.id), false);
  assert.deepEqual(store.list(), []);
});

test('saving and listing do not expose mutable stored state', () => {
  const store = createUserscriptStore(memoryStorage());
  const saved = store.save(draft());
  saved.enabled = true;
  const listed = store.list();
  listed[0].name = 'Mutated';
  assert.equal(store.list()[0].enabled, false);
  assert.equal(store.list()[0].name, 'Example script');
});

test('userscripts do not default to enabled and reject non-boolean enabled', () => {
  const store = createUserscriptStore(memoryStorage());
  for (const enabled of [undefined, false]) assert.equal(store.save(draft({ enabled })).enabled, false);
  for (const enabled of ['true', 1, null]) assert.throws(() => store.save(draft({ enabled })), /enabled/);
});

test('storage write failures are reported and do not claim a save or delete', () => {
  const storage = memoryStorage();
  const store = createUserscriptStore(storage);
  const original = store.save(draft());
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.throws(() => store.save({ ...original, name: 'Unsaved' }), /Unable to save/);
  assert.throws(() => store.remove(original.id), /Unable to save/);
  assert.deepEqual(store.list(), [original]);
});

test('storage read failures recover list but block destructive writes', () => {
  let written = false;
  const store = createUserscriptStore({ getItem() { throw new Error('SecurityError'); }, setItem() { written = true; } });
  assert.deepEqual(store.list(), []);
  assert.match(store.warning, /Unable to read/);
  assert.throws(() => store.save(draft()), /Unable to read/);
  assert.throws(() => store.remove('some-id'), /Unable to read/);
  assert.equal(written, false);
});

test('corrupt JSON and invalid saved formats recover with a visible warning', () => {
  for (const raw of ['{bad JSON', '{}', 'null', '"script"']) {
    const store = createUserscriptStore(memoryStorage(raw));
    assert.deepEqual(store.list(), []);
    assert.ok(store.warning);
    store.save(draft());
    assert.equal(store.list().length, 1);
    assert.equal(store.warning, null);
  }
});

test('bad and duplicate stored records are ignored while valid records survive', () => {
  const valid = draft({ id: 'valid-id', enabled: true });
  const raw = JSON.stringify([null, { code: 'bad' }, valid, valid, draft({ id: 'invalid:id' }), draft({ id: 'bad-protocol', match: 'javascript:*' })]);
  const store = createUserscriptStore(memoryStorage(raw));
  assert.deepEqual(store.list(), [valid]);
  assert.match(store.warning, /ignored/);
});

test('record validation and size limits are enforced before writing', () => {
  const store = createUserscriptStore(memoryStorage());
  for (const value of [null, {}, draft({ name: '' }), draft({ name: 'x'.repeat(101) }), draft({ match: '*' .repeat(2001) }), draft({ code: 42 }), draft({ code: 'x'.repeat(100001) }), draft({ id: '../unsafe' })]) {
    assert.throws(() => store.save(value));
  }
  assert.deepEqual(store.list(), []);
  assert.equal(store.save(draft({ name: 'x'.repeat(100), code: 'x'.repeat(100000) })).code.length, 100000);
});

test('50-script limit allows editing and replacing after deletion', () => {
  const store = createUserscriptStore(memoryStorage());
  for (let index = 0; index < 50; index++) store.save(draft({ id: `script-${index}` }));
  assert.throws(() => store.save(draft()), /up to 50/);
  store.save(draft({ id: 'script-0', name: 'Updated at limit' }));
  assert.equal(store.list().length, 50);
  store.remove('script-0');
  store.save(draft());
  assert.equal(store.list().length, 50);
});

test('exact HTTP(S) URLs are normalized and bounded', () => {
  assert.equal(matchesUrl('https://EXAMPLE.com', 'https://example.com/'), true);
  assert.equal(matchesUrl('https://example.com/page', 'https://example.com/page'), true);
  assert.equal(matchesUrl('https://example.com/page', 'https://example.com/pages'), false);
  assert.equal(matchesUrl('https://example.com/page', 'http://example.com/page'), false);
  assert.equal(matchesUrl('https://example.com/page', 'https://example.com/page?q=1'), false);
});

test('wildcard schemes and subdomains include the apex with hostname boundaries', () => {
  const pattern = '*://*.example.com/*';
  for (const url of ['https://example.com/', 'http://example.com/path', 'https://a.b.example.com/path?q=1#part']) assert.equal(matchesUrl(pattern, url), true, url);
  for (const url of ['https://evilexample.com/', 'https://example.com.evil.test/', 'https://other.com/?q=example.com']) assert.equal(matchesUrl(pattern, url), false, url);
});

test('wildcard hosts, multiple patterns, and local ports work', () => {
  assert.equal(matchesUrl('https://*/*', 'https://example.org:8443/anything'), true);
  assert.equal(matchesUrl('*://*/*', 'http://localhost:3000/'), true);
  assert.equal(matchesUrl('http://localhost:3000/*', 'http://localhost:3000/app'), true);
  assert.equal(matchesUrl('http://localhost:3000/*', 'http://localhost:3001/app'), false);
  assert.equal(matchesUrl('https://example.com:443/*', 'https://example.com/'), true);
  assert.equal(matchesUrl('*://example.com:80/*', 'http://example.com/'), true);
  assert.equal(matchesUrl('http://example.com/*,\n https://other.com/*', 'https://other.com/test'), true);
  assert.equal(matchesUrl('https://example.com/*', 'https://example.com:8443/'), false);
});

test('path globs treat regex characters and query strings literally', () => {
  assert.equal(matchesUrl('https://example.com/a[1].js?x=1+2*', 'https://example.com/a[1].js?x=1+2&ok=yes'), true);
  assert.equal(matchesUrl('https://example.com/a[1].js*', 'https://example.com/a1Xjs'), false);
  assert.equal(matchesUrl('https://example.com/*/end', 'https://example.com/a/b/end'), true);
  assert.equal(matchesUrl('https://example.com/*/end', 'https://example.com/a/b/ending'), false);
  assert.equal(matchesUrl('https://example.com/a%20b/*', 'https://example.com/a%20b/c'), true);
  assert.equal(matchesUrl('https://example.com/***', 'https://example.com/'), true);
});

test('broad globs never match non-HTTP protocols or relative URLs', () => {
  for (const url of ['about:blank', 'data:text/html,hello', 'javascript:alert(1)', 'file:///app', 'ftp://example.com/', '/app', 'not a URL']) {
    assert.equal(matchesUrl('*', url), false, url);
    assert.equal(matchesUrl('*://*/*', url), false, url);
  }
  assert.equal(matchesUrl('*', 'https://example.com/'), true);
  assert.equal(matchesUrl('*', 'http://localhost:3000/'), true);
});

test('invalid patterns are rejected at save and safely fail during matching', () => {
  const store = createUserscriptStore(memoryStorage());
  for (const match of ['', '  ,\n', 'example.com/*', 'ftp://example.com/*', 'https://foo*bar.com/*', 'https://user:secret@example.com/*', 'https://example.com/a b', 'https://example.com/\\evil', 'https://*.127.0.0.1/*', 'https://example.com:99999/*']) {
    assert.throws(() => validatePatterns(match), undefined, match);
    assert.throws(() => store.save(draft({ match })), undefined, match);
    assert.equal(matchesUrl(match, 'https://example.com/'), false, match);
  }
  assert.deepEqual(validatePatterns(' https://example.com/*,\n*://*.other.com/* '), ['https://example.com/*', '*://*.other.com/*']);
});
