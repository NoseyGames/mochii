import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { buildStatic } from './build-static.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const types = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.zip': 'application/zip',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
}));

function send(response, status, message, method) {
  const body = `${message}\n`;
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(method === 'HEAD' ? undefined : body);
}

function requestPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.length > 8192) return null;
  let path;
  try { path = decodeURIComponent(value.split('?')[0]); } catch { return null; }
  if (/[\\\x00-\x1f\x7f:]/.test(path)) return null;
  const parts = path.slice(1).split('/');
  if (parts.some(part => part.startsWith('.') || /[<>"|*?]/.test(part))) return null;
  return path === '/' ? ['index.html'] : parts;
}

async function staticFile(directory, parts) {
  if (parts.some(part => !part)) return null;
  let path = directory;
  for (const part of parts) {
    path = join(path, part);
    const info = await lstat(path);
    if (info.isSymbolicLink()) return null;
  }
  const resolved = await realpath(path);
  const local = relative(directory, resolved);
  if (!local || local === '..' || local.startsWith(`..${sep}`) || resolve(directory, local) !== resolved) return null;
  if (!(await lstat(resolved)).isFile()) return null;
  return resolved;
}

export async function createStaticPreview({ directory = join(projectRoot, 'dist'), port = 4173 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Preview port must be an integer from 0 to 65535.');
  const entry = await lstat(resolve(directory));
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Preview directory must be a regular directory.');
  const root = await realpath(resolve(directory));
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Expires', '0');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    let file;
    try {
      const host = /^(localhost|127\.0\.0\.1)(?::(\d{1,5}))?$/.exec(request.headers.host || '');
      if (!host || Number(host[2] || 80) !== server.address().port) return send(response, 403, 'Local preview only.', request.method);
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.setHeader('Allow', 'GET, HEAD');
        return send(response, 405, 'Method not allowed.', request.method);
      }
      const parts = requestPath(request.url);
      if (!parts) return send(response, 400, 'Invalid request path.', request.method);
      let path;
      try { path = await staticFile(root, parts); } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'EINVAL'].includes(error.code)) throw error;
      }
      if (!path && parts.at(-1) && !extname(parts.at(-1)) && parts[0] !== 'api') {
        try { path = await staticFile(root, [...parts.slice(0, -1), `${parts.at(-1)}.html`]); } catch (error) {
          if (!['ENOENT', 'ENOTDIR', 'EINVAL'].includes(error.code)) throw error;
        }
      }
      if (!path) return send(response, 404, 'Not found.', request.method);
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const info = await file.stat();
      if (!info.isFile()) return send(response, 404, 'Not found.', request.method);
      response.writeHead(200, {
        'Content-Type': types.get(extname(path).toLowerCase()) || 'application/octet-stream',
        'Content-Length': info.size,
      });
      if (request.method === 'HEAD') response.end();
      else await pipeline(file.createReadStream({ autoClose: false }), response);
    } catch {
      if (response.headersSent) response.destroy();
      else send(response, 500, 'Preview request failed.', request.method);
    } finally {
      await file?.close().catch(() => {});
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); done(); });
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const value = process.env.PORT || '4173';
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
    const built = await buildStatic();
    const server = await createStaticPreview({ directory: built.directory, port: Number(value) });
    console.log(`Mochii preview: http://127.0.0.1:${server.address().port}/math`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
  } catch (error) {
    console.error(`Preview failed: ${error.message}`);
    process.exitCode = 1;
  }
}
