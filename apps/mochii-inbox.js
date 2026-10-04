export const INBOX_STORAGE_KEY = 'mochii.inbox.session.v1';
export const INBOX_SESSION_MS = 86400000;
const API = 'https://api.maildrop.cc/graphql';
const LIST_QUERY = 'query Inbox($mailbox:String!){inbox(mailbox:$mailbox){id headerfrom subject date}}';
const MESSAGE_QUERY = 'query Message($mailbox:String!,$id:String!){message(mailbox:$mailbox,id:$id){id headerfrom subject date data}}';
const MAX_RESPONSE = 131072;
const MAX_TEXT = 32000;
const POLL_MS = 15000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAILBOX = /^mochii[a-f0-9]{32}$/;
const clean = (value, limit) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, limit) : '';
const record = value => value && typeof value === 'object' && !Array.isArray(value);

export class InboxError extends Error {
  constructor(message, code = 'unavailable') { super(message); this.name = 'InboxError'; this.code = code; }
}

export function normalizeInboxSession(value, now = Date.now()) {
  if (!record(value) || value.version !== 1 || typeof value.mailbox !== 'string' || !MAILBOX.test(value.mailbox) ||
      value.address !== value.mailbox + '@maildrop.cc' ||
      !Number.isFinite(value.createdAt) || value.createdAt < 0 || value.createdAt > now + 300000 ||
      !Number.isFinite(value.expiresAt) || value.expiresAt <= now || value.expiresAt > value.createdAt + INBOX_SESSION_MS ||
      value.expiresAt <= value.createdAt) return null;
  return { version: 1, mailbox: value.mailbox, address: value.address, createdAt: value.createdAt, expiresAt: value.expiresAt };
}

export function createInboxStore(storage, now = () => Date.now()) {
  let value = null;
  let available = !!storage;
  try {
    const raw = storage?.getItem(INBOX_STORAGE_KEY);
    if (raw && raw.length <= 16384) value = normalizeInboxSession(JSON.parse(raw), now());
    if (raw && !value) storage.removeItem(INBOX_STORAGE_KEY);
  } catch { available = false; }
  return {
    get value() { return value ? { ...value } : null; },
    get available() { return available; },
    save(next) {
      value = normalizeInboxSession(next, now());
      if (!value) throw new InboxError('This inbox session is invalid or expired.', 'expired');
      try { if (!storage) throw new Error(); storage.setItem(INBOX_STORAGE_KEY, JSON.stringify(value)); available = true; }
      catch { available = false; }
      return { ...value };
    },
    clear() {
      value = null;
      try { if (!storage) throw new Error(); storage.removeItem(INBOX_STORAGE_KEY); available = true; }
      catch { available = false; }
    }
  };
}

