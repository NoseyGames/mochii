import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Script } from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set(['node_modules', '.pnpm-store', '.git', '.codex', '.agents', '.cache', '.shipping', 'test-results', 'playwright-report']);
const failures = [];
let checked = 0;

async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) yield* files(path);
    else if (entry.isFile()) yield path;
  }
}

function checkJavaScript(source, label, module = false) {
  checked++;
  try {
    if (module) {
      const result = spawnSync(process.execPath, ['--check', '--input-type=module'], {
        input: source,
        encoding: 'utf8',
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(result.stderr.trim());
    } else {
      // Compile only. Browser globals and vendored bundles must never execute here.
      new Script(source, { filename: label });
    }
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
  }
}

function decodeAttribute(value) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (match, entity) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()];
    const hexadecimal = entity[1].toLowerCase() === 'x';
    const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\ufffd';
  });
}

function checkHtml(html, label) {
  const classicScripts = [];
  // Consume whole tags (including quoted > characters), then skip raw script/style
  // contents. Looking for handlers across the whole file would misparse JS strings.
  const tags = /<!--[\s\S]*?-->|<![^>]*>|<\/?([a-z][\w:-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
  let tag;
  while ((tag = tags.exec(html))) {
    if (!tag[1] || tag[0].startsWith('</')) continue;
    const name = tag[1].toLowerCase();
    const line = html.slice(0, tag.index).split('\n').length;
    const attributes = new Map();
    const matcher = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let attribute;
    while ((attribute = matcher.exec(tag[2]))) {
      const key = attribute[1].toLowerCase();
      const value = decodeAttribute(attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
      attributes.set(key, value);
      if (/^on[a-z]+$/.test(key)) {
        checkJavaScript(`(function(event) {\n${value}\n})`, `${label}:${line} ${key}`);
      }
    }
    if (attributes.has('srcdoc')) checkHtml(attributes.get('srcdoc'), `${label}:${line} srcdoc`);
    if (!['script', 'style', 'textarea', 'title'].includes(name)) continue;
    const close = new RegExp(`</${name}\\s*>`, 'gi');
    close.lastIndex = tags.lastIndex;
    const end = close.exec(html);
    const body = html.slice(tags.lastIndex, end ? end.index : html.length);
    if (name === 'script' && !attributes.has('src')) {
      const type = (attributes.get('type') ?? '').toLowerCase().trim();
      if (type === 'module' || !type || /^(?:text|application)\/(?:java|ecma)script$/.test(type)) {
        checkJavaScript(body, `${label}:${line} inline script`, type === 'module');
        if (type !== 'module') classicScripts.push(body);
      }
    }
    tags.lastIndex = end ? close.lastIndex : html.length;
  }
  // Classic scripts share a global scope: separate parsing misses duplicate classes.
  if (classicScripts.length > 1) checkJavaScript(classicScripts.join('\n;\n'), `${label} shared script scope`);
}

for await (const path of files(root)) {
  const extension = extname(path).toLowerCase();
  const label = relative(root, path);
  if (['.js', '.mjs', '.cjs'].includes(extension)) {
    checked++;
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      failures.push(`${label}: ${result.error?.message ?? result.stderr.trim()}`);
    }
  } else if (extension === '.html') {
    checkHtml(await readFile(path, 'utf8'), label);
  }
}

if (failures.length) {
  console.error(failures.join('\n\n'));
  process.exitCode = 1;
} else {
  console.log(`Syntax OK: ${checked} JavaScript files, inline scripts, and event handlers.`);
}
