import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { handleAssist } from '../workers/assist.mjs';

const source = readFileSync(new URL('../browser-tools/config.js', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const shell = 'https://testingproductionubgdontgo.pages.dev';
const proxy = 'https://monkeh.1234-imwatchingyouopenthedoor.workers.dev';
const mirrors = ['https://monkeh-noseygames.netlify.app', 'https://monkeh-browser.robert360254.chatgpt.site'];
const productionShells = [shell, ...mirrors];
const untrustedOrigins = [
  'https://unknown.example', 'https://monkeh.vercel.app', 'https://monkeh-git-main-other.vercel.app',
  'https://other-monkeh.netlify.app', 'https://deploy-preview-1--monkeh-noseygames.netlify.app',
  'https://branch--monkeh-noseygames.netlify.app', 'https://monkeh-noseygames.netlify.app.attacker.example',
  'https://monkeh-browser.other-user.chatgpt.site', 'https://different-project.robert360254.chatgpt.site',
  'https://preview.monkeh-browser.robert360254.chatgpt.site', 'https://monkeh-browser.robert360254.chatgpt.site.attacker.example',
  'http://monkeh-noseygames.netlify.app', 'https://monkeh-noseygames.netlify.app:8443',
  'https://attacker.testingproductionubgdontgo.pages.dev.attacker.example',
];
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
      assert.deepEqual(Array.from(config.shellOrigins), app === shell ? productionShells : [app]);
      assert(Object.isFrozen(config.shellOrigins));
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
  for (const origin of untrustedOrigins) {
    const fixture = context(origin + '/math');
    await assert.rejects(fixture.page.MonkehConfig.fetchConfig(), /not configured/, origin);
    assert.equal(fixture.requests, 0);
    assert.equal(fixture.page.MonkehConfig.redirectShell(), false, origin);
    assert.equal(fixture.redirect, undefined);
  }
});

test('each confirmed production mirror stays on its own URL and shares the complete exact bridge allowlist', async () => {
  for (const origin of [...productionShells, proxy]) {
    const fixture = context(origin + '/math.html?view=apps#desktop');
    const config = await fixture.page.MonkehConfig.fetchConfig();
    assert.equal(config.proxyOrigin, proxy);
    assert.deepEqual(Array.from(config.shellOrigins), productionShells);
    assert(Object.isFrozen(config.shellOrigins));
    if (productionShells.includes(origin)) {
      assert.equal(fixture.page.MonkehConfig.redirectShell(), false);
      assert.equal(fixture.redirect, undefined, 'listed shells remain independent entrypoints');
    }
    assert.equal(fixture.requests, 0);
  }
});

test('local configurations keep only their own shell and proxy pair', async () => {
  for (const hostname of ['localhost', '127.0.0.1']) {
    for (const port of [4173, 4174]) {
      const fixture = context(`http://${hostname}:${port}/math`);
      const config = await fixture.page.MonkehConfig.fetchConfig();
      assert.deepEqual(Array.from(config.shellOrigins), [`http://${hostname}:4173`]);
      assert.equal(config.proxyOrigin, `http://${hostname}:4174`);
      assert.equal(fixture.page.MonkehConfig.redirectShell(), port === 4174);
      assert.equal(fixture.redirect, port === 4174 ? `http://${hostname}:4173/math` : undefined);
    }
  }
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
  for (const [origin, expected] of [
    ...productionShells.map(origin => [origin, 403]), [proxy, 200],
    ['https://abc123.testingproductionubgdontgo.pages.dev', 403],
    ['http://localhost:4173', 403], ['http://localhost:4174', 200],
    ['http://127.0.0.1:4173', 403], ['http://127.0.0.1:4174', 200],
    ...untrustedOrigins.map(origin => [origin, 403]),
  ]) {
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
    assert.equal((await response).status, expected, origin);
    assert.equal(fixture.requests, 0);
  }
});

test('deployed AI CORS allows exactly the confirmed shells while Wisp remains proxy-origin only', async () => {
  const { vars } = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(JSON.parse(vars.ASSIST_ALLOWED_ORIGINS), productionShells);
  assert.deepEqual(JSON.parse(vars.WISP_ALLOWED_ORIGINS), [proxy]);
  for (const origin of productionShells) {
    const response = await handleAssist(new Request(proxy + '/api/assist', { method: 'OPTIONS', headers: { Origin: origin } }), vars);
    assert.equal(response.status, 204, origin);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
  }
  for (const origin of [proxy, 'http://localhost:4173', 'https://abc123.testingproductionubgdontgo.pages.dev', ...untrustedOrigins]) {
    const response = await handleAssist(new Request(proxy + '/api/assist', { method: 'OPTIONS', headers: { Origin: origin } }), vars);
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
});
