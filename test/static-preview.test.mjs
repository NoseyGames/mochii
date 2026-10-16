import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createStaticPreview } from '../scripts/serve-static.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mochii-static-preview-'));
  const root = join(directory, 'dist');
  await mkdir(root);
  for (const [path, content] of Object.entries({
    'index.html': '<h1>Mochii</h1>', 'math.html': '<h1>Browser</h1>',
    'flyflix.html': '<h1>Movies</h1>', 'apps/mochii-cloud.html': '<h1>Games</h1>',
    'browser-tools/config.js': 'globalThis.config = {};', 'sw.js': 'self.onfetch = () => {};',
    'bearmux/epoxy/index.mjs': 'export default {};', 'engine.wasm': '\0asm',
    'catalog.json': '{"items":[]}', 'song.mp3': 'audio', 'track.ogg': 'ogg',
    'style.css': 'body{}', 'secret.txt': 'internal preview fixture',
  })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const server = await createStaticPreview({ directory: root, port: 0 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    await rm(directory, { recursive: true, force: true });
  });
  const port = server.address().port;
  function get(path, options = {}) {
    return new Promise((done, reject) => {
      const outgoing = request({ hostname: '127.0.0.1', port, path, method: 'GET', ...options }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => done({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
        response.on('error', reject);
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
  }
  return { root, directory, server, get, port };
}

test('static preview binds only loopback and serves browser, game and movie routes without a second origin', async t => {
  const app = await fixture(t);
  assert.equal(app.server.address().address, '127.0.0.1');
  for (const [path, body] of [['/', '<h1>Mochii</h1>'], ['/math', '<h1>Browser</h1>'], ['/math.html', '<h1>Browser</h1>'], ['/flyflix?search=movie', '<h1>Movies</h1>'], ['/apps/mochii-cloud', '<h1>Games</h1>'], ['/math?target=https%3A%2F%2Fexample.com%2F..%2F%25', '<h1>Browser</h1>']]) {
    const response = await app.get(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.body, body, path);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(response.headers['cache-control'], 'no-store, max-age=0');
    assert.equal(response.headers.pragma, 'no-cache');
    assert.equal(response.headers.expires, '0');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
});

test('preview MIME types allow JavaScript modules, service workers, WASM, JSON and audio to load', async t => {
  const app = await fixture(t);
  for (const [path, type] of [['/browser-tools/config.js', 'text/javascript; charset=utf-8'], ['/sw.js', 'text/javascript; charset=utf-8'], ['/bearmux/epoxy/index.mjs', 'text/javascript; charset=utf-8'], ['/engine.wasm', 'application/wasm'], ['/catalog.json', 'application/json; charset=utf-8'], ['/song.mp3', 'audio/mpeg'], ['/track.ogg', 'audio/ogg'], ['/style.css', 'text/css; charset=utf-8']]) {
    const response = await app.get(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers['content-type'], type, path);
    assert.equal(response.headers['cache-control'], 'no-store, max-age=0');
  }
});

test('HEAD matches GET metadata without returning the asset or error body', async t => {
  const app = await fixture(t);
  for (const path of ['/math', '/engine.wasm', '/missing.js']) {
    const get = await app.get(path);
    const head = await app.get(path, { method: 'HEAD' });
    assert.equal(head.status, get.status);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], String(Buffer.byteLength(get.body)));
    assert.equal(head.headers['content-type'], get.headers['content-type']);
  }
});

test('unknown assets and APIs return real non-HTML 404s without an app fallback or directory listing', async t => {
  const app = await fixture(t);
  await mkdir(join(app.root, 'api'), { recursive: true });
  await writeFile(join(app.root, 'api', 'assist.html'), '<h1>Must not become an API</h1>');
  for (const path of ['/api/assist', '/api/music/search?q=hello', '/missing.js', '/missing', '/apps/', '/browser-tools', '/math.html/']) {
    const response = await app.get(path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(response.body, 'Not found.\n');
  }
});

test('preview rejects traversal, encoded separators, malformed paths and nonlocal Host headers', async t => {
  const app = await fixture(t);
  await writeFile(join(app.directory, 'outside.txt'), 'must not be served');
  for (const path of ['/../outside.txt', '/%2e%2e/outside.txt', '/folder/%2e%2e/%2e%2e/outside.txt', '/%2e%2e%5coutside.txt', '/folder%2f..%2f..%2foutside.txt', '//outside.txt', '/%00', '/%ZZ', '/.env', '/secret.txt:stream', '/secret.txt%5c', 'https://evil.example/math']) {
    const response = await app.get(path);
    assert.equal(response.status, 400, path);
    assert.equal(response.body, 'Invalid request path.\n');
  }
  for (const host of ['evil.example', '127.0.0.1.evil.example', `user@127.0.0.1:${app.port}`, '127.0.0.1:1']) {
    const response = await app.get('/math', { headers: { Host: host } });
    assert.equal(response.status, 403, host);
  }
  assert.equal((await app.get('/math', { headers: { Host: `localhost:${app.port}` } })).status, 200);
});

test('preview rejects directory symlinks inside and outside dist and a symlinked root', async t => {
  const app = await fixture(t);
  const outside = join(app.directory, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'private.html'), 'must not be served');
  await symlink(outside, join(app.root, 'escape'), 'junction');
  await symlink(join(app.root, 'apps'), join(app.root, 'alias'), 'junction');
  await symlink(app.root, join(app.directory, 'linked-root'), 'junction');
  for (const path of ['/escape/private.html', '/escape/private', '/alias/mochii-cloud.html']) {
    assert.equal((await app.get(path)).status, 404, path);
  }
  await assert.rejects(createStaticPreview({ directory: join(app.directory, 'linked-root'), port: 0 }), /regular directory/);
});

test('preview rejects write methods and invalid listening ports', async t => {
  const app = await fixture(t);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await app.get('/math', { method });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.allow, 'GET, HEAD');
  }
  for (const port of [-1, 65536, 1.5, '4173', NaN]) {
    await assert.rejects(createStaticPreview({ directory: app.root, port }), /Preview port/);
  }
});