export function extractMessageText(value) {
  const source = typeof value === 'string' ? value.slice(0, MAX_RESPONSE) : '';
  let partsRead = 0;
  function part(raw, depth) {
    if (depth > 5 || ++partsRead > 32) return '';
    const split = raw.search(/\r?\n\r?\n/);
    if (split < 0 || split > 16384) return depth === 0 ? raw : '';
    const head = raw.slice(0, split).replace(/\r?\n[\t ]+/g, ' ');
    if (!/^[A-Za-z][A-Za-z0-9-]*:/m.test(head)) return depth === 0 ? raw : '';
    const headers = Object.create(null);
    head.split(/\r?\n/).forEach(line => {
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    });
    const separator = raw.slice(split).match(/^\r?\n\r?\n/)[0];
    const body = raw.slice(split + separator.length);
    const type = headers['content-type'] || 'text/plain';
    if (/^attachment\b/i.test(headers['content-disposition'] || '')) return '';
    if (/^multipart\//i.test(type)) {
      const boundary = type.match(/\bboundary\s*=\s*(?:"([^"\r\n]{1,100})"|([^\s;"\r\n]{1,100}))/i);
      const token = boundary?.[1] || boundary?.[2];
      if (!token) return '';
      return body.split('--' + token).slice(1, 33).map(item => part(item.replace(/^\r?\n/, ''), depth + 1)).filter(Boolean).join('\n\n');
    }
    if (!/^text\/plain(?:\s*;|\s*$)/i.test(type)) return '';
    const transfer = (headers['content-transfer-encoding'] || '').toLowerCase();
    if (!['base64', 'quoted-printable'].includes(transfer)) return body;
    try {
      let bytes;
      if (transfer === 'base64') {
        if (!/^[A-Za-z0-9+/=\s]*$/.test(body)) return '';
        bytes = Uint8Array.from(globalThis.atob(body.replace(/\s/g, '')), character => character.charCodeAt(0));
      } else {
        const decoded = body.replace(/=\r?\n/g, '').replace(/=([A-Fa-f0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
      }
      const charset = type.match(/\bcharset\s*=\s*"?([A-Za-z0-9_-]+)/i)?.[1] || 'utf-8';
      return new TextDecoder(charset).decode(bytes);
    } catch { return ''; }
  }
  const result = part(source, 0).trim();
  return { text: clean(result, MAX_TEXT) || 'This message has no readable plain-text version. HTML email and attachments are not displayed.',
    truncated: result.length > MAX_TEXT || (typeof value === 'string' && value.length > MAX_RESPONSE) };
}

export function createInboxClient({ fetch: fetcher = globalThis.fetch?.bind(globalThis), crypto = globalThis.crypto,
  now = () => Date.now(), setTimeout: later = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout } = {}) {
  let queue = Promise.resolve();
  let lastRequest = -Infinity;
  let cooldown = 0;
  const cancelled = () => new InboxError('Inbox request cancelled.', 'cancelled');
  const assertActive = signal => { if (signal?.aborted) throw cancelled(); };
  function wait(ms, signal) {
    assertActive(signal);
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const stop = () => { cancel(timer); signal?.removeEventListener('abort', stop); reject(cancelled()); };
      const timer = later(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
      signal?.addEventListener('abort', stop, { once: true });
    });
  }
  async function json(response) {
    const type = (response.headers.get('content-type') || '').split(';', 1)[0].trim();
    if (!/^application\/(?:[a-z0-9.+-]*\+)?json$/i.test(type) || response.redirected) {
      await response.body?.cancel().catch(() => {});
      throw new InboxError('Maildrop returned an unsupported response. Try again later.', 'response');
    }
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE) {
      await response.body?.cancel().catch(() => {});
      throw new InboxError('This email response is too large to display safely.', 'size');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new InboxError('Maildrop returned an empty response.', 'response');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0;
    let text = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE) throw new InboxError('This email response is too large to display safely.', 'size');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      const body = JSON.parse(text);
      if (!record(body)) throw new Error();
      return body;
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof InboxError) throw error;
      throw new InboxError('Maildrop returned invalid JSON. Try again later.', 'response');
    } finally { reader.releaseLock(); }
  }
  function request(query, variables, { signal } = {}) {
    const task = queue.then(async () => {
      assertActive(signal);
      if (cooldown > now()) throw new InboxError('Maildrop is busy. Wait a minute before trying again.', 'rate');
      await wait(Math.max(0, lastRequest + 350 - now()), signal);
      assertActive(signal);
      const controller = new AbortController();
      let timer;
      let timeout = false;
      let rejectAbort;
      const stop = () => { controller.abort(); rejectAbort?.(cancelled()); };
      const aborted = new Promise((_, reject) => { rejectAbort = reject; });
      signal?.addEventListener('abort', stop, { once: true });
      const expired = new Promise((_, reject) => {
        timer = later(() => { timeout = true; controller.abort(); reject(new InboxError('Maildrop took too long to respond. Try again.', 'timeout')); }, 12000);
      });
      try {
        lastRequest = now();
        const work = (async () => {
          const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
          const response = await fetcher(API, { method: 'POST', headers, body: JSON.stringify({ query, variables }),
            signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            if (response.status === 401 || response.status === 403) throw new InboxError('Maildrop could not accept this request. Try again later.', 'unavailable');
            if (response.status === 429) { cooldown = now() + 60000; throw new InboxError('Maildrop is busy. Wait a minute before trying again.', 'rate'); }
            if (response.status === 404) throw new InboxError('This inbox or message is no longer available.', 'missing');
            throw new InboxError('Maildrop is temporarily unavailable. Try again later.', 'unavailable');
          }
          const data = await json(response);
          if (data.errors?.length || !record(data.data)) throw new InboxError('Maildrop could not read this inbox. Try again later.', 'response');
          return data.data;
        })();
        return await Promise.race([work, expired, aborted]);
      } catch (error) {
        if (signal?.aborted) throw cancelled();
        if (error instanceof InboxError) throw error;
        if (timeout) throw new InboxError('Maildrop took too long to respond. Try again.', 'timeout');
        throw new InboxError('Could not reach Maildrop. Check your connection and try again.', 'network');
      } finally { cancel(timer); signal?.removeEventListener('abort', stop); }
    });
    queue = task.catch(() => {});
    return task;
  }
  function current(session) {
    const value = normalizeInboxSession(session, now());
    if (!value) throw new InboxError('This inbox session is invalid or expired. Forget it to create another.', 'expired');
    return value;
  }
  function summary(item) {
    if (!record(item) || typeof item.id !== 'string' || !ID.test(item.id)) return null;
    return { id: item.id, from: { name: clean(item.headerfrom, 254), address: '' },
      subject: clean(item.subject, 240) || '(No subject)', intro: '', createdAt: clean(item.date, 40) };
  }
  return {
    create({ signal } = {}) {
      assertActive(signal);
      if (!crypto?.getRandomValues) throw new InboxError('Secure randomness is unavailable in this browser.', 'crypto');
      const mailbox = 'mochii' + Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
      const stamp = now();
      return { version: 1, mailbox, address: mailbox + '@maildrop.cc', createdAt: stamp, expiresAt: stamp + INBOX_SESSION_MS };
    },
    async validate(session, { signal } = {}) {
      const value = current(session);
      const body = await request(LIST_QUERY, { mailbox: value.mailbox }, { signal });
      if (!Array.isArray(body.inbox)) throw new InboxError('Maildrop returned an invalid message list.', 'response');
      return value;
    },
    async messages(session, { signal } = {}) {
      const value = current(session);
      const body = await request(LIST_QUERY, { mailbox: value.mailbox }, { signal });
      if (!Array.isArray(body.inbox)) throw new InboxError('Maildrop returned an invalid message list.', 'response');
      const seen = new Set();
      return body.inbox.slice(0, 30).map(summary).filter(item => item && !seen.has(item.id) && seen.add(item.id));
    },
    async message(session, id, { signal } = {}) {
      const value = current(session);
      if (typeof id !== 'string' || !ID.test(id)) throw new InboxError('This message address is invalid.', 'message');
      const body = await request(MESSAGE_QUERY, { mailbox: value.mailbox, id }, { signal });
      const item = summary(body.message);
      if (!item || item.id !== id) throw new InboxError('This message is no longer available.', 'missing');
      const raw = extractMessageText(body.message.data);
      return { ...item, text: raw.text, truncated: raw.truncated };
    }
  };
}

