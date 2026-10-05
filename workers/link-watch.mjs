const DEFAULT_SUFFIXES = 'pages.dev,workers.dev,netlify.app,vercel.app,onrender.com,github.io';
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_ATTEMPTS = 8;
const MAX_QUEUE = 100;

function hostname(value) {
  if (typeof value !== 'string' || value.length > 253 || value !== value.toLowerCase() || !value.includes('.')) return false;
  const labels = value.split('.');
  return labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    /^[a-z]{2,63}$/.test(labels.at(-1)) && !/\.(?:localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$/.test(value);
}

export function allowedHosts(env = {}) {
  const list = value => {
    if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid host configuration');
    const entries = value.split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
    if (entries.length > 64 || entries.some(item => !hostname(item))) throw new Error('Invalid host configuration');
    return new Set(entries);
  };
  return { suffixes: list(env.ALLOWED_HOST_SUFFIXES ?? DEFAULT_SUFFIXES), hosts: list(env.ALLOWED_CUSTOM_HOSTS ?? '') };
}

export function validateOrigin(value, env = {}) {
  if (typeof value !== 'string' || value.length > 270) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.port || !hostname(url.hostname)) return null;
  const allowed = allowedHosts(env);
  return allowed.hosts.has(url.hostname) || [...allowed.suffixes].some(suffix => url.hostname.endsWith(`.${suffix}`)) ? url.origin : null;
}

export function webhookUrl(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.origin !== 'https://discord.com' || url.username || url.password || url.search || url.hash ||
      !/^\/api\/(?:v10\/)?webhooks\/\d{17,22}\/[A-Za-z0-9._-]{20,200}$/.test(url.pathname)) return null;
  url.searchParams.set('wait', 'true');
  return url.href;
}

export async function smallJson(message, maxBytes = 2048, signal) {
  const declared = message.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new Error('Body too large');
  if (!message.body) throw new Error('Missing body');
  const reader = message.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    if (signal?.aborted) throw new Error('Deadline exceeded');
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error('Body too large');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    signal?.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function deadline(operation, milliseconds) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Deadline exceeded')); }, milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function verifyMirror(origin, fetcher = fetch) {
  try {
    return await deadline(async signal => {
      const response = await fetcher(`${origin}/monkeh-mirror.json`, { redirect: 'error', signal, headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (response.status !== 200 || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
        void response.body?.cancel().catch(() => {});
        return false;
      }
      if (response.url && new URL(response.url).origin !== origin) return false;
      const marker = await smallJson(response, 2048, signal);
      return marker !== null && typeof marker === 'object' && !Array.isArray(marker) && marker.project === 'NoseyGames/monkeh' && marker.version === 1;
    }, 5000);
  } catch { return false; }
}

export async function deliverMirror(url, origin, fetcher = fetch) {
  let response;
  try {
    response = await deadline(signal => fetcher(url, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `New Monkeh mirror\n<${origin}>`, allowed_mentions: { parse: [] }, flags: 4 }),
    }), 8000);
  } catch { return { kind: 'uncertain', code: 'discord_outcome_unknown' }; }
  if (response.status === 429) {
    let body;
    try { body = await deadline(signal => smallJson(response, 2048, signal), 1000); } catch { body = {}; }
    const seconds = Math.max(Number(response.headers.get('retry-after') || 0), Number(body?.retry_after || 0));
    if (!Number.isFinite(seconds) || seconds > 86400) return { kind: 'failed', code: 'discord_retry_after_invalid' };
    return { kind: 'retry', code: 'discord_429', retryAfter: Math.max(MINUTE, Math.ceil(seconds * 1000)) };
  }
  if (response.status >= 500 && response.status <= 599) {
    void response.body?.cancel().catch(() => {});
    return { kind: 'uncertain', code: 'discord_5xx' };
  }
  if ([401, 403, 404].includes(response.status)) {
    void response.body?.cancel().catch(() => {});
    return { kind: 'blocked', code: `discord_${response.status}` };
  }
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => {});
    return { kind: response.ok ? 'uncertain' : 'failed', code: response.ok ? 'discord_confirmation_missing' : `discord_${response.status}` };
  }
  try {
    const message = await deadline(signal => smallJson(response, 16384, signal), 2000);
    if (typeof message?.id === 'string' && /^\d{17,22}$/.test(message.id)) return { kind: 'delivered', messageId: message.id };
  } catch {}
  return { kind: 'uncertain', code: 'discord_confirmation_missing' };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
}

