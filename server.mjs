import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baremuxPath } from '@mercuryworkshop/bare-mux/node';
import { epoxyPath } from '@mercuryworkshop/epoxy-transport';
import { loadServerConfig, isAuthorized, isAllowedHost, isAllowedOrigin } from './server-config.mjs';
import { createWispGateway } from './server-wisp.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicFiles = new Set([
  'index.html', 'math.html', 'history.html', 'flyflix.html', 'style.css', 'sw.js',
]);
const proxyFiles = new Set([
  '/proxy-host.html', '/flyflix-provider.html', '/browser-tools/proxy-host.js',
  '/browser-tools/runtime.js', '/browser-tools/proxy-network.js', '/sw.js',
]);
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function reply(req, res, status, message, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(req.method === 'HEAD' ? undefined : message);
}

function requestPath(req) {
  // Decode before resolving; never accept Windows paths or dot segments.
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  if (!pathname.startsWith('/') || pathname.startsWith('//') || /[\\\x00-\x20\x7f]/.test(pathname) ||
      pathname.split('/').some(segment => segment.startsWith('.') || segment.includes(':'))) {
    return null;
  }
  return pathname;
}

function assetFor(pathname, proxyMode = false) {
  const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (proxyMode) {
    if (proxyFiles.has(pathname)) return { directory: root, filename };
    if (!['/bearmux/', '/ultrav/'].some(prefix => pathname.startsWith(prefix))) return null;
  }
  if (publicFiles.has(filename)) return { directory: root, filename };
  // Installed packages provide a matched worker/client and transport with embedded WASM.
  for (const [prefix, directory] of [
    ['/bearmux/epoxy/', epoxyPath],
    ['/bearmux/', baremuxPath],
    ['/ultrav/', path.join(root, 'ultrav')],
    ['/apps/', path.join(root, 'apps')],
    ['/browser-tools/', path.join(root, 'browser-tools')],
  ]) {
    if (pathname.startsWith(prefix) && Object.hasOwn(contentTypes, path.extname(pathname))) {
      return { directory, filename: pathname.slice(prefix.length) };
    }
  }
  return null;
}

async function serve(req, res, config, proxyMode) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (proxyMode) {
    res.setHeader('Content-Security-Policy', `frame-ancestors ${config.publicConfig.shellOrigins.join(' ')} ${config.proxyOrigin.origin}`);
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  } else {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  }
  if (!isAllowedHost(req, config)) {
    reply(req, res, 421, 'Unrecognized host');
    return;
  }
  if (!isAuthorized(req, config)) {
    reply(req, res, 401, 'Authentication required', { 'WWW-Authenticate': 'Basic realm="Monkeh", charset="UTF-8"' });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    reply(req, res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return;
  }
  let pathname;
  try {
    pathname = requestPath(req);
  } catch {
    reply(req, res, 400, 'Invalid URL');
    return;
  }
  if (!pathname) {
    reply(req, res, 404, 'Not found');
    return;
  }
  if (pathname === '/api/health') {
    reply(req, res, 200, JSON.stringify({ status: 'ok', wispPath: '/wisp/' }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
    return;
  }
  if (pathname === '/api/config') {
    reply(req, res, 200, JSON.stringify(config.publicConfig), { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }
  if (pathname === '/wisp/') {
    reply(req, res, 426, 'This endpoint requires a WebSocket connection.', { Upgrade: 'websocket' });
    return;
  }
  const asset = assetFor(pathname, proxyMode);
  if (!asset) {
    reply(req, res, 404, 'Not found');
    return;
  }
  try {
    const directory = await realpath(asset.directory);
    const filename = await realpath(path.resolve(directory, asset.filename));
    if (!filename.startsWith(directory + path.sep) || !(await stat(filename)).isFile()) {
      reply(req, res, 404, 'Not found');
      return;
    }
    const headers = {
      'Content-Type': contentTypes[path.extname(filename)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    };
    if (pathname === '/sw.js') headers['Service-Worker-Allowed'] = '/';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else createReadStream(filename).on('error', () => res.destroy()).pipe(res);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') reply(req, res, 404, 'Not found');
    else throw error;
  }
}

function createConfiguredServer({ env = process.env, wispOptions } = {}, proxyMode = false) {
  const originalConfig = loadServerConfig(env);
  const config = proxyMode ? { ...originalConfig, publicOrigin: originalConfig.proxyOrigin } : originalConfig;
  const gateway = createWispGateway(config, wispOptions);
  const server = createServer({ maxHeaderSize: 16384, headersTimeout: 10000, requestTimeout: 15000, keepAliveTimeout: 5000 }, (req, res) => {
    serve(req, res, config, proxyMode).catch(error => {
      console.error('Request failed:', error.message);
      if (res.headersSent) res.destroy();
      else reply(req, res, 500, 'Internal server error');
    });
  });
  server.maxConnections = 256;
  server.maxRequestsPerSocket = 100;
  server.on('close', () => gateway.close());
  const close = server.close.bind(server);
  server.close = callback => { gateway.close(); return close(callback); };

  server.on('upgrade', (req, socket, head) => {
    // Socket errors before the WebSocket receiver attaches must not crash Node.
    socket.on('error', () => socket.destroy());
    const reject = (status, reason, headers = '') => {
      socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n${headers}\r\n`);
      socket.setTimeout(1000, () => socket.destroy());
    };
    let pathname;
    try { pathname = requestPath(req); } catch { /* Rejected below. */ }
    if (pathname !== '/wisp/') {
      reject(404, 'Not Found');
      return;
    }
    if (!isAllowedHost(req, config)) { reject(421, 'Misdirected Request'); return; }
    if (!isAuthorized(req, config)) { reject(401, 'Unauthorized', 'WWW-Authenticate: Basic realm="Monkeh", charset="UTF-8"\r\n'); return; }
    if (!isAllowedOrigin(req, config)) { reject(403, 'Forbidden'); return; }
    const protocols = req.headers['sec-websocket-protocol'];
    if (protocols && protocols.split(',').map(value => value.trim()).some(value => value !== 'wisp-v2')) {
      reject(400, 'Bad Request'); return;
    }
    if (!gateway.canAccept(req)) { reject(429, 'Too Many Requests', 'Retry-After: 5\r\n'); return; }
    try { gateway.upgrade(req, socket, head); } catch (error) {
      console.error('WebSocket upgrade failed:', error.message);
      socket.destroy();
    }
  });
  return server;
}

export function createAppServer(options) { return createConfiguredServer(options, false); }
export function createProxyServer(options) { return createConfiguredServer(options, true); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { port, proxyPort, host, proxyOrigin } = loadServerConfig();
    const displayHost = host.includes(':') ? `[${host}]` : host;
    const server = createAppServer();
    const proxyServer = createProxyServer();
    for (const instance of [server, proxyServer]) instance.on('error', error => {
      console.error('Unable to start Monkeh:', error.message);
      process.exitCode = 1;
      server.close();
      proxyServer.close();
    });
    server.listen(port, host, () => {
      console.log(`Monkeh listening on http://${displayHost}:${port} (app: /math.html)`);
    });
    proxyServer.listen(proxyPort, host, () => console.log(`Isolated proxy listening on http://${displayHost}:${proxyPort} (browser origin: ${proxyOrigin.origin})`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); proxyServer.close(); });
  } catch (error) {
    console.error('Unable to start Monkeh:', error.message);
    process.exitCode = 1;
  }
}
