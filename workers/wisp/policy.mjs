import ipaddr from 'ipaddr.js';

export function isPublicAddress(address) {
  return typeof address === 'string' && ipaddr.isValid(address) && ipaddr.process(address).range() === 'unicast';
}

export function destinationHostname(bytes) {
  let host;
  try { host = new TextDecoder('utf-8', { fatal: true }).decode(bytes).toLowerCase(); } catch { return null; }
  if (host.length > 253 || ipaddr.isValid(host) || !host.includes('.')) return null;
  const labels = host.split('.');
  if (labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  if (/(?:^|\.)(?:localhost|local|internal|invalid|test|onion)$/.test(host) || host.endsWith('.home.arpa')) return null;
  return host;
}

export function allowedOrigin(request, env) {
  try {
    const allowed = JSON.parse(env.WISP_ALLOWED_ORIGINS || '[]');
    const origin = request.headers.get('Origin');
    const url = new URL(origin);
    return Array.isArray(allowed) && allowed.length <= 8 && origin === url.origin &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
      allowed.includes(origin);
  } catch { return false; }
}

export async function admitConnection(request, env) {
  const address = request.headers.get('CF-Connecting-IP');
  if (!address || !ipaddr.isValid(address) || typeof env.WISP_RATE?.limit !== 'function' ||
      typeof env.WISP_GLOBAL_RATE?.limit !== 'function') return 503;
  try {
    if (!(await env.WISP_RATE.limit({ key: address })).success) return 429;
    if (!(await env.WISP_GLOBAL_RATE.limit({ key: 'wisp-upgrades' })).success) return 429;
    return 0;
  } catch { return 503; }
}

export async function resolvePublicAddress(hostname, signal, fetcher = fetch) {
  // One fixed HTTPS resolver request per stream; the validated answer, never
  // the unchecked hostname, is passed to TCP connect to prevent rebinding.
  const response = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
    headers: { Accept: 'application/dns-json' }, redirect: 'manual', signal,
  });
  if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw new Error('DNS unavailable'); }
  const reader = response.body.getReader();
  let body = '', size = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) throw new Error('DNS response too large');
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
  const result = JSON.parse(body);
  const answers = result.Status === 0 && Array.isArray(result.Answer) ? result.Answer.filter(record => record.type === 1) : [];
  const address = answers.find(record => isPublicAddress(record.data))?.data;
  if (!address) throw Object.assign(new Error('Destination is not public'), { code: 'EACCES' });
  return address;
}