function cors(origin) {
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' };
}

function limited(seconds = 60) { return { status: 429, body: { status: 'rate_limited' }, retryAfter: seconds }; }

async function fingerprint(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export class MirrorLedger {
  constructor(ctx, env, options = {}) {
    this.storage = ctx.storage;
    this.sql = ctx.storage.sql;
    this.env = env;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.webhook = webhookUrl(env.DISCORD_WEBHOOK_URL);
    this.webhookFingerprint = this.webhook ? fingerprint(this.webhook) : Promise.resolve(null);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS mirrors (origin TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, message_id TEXT, error_code TEXT);
      CREATE INDEX IF NOT EXISTS mirrors_due ON mirrors(status, next_at);
      CREATE TABLE IF NOT EXISTS verification (origin TEXT PRIMARY KEY, token TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS verification_expiry ON verification(expires_at);
      CREATE TABLE IF NOT EXISTS limits (name TEXT PRIMARY KEY, reset_at INTEGER NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS webhook_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), fingerprint TEXT NOT NULL, blocked INTEGER NOT NULL DEFAULT 0, resume_at INTEGER NOT NULL DEFAULT 0);
    `);
  }

  rows(query, ...bindings) { return this.sql.exec(query, ...bindings).toArray(); }
  transaction(operation) { return this.storage.transaction(operation); }

  takeLimits(specifications, now) {
    let retryAfter = 0;
    const records = specifications.map(([name, limit, duration]) => {
      const existing = this.rows('SELECT reset_at, count FROM limits WHERE name = ?', name)[0];
      const record = existing && existing.reset_at > now ? existing : { reset_at: Math.floor(now / duration) * duration + duration, count: 0 };
      if (record.count >= limit) retryAfter = Math.max(retryAfter, Math.ceil((record.reset_at - now) / 1000));
      return { name, ...record };
    });
    if (retryAfter) return retryAfter;
    for (const record of records) this.sql.exec('INSERT INTO limits(name, reset_at, count) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET reset_at = excluded.reset_at, count = excluded.count', record.name, record.reset_at, record.count + 1);
    return 0;
  }

  async arm() {
    const state = this.rows('SELECT blocked, resume_at FROM webhook_state WHERE singleton = 1')[0];
    if (!this.webhook || state?.blocked) { await this.storage.deleteAlarm(); return; }
    const next = this.rows("SELECT MIN(next_at) AS next_at FROM mirrors WHERE status IN ('queued', 'sending')")[0]?.next_at;
    if (next === null || next === undefined) { await this.storage.deleteAlarm(); return; }
    const now = this.now();
    const notBefore = Math.max(next, state?.resume_at || 0);
    const target = notBefore > now ? notBefore : now + 1000;
    const current = await this.storage.getAlarm();
    if (current !== target && (current === null || target < current || notBefore > now)) await this.storage.setAlarm(target);
  }

  async configured() {
    if (!this.webhook) return false;
    const hash = await this.webhookFingerprint;
    return await this.transaction(async () => {
      const state = this.rows('SELECT fingerprint, blocked FROM webhook_state WHERE singleton = 1')[0];
      if (!state || state.fingerprint !== hash) {
        this.sql.exec('INSERT INTO webhook_state(singleton, fingerprint, blocked, resume_at) VALUES (1, ?, 0, 0) ON CONFLICT(singleton) DO UPDATE SET fingerprint = excluded.fingerprint, blocked = 0, resume_at = 0', hash);
        this.sql.exec("UPDATE mirrors SET next_at = MIN(next_at, ?) WHERE status = 'queued'", this.now());
        await this.arm();
        return true;
      }
      if (!state.blocked) await this.arm();
      return !state.blocked;
    });
  }

  async report(origin) {
    if (!await this.configured()) return { status: 503, body: { status: 'not_configured' } };
    const token = crypto.randomUUID();
    const reservation = await this.transaction(async () => {
      const now = this.now();
      const rate = this.takeLimits([['reports', 60, MINUTE]], now);
      if (rate) return limited(rate);
      const known = this.rows('SELECT status FROM mirrors WHERE origin = ?', origin)[0];
      if (known) { await this.arm(); return { status: 200, body: { status: 'already_known', delivery: known.status } }; }
      this.sql.exec('DELETE FROM verification WHERE expires_at <= ?', now);
      const cached = this.rows('SELECT status, expires_at FROM verification WHERE origin = ?', origin)[0];
      if (cached) return { status: cached.status === 'negative' ? 422 : 409, body: { status: cached.status === 'negative' ? 'unverified' : 'verifying' }, retryAfter: Math.ceil((cached.expires_at - now) / 1000) };
      const pending = this.rows("SELECT COUNT(*) AS count FROM mirrors WHERE status IN ('queued', 'sending')")[0].count;
      if (pending >= MAX_QUEUE) return limited(300);
      const validationRate = this.takeLimits([['validations_minute', 6, MINUTE], ['validations_day', 120, DAY]], now);
      if (validationRate) return limited(validationRate);
      this.sql.exec("INSERT INTO verification(origin, token, status, expires_at) VALUES (?, ?, 'validating', ?)", origin, token, now + 15000);
      return null;
    });
    if (reservation) return reservation;
    const verified = await verifyMirror(origin, this.fetcher);
    return await this.transaction(async () => {
      const now = this.now();
      const lease = this.rows('SELECT token FROM verification WHERE origin = ?', origin)[0];
      if (lease?.token !== token) return { status: 409, body: { status: 'verification_expired' }, retryAfter: 15 };
      this.sql.exec('DELETE FROM verification WHERE origin = ?', origin);
      if (!verified) {
        this.sql.exec("INSERT INTO verification(origin, token, status, expires_at) VALUES (?, ?, 'negative', ?)", origin, token, now + 5 * MINUTE);
        return { status: 422, body: { status: 'unverified' }, retryAfter: 300 };
      }
      if (this.rows('SELECT blocked FROM webhook_state WHERE singleton = 1')[0]?.blocked) return { status: 503, body: { status: 'not_configured' } };
      const known = this.rows('SELECT status FROM mirrors WHERE origin = ?', origin)[0];
      if (known) return { status: 200, body: { status: 'already_known', delivery: known.status } };
      if (this.rows("SELECT COUNT(*) AS count FROM mirrors WHERE status IN ('queued', 'sending')")[0].count >= MAX_QUEUE) return limited(300);
      const rate = this.takeLimits([['discoveries_hour', 10, HOUR], ['discoveries_day', 50, DAY]], now);
      if (rate) return limited(rate);
      this.sql.exec("INSERT INTO mirrors(origin, status, next_at, created_at, updated_at) VALUES (?, 'queued', ?, ?, ?)", origin, now, now, now);
      await this.arm();
      return { status: 202, body: { status: 'queued' } };
    });
  }

  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (request.method === 'GET' && pathname === '/health') {
      const ready = await this.configured();
      const counts = { queued: 0, sending: 0, delivered: 0, failed: 0, uncertain: 0 };
      for (const row of this.rows('SELECT status, COUNT(*) AS count FROM mirrors GROUP BY status')) if (Object.hasOwn(counts, row.status)) counts[row.status] = row.count;
      return json({ ready, configured: { webhook: Boolean(this.webhook), ledger: true }, counts });
    }
    if (request.method !== 'POST' || pathname !== '/report') return json({ status: 'not_found' }, 404);
    let body;
    try { body = await deadline(signal => smallJson(request, 512, signal), 3000); } catch { return json({ status: 'invalid_report' }, 400); }
    const origin = validateOrigin(body?.origin, this.env);
    if (!origin || request.headers.get('origin') !== origin) return json({ status: 'invalid_origin' }, 403);
    const result = await this.report(origin);
    return json(result.body, result.status, result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : {});
  }

  async alarm() {
    if (!await this.configured()) return;
    const claimed = await this.transaction(async () => {
      const now = this.now();
      this.sql.exec("UPDATE mirrors SET status = 'uncertain', error_code = 'interrupted_delivery', updated_at = ? WHERE status = 'sending' AND next_at <= ?", now, now);
      const state = this.rows('SELECT resume_at FROM webhook_state WHERE singleton = 1')[0];
      if (state?.resume_at > now) { await this.arm(); return null; }
      const item = this.rows("SELECT origin, attempts FROM mirrors WHERE status = 'queued' AND next_at <= ? ORDER BY next_at, created_at, origin LIMIT 1", now)[0];
      if (!item) { await this.arm(); return null; }
      if (item.attempts >= MAX_ATTEMPTS) {
        this.sql.exec("UPDATE mirrors SET status = 'failed', error_code = 'retry_exhausted', updated_at = ? WHERE origin = ?", now, item.origin);
        await this.arm();
        return null;
      }
      const rate = this.takeLimits([['webhook_attempts', 30, HOUR]], now);
      if (rate) {
        this.sql.exec('UPDATE webhook_state SET resume_at = ? WHERE singleton = 1', now + rate * 1000);
        await this.arm();
        return null;
      }
      item.attempts++;
      this.sql.exec("UPDATE mirrors SET status = 'sending', attempts = ?, next_at = ?, updated_at = ? WHERE origin = ?", item.attempts, now + 30000, now, item.origin);
      await this.arm();
      return item;
    });
    if (!claimed) return;
    const outcome = await deliverMirror(this.webhook, claimed.origin, this.fetcher);
    await this.transaction(async () => {
      const now = this.now();
      if (outcome.kind === 'delivered') {
        this.sql.exec("UPDATE mirrors SET status = 'delivered', message_id = ?, error_code = NULL, updated_at = ? WHERE origin = ? AND status = 'sending'", outcome.messageId, now, claimed.origin);
      } else if (outcome.kind === 'retry' && claimed.attempts < MAX_ATTEMPTS) {
        const delay = Math.max(outcome.retryAfter, Math.min(HOUR, MINUTE * 2 ** (claimed.attempts - 1)));
        this.sql.exec("UPDATE mirrors SET status = 'queued', next_at = ?, error_code = ?, updated_at = ? WHERE origin = ? AND status = 'sending'", now + delay, outcome.code, now, claimed.origin);
        if (outcome.code === 'discord_429') this.sql.exec('UPDATE webhook_state SET resume_at = MAX(resume_at, ?) WHERE singleton = 1', now + delay);
      } else if (outcome.kind === 'blocked') {
        this.sql.exec("UPDATE mirrors SET status = 'queued', next_at = ?, error_code = ?, updated_at = ? WHERE origin = ? AND status = 'sending'", now, outcome.code, now, claimed.origin);
        this.sql.exec('UPDATE webhook_state SET blocked = 1 WHERE singleton = 1');
      } else {
        const status = outcome.kind === 'uncertain' ? 'uncertain' : 'failed';
        this.sql.exec("UPDATE mirrors SET status = ?, error_code = ?, updated_at = ? WHERE origin = ? AND status = 'sending'", status, outcome.kind === 'retry' ? 'retry_exhausted' : outcome.code, now, claimed.origin);
      }
      await this.arm();
    });
  }
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    let origin;
    try { origin = validateOrigin(request.headers.get('origin'), env); } catch { return json({ status: 'not_configured' }, 503); }
    if (pathname !== '/report' && pathname !== '/health') return json({ status: 'not_found' }, 404);
    if (pathname === '/report' && !origin) return json({ status: 'invalid_origin' }, 403);
    const headers = origin ? cors(origin) : {};
    if (request.method === 'OPTIONS' && pathname === '/report') return new Response(null, { status: 204, headers });
    if (!(request.method === 'GET' && pathname === '/health') && !(request.method === 'POST' && pathname === '/report')) return json({ status: 'method_not_allowed' }, 405, headers);
    const ledger = env.MIRROR_LEDGER;
    const hook = webhookUrl(env.DISCORD_WEBHOOK_URL);
    if (!ledger || !hook && pathname === '/report') return json(pathname === '/health' ? { ready: false, configured: { webhook: Boolean(hook), ledger: Boolean(ledger) }, counts: null } : { status: 'not_configured' }, pathname === '/health' ? 200 : 503, headers);
    if (pathname === '/report') {
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return json({ status: 'invalid_report' }, 415, headers);
      if (env.REPORT_RATE && !(await env.REPORT_RATE.limit({ key: 'all' })).success) return json({ status: 'rate_limited' }, 429, { ...headers, 'Retry-After': '60' });
    }
    try {
      const stub = ledger.get(ledger.idFromName('monkeh-mirrors-v1'));
      const response = await stub.fetch(new Request(`https://ledger.internal${pathname}`, request));
      const result = new Response(response.body, response);
      for (const [name, value] of Object.entries(headers)) result.headers.set(name, value);
      return result;
    } catch { return json({ status: 'temporarily_unavailable' }, 503, headers); }
  },
};
