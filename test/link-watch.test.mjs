import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import worker, { MirrorLedger, validateOrigin, allowedHosts, webhookUrl, verifyMirror, deliverMirror, smallJson } from '../workers/link-watch.mjs';

const secret = `https://discord.com/api/webhooks/123456789012345678/${'a'.repeat(64)}`;
const origin = 'https://monkeh.pages.dev';
const marker = () => Response.json({ project: 'NoseyGames/monkeh', version: 1 });
const confirmed = () => Response.json({ id: '987654321098765432' });
const reportRequest = (target = origin, bodyOrigin = target) => new Request('https://watch.example.com/report', {
  method: 'POST', headers: { Origin: target, 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: bodyOrigin }),
});

function storageForTest(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let tail = Promise.resolve();
  const storage = {
    alarm: null,
    sql: {
      exec(query, ...bindings) {
        let rows;
        if (query.includes('CREATE TABLE IF NOT EXISTS')) { db.exec(query); rows = []; }
        else rows = db.prepare(query).all(...bindings);
        return { toArray: () => rows };
      },
    },
    transaction(operation) {
      const result = tail.then(async () => {
        db.exec('BEGIN');
        try { const value = await operation(); db.exec('COMMIT'); return value; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      });
      tail = result.catch(() => {});
      return result;
    },
    async getAlarm() { return storage.alarm; },
    async setAlarm(value) { storage.alarm = value; },
    async deleteAlarm() { storage.alarm = null; },
  };
  return storage;
}

function setup(t, options = {}) {
  const storage = storageForTest(t);
  let now = Date.UTC(2026, 9, 4);
  const requests = [];
  const env = { DISCORD_WEBHOOK_URL: secret, ...options.env };
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    return options.fetch ? options.fetch(url, init) : String(url).endsWith('/monkeh-mirror.json') ? marker() : confirmed();
  };
  let ledger = new MirrorLedger({ storage }, env, { fetch: fetcher, now: () => now });
  env.MIRROR_LEDGER = { idFromName: name => name, get: () => ({ fetch: request => ledger.fetch(request) }) };
  return {
    env, storage, requests,
    get ledger() { return ledger; },
    get now() { return now; },
    set now(value) { now = value; },
    report(target = origin) { return ledger.fetch(reportRequest(target)); },
    async fire(at = storage.alarm) { assert.equal(typeof at, 'number'); now = at; storage.alarm = null; await ledger.alarm(); },
    replace(newEnv = env) { ledger = new MirrorLedger({ storage }, newEnv, { fetch: fetcher, now: () => now }); },
    state(target = origin) { return storage.sql.exec('SELECT * FROM mirrors WHERE origin = ?', target).toArray()[0]; },
    sent() { return requests.filter(request => request.init.method === 'POST'); },
    verified() { return requests.filter(request => String(request.url).endsWith('/monkeh-mirror.json')); },
  };
}

