import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const auk = readFileSync(new URL('../apps/auk.js', import.meta.url), 'utf8');
const vox = readFileSync(new URL('../apps/vox.html', import.meta.url), 'utf8');
const flyflix = readFileSync(new URL('../flyflix.html', import.meta.url), 'utf8');
const flyflixProvider = readFileSync(new URL('../flyflix-provider.html', import.meta.url), 'utf8');
const aukHtml = readFileSync(new URL('../apps/auk.html', import.meta.url), 'utf8');
const configSource = readFileSync(new URL('../browser-tools/config.js', import.meta.url), 'utf8');
const inlineScript = html => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .find(([, attributes]) => !/\bsrc\s*=/.test(attributes))[2];
const voxScript = [...vox.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .find(([, attributes, source]) => !/\bsrc\s*=/.test(attributes) && source.includes('class GameLoaders'))[2];

function contextFor(source, overrides = {}) {
  function element() {
    return {
      addEventListener() {}, setAttribute(name, value) { this[name] = value; },
      remove() {}, appendChild() {}, querySelector() { return null; }, value: '', style: {}, classList: { add() {}, remove() {}, contains() { return false; } }
    };
  }
  const page = {
    MonkehUseBackendConfig: true,
    console, performance, URL, Blob, TextEncoder, TextDecoder, Uint8Array, AbortController, AbortSignal,
    setTimeout, clearTimeout, setInterval, clearInterval,
    document: { getElementById: element, querySelector: element, createElement: element, addEventListener() {} },
    addEventListener() {}, removeEventListener() {},
    ...overrides
  };
  page.window = page;
  vm.createContext(page);
  vm.runInContext(configSource, page);
  vm.runInContext(source, page);
  return page;
}

function project(overrides = {}) {
  return { files: [{ id: 1, name: 'index.html', language: 'html', content: '<h1>Hello</h1>' }], ...overrides };
}

test('Auk rejects malformed, oversized, duplicate-ID and unsupported saved files before making editors', () => {
  const page = contextFor(auk);
  for (const bad of [false, [], {}, project({ files: [null] }), project({ files: [project().files[0], project().files[0]] }),
    project({ files: [{ ...project().files[0], id: Number.MAX_SAFE_INTEGER }] }),
    project({ files: [{ ...project().files[0], language: '__proto__' }] }),
    project({ files: [{ ...project().files[0], name: '../escape.html' }] }),
    project({ files: [{ ...project().files[0], content: 'x'.repeat(512 * 1024 + 1) }] }),
    project({ files: Array.from({ length: 65 }, (_, index) => ({ id: index + 1, name: `file${index}.html`, language: 'html', content: '' })) })]) {
    assert.throws(() => page.validateSavedEditorData(bad), /Invalid|exceeds/);
  }
});

test('Auk normalizes bad preference types without losing valid file contents', () => {
  const page = contextFor(auk);
  const normalized = page.validateSavedEditorData(project({ theme: 'dark injected', fontSize: '99999', tabSize: {}, autoRun: 'false', autosave: false }));
  assert.equal(normalized.theme, 'dark');
  assert.equal(normalized.fontSize, 24);
  assert.equal(normalized.tabSize, '4');
  assert.equal(normalized.autoRun, true);
  assert.equal(normalized.autosave, false);
  assert.equal(normalized.files[0].content, '<h1>Hello</h1>');
});

test('Auk keeps imported file names out of executable preview markup and uses an opaque sandbox', () => {
  const page = contextFor(auk);
  vm.runInContext(`files = [{id:1,name:'</title><script>ATTACK</script>',language:'html',content:'<p>Safe</p>'}];addPreview(files[0]);updatePreview(1);`, page);
  const preview = vm.runInContext('previews[1]', page);
  assert.equal(preview.sandbox, 'allow-scripts');
  assert.equal(preview.referrerPolicy, 'no-referrer');
  assert.doesNotMatch(preview.srcdoc, /ATTACK/);
  assert.match(preview.srcdoc, /<p>Safe<\/p>/);
});

test('Auk clearly marks saved code as paused when auto-run is off, and Run Preview runs without enabling auto-run', () => {
  const page = contextFor(auk);
  vm.runInContext(`files = [{id:1,name:'index.html',language:'html',content:'<h1>Saved work</h1>'}];activeFileId=1;autoRunToggle.checked=false;addPreview(files[0]);`, page);
  const preview = vm.runInContext('previews[1]', page);
  assert.match(preview.srcdoc, /Preview paused/);
  assert.doesNotMatch(preview.srcdoc, /No Content/);
  page.runActivePreview();
  assert.match(preview.srcdoc, /<h1>Saved work<\/h1>/);
  assert.equal(vm.runInContext('autoRunToggle.checked', page), false);
  assert.equal(vm.runInContext('files[0].content', page), '<h1>Saved work</h1>');
});

test('closing the Auk shortcuts dialog also clears the preference that would reopen it on reload', () => {
  const page = contextFor(auk, { localStorage: { setItem() {} } });
  page.openShortcutsModal();
  assert.equal(vm.runInContext('shortcutsToggle.checked', page), true);
  page.closeShortcutsModal();
  assert.equal(vm.runInContext('shortcutsToggle.checked', page), false);
  assert.equal(vm.runInContext('shortcutsModal.style.display', page), 'none');
});

test('game JSON URL validation accepts relative HTTPS paths and rejects credentials and active/local protocols', () => {
  const page = contextFor(voxScript);
  assert.equal(page.remoteGameUrl('../game.swf', 'https://games.example/configs/a.json'), 'https://games.example/game.swf');
  for (const bad of ['javascript:alert(1)', 'data:text/html,test', 'blob:https://example.com/fake', 'file:///tmp/test', 'https://user:password@example.com/game', null, 'x'.repeat(8193)]) {
    assert.throws(() => page.remoteGameUrl(bad), /Invalid|HTTP or HTTPS/);
  }
});

test('game download counts streamed bytes, aborts oversized responses, and omits browser credentials', async () => {
  let options;
  let cancelled = false;
  const page = contextFor(voxScript, {
    async fetch(_url, supplied) {
      options = supplied;
      let i = 0;
      return { ok: true, headers: new Headers(), body: { getReader: () => ({
        async read() { return ++i < 3 ? { done: false, value: new Uint8Array(8) } : { done: true }; },
        async cancel() { cancelled = true; }
      }) } };
    }
  });
  await assert.rejects(page.readGameBytes('https://example.com/game.js', 10), /size limit/);
  assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.signal.aborted, true);
  assert.equal(cancelled, true);
});

