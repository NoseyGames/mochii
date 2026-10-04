import { createHash, timingSafeEqual } from 'node:crypto';

function integer(value, fallback, min, max, name) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return number;
}

export function isLoopbackHost(host) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host).toLowerCase());
}

function publicUrl(value, kind) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) throw new Error(`${kind} must be a valid URL.`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${kind} must be an absolute URL.`); }
  if (url.username || url.password) throw new Error(`${kind} cannot contain credentials.`);
  if (kind === 'Backup endpoint') {
    if (url.hash || url.search || (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && isLoopbackHost(url.hostname)))) {
      throw new Error('Backup endpoints require wss:// (ws:// is allowed only for localhost), without query strings or fragments.');
    }
  } else if (url.protocol !== 'https:' || url.search) {
    throw new Error(`${kind} requires HTTPS without query strings or credentials.`);
  }
  return url;
}

export function loadServerConfig(env = process.env) {
  const host = env.HOST === '[::1]' ? '::1' : env.HOST || '127.0.0.1';
  const port = integer(env.PORT, 3000, 1, 65535, 'PORT');
  const proxyPort = integer(env.PROXY_PORT, port + 1, 1, 65535, 'PROXY_PORT');
  if (port === proxyPort) throw new Error('PORT and PROXY_PORT must be different.');
  const authToken = env.PROXY_AUTH_TOKEN || '';
  const authUser = env.PROXY_AUTH_USER || 'monkeh';
  if (authToken && (authToken.length < 16 || /[\r\n]/.test(authToken))) throw new Error('PROXY_AUTH_TOKEN must contain at least 16 characters and no line breaks.');
  if (!authUser || /[:\r\n]/.test(authUser)) throw new Error('PROXY_AUTH_USER cannot contain a colon or line break.');
  if (!isLoopbackHost(host) && !authToken && env.ALLOW_PUBLIC_PROXY !== 'true') {
    throw new Error('Public binding requires PROXY_AUTH_TOKEN or an explicit ALLOW_PUBLIC_PROXY=true.');
  }
  let publicOrigin = null;
  if (env.PUBLIC_ORIGIN) {
    publicOrigin = new URL(env.PUBLIC_ORIGIN);
    if (publicOrigin.username || publicOrigin.password || publicOrigin.search || publicOrigin.hash || publicOrigin.pathname !== '/' ||
        !['http:', 'https:'].includes(publicOrigin.protocol) || (publicOrigin.protocol === 'http:' && !isLoopbackHost(publicOrigin.hostname))) {
      throw new Error('PUBLIC_ORIGIN must be an HTTPS origin (HTTP is allowed only for localhost).');
    }
  }
                                                                              
                                                                        
  const localOriginHost = host === '::1' ? '[::1]' : host.toLowerCase() === 'localhost' ? 'localhost' : '127.0.0.1';
  let proxyOrigin;
  try { proxyOrigin = new URL(env.PROXY_ORIGIN || `http://${localOriginHost}:${proxyPort}`); } catch { throw new Error('PROXY_ORIGIN must be an absolute origin.'); }
  if (proxyOrigin.username || proxyOrigin.password || proxyOrigin.search || proxyOrigin.hash || proxyOrigin.pathname !== '/' ||
      !['http:', 'https:'].includes(proxyOrigin.protocol) || (proxyOrigin.protocol === 'http:' && !isLoopbackHost(proxyOrigin.hostname))) {
    throw new Error('PROXY_ORIGIN must be an HTTPS origin (HTTP is allowed only for localhost).');
  }
  if (!isLoopbackHost(host) && (!env.PUBLIC_ORIGIN || !env.PROXY_ORIGIN)) {
    throw new Error('Public binding requires distinct PUBLIC_ORIGIN and PROXY_ORIGIN URLs.');
  }
  const shellOrigins = publicOrigin ? [publicOrigin.origin] : [...new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://${localOriginHost}:${port}`])];
  if (shellOrigins.includes(proxyOrigin.origin)) throw new Error('PROXY_ORIGIN must be different from the app origin.');
  let backups = [];
  if (env.WISP_BACKUPS_JSON) {
    try { backups = JSON.parse(env.WISP_BACKUPS_JSON); } catch { throw new Error('WISP_BACKUPS_JSON must be a JSON array.'); }
  }
  if (!Array.isArray(backups) || backups.length > 31) throw new Error('WISP_BACKUPS_JSON accepts up to 31 backup endpoints.');
  const seen = new Set();
  const endpoints = [{ name: 'Primary', url: '/wisp/' }];
  for (const [index, backup] of backups.entries()) {
    if (!backup || typeof backup !== 'object' || Array.isArray(backup)) throw new Error('Each backup must have a name and URL.');
    const url = publicUrl(backup.url, 'Backup endpoint').href;
    if (seen.has(url)) continue;
    seen.add(url);
    const name = typeof backup.name === 'string' ? backup.name.trim() : `Backup ${index + 1}`;
    if (!name || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Backup names must contain 1–60 printable characters.');
    endpoints.push({ name, url });
  }
  let windowsVm = null;
  if (env.WINDOWS_VM_URL) {
    const url = publicUrl(env.WINDOWS_VM_URL, 'Windows VM gateway').href;
    const label = (env.WINDOWS_VM_NAME || 'Windows desktop').trim();
    if (!label || label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) throw new Error('WINDOWS_VM_NAME must contain 1–80 printable characters.');
    windowsVm = { url, label };
  }
  const ports = env.WISP_ALLOWED_PORTS ? env.WISP_ALLOWED_PORTS.split(',').map(value => integer(value.trim(), null, 1, 65535, 'WISP_ALLOWED_PORTS')) : [80, 443, 8080, 8443];
  if (!ports.length || ports.length > 64) throw new Error('WISP_ALLOWED_PORTS accepts up to 64 ports.');
  return {
    host,
    port,
    proxyPort,
    proxyOrigin,
    publicOrigin,
    authDigest: authToken ? createHash('sha256').update(`Basic ${Buffer.from(`${authUser}:${authToken}`).toString('base64')}`).digest() : null,
    maxConnections: integer(env.WISP_MAX_CONNECTIONS, 64, 1, 512, 'WISP_MAX_CONNECTIONS'),
    maxConnectionsPerIp: integer(env.WISP_MAX_CONNECTIONS_PER_IP, 16, 1, 128, 'WISP_MAX_CONNECTIONS_PER_IP'),
    allowedPorts: new Set(ports),
    publicConfig: { wispEndpoints: endpoints, maxWispBackups: 31, windowsVm, proxyOrigin: proxyOrigin.origin, shellOrigins, requiresAuthentication: Boolean(authToken) },
  };
}

export function isAuthorized(req, config) {
  if (!config.authDigest) return true;
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string' || authorization.length > 4096) return false;
  return timingSafeEqual(createHash('sha256').update(authorization).digest(), config.authDigest);
}

export function isAllowedHost(req, config) {
  if (typeof req.headers.host !== 'string') return false;
  if (Array.isArray(req.rawHeaders) && req.rawHeaders.filter((_, index) => index % 2 === 0).filter(name => name.toLowerCase() === 'host').length !== 1) return false;
  try {
    const url = new URL(`http://${req.headers.host}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    if (config.publicOrigin && url.host.toLowerCase() === config.publicOrigin.host.toLowerCase()) return true;
    if (config.publicOrigin) return isLoopbackHost(url.hostname);
    return isLoopbackHost(config.host) ? isLoopbackHost(url.hostname) : true;
  } catch { return false; }
}

export function isAllowedOrigin(req, config) {
  if (typeof req.headers.origin !== 'string' || !isAllowedHost(req, config)) return false;
  try {
    const origin = new URL(req.headers.origin);
    if (origin.origin !== req.headers.origin || !['http:', 'https:'].includes(origin.protocol)) return false;
    if (config.publicOrigin && origin.origin === config.publicOrigin.origin) return origin.host.toLowerCase() === req.headers.host.toLowerCase();
    return origin.host.toLowerCase() === req.headers.host.toLowerCase() && (!config.publicOrigin || isLoopbackHost(origin.hostname));
  } catch { return false; }
}
