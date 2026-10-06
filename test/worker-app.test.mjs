import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../workers/app.mjs';

const origin = 'https://monkeh.1234-imwatchingyouopenthedoor.workers.dev';
const shell = 'https://testingproductionubgdontgo.pages.dev';

test('retired Wisp routes fail immediately without reading request bodies or using bindings', async () => {
  const unavailable = new Proxy({}, { get() { throw new Error('Retired routes must not use a binding'); } });
  for (const path of ['/wisp', '/wisp/', '/wisp/obsolete', '/wisp/?v=2']) {
    for (const method of ['GET', 'POST']) {
      const request = { url: origin + path, method, get body() { throw new Error('Do not read request body'); } };
      const response = await worker.fetch(request, unavailable);
      assert.equal(response.status, 410);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.match((await response.json()).error, /retired/);
    }
  }
  const upgrade = await worker.fetch(new Request(origin + '/wisp/', { headers: { Upgrade: 'websocket', Origin: origin } }), unavailable);
  assert.equal(upgrade.status, 410);
});

test('isolated browser assets are still served and unrelated paths do not match the retired relay', async () => {
  const requested = [];
  const env = { ASSETS: { async fetch(request) { requested.push(request.url); return new Response('asset'); } } };
  for (const path of ['/proxy-host.html', '/proxy-bootstrap.html', '/sw.js', '/ultrav/uv.bundle.js', '/wisp-other']) {
    const response = await worker.fetch(new Request(origin + path), env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'asset');
  }
  assert.equal(requested.length, 5);
  const unknown = await worker.fetch(new Request(origin + '/api/unknown'), env);
  assert.equal(unknown.status, 404);
  assert.equal(requested.length, 5);
});

test('coding-help and music handlers remain available after Wisp removal', async () => {
  const env = { ASSIST_ALLOWED_ORIGINS: JSON.stringify([shell]), ASSETS: { fetch() { throw new Error('API requests must not reach static assets'); } } };
  for (const path of ['/api/assist', '/api/music/search']) {
    const response = await worker.fetch(new Request(origin + path, { method: 'OPTIONS', headers: { Origin: shell } }), env);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), shell);
  }
});