test('game download rejects oversized Content-Length before reading and rejects unowned blob URLs', async () => {
  const page = contextFor(voxScript, { async fetch() {
    return { ok: true, headers: new Headers({ 'content-length': '100' }), body: { getReader() { assert.fail('must not read'); } } };
  } });
  await assert.rejects(page.readGameBytes('https://example.com/game.zip', 10), /size limit/);
  await assert.rejects(page.readGameBytes('blob:https://example.com/unowned'), /HTTP or HTTPS/);
});

test('ZIP extraction stops the decompressor when output crosses the limit', async () => {
  let paused = false;
  const handlers = {};
  const stream = {
    on(name, handler) { handlers[name] = handler; return this; },
    pause() { paused = true; },
    resume() { handlers.data(new Uint8Array(8)); handlers.data(new Uint8Array(8)); handlers.end(); return this; }
  };
  const page = contextFor(voxScript);
  await assert.rejects(page.extractZipEntry({ internalStream: () => stream }, 10), /size limit/);
  assert.equal(paused, true);
});

test('ZIP extraction retains a small playable file', async () => {
  const handlers = {};
  const stream = {
    on(name, handler) { handlers[name] = handler; return this; }, pause() {},
    resume() { handlers.data(new Uint8Array([1, 2, 3])); handlers.end(); return this; }
  };
  const page = contextFor(voxScript);
  const blob = await page.extractZipEntry({ internalStream: () => stream }, 10);
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3]);
});

test('Vox enforces library and running-game limits without copying oversized input', () => {
  const page = contextFor(voxScript);
  const Player = vm.runInContext('SwfPlayer', page);
  const player = Object.create(Player.prototype);
  player.loadedGames = [];
  player.showNotification = () => {};
  assert.equal(player.canAddGame(25 * 1024 * 1024 + 1), false);
  player.loadedGames = Array.from({ length: 50 }, () => ({ size: 0 }));
  assert.equal(player.canAddGame(1), false);
  player.loadedGames = [{ size: 100 * 1024 * 1024 }];
  assert.equal(player.canAddGame(1), false);
});