test('mirror origins require canonical public HTTPS names within configured hosting domains', () => {
  for (const value of [origin, 'https://project.account.workers.dev', 'https://name.github.io']) assert.equal(validateOrigin(value), value);
  for (const value of [null, '', 'https://pages.dev', 'https://evilpages.dev', 'http://monkeh.pages.dev', 'https://monkeh.pages.dev/', 'https://monkeh.pages.dev:443', 'https://monkeh.pages.dev:8443', 'https://MONKEH.pages.dev', 'https://user@monkeh.pages.dev', 'https://monkeh.pages.dev/path', 'https://monkeh.pages.dev?x=1', 'https://monkeh.pages.dev#x', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://host.local', 'https://private.chatgpt.site']) {
    assert.equal(validateOrigin(value), null, String(value));
  }
  assert.equal(validateOrigin('https://games.my-own-site.com', { ALLOWED_CUSTOM_HOSTS: 'games.my-own-site.com' }), 'https://games.my-own-site.com');
  assert.equal(validateOrigin('https://other.my-own-site.com', { ALLOWED_CUSTOM_HOSTS: 'games.my-own-site.com' }), null);
  assert.equal(validateOrigin(origin, { ALLOWED_HOST_SUFFIXES: '', ALLOWED_CUSTOM_HOSTS: 'monkeh.pages.dev' }), origin);
  assert.throws(() => allowedHosts({ ALLOWED_CUSTOM_HOSTS: '127.0.0.1,host.local' }));
});

test('webhook secrets are restricted to Discord execute-webhook URLs', () => {
  assert.equal(webhookUrl(secret), secret + '?wait=true');
  for (const value of [undefined, 'https://attacker.com/api/webhooks/123/secret', secret + '?wait=false', secret + '#token', secret.replace('discord.com', 'discord.com.attacker.net'), secret.replace('https:', 'http:'), secret.replace('https://', 'https://user@'), 'https://discord.com/api/webhooks/123/no']) assert.equal(webhookUrl(value), null);
});

test('verification fetches only a small JSON marker without redirects or credentials', async () => {
  assert.equal(await verifyMirror(origin, async (url, init) => {
    assert.equal(url, origin + '/monkeh-mirror.json');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, undefined);
    assert.ok(init.signal instanceof AbortSignal);
    return marker();
  }), true);
  const responses = [
    () => Response.redirect('https://elsewhere.pages.dev/marker'),
    () => Response.json({ project: 'other/project', version: 1 }),
    () => Response.json({ project: 'NoseyGames/monkeh', version: '1' }),
    () => new Response('{"project":"NoseyGames/monkeh","version":1}', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('x'.repeat(2049), { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } }),
  ];
  for (const response of responses) assert.equal(await verifyMirror(origin, async () => response()), false);
  assert.equal(await verifyMirror(origin, async () => { throw new Error('fetch denied'); }), false);
});

test('body limits apply to streamed bytes even without a trustworthy content-length', async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(513)); controller.close(); } }));
  await assert.rejects(smallJson(response, 512), /large/);
  await assert.rejects(smallJson(new Response('{}', { headers: { 'Content-Length': '10000000' } }), 512), /large/);
  const controller = new AbortController();
  const stalled = smallJson(new Response(new ReadableStream({ start() {} })), 512, controller.signal);
  controller.abort();
  await assert.rejects(stalled);
});

