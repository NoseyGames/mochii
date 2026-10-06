import { handleAssist } from './assist.mjs';
import { handleMusic } from './music.mjs';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/assist') return handleAssist(request, env);
    if (pathname.startsWith('/api/music/')) return handleMusic(request, env);
    if (pathname === '/wisp' || pathname.startsWith('/wisp/')) return Response.json({ error: 'This Wisp endpoint has been retired. Use an external Wisp server.' }, { status: 410, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    if (pathname.startsWith('/api/')) return Response.json({ error: 'Unknown API route.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    return env.ASSETS.fetch(request);
  }
};