test('external app code has integrity checks or executes only in an isolated provider', () => {
  for (const [, url, attributes] of aukHtml.matchAll(/<script src="(https:[^"]+)"([^>]*)>/g)) {
    assert.match(attributes, /integrity="sha384-/);
    assert.match(url, /codemirror\/5\.65\.13\//);
  }
  assert.doesNotMatch(aukHtml + vox, /googletagmanager/);
  assert.match(vox, /ruffle@0\.6\.0\/ruffle\.js" integrity="sha384-/);
  assert.match(vox, /connect-src https:\/\/unpkg.com\/@ruffle-rs\/ruffle@0\.6\.0\//);
  assert.match(vox, /allowScriptAccess:false/);
  assert.match(flyflix, /id="provider"[^>]+sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"/);
  assert.doesNotMatch(flyflix, /flyflix@main|main\.js|srcdoc\s*=/);
  assert.match(flyflixProvider, /flyflix@89bd78c99e75504faa5f1f8d928e3370574f9eab\/main\.js/);
});

test('Flyflix refuses shell-origin execution and ignores forged provider status messages', async () => {
  const script = inlineScript(flyflix);
  const listeners = new Map();
  const page = contextFor(script, {
    location: new URL('https://monkeh.test/flyflix.html'), AbortSignal,
    addEventListener: (name, listener) => listeners.set(name, listener),
    async fetch() { return Response.json({ proxyOrigin: 'https://proxy.test' }); }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vm.runInContext('frame.src', page), 'https://proxy.test/flyflix-provider.html?run=1');
  for (const origin of ['https://monkeh.test', 'javascript:alert(1)', 'https://user:password@proxy.test', 'https://proxy.test/path']) {
    assert.throws(() => page.validateProviderOrigin(origin), /separate configured proxy origin/);
  }
  const target = vm.runInContext('frame.contentWindow = {}; frame.contentWindow', page);
  const message = { type: 'provider-rendered', generation: 1 };
  listeners.get('message')({ source: target, origin: 'https://evil.test', data: message });
  listeners.get('message')({ source: {}, origin: 'https://proxy.test', data: message });
  assert.match(vm.runInContext('status.textContent', page), /Opening provider/);
  listeners.get('message')({ source: target, origin: 'https://proxy.test', data: message });
  assert.match(vm.runInContext('status.textContent', page), /Provider connected/);
  vm.runInContext('clearTimeout(timeout)', page);
});

test('Flyflix provider checks its isolated origin before loading the pinned third-party module', async () => {
  const script = inlineScript(flyflixProvider);
  let loads = 0;
  const badPage = contextFor(script, {
    location: new URL('https://monkeh.test/flyflix-provider.html?run=1'), AbortSignal,
    parent: { postMessage() {} },
    async fetch() { return Response.json({ proxyOrigin: 'https://proxy.test', shellOrigins: ['https://monkeh.test'] }); },
  });
  badPage.document.head = { appendChild() { loads++; } };
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loads, 0);
  assert.equal(vm.runInContext('shellOrigins.length', badPage), 0);

  let moduleUrl;
  let route;
  const goodPage = contextFor(script, {
    location: new URL('https://proxy.test/flyflix-provider.html?run=1'), AbortSignal,
    parent: { postMessage() {} }, history: { replaceState(_state, _title, path) { route = path; } },
    MutationObserver: class { observe() {} },
    async fetch() { return Response.json({ proxyOrigin: 'https://proxy.test', shellOrigins: ['https://monkeh.test'] }); },
  });
  goodPage.document.head = { appendChild(script) { moduleUrl = script.src; } };
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(route, '/');
  assert.match(moduleUrl, /89bd78c99e75504faa5f1f8d928e3370574f9eab\/main\.js$/);
});

test('Flyflix reports a missing backend for an HTML fallback and Reload recovers after routing is fixed', async () => {
  const page = contextFor(inlineScript(flyflix), {
    location: new URL('https://monkeh.test/flyflix.html'),
    async fetch() { return new Response('<!DOCTYPE html><title>Monkeh</title>', { headers: { 'Content-Type': 'text/html' } }); }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(vm.runInContext('status.textContent', page), /backend is not connected.*\/api\/config/);
  assert.doesNotMatch(vm.runInContext('status.textContent', page), /Unexpected token/);
  assert.equal(vm.runInContext('frame.src', page), undefined);
  page.fetch = async () => Response.json({ proxyOrigin: 'https://proxy.test' });
  await page.loadProvider();
  assert.equal(vm.runInContext('frame.src', page), 'https://proxy.test/flyflix-provider.html?run=2');
  vm.runInContext('clearTimeout(timeout)', page);
});

test('Flyflix provider rejects HTML configuration before loading third-party code and can retry', async () => {
  let loads = 0;
  const notice = { hidden: true, textContent: '' };
  const root = { childElementCount: 0 };
  const page = contextFor(inlineScript(flyflixProvider), {
    location: new URL('https://proxy.test/flyflix-provider.html?run=1'),
    parent: { postMessage() {} },
    history: { replaceState() {} },
    MutationObserver: class { observe() {} },
    document: {
      getElementById: id => id === 'provider-error' ? notice : root,
      createElement: () => ({ addEventListener() {} }),
      head: { appendChild() { loads++; } }
    },
    async fetch() { return new Response('<!DOCTYPE html><title>Monkeh</title>', { headers: { 'Content-Type': 'text/html' } }); }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /backend is not connected.*\/api\/config/);
  assert.equal(loads, 0);
  page.fetch = async () => Response.json({ proxyOrigin: 'https://proxy.test', shellOrigins: ['https://monkeh.test'] });
  await page.startProvider();
  assert.equal(loads, 1);
});