test('report CORS is exact, body origin cannot differ, and missing secrets never queue', async t => {
  const f = setup(t);
  const preflight = await worker.fetch(new Request('https://watch.example.com/report', { method: 'OPTIONS', headers: { Origin: origin } }), f.env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  const mismatch = await worker.fetch(reportRequest(origin, 'https://other.pages.dev'), f.env);
  assert.equal(mismatch.status, 403);
  assert.equal(f.requests.length, 0);
  const absent = await worker.fetch(reportRequest(), { MIRROR_LEDGER: f.env.MIRROR_LEDGER });
  assert.equal(absent.status, 503);
  assert.equal(f.state(), undefined);
  const denied = await worker.fetch(reportRequest('https://attacker.com'), f.env);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const accepted = await worker.fetch(reportRequest(), f.env);
  assert.equal(accepted.status, 202);
  assert.equal(accepted.headers.get('access-control-allow-origin'), origin);
  assert.equal(f.state().status, 'queued');
});

test('concurrent repeated reports validate and enqueue once, and delivered origins survive restarts forever', async t => {
  let release;
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  const f = setup(t, { fetch: url => String(url).endsWith('/monkeh-mirror.json') ? (started(), new Promise(resolve => { release = () => resolve(marker()); })) : confirmed() });
  const first = f.report();
  await pending;
  const duplicates = await Promise.all(Array.from({ length: 15 }, () => f.report()));
  assert.ok(duplicates.every(response => response.status === 409));
  assert.equal(f.verified().length, 1);
  release();
  assert.equal((await first).status, 202);
  assert.equal((await f.report()).status, 200);
  await f.fire();
  assert.equal(f.state().status, 'delivered');
  assert.equal(f.state().message_id, '987654321098765432');
  f.now += 366 * 86400000;
  f.replace();
  assert.equal((await f.report()).status, 200);
  await f.ledger.alarm();
  assert.equal(f.sent().length, 1);
  assert.equal(f.verified().length, 1);
  assert.equal(f.storage.alarm, null);
});

test('failed verification is negatively cached and never produces Discord messages', async t => {
  let valid = false;
  const f = setup(t, { fetch: () => valid ? marker() : Response.json({ project: 'wrong', version: 1 }) });
  assert.equal((await f.report()).status, 422);
  assert.equal((await f.report()).status, 422);
  assert.equal(f.verified().length, 1);
  assert.equal(f.state(), undefined);
  assert.equal(f.storage.alarm, null);
  f.now += 300001;
  valid = true;
  assert.equal((await f.report()).status, 202);
  assert.equal(f.verified().length, 2);
  assert.equal(f.sent().length, 0);
});

test('Discord rate limits persist as queued work and honor retry_after before successful delivery', async t => {
  let sends = 0;
  const f = setup(t, { fetch: url => String(url).endsWith('/monkeh-mirror.json') ? marker() : ++sends === 1 ? Response.json({ retry_after: 90 }, { status: 429 }) : confirmed() });
  await f.report();
  await f.fire();
  assert.equal(f.state().status, 'queued');
  assert.equal(f.state().message_id, null);
  const due = f.now + 90000;
  assert.equal(f.storage.alarm, due);
  await f.fire(due - 1);
  assert.equal(f.sent().length, 1);
  await f.fire(due);
  assert.equal(f.sent().length, 2);
  assert.equal(f.state().status, 'delivered');
  const sent = JSON.parse(f.sent()[1].init.body);
  assert.deepEqual(sent.allowed_mentions, { parse: [] });
  assert.equal(sent.content, `New Monkeh mirror\n<${origin}>`);
  assert.equal(f.sent()[1].init.redirect, 'error');
});

test('repeated rate-limit rejections have bounded persistent retries without false delivery', async t => {
  const f = setup(t, { fetch: url => String(url).endsWith('/monkeh-mirror.json') ? marker() : Response.json({ retry_after: 60 }, { status: 429 }) });
  await f.report();
  for (let attempt = 1; attempt <= 8; attempt++) {
    f.replace();
    await f.fire();
    assert.equal(f.state().attempts, attempt);
    assert.equal(f.state().message_id, null);
  }
  assert.equal(f.state().status, 'failed');
  assert.equal(f.state().error_code, 'retry_exhausted');
  assert.equal(f.storage.alarm, null);
  assert.equal((await f.report()).status, 200);
  assert.equal(f.sent().length, 8);
});

test('Discord server errors remain uncertain across restarts and reports without duplicate sends', async t => {
  for (const status of [500, 502, 503, 504]) {
    const f = setup(t, { fetch: url => String(url).endsWith('/monkeh-mirror.json') ? marker() : new Response(null, { status }) });
    assert.equal((await f.report()).status, 202);
    await f.fire();
    assert.equal(f.state().status, 'uncertain');
    assert.equal(f.state().error_code, 'discord_5xx');
    assert.equal(f.state().message_id, null);
    assert.equal(f.storage.alarm, null);
    f.replace();
    assert.equal((await f.report()).status, 200);
    await f.ledger.alarm();
    assert.equal(f.sent().length, 1);
    assert.equal(f.state().attempts, 1);
    assert.equal(f.storage.alarm, null);
  }
});

test('permanent errors stop retrying and invalid webhooks pause the queue until the secret changes', async t => {
  const invalid = setup(t, { fetch: url => String(url).endsWith('/monkeh-mirror.json') ? marker() : new Response(null, { status: 400 }) });
  await invalid.report();
  await invalid.fire();
  assert.equal(invalid.state().status, 'failed');
  assert.equal(invalid.state().error_code, 'discord_400');
  assert.equal(invalid.storage.alarm, null);
  let recovered = false;
  const blocked = setup(t, { fetch: url => String(url).endsWith('/monkeh-mirror.json') ? marker() : recovered ? confirmed() : new Response(null, { status: 404 }) });
  await blocked.report();
  await blocked.fire();
  assert.equal(blocked.state().status, 'queued');
  assert.equal(blocked.storage.alarm, null);
  assert.equal((await blocked.report()).status, 503);
  const unhealthy = await (await blocked.ledger.fetch(new Request('https://ledger.internal/health'))).json();
  assert.equal(unhealthy.ready, false);
  recovered = true;
  blocked.env.DISCORD_WEBHOOK_URL = secret.replace(/a{64}$/, 'b'.repeat(64));
  blocked.replace();
  assert.equal((await (await blocked.ledger.fetch(new Request('https://ledger.internal/health'))).json()).ready, true);
  await blocked.fire();
  assert.equal(blocked.state().status, 'delivered');
  assert.equal(blocked.sent().length, 2);
});

test('unknown outcomes and interrupted in-flight deliveries are held without automatic resend', async t => {
  const f = setup(t, { fetch: url => {
    if (String(url).endsWith('/monkeh-mirror.json')) return marker();
    throw new Error('The response was lost after the server might have accepted the message');
  } });
  await f.report();
  await f.fire();
  assert.equal(f.state().status, 'uncertain');
  assert.equal(f.state().message_id, null);
  f.replace();
  await f.report();
  await f.ledger.alarm();
  assert.equal(f.sent().length, 1);
  assert.equal(f.storage.alarm, null);
  const other = 'https://interrupted.pages.dev';
  f.storage.sql.exec("INSERT INTO mirrors(origin, status, attempts, next_at, created_at, updated_at) VALUES (?, 'sending', 1, ?, ?, ?)", other, f.now - 1, f.now - 40000, f.now - 40000);
  f.replace();
  await f.ledger.alarm();
  assert.equal(f.state(other).status, 'uncertain');
  assert.equal(f.state(other).error_code, 'interrupted_delivery');
  assert.equal(f.sent().length, 1);
});

test('unknown successful responses do not authorize a duplicate retry', async () => {
  assert.equal((await deliverMirror(webhookUrl(secret), origin, async () => new Response(null, { status: 204 }))).kind, 'uncertain');
  assert.equal((await deliverMirror(webhookUrl(secret), origin, async () => Response.json({ ok: true }))).kind, 'uncertain');
});

test('validation and new-mirror limits bound unauthenticated reports', async t => {
  const f = setup(t);
  for (let index = 0; index < 6; index++) assert.equal((await f.report(`https://mirror${index}.pages.dev`)).status, 202);
  assert.equal((await f.report('https://rate-limited.pages.dev')).status, 429);
  assert.equal(f.verified().length, 6);
  f.now += 60000;
  for (let index = 6; index < 10; index++) assert.equal((await f.report(`https://mirror${index}.pages.dev`)).status, 202);
  assert.equal((await f.report('https://hourly-limit.pages.dev')).status, 429);
  assert.equal(f.state('https://hourly-limit.pages.dev'), undefined);
});

test('queue bounds are rechecked after concurrent validations complete', async t => {
  const releases = [];
  const f = setup(t, { fetch: () => new Promise(resolve => releases.push(() => resolve(marker()))) });
  for (let index = 0; index < 99; index++) f.storage.sql.exec("INSERT INTO mirrors(origin, status, next_at, created_at, updated_at) VALUES (?, 'queued', ?, ?, ?)", `https://stored${index}.pages.dev`, f.now, f.now, f.now);
  const reports = [f.report('https://new-a.pages.dev'), f.report('https://new-b.pages.dev')];
  while (releases.length < 2) await new Promise(resolve => setImmediate(resolve));
  releases.forEach(release => release());
  const statuses = (await Promise.all(reports)).map(response => response.status).sort();
  assert.deepEqual(statuses, [202, 429]);
  assert.equal(f.storage.sql.exec("SELECT COUNT(*) AS count FROM mirrors WHERE status = 'queued'").toArray()[0].count, 100);
});

test('health reveals counts and readiness without URLs or webhook secrets; no public send endpoint exists', async t => {
  const f = setup(t);
  await f.report();
  const response = await worker.fetch(new Request('https://watch.example.com/health'), f.env);
  const content = await response.text();
  assert.doesNotMatch(content, /https:|discord|webhooks|monkeh\.pages/);
  const health = JSON.parse(content);
  assert.equal(health.ready, true);
  assert.equal(health.counts.queued, 1);
  assert.equal((await worker.fetch(new Request('https://watch.example.com/test-send'), f.env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://watch.example.com/links'), f.env)).status, 404);
  const missing = await (await worker.fetch(new Request('https://watch.example.com/health'), {})).json();
  assert.deepEqual(missing.configured, { webhook: false, ledger: false });
  assert.equal(missing.ready, false);
  assert.equal(missing.counts, null);
});
