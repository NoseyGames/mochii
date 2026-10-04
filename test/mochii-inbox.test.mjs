import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { INBOX_STORAGE_KEY, INBOX_SESSION_MS, normalizeInboxSession, createInboxStore, createInboxClient, extractMessageText, mountInbox } from '../apps/mochii-inbox.js';

const stamp = 1800000000000;
const mailbox = 'mochii' + 'ab'.repeat(16);
const session = () => ({ version: 1, mailbox, address: mailbox + '@maildrop.cc', createdAt: stamp, expiresAt: stamp + INBOX_SESSION_MS });
const response = data => new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } });
const tick = () => new Promise(resolve => setImmediate(resolve));
function storage(initial) {
  const values = new Map(initial ? [[INBOX_STORAGE_KEY, initial]] : []);
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function client(fetch, extra = {}) {
  let time = stamp;
  return createInboxClient({ crypto: webcrypto, fetch, now: () => time += 1000, ...extra });
}

test('startup address generation is local and uses 128 random bits without credentials', () => {
  let calls = 0;
  const api = client(() => { calls++; throw new Error(); });
  const first = api.create();
  const second = api.create();
  assert.match(first.address, /^mochii[a-f0-9]{32}@maildrop\.cc$/);
  assert.notEqual(first.address, second.address);
  assert.equal(first.expiresAt - first.createdAt, INBOX_SESSION_MS);
  assert.equal(calls, 0);
  assert.deepEqual(Object.keys(first).sort(), ['address', 'createdAt', 'expiresAt', 'mailbox', 'version']);
  assert.throws(() => client(null, { crypto: null }).create(), { code: 'crypto' });
});

test('session validation rejects arbitrary mailboxes, expired sessions and injected fields', () => {
  for (const invalid of [null, [], {}, { ...session(), mailbox: 'someone' }, { ...session(), address: mailbox + '@evil.test' },
    { ...session(), createdAt: stamp + 300001 }, { ...session(), expiresAt: stamp }, { ...session(), expiresAt: stamp + INBOX_SESSION_MS + 1 }]) {
    assert.equal(normalizeInboxSession(invalid, stamp), null);
  }
  const value = normalizeInboxSession({ ...session(), token: 'secret', password: 'secret' }, stamp);
  assert.deepEqual(value, session());
});

test('session storage survives reload, returns copies and recovers from unavailable storage', () => {
  const memory = storage();
  const store = createInboxStore(memory, () => stamp);
  store.save(session());
  const restored = createInboxStore(memory, () => stamp);
  const copy = restored.value;
  copy.address = 'changed';
  assert.equal(restored.value.address, session().address);
  restored.clear();
  assert.equal(createInboxStore(memory, () => stamp).value, null);
  const blocked = createInboxStore({ getItem() { throw new Error(); }, setItem() { throw new Error(); }, removeItem() { throw new Error(); } }, () => stamp);
  blocked.save(session());
  assert.equal(blocked.available, false);
  assert.equal(blocked.value.address, session().address);
  blocked.clear();
  assert.equal(blocked.value, null);
});

test('corrupt and oversized persisted values cannot become sessions', () => {
  for (const raw of ['{', 'x'.repeat(17000), JSON.stringify({ ...session(), expiresAt: stamp })]) {
    assert.equal(createInboxStore(storage(raw), () => stamp).value, null);
  }
});

test('mail reads only use fixed GraphQL queries and omit browser credentials', async () => {
  const calls = [];
  const api = client(async (url, options) => {
    calls.push({ url, ...options });
    return response({ inbox: [{ id: 'safe1', headerfrom: 'Sender', subject: '<img onerror=evil()>', date: '2026-10-04' }, { id: 'safe1' }, { id: '../bad' }] });
  });
  const messages = await api.messages(session());
  assert.equal(messages.length, 1);
  assert.equal(messages[0].subject, '<img onerror=evil()>');
  assert.equal(calls[0].url, 'https://api.maildrop.cc/graphql');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].credentials, 'omit');
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].referrerPolicy, 'no-referrer');
  const body = JSON.parse(calls[0].body);
  assert.match(body.query, /^query Inbox/);
  assert.deepEqual(body.variables, { mailbox });
});

