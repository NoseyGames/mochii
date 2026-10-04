import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../browser-tools/config.js', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const shell = 'https://testingproductionubgdontgo.pages.dev';
const proxy = 'https://monkeh.1234-imwatchingyouopenthedoor.workers.dev';
function context(url) {
  let requests = 0;
  let redirect;
  const location = new URL(url);
  location.replace = value => { redirect = value; };
  const page = vm.createContext({ location, URL, Response,
    fetch() { requests++; throw new Error('A static site has no API'); },
  });
  vm.runInContext(source, page);
  return { page, get requests() { return requests; }, get redirect() { return redirect; } };
}

test('production and local static hosts share an immutable server list without API requests', async () => {
  for (const [app, host] of [[shell, proxy], ['http://localhost:4173', 'http://localhost:4174'], ['http://127.0.0.1:4173', 'http://127.0.0.1:4174']]) {
    for (const origin of [app, host]) {
      const fixture = context(origin + '/math.html');
      const config = await fixture.page.MonkehConfig.fetchConfig();
      assert.equal(config.mode, 'static');
      assert.equal(config.proxyOrigin, host);
      assert.equal(config.shellOrigins[0], app);
      assert.equal(config.requiresAuthentication, false);
      assert.equal(config.wispEndpoints.length, 30);
      assert.equal(config.maxWispBackups, 31);
      assert.equal(new Set(config.wispEndpoints.map(entry => new URL(entry.url).href)).size, config.wispEndpoints.length);
      assert(Object.isFrozen(config.wispEndpoints));
      for (const endpoint of config.wispEndpoints) {
        assert(Object.isFrozen(endpoint));
        const url = new URL(endpoint.url);
        assert.equal(url.protocol, 'wss:');
        assert.equal(url.username + url.password + url.hash, '');
      }
      assert.equal(fixture.requests, 0);
    }
  }
});

test('unknown mirrors fail closed and never try parsing a static fallback as JSON', async () => {
  const fixture = context('https://unknown.example/math');
  await assert.rejects(fixture.page.MonkehConfig.fetchConfig(), /not configured/);
  assert.equal(fixture.requests, 0);
});

test('the owner-supplied endpoint paths are preserved and only the limited Worker is fallback-only', async () => {
  const config = await context(shell + '/math').page.MonkehConfig.fetchConfig();
  const urls = config.wispEndpoints.map(entry => entry.url);
  for (const url of ['wss://wisp.mercurywork.shop/', 'wss://wispserver.dev/wisp', 'wss://admin.proxy.hydrovolter.com/scramjet/wisp/',
    'wss://henhouse.social/relay', 'wss://nostr.me/relay', 'wss://anura.pro/', 'wss://anura.pro/wisp/', 'wss://wisp.solife.me/']) {
    assert(urls.includes(url), url);
  }
  const fallbacks = config.wispEndpoints.filter(entry => entry.fallback);
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].url, proxy.replace('https:', 'wss:') + '/wisp/');
});

test('shell entry from proxy or Pages previews goes to canonical app preserving navigation', () => {
  for (const origin of [proxy, 'https://abc123.testingproductionubgdontgo.pages.dev']) {
    const fixture = context(origin + '/math?view=apps#desktop');
    assert.equal(fixture.page.MonkehConfig.redirectShell(), true);
    assert.equal(fixture.redirect, shell + '/math?view=apps#desktop');
  }
  const fixture = context(shell + '/math');
  assert.equal(fixture.page.MonkehConfig.redirectShell(), false);
  assert.equal(fixture.redirect, undefined);
});

test('static service worker proxies only on the isolated origin without an API', async () => {
  for (const [origin, expected] of [[shell, 403], [proxy, 200]]) {
    const fixture = context(origin + '/sw.js');
    const events = new Map();
    fixture.page.importScripts = () => {};
    fixture.page.__uv$config = {};
    fixture.page.self = { location: fixture.page.location, addEventListener: (type, listener) => events.set(type, listener) };
    fixture.page.UVServiceWorker = class {
      route() { return true; }
      fetch() { return new Response('proxy success'); }
    };
    vm.runInContext(workerSource, fixture.page);
    let response;
    events.get('fetch')({ request: { url: origin + '/service/test' }, respondWith(value) { response = value; } });
    assert.equal((await response).status, expected);
    assert.equal(fixture.requests, 0);
  }
});
