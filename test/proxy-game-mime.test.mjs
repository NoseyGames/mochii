import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const uvSource = readFileSync(new URL('../ultrav/uv.sw.js', import.meta.url), 'utf8');
const origin = 'https://proxy.test';
const game = 'https://cdn.jsdelivr.net/gh/zennedu/3kh@aba902390fff20765e8e11e4b631b6e5664e17c3/m06557be/index.html';

function worker({ body = '<!DOCTYPE html><html><body>Game</body></html>', type = 'text/plain; charset=utf-8', status = 200, finalURL = game } = {}) {
  const events = new Map();
  const rewrites = [];
  let clients = 0;
  let requests = 0;
  class Ultraviolet {
    static EventEmitter = EventEmitter;
    static BareClient = class {
      constructor() { clients++; }
      async fetch() {
        requests++;
        const response = new Response(body, { status, headers: { 'Content-Type': type, 'X-Frame-Options': 'DENY', 'X-Test': 'original' } });
        response.rawHeaders = Object.fromEntries(response.headers);
        response.rawResponse = { body: response.body, status, headers: response.rawHeaders };
        response.finalURL = finalURL;
        return response;
      }
    };
    constructor(config) {
      this.config = config;
      this.meta = {};
      this.cookie = { db: async () => ({}), getCookies: async () => [], serialize: () => '', setCookies: async () => {} };
      this.js = { rewrite: value => value };
    }
    sourceUrl(value) { return value.startsWith(origin + '/service/') ? decodeURIComponent(value.slice((origin + '/service/').length)) : value; }
    rewriteHtml(value) { rewrites.push(value); return '<html data-rewritten>' + value + '</html>'; }
    createHtmlInject() { return ''; }
  }
  const context = vm.createContext({
    URL, Response, Request, ReadableStream, Uint8Array, TextDecoder, Proxy, Reflect,
    navigator: { userAgent: 'Monkeh test' }, crossOriginIsolated: false, console,
    __uv$config: { prefix: '/service/', encodeUrl: encodeURIComponent, decodeUrl: decodeURIComponent },
    MonkehConfig: { async fetchConfig() { return { proxyOrigin: origin }; } },
    Ultraviolet,
    location: { origin },
    addEventListener(name, listener) { events.set(name, listener); },
    importScripts(path) { if (path === '/ultrav/uv.sw.js') vm.runInContext(uvSource, context); }
  });
  context.self = context;
  vm.runInContext(source, context);
  async function navigate(url = game, destination = 'iframe', method = 'GET') {
    const request = new Request(origin + '/service/' + encodeURIComponent(url), { method });
    Object.defineProperty(request, 'destination', { value: destination });
    let response;
    events.get('fetch')({ request, respondWith(value) { response = value; } });
    return response;
  }
  return { navigate, rewrites, get clients() { return clients; }, get requests() { return requests; } };
}

test('known CDN game HTML is repaired before the real UV document rewrite pipeline', async () => {
  for (const url of [game, 'https://cdn.jsdelivr.net/gh/zennedu/hydra@4afc772e861d3df34427623bbc4afa7ce1fbb067/m551560d/m329ecec.html',
    'https://cdn.jsdelivr.net/gh/securlycdn/html@main/0.html', 'https://cdn.jsdelivr.net/gh/securlycdn/html/0.html']) {
    const app = worker({ finalURL: url });
    const response = await app.navigate(url);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await response.text(), /data-rewritten/);
    assert.equal(app.rewrites.length, 1);
    assert.equal(response.headers.get('x-frame-options'), null, 'normal UV header processing still runs');
    assert.equal(response.headers.get('x-test'), 'original');
    assert.equal(app.requests, 1, 'no destination replay');
    assert.equal(app.clients, 1, 'the scoped repair shares the existing BareMux client');
  }
});

test('HTML detection supports chunk boundaries and preserves every input byte', async () => {
  const chunks = ['\ufeff \n<!DOC', 'TYPE html><html><body>', 'x'.repeat(5000), '</body></html>'];
  let index = 0;
  const body = new ReadableStream({ pull(controller) {
    if (index === chunks.length) controller.close();
    else controller.enqueue(new TextEncoder().encode(chunks[index++]));
  } });
  const app = worker({ body });
  const response = await app.navigate();
  await response.text();
  assert.equal(app.rewrites[0], chunks.join('').replace(/^\ufeff/, ''));
});

test('non-HTML and an HTML prefix beyond the bounded sniff are not promoted to executable documents', async () => {
  for (const body of ['{"error":"not html"}', 'Not found', ' '.repeat(1024) + '<html>Late markup</html>']) {
    const app = worker({ body });
    const response = await app.navigate();
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await response.text(), body);
    assert.equal(app.rewrites.length, 0);
  }
});

test('data requests, scripts, failed responses, POSTs and other repositories retain original MIME', async () => {
  for (const options of [
    { destination: '' }, { destination: 'script' }, { method: 'POST' }, { status: 404 },
    { type: 'application/json' }, { url: 'https://cdn.jsdelivr.net/gh/another/repo/index.html' },
    { url: 'https://cdn.jsdelivr.net/gh/securlycdn/other@main/0.html' },
    { url: 'https://cdn.jsdelivr.net/gh/securlycdn/html-extra@main/0.html' },
    { url: 'https://unrelated.test/gh/zennedu/3kh/index.html' },
    { url: 'https://cdn.jsdelivr.net/gh/zennedu/3kh/index.js' },
    { finalURL: 'https://unrelated.test/redirected.html' }
  ]) {
    const url = options.url || game;
    const app = worker({ ...options, finalURL: options.finalURL || url });
    const response = await app.navigate(url, options.destination ?? 'iframe', options.method || 'GET');
    assert.equal(response.headers.get('content-type'), options.type || 'text/plain; charset=utf-8', JSON.stringify(options));
    assert.equal(app.rewrites.length, 0, JSON.stringify(options));
  }
});