test('invalid message IDs never make a network request and mismatched responses fail', async () => {
  let count = 0;
  const api = client(async () => { count++; return response({ message: { id: 'different', data: 'secret' } }); });
  await assert.rejects(api.message(session(), '../private'), { code: 'message' });
  assert.equal(count, 0);
  await assert.rejects(api.message(session(), 'safe'), { code: 'missing' });
});

test('message reading decodes plaintext and never follows provider-supplied URLs', async () => {
  const calls = [];
  const api = client(async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ message: { id: 'mail1', subject: 'Code', headerfrom: 'Sender', data: 'Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\nQ29kZSAxMjM0', url: 'https://evil.test/' } });
  });
  const message = await api.message(session(), 'mail1');
  assert.equal(message.text, 'Code 1234');
  assert.deepEqual(calls[0].body.variables, { mailbox, id: 'mail1' });
  assert.equal(calls.length, 1);
});

test('MIME extraction excludes HTML and attachments and bounds output', () => {
  const mime = 'Content-Type: multipart/alternative; boundary="x"\r\n\r\n--x\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCode=20caf=C3=A9\r\n--x\r\nContent-Type: text/html\r\n\r\n<script>evil()</script>\r\n--x\r\nContent-Type: text/plain\r\nContent-Disposition: attachment\r\n\r\nPRIVATE ATTACHMENT\r\n--x--';
  assert.equal(extractMessageText(mime).text, 'Code café');
  assert.match(extractMessageText('Content-Type: text/html\n\n<img src="https://evil.test">').text, /no readable plain-text/);
  const large = extractMessageText('a'.repeat(50000));
  assert.equal(large.text.length, 32000);
  assert.equal(large.truncated, true);
});

