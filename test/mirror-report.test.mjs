import test from 'node:test';
import assert from 'node:assert/strict';
import { publicMirrorOrigin, reportMirror, scheduleMirrorReport } from '../browser-tools/mirror-report.js';

function fixture(origin = 'https://a.pages.dev') {
  const storage = new Map();
  const win = { location: { origin }, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } };
  win.top = win.self = win;
  return win;
}
test('mirror reports strip page paths and reject local or credential-bearing addresses', () => {
  assert.equal(publicMirrorOrigin('https://a.pages.dev/math?token=secret'), 'https://a.pages.dev');
  for (const value of ['http://a.pages.dev', 'https://127.0.0.1', 'https://[::1]', 'https://a.local', 'https://user:pass@a.pages.dev', 'https://a.pages.dev:8443']) assert.equal(publicMirrorOrigin(value), '');
});
test('mirror reports contain only public origin and successful results are not sent twice', async () => {
  const win = fixture(); const requests = [];
  const fetcher = async (url, options) => { requests.push({ url, options }); return new Response('', { status: 202 }); };
  assert.equal(await reportMirror(win, 'https://watch.workers.dev/report', { fetcher }), true);
  assert.equal(await reportMirror(win, 'https://watch.workers.dev/report', { fetcher }), true);
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].options.body), { origin: 'https://a.pages.dev' });
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.referrerPolicy, 'no-referrer');
  assert.equal(await reportMirror(win, 'https://replacement.workers.dev/report', { fetcher }), true);
  assert.equal(requests.length, 2);
});
test('unconfigured workers and transient failures remain retryable on a later visit', async () => {
  const win = fixture(); let calls = 0;
  const fetcher = async () => new Response('', { status: ++calls === 1 ? 503 : 200 });
  assert.equal(await reportMirror(win, 'https://watch.workers.dev/report', { fetcher }), false);
  assert.equal(await reportMirror(win, 'https://watch.workers.dev/report', { fetcher }), true);
  assert.equal(calls, 2);
});
test('embeds, local previews and empty configuration never report', async () => {
  const fetcher = () => { throw new Error('Unexpected request'); };
  const win = fixture(); win.top = {};
  assert.equal(await reportMirror(win, 'https://watch.workers.dev/report', { fetcher }), false);
  assert.equal(await reportMirror(fixture('http://localhost:4173'), 'https://watch.workers.dev/report', { fetcher }), false);
  assert.equal(await reportMirror(fixture('https://monkeh-browser.robert360254.chatgpt.site'), 'https://watch.workers.dev/report', { fetcher }), false);
  assert.equal(await reportMirror(fixture(), '', { fetcher }), false);
});
test('report setup waits for page load and idle time', () => {
  const win = fixture(); const events = new Map(); let idleCalls = 0;
  win.document = { readyState: 'loading' }; win.addEventListener = (name, fn) => events.set(name, fn);
  win.requestIdleCallback = () => idleCalls++;
  scheduleMirrorReport(win); assert.equal(idleCalls, 0);
  events.get('load')(); assert.equal(idleCalls, 1);
});
