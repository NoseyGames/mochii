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

const secureStaticOrigins = [
  ...productionShells, proxy, 'https://abc123.testingproductionubgdontgo.pages.dev',
  ...untrustedOrigins.filter(origin => origin.startsWith('https:')),
  'http://localhost:4173', 'http://localhost:4174', 'http://localhost:8090',
  'http://127.0.0.1:4173', 'http://127.0.0.1:4174', 'http://[::1]:8090',
];

test('static deployments share immutable external Wisp settings without origin configuration or API requests', async () => {
  for (const origin of secureStaticOrigins) {
    const fixture = context(origin + '/math.html');
    const config = await fixture.page.MonkehConfig.fetchConfig();
    assert.equal(config.mode, 'static', origin);
    assert(Object.isFrozen(config));
    for (const key of ['proxyOrigin', 'shellOrigin', 'shellOrigins']) assert.equal(Object.hasOwn(config, key), false, key);
    assert.equal(config.requiresAuthentication, false);
    assert.equal(config.wispEndpoints.length, 29);
    assert.equal(config.maxWispBackups, 31);
    assert.equal(new Set(config.wispEndpoints.map(entry => new URL(entry.url).href)).size, config.wispEndpoints.length);
    assert(Object.isFrozen(config.wispEndpoints));
    for (const endpoint of config.wispEndpoints) {
      assert(Object.isFrozen(endpoint));
      const url = new URL(endpoint.url);
      assert.equal(url.protocol, 'wss:');
      assert.equal(url.username + url.password + url.hash, '');
    }
    assert.equal(fixture.requests, 0, origin);
  }
});

test('every secure mirror keeps its URL and navigation without a shell redirect', async () => {
  for (const origin of secureStaticOrigins) {
    const url = origin + '/math.html?view=apps#desktop';
    const fixture = context(url);
    await fixture.page.MonkehConfig.fetchConfig();
    assert.equal(fixture.page.MonkehConfig.redirectShell(), false, origin);
    assert.equal(fixture.redirect, undefined, origin);
    assert.equal(fixture.page.location.href, url);
    assert.equal(fixture.requests, 0);
  }
});

test('insecure public and opaque static deployments reject configuration without contacting an API', async () => {
  for (const url of ['http://public.example/math', 'http://localhost.attacker.example/math', 'http://monkeh-noseygames.netlify.app/math', 'file:///math.html', 'data:text/html,test']) {
    const fixture = context(url);
    await assert.rejects(fixture.page.MonkehConfig.fetchConfig(), /HTTPS or localhost|Invalid URL/, url);
    assert.equal(fixture.requests, 0);
    assert.equal(fixture.page.MonkehConfig.redirectShell(), false);
    assert.equal(fixture.redirect, undefined);
  }
});

test('static configuration rejects credentials, paths and non-origin values', () => {
  const fixture = context('https://mirror.example/math');
  for (const value of ['https://user:pass@mirror.example', 'https://mirror.example/path', 'https://mirror.example?query=1', 'https://mirror.example#part', 'https://mirror.example/', 'null', '']) {
    assert.throws(() => fixture.page.MonkehConfig.staticConfig(value), /HTTPS or localhost|Invalid URL/, String(value));
  }
  assert.equal(fixture.requests, 0);
});

test('the owner-supplied endpoint paths are preserved and all configured relays are external', async () => {
  const config = await context(shell + '/math').page.MonkehConfig.fetchConfig();
  const urls = config.wispEndpoints.map(entry => entry.url);
  for (const url of ['wss://wisp.mercurywork.shop/', 'wss://wispserver.dev/wisp', 'wss://admin.proxy.hydrovolter.com/scramjet/wisp/',
    'wss://henhouse.social/relay', 'wss://nostr.me/relay', 'wss://anura.pro/', 'wss://anura.pro/wisp/', 'wss://wisp.solife.me/']) {
    assert(urls.includes(url), url);
  }
  assert.equal(config.wispEndpoints.some(entry => entry.fallback), false);
  assert.equal(config.wispEndpoints.some(entry => new URL(entry.url).hostname === new URL(proxy).hostname), false);
});

test('static service workers use each secure deployment without an API and reject insecure hosts', async () => {
  for (const [origin, expected] of [
    ...secureStaticOrigins.map(origin => [origin, 200]),
    ['http://public.example', 403], ['http://localhost.attacker.example', 403],
  ]) {
    const fixture = context(origin + '/sw.js');
    const events = new Map();
    let proxyFetches = 0;
    fixture.page.importScripts = () => {};
    fixture.page.__uv$config = {};
    fixture.page.self = { location: fixture.page.location, addEventListener: (type, listener) => events.set(type, listener) };
    fixture.page.UVServiceWorker = class {
      route() { return true; }
      fetch() { proxyFetches++; return new Response('proxy success'); }
    };
    vm.runInContext(workerSource, fixture.page);
    let response;
    events.get('fetch')({ request: { url: origin + '/service/test' }, respondWith(value) { response = value; } });
    assert.equal((await response).status, expected, origin);
    assert.equal(proxyFetches, expected === 200 ? 1 : 0, origin);
    assert.equal(fixture.requests, 0, origin);
  }
});

test('deployed AI CORS retains confirmed shells and removes only the retired Wisp bindings', async () => {
  const { vars, ai, ratelimits, assets } = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(JSON.parse(vars.ASSIST_ALLOWED_ORIGINS), productionShells);
  assert.equal(vars.ENABLE_WISP, undefined);
  assert.equal(vars.WISP_ALLOWED_ORIGINS, undefined);
  assert.deepEqual(ai, { binding: 'AI' });
  assert.deepEqual(ratelimits.map(binding => binding.name), ['ASSIST_RATE', 'ASSIST_GLOBAL_RATE', 'MUSIC_RATE']);
  assert.equal(assets.binding, 'ASSETS');
  assert.deepEqual(assets.run_worker_first, ['/api/*', '/wisp', '/wisp/*']);
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