test('HTML, malformed JSON and GraphQL failures become safe errors', async () => {
  for (const bad of [new Response('<!DOCTYPE html>SECRET', { headers: { 'Content-Type': 'text/html' } }),
    new Response('SECRET', { headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify({ errors: [{ message: 'SECRET' }] }), { headers: { 'Content-Type': 'application/json' } })]) {
    await assert.rejects(client(async () => bad).messages(session()), error => error.code === 'response' && !error.message.includes('SECRET'));
  }
});

test('streamed response size is bounded even without Content-Length', async () => {
  const api = client(async () => new Response(' '.repeat(131073), { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(api.messages(session()), { code: 'size' });
});

test('rate limiting backs off without making repeated requests', async () => {
  let count = 0;
  let time = stamp;
  const api = client(async () => { count++; return new Response('', { status: 429 }); }, { now: () => time });
  await assert.rejects(api.messages(session()), { code: 'rate' });
  await assert.rejects(api.messages(session()), { code: 'rate' });
  assert.equal(count, 1);
  time += 60001;
  await assert.rejects(api.messages(session()), { code: 'rate' });
  assert.equal(count, 2);
});

test('timeout and cancellation abort the transport without leaving the queue blocked', async () => {
  let expire;
  let transport;
  const api = client(async (_, options) => { transport = options.signal; return new Promise(() => {}); },
    { setTimeout: (fn, ms) => { assert.equal(ms, 12000); expire = fn; return 1; }, clearTimeout() {} });
  const request = api.messages(session());
  const assertion = assert.rejects(request, { code: 'timeout' });
  await tick(); expire(); await assertion;
  assert.equal(transport.aborted, true);
  const abort = new AbortController();
  const next = api.messages(session(), { signal: abort.signal });
  const cancelled = assert.rejects(next, { code: 'cancelled' });
  await tick(); abort.abort(); await cancelled;
  assert.equal(transport.aborted, true);
  await assert.rejects(api.messages(session(), { signal: abort.signal }), { code: 'cancelled' });
});

function harness({ saved = storage(), fetch = async () => response({ inbox: [] }) } = {}) {
  let serial = 0;
  let observer;
  const timers = new Map();
  const nodes = new Map();
  class Node {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; }
    append(...children) { this.children.push(...children.flatMap(child => child.tagName === '#FRAGMENT' ? child.children : [child])); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    setAttribute(key, value) { this.attributes.set(key, value); }
    addEventListener(event, fn) { this.listeners.set(event, fn); }
    removeEventListener(event, fn) { if (this.listeners.get(event) === fn) this.listeners.delete(event); }
    fire(event) { return this.listeners.get(event)?.(); }
    click() { if (!this.disabled) return this.fire('click'); }
    focus() { this.focused = true; }
    select() { this.selected = true; }
    set innerHTML(_) { throw new Error('Unsafe HTML rendering'); }
  }
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const doc = new Node();
  Object.assign(doc, { getElementById: get, createElement: tag => new Node(tag), createDocumentFragment: () => new Node('#fragment') });
  const win = new Node();
  Object.assign(win, { sessionStorage: saved, crypto: webcrypto, fetch, confirm: () => true,
    navigator: { clipboard: { writeText: async value => { win.copied = value; } } },
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} disconnect() { observer = null; } } });
  get('view-guide').hidden = true;
  const mounted = mountInbox(doc, win);
  return { get, doc, win, mounted, timers, saved, show() { get('view-guide').hidden = false; observer?.(); }, hide() { get('view-guide').hidden = true; observer?.(); } };
}

test('mount generates one address at startup without contacting the provider and restores reloads', async () => {
  let count = 0;
  const h = harness({ fetch: async () => { count++; return response({ inbox: [] }); } });
  const address = h.get('inbox-address').value;
  assert.match(address, /@maildrop\.cc$/);
  assert.equal(count, 0);
  assert.equal(h.timers.size, 0);
  await h.get('inbox-copy').click();
  assert.equal(h.win.copied, address);
  h.mounted.destroy();
  const reload = harness({ saved: h.saved });
  assert.equal(reload.get('inbox-address').value, address);
  reload.mounted.destroy();
});

test('polling runs only in visible Setup and pauses for page lifecycle changes', async () => {
  let count = 0;
  const h = harness({ fetch: async () => { count++; return response({ inbox: [] }); } });
  h.show(); await tick();
  assert.equal(count, 1);
  assert.deepEqual([...h.timers.values()].map(item => item.ms), [15000]);
  h.hide(); assert.equal(h.timers.size, 0);
  await h.mounted.refresh(); assert.equal(count, 1);
  h.doc.hidden = true; h.show(); assert.equal(h.timers.size, 0);
  h.doc.hidden = false; h.doc.fire('visibilitychange'); await tick();
  h.win.fire('pagehide'); assert.equal(h.timers.size, 0);
  await h.mounted.refresh(); assert.equal(count, 1);
  h.mounted.destroy(); assert.equal(h.doc.listeners.size, 0); assert.equal(h.win.listeners.size, 0);
});

test('forget cancels an in-flight read and stale responses cannot restore messages', async () => {
  let complete;
  let signal;
  const h = harness({ fetch: async (_, options) => { signal = options.signal; return new Promise(resolve => { complete = resolve; }); } });
  h.show(); await tick();
  h.mounted.forget();
  assert.equal(signal.aborted, true);
  complete(response({ inbox: [{ id: 'late', subject: 'stale' }] })); await tick();
  assert.equal(h.get('inbox-address').value, '');
  assert.equal(h.get('inbox-list').children.length, 0);
  assert.equal(h.saved.values.size, 0);
  assert.equal(h.timers.size, 0);
  assert.match(h.get('inbox-status').textContent, /not deleted/);
  h.mounted.destroy();
});

test('message subjects render as text and destruction prevents stale status updates', async () => {
  const h = harness({ fetch: async () => response({ inbox: [{ id: 'mail1', headerfrom: '<img src=x>', subject: '<script>bad()</script>' }] }) });
  h.show(); await tick();
  const row = h.get('inbox-list').children[0];
  assert.equal(row.children[0].textContent, '<img src=x>');
  assert.equal(row.children[1].textContent, '<script>bad()</script>');
  assert.equal(row.children.length, 2);
  const pending = h.mounted.refresh();
  assert.equal(row.disabled, true);
  h.hide(); await pending;
  assert.equal(row.disabled, false);
  h.mounted.destroy();
  const state = h.get('inbox-status').textContent;
  await h.mounted.refresh();
  assert.equal(h.get('inbox-status').textContent, state);
});

test('late clipboard completion cannot overwrite a forgotten inbox status', async () => {
  const h = harness();
  h.show(); await tick();
  let copied;
  h.win.navigator.clipboard.writeText = () => new Promise(resolve => { copied = resolve; });
  const pending = h.get('inbox-copy').click();
  h.mounted.forget();
  const state = h.get('inbox-status').textContent;
  copied(); await pending;
  assert.equal(h.get('inbox-status').textContent, state);
  assert.equal(h.get('inbox-address').value, '');
  h.mounted.destroy();
});
