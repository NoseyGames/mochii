import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAssist, MODEL } from '../workers/assist.mjs';

const origin = 'https://shell.example';
function request(body = { question: 'Explain const', code: 'const n = 2;' }, headers = {}, method = 'POST') {
  return new Request('https://proxy.example/api/assist', { method, headers: { origin, 'Content-Type': 'application/json', 'cf-connecting-ip': '192.0.2.1', ...headers }, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
}
function env(overrides = {}) {
  return { ENABLE_ASSIST: 'true', ASSIST_ALLOWED_ORIGINS: JSON.stringify([origin]), ASSIST_RATE: { limit: async () => ({ success: true }) }, ASSIST_GLOBAL_RATE: { limit: async () => ({ success: true }) }, AI: { run: async () => ({ response: 'An explanation.' }) }, ...overrides };
}

test('AI endpoint permits only explicit origins and JSON POSTs', async () => {
  assert.equal((await handleAssist(request({}, { origin: 'https://evil.example' }), env())).status, 403);
  assert.equal((await handleAssist(request({}, {}, 'GET'), env())).status, 405);
  assert.equal((await handleAssist(request({}, { 'Content-Type': 'text/plain' }), env())).status, 415);
  const preflight = await handleAssist(request({}, {}, 'OPTIONS'), env());
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), null);
});
test('AI endpoint rejects invalid, oversized and extra input before inference', async () => {
  let calls = 0;
  const config = env({ AI: { run: async () => { calls++; } } });
  for (const body of ['<html>', { question: '' }, { question: 'x'.repeat(2001) }, { question: 'x', code: 'c'.repeat(6001) }, { question: 'x', model: 'other' }, { question: 'x', code: {} }]) {
    assert.equal((await handleAssist(request(body), config)).status, 400);
  }
  assert.equal((await handleAssist(request('x'.repeat(32001)), config)).status, 413);
  assert.equal(calls, 0);
});
test('AI request enforces model and output limits and returns only answer', async () => {
  const response = await handleAssist(request(), env({ AI: { run: async (model, input) => {
    assert.equal(model, MODEL);
    assert.equal(input.max_tokens, 768);
    assert.equal(input.stream, false);
    assert.equal(input.messages.length, 2);
    assert.match(input.messages[1].content, /const n = 2/);
    return { response: '<script>plain text</script>', usage: 'private' };
  } } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { answer: '<script>plain text</script>' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('AI endpoint fails closed without bindings and rate limits before inference', async () => {
  for (const override of [{ ENABLE_ASSIST: 'false' }, { AI: undefined }, { ASSIST_RATE: undefined }]) assert.equal((await handleAssist(request(), env(override))).status, 503);
  const response = await handleAssist(request(), env({ ASSIST_RATE: { limit: async () => ({ success: false }) }, AI: { run: () => { throw new Error('should not run'); } } }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
});
test('provider errors and malformed answers do not expose internal information', async () => {
  const response = await handleAssist(request(), env({ AI: { run: async () => { throw new Error('SECRET internal value'); } } }));
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /SECRET/);
  assert.equal((await handleAssist(request(), env({ AI: { run: async () => ({ response: 42 }) } }))).status, 502);
});

test('slow request bodies expire after ten seconds and cancel without starting inference', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = 0;
  let inferenceCalls = 0;
  let completed = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"question":"unfinished')); },
    cancel() { cancelled++; },
  });
  const slowRequest = new Request('https://proxy.example/api/assist', {
    method: 'POST', duplex: 'half', body,
    headers: { origin, 'Content-Type': 'application/json', 'cf-connecting-ip': '192.0.2.1' },
  });
  const pending = handleAssist(slowRequest, env({ AI: { run: async () => { inferenceCalls++; return { response: 'Must not run' }; } } }));
  pending.then(() => { completed = true; });
  // Let both rate checks finish and the body reader consume its first chunk.
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  t.mock.timers.tick(9999);
  await Promise.resolve();
  assert.equal(completed, false);
  t.mock.timers.tick(1);
  const response = await pending;
  assert.equal(response.status, 408);
  assert.equal(cancelled, 1);
  assert.equal(inferenceCalls, 0);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('rate limits reject requests before acquiring or consuming their bodies', async () => {
  let readers = 0;
  const limitedRequest = {
    method: 'POST',
    headers: new Headers({ origin, 'Content-Type': 'application/json', 'cf-connecting-ip': '192.0.2.1' }),
    body: { getReader() { readers++; throw new Error('Request body must not be read'); } },
  };
  for (const overrides of [
    { ASSIST_RATE: { limit: async () => ({ success: false }) } },
    { ASSIST_GLOBAL_RATE: { limit: async () => ({ success: false }) } },
  ]) {
    const response = await handleAssist(limitedRequest, env(overrides));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '60');
  }
  assert.equal(readers, 0);
});
