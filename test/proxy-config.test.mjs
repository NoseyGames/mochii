import assert from 'node:assert/strict';
import test from 'node:test';
import '../browser-tools/config.js';

const { fetchConfig } = globalThis.MonkehConfig;
const json = (body, type = 'application/json') => new Response(body, { headers: { 'Content-Type': type } });

test('configuration requests are same-origin, uncached, bounded by a deadline and explicitly ask for JSON', async () => {
  const config = await fetchConfig({ fetch: async (url, options) => {
    assert.equal(url, '/api/config');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers.Accept, 'application/json');
    assert(options.signal instanceof AbortSignal);
    return json('{"proxyOrigin":"https://proxy.example"}', 'application/json; charset=utf-8');
  } });
  assert.equal(config.proxyOrigin, 'https://proxy.example');
});

test('HTML fallback is diagnosed whether honestly labelled or incorrectly labelled as JSON', async () => {
  for (const type of ['text/html', 'application/xhtml+xml', 'application/json']) {
    await assert.rejects(fetchConfig({ fetch: async () => json('<!DOCTYPE html><script>private response</script>', type) }), error => {
      assert.match(error.message, /proxy backend is not connected.*\/api\/config/);
      assert.doesNotMatch(error.message, /Unexpected token|private response/);
      return true;
    });
  }
});

test('HTTP failure, sign-in redirects and unexpected content types are not parsed as configuration', async () => {
  for (const [status, message] of [[401, /access was denied/], [403, /access was denied/], [404, /not found/], [502, /HTTP 502/]]) {
    await assert.rejects(fetchConfig({ fetch: async () => new Response('<html>error</html>', { status }) }), message);
  }
  const redirect = json('{}');
  Object.defineProperty(redirect, 'redirected', { value: true });
  await assert.rejects(fetchConfig({ fetch: async () => redirect }), /redirected/);
  await assert.rejects(fetchConfig({ fetch: async () => new Response('{}') }), /non-JSON configuration/);
});

test('malformed JSON and non-object configuration produce stable messages without reflecting the response', async () => {
  for (const body of ['{not valid private data', '', 'null', '[]', 'true', '1']) {
    await assert.rejects(fetchConfig({ fetch: async () => json(body) }), /invalid JSON|invalid configuration object/);
  }
  assert.deepEqual(await fetchConfig({ fetch: async () => json('{}', 'application/vnd.monkeh+json') }), {});
});

test('oversized declared and streamed config responses are cancelled', async () => {
  for (const declared of [false, true]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(65537)); },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'application/json', ...(declared ? { 'Content-Length': '65537' } : {}) } });
    await assert.rejects(fetchConfig({ fetch: async () => response }), /64 KiB/);
    assert.equal(cancelled, true);
  }
});

test('network failure and cancellation are actionable and a subsequent request can recover', async () => {
  await assert.rejects(fetchConfig({ fetch: async () => { throw new TypeError('Failed to fetch'); } }), /could not be reached/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchConfig({ signal: controller.signal, fetch: async (_url, options) => { options.signal.throwIfAborted(); } }), /cancelled or timed out/);
  assert.deepEqual(await fetchConfig({ fetch: async () => json('{}') }), {});
});
