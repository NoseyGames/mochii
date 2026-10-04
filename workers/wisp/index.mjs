import { connect } from 'cloudflare:sockets';
import { allowedOrigin, admitConnection, resolvePublicAddress } from './policy.mjs';
import { attachWisp } from './protocol.mjs';

function error(status, message) {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
    ...(status === 429 ? { 'Retry-After': '60' } : {}) } });
}

export async function handleWisp(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== '/wisp/' || url.search) return error(404, 'Not found');
  if (env.ENABLE_WISP !== 'true') return error(503, 'Wisp backup is disabled');
  if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return error(426, 'WebSocket required');
  if (!allowedOrigin(request, env)) return error(403, 'Origin not allowed');
  const protocols = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map(value => value.trim()) || [];
  if (protocols.length && !protocols.includes('wisp-v2')) return error(400, 'Unsupported WebSocket protocol');
  const admission = await admitConnection(request, env);
  if (admission) return error(admission, admission === 429 ? 'Proxy is busy; retry shortly' : 'Proxy limits are unavailable');
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  attachWisp(server, { connect, resolve: resolvePublicAddress, version2: protocols.includes('wisp-v2') });
  const headers = protocols.includes('wisp-v2') ? { 'Sec-WebSocket-Protocol': 'wisp-v2' } : {};
  return new Response(null, { status: 101, webSocket: client, headers });
}

export default { fetch: handleWisp };
