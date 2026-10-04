export const USERSCRIPTS_STORAGE_KEY = 'monkeh.userscripts.v1';

const MAX_SCRIPTS = 50;
let fallbackId = 0;

function fail(message) {
  throw new Error(message);
}

function parsePattern(pattern) {
  if (pattern === '*') return { scheme: '*', host: '*', port: null, suffix: '*' };
  if (/\s/.test(pattern)) fail('URL patterns cannot contain spaces. Encode spaces as %20.');
  const parts = /^(https?|\*):\/\/([^/?#]+)([/?#].*)?$/i.exec(pattern);
  if (!parts) fail('Use HTTP(S) URL patterns, such as https://example.com/*.');
  const scheme = parts[1].toLowerCase();
  const authority = parts[2];
  if (authority.includes('@') || authority.includes('\\')) fail('URL patterns cannot contain credentials or backslashes.');
  if ((parts[3] || '').includes('\\')) fail('URL patterns cannot contain backslashes.');
  if (authority === '*') {
    const parsed = new URL(`${scheme === '*' ? 'https' : scheme}://pattern.invalid${parts[3] || '/'}`);
    return { scheme, host: '*', port: null, suffix: parsed.pathname + parsed.search + parsed.hash };
  }
  const subdomains = authority.startsWith('*.');
  const domain = subdomains ? authority.slice(2) : authority;
  if (!domain || domain.includes('*')) fail('Host wildcards must be * or a leading *., such as *.example.com.');
  let parsed;
  try {
    parsed = new URL(`${scheme === '*' ? 'https' : scheme}://${domain}${parts[3] || '/'}`);
  } catch {
    fail('One of the URL patterns is not a valid HTTP(S) URL.');
  }
  if (!parsed.hostname || parsed.username || parsed.password) fail('URL patterns need a valid hostname.');
  if (subdomains && (parsed.hostname.startsWith('[') || /^[\d.]+$/.test(parsed.hostname))) {
    fail('Subdomain wildcards need a domain name, not an IP address.');
  }
                                                                      
  const portMatch = /:(\d+)$/.exec(domain);
  const port = portMatch ? String(Number(portMatch[1])) : '';
  return {
    scheme,
    host: parsed.hostname,
    subdomains,
    port,
    suffix: parsed.pathname + parsed.search + parsed.hash,
  };
}

                                                                                   
export function validatePatterns(patternText) {
  if (typeof patternText !== 'string' || !patternText.trim()) fail('Enter at least one URL pattern.');
  if (patternText.length > 2000) fail('URL patterns must be 2,000 characters or fewer.');
  const patterns = patternText.split(/[,\r\n]+/).map((pattern) => pattern.trim()).filter(Boolean);
  if (!patterns.length) fail('Enter at least one URL pattern.');
  for (const pattern of patterns) parsePattern(pattern);
  return patterns;
}

                                                                               
function matchGlob(pattern, value) {
  let p = 0;
  let v = 0;
  let star = -1;
  let retry = 0;
  while (v < value.length) {
    if (pattern[p] === '*') {
      star = p++;
      retry = v;
    } else if (pattern[p] === value[v]) {
      p++;
      v++;
    } else if (star !== -1) {
      p = star + 1;
      v = ++retry;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

                                                                 
export function matchesUrl(patternText, url) {
  let target;
  let patterns;
  try {
    target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) return false;
    patterns = validatePatterns(patternText).map(parsePattern);
  } catch {
    return false;
  }
  const scheme = target.protocol.slice(0, -1);
  const suffix = target.pathname + target.search + target.hash;
  return patterns.some((pattern) => {
    if (pattern.scheme !== '*' && pattern.scheme !== scheme) return false;
    if (pattern.host !== '*' && target.hostname !== pattern.host &&
        !(pattern.subdomains && target.hostname.endsWith(`.${pattern.host}`))) return false;
    if (pattern.port !== null) {
      const actualPort = target.port || (scheme === 'https' ? '443' : '80');
      const expectedPort = pattern.port || (scheme === 'https' ? '443' : '80');
      if (actualPort !== expectedPort) return false;
    }
    return matchGlob(pattern.suffix, suffix);
  });
}

function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id);
}

function newId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch {
                                                                                 
  }
  return `script_${Date.now().toString(36)}_${(++fallbackId).toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function cleanRecord(record, id) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('Userscript must be an object.');
  if (!validId(id)) fail('Userscript ID is invalid.');
  if (typeof record.name !== 'string' || !record.name.trim()) fail('Give your userscript a name.');
  if (record.name.length > 100) fail('Userscript names must be 100 characters or fewer.');
  validatePatterns(record.match);
  if (typeof record.code !== 'string') fail('Userscript code must be text.');
  if (record.code.length > 100000) fail('Userscript code must be 100,000 characters or fewer.');
  if (record.enabled !== undefined && typeof record.enabled !== 'boolean') fail('Userscript enabled must be true or false.');
  return { id, name: record.name.trim(), match: record.match.trim(), code: record.code, enabled: record.enabled === true };
}

                                                                                    
export function createUserscriptStore(storage) {
  let warning = null;

  function read() {
    warning = null;
    let raw;
    try {
      raw = storage.getItem(USERSCRIPTS_STORAGE_KEY);
    } catch {
      fail('Unable to read userscripts. Browser storage may be blocked.');
    }
    if (raw === null || raw === undefined) return [];
    let records;
    try {
      records = JSON.parse(raw);
    } catch {
      warning = 'Saved userscripts contained invalid JSON and could not be loaded.';
      return [];
    }
    if (!Array.isArray(records)) {
      warning = 'Saved userscripts had an invalid format and could not be loaded.';
      return [];
    }
    const seen = new Set();
    const result = [];
    for (const record of records) {
      try {
        const clean = cleanRecord(record, record?.id);
        if (seen.has(clean.id) || result.length >= MAX_SCRIPTS) throw new Error('Duplicate or excess record.');
        seen.add(clean.id);
        result.push(clean);
      } catch {
        warning = 'Some saved userscripts were invalid or exceeded the limit and were ignored.';
      }
    }
    return result;
  }

  function write(records) {
    try {
      storage.setItem(USERSCRIPTS_STORAGE_KEY, JSON.stringify(records));
    } catch {
      fail('Unable to save userscripts. Browser storage may be full or blocked.');
    }
    warning = null;
  }

  return {
    get warning() { return warning; },
    list() {
      try {
        return read();
      } catch (error) {
        warning = error.message;
        return [];
      }
    },
    save(record) {
      const records = read();
      let id = record?.id;
      if (id === undefined || id === null || id === '') {
        id = newId();
        if (records.some((item) => item.id === id)) {
          id = `script_${Date.now().toString(36)}_${(++fallbackId).toString(36)}`;
        }
      }
      const clean = cleanRecord(record, id);
      const index = records.findIndex((item) => item.id === clean.id);
      if (index < 0) {
        if (records.length >= MAX_SCRIPTS) fail('You can save up to 50 userscripts. Delete one before adding another.');
        records.push(clean);
      } else {
        records[index] = clean;
      }
      write(records);
      return { ...clean };
    },
    remove(id) {
      if (!validId(id)) fail('Userscript ID is invalid.');
      const records = read();
      const remaining = records.filter((record) => record.id !== id);
      if (remaining.length === records.length) return false;
      write(remaining);
      return true;
    },
  };
}