export function mountInbox(doc = document, win = window) {
  const $ = id => doc.getElementById(id);
  if (!$('inbox-create')) return { destroy() {} };
  let storage;
  try { storage = win.sessionStorage; } catch {}
  const store = createInboxStore(storage);
  const client = createInboxClient({ fetch: typeof win.fetch === 'function' ? win.fetch.bind(win) : () => Promise.reject(new Error()), crypto: win.crypto || null,
    setTimeout: win.setTimeout.bind(win), clearTimeout: win.clearTimeout.bind(win) });
  let session = store.value;
  let startupError = '';
  if (!session) {
    try { session = store.save(client.create()); }
    catch (error) { startupError = error instanceof InboxError ? error.message : 'Could not generate a temporary address in this browser.'; }
  }
  let busy = false;
  let operation = 0;
  let controller;
  let poll;
  let destroyed = false;
  let suspended = false;
  let rows = [];
  let selected = null;
  let retryDelay = POLL_MS;
  const listeners = [];
  const visible = () => !destroyed && !suspended && !doc.hidden && !$('view-guide')?.hidden;
  const status = value => { $('inbox-status').textContent = value; };
  const listen = (node, event, handler) => { node?.addEventListener(event, handler); if (node) listeners.push([node, event, handler]); };
  function controls() {
    $('inbox-create').disabled = busy || !!session;
    $('inbox-copy').disabled = !session;
    $('inbox-refresh').disabled = busy || !session;
    $('inbox-forget').disabled = !session;
    $('inbox-address').value = session?.address || '';
    for (const button of $('inbox-list').children) button.disabled = busy;
  }
  function resetReading() {
    selected = null;
    $('inbox-message').textContent = '';
    $('inbox-sender').textContent = '';
    $('inbox-subject').textContent = '';
    if ($('inbox-reading-pane')) $('inbox-reading-pane').hidden = true;
  }
  function render() {
    const fragment = doc.createDocumentFragment();
    for (const item of rows) {
      const button = doc.createElement('button');
      button.type = 'button'; button.className = 'inbox-message-button';
      button.setAttribute('aria-pressed', String(selected === item.id));
      const sender = doc.createElement('span'); sender.className = 'inbox-message-from'; sender.textContent = item.from.name || item.from.address || 'Unknown sender';
      const subject = doc.createElement('span'); subject.className = 'inbox-message-subject'; subject.textContent = item.subject;
      button.append(sender, subject);
      button.addEventListener('click', () => readMessage(item.id));
      fragment.append(button);
    }
    $('inbox-list').replaceChildren(fragment);
    $('inbox-empty').hidden = rows.length > 0;
    $('inbox-empty').textContent = session ? 'No messages yet. Keep Setup open to check for new mail.' : 'Create an inbox when you need a temporary email address.';
    controls();
  }
  function schedule() {
    win.clearTimeout(poll);
    if (session && visible() && !busy) poll = win.setTimeout(() => { void refresh(); }, retryDelay);
  }
  function pause() {
    win.clearTimeout(poll);
    operation++;
    controller?.abort(); controller = null;
    if (busy) status('Inbox request paused. Open Setup and refresh to continue.');
    busy = false;
    controls();
  }
  async function run(task) {
    if (busy || !visible()) return;
    busy = true;
    const mine = ++operation;
    controller = new AbortController();
    const active = controller;
    win.clearTimeout(poll);
    controls();
    try {
      await task(active.signal, () => mine === operation && !active.signal.aborted && !destroyed);
      if (mine === operation) retryDelay = POLL_MS;
    } catch (error) {
      if (mine !== operation || destroyed) return;
      if (error?.code === 'expired') {
        store.clear(); session = null; rows = []; resetReading(); render();
      }
      retryDelay = error?.code === 'rate' ? 60000 : POLL_MS;
      status(error instanceof InboxError ? error.message : 'The inbox could not be updated. Try again.');
    } finally {
      if (mine === operation) { busy = false; controller = null; controls(); schedule(); }
    }
  }
  function refresh() {
    if (!session) return Promise.resolve();
    return run(async (signal, current) => {
      status('Checking for messages…');
      const messages = await client.messages(session, { signal });
      if (!current()) return;
      rows = messages;
      if (selected && !rows.some(item => item.id === selected)) resetReading();
      render();
      status(`Inbox checked.${store.available ? ' This tab remembers the address for up to 24 hours.' : ' The address is remembered only until this page is reloaded because tab storage is unavailable.'}`);
    });
  }
  function readMessage(id) {
    if (!session || !rows.some(item => item.id === id)) return Promise.resolve();
    return run(async (signal, current) => {
      status('Opening message…');
      const item = await client.message(session, id, { signal });
      if (!current()) return;
      selected = id;
      $('inbox-sender').textContent = [item.from.name, item.from.address].filter(Boolean).join(' · ') || 'Unknown sender';
      $('inbox-subject').textContent = item.subject;
      $('inbox-message').textContent = item.text;
      if ($('inbox-reading-pane')) $('inbox-reading-pane').hidden = false;
      render();
      status(item.truncated ? 'Message shortened to 32,000 characters. Only plain text is shown.' : 'Only plain text is shown. Links, images, and attachments are not opened.');
    });
  }
  function forget() {
    if (!session || !win.confirm('Forget this temporary address? This removes it from this tab, but does not delete any messages at Maildrop.')) return;
    pause(); store.clear(); session = null; rows = []; resetReading(); render();
    status(store.available ? 'Address forgotten in this tab. Maildrop messages were not deleted.' : 'Address cleared from this page. Tab storage could not be cleared; close this tab to remove the saved address. Maildrop messages were not deleted.');
  }
  listen($('inbox-create'), 'click', () => {
    if (session) return;
    void run(async (signal, current) => {
      status('Generating your temporary address…');
      const created = await client.create({ signal });
      if (!current()) return;
      session = store.save(created); rows = []; resetReading(); render();
      status(store.available ? 'Address ready. This tab remembers it for up to 24 hours. No game account was created.' : 'Address ready for this page only. Tab storage is unavailable; reloading will forget it. No game account was created.');
    });
  });
  listen($('inbox-refresh'), 'click', () => { void refresh(); });
  listen($('inbox-forget'), 'click', forget);
  listen($('inbox-copy'), 'click', async () => {
    if (!session) return;
    const address = session.address;
    const mine = operation;
    const current = () => mine === operation && session?.address === address && visible();
    try { await win.navigator.clipboard.writeText(address); if (current()) status('Email address copied.'); }
    catch { if (current()) { $('inbox-address').focus(); $('inbox-address').select(); status('Address selected. Copy it using your browser.'); } }
  });
  function visibility() { if (visible()) { if (session) void refresh(); } else pause(); }
  const observer = win.MutationObserver && $('view-guide') ? new win.MutationObserver(visibility) : null;
  observer?.observe($('view-guide'), { attributes: true, attributeFilter: ['hidden'] });
  listen(doc, 'visibilitychange', visibility);
  listen(win, 'pagehide', () => { suspended = true; pause(); });
  listen(win, 'pageshow', () => { suspended = false; visibility(); });
  render();
  status(startupError || (session ? 'Your temporary address is ready. Open Setup to check mail. No game account was created.' : 'Create an inbox to receive email here. No game accounts are created.'));
  if (session && visible()) void refresh();
  return { refresh, forget, destroy() { destroyed = true; pause(); observer?.disconnect(); listeners.forEach(([node, event, handler]) => node.removeEventListener(event, handler)); } };
}
