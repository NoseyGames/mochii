import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../browser-tools/ai-help.js', import.meta.url), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness(configPromise) {
  const elements = new Map();
  function get(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', disabled: false, hidden: false, listeners: new Map(),
      addEventListener(name, callback) { this.listeners.set(name, callback); },
      emit(name) { return this.listeners.get(name)?.({ preventDefault() {} }); },
    });
    return elements.get(id);
  }
  const requests = [];
  const windowListeners = new Map();
  const context = vm.createContext({
    document: { getElementById: get },
    window: {
      MonkehPrivacy: { get: () => ({ aiEnabled: true }) },
      addEventListener(name, callback) { windowListeners.set(name, callback); },
    },
    MonkehConfig: { fetchConfig: () => configPromise },
    AbortController, AbortSignal, URL,
    fetch: async (url, options) => {
      options.signal.throwIfAborted();
      requests.push({ url: url.href, body: JSON.parse(options.body), options });
      return new Response(JSON.stringify({ answer: '<script>Never execute this answer.</script>' }), { headers: { 'Content-Type': 'application/json' } });
    },
  });
  vm.runInContext(source, context, { filename: 'ai-help.js' });
  return { get, requests, windowListeners };
}

test('coding help sends only the question and code present when Ask was pressed', async () => {
  const config = deferred();
  const app = harness(config.promise);
  app.get('ai-question').value = 'Explain this function';
  app.get('ai-code').value = 'const publicExample = 1;';
  const pending = app.get('ai-help-form').emit('submit');
  app.get('ai-question').value = 'New draft question';
  app.get('ai-code').value = 'Private unsent draft typed after clicking Ask';
  config.resolve({ proxyOrigin: 'https://proxy.example' });
  await pending;
  assert.equal(app.requests.length, 1);
  assert.deepEqual(app.requests[0].body, { question: 'Explain this function', code: 'const publicExample = 1;' });
  assert.equal(app.requests[0].options.credentials, 'omit');
  assert.equal(app.requests[0].options.referrerPolicy, 'no-referrer');
  assert.equal(app.get('ai-output').textContent, '<script>Never execute this answer.</script>');
});

test('disabling coding help while configuration loads cancels the pending request', async () => {
  const config = deferred();
  const app = harness(config.promise);
  app.get('ai-question').value = 'Explain this function';
  const pending = app.get('ai-help-form').emit('submit');
  app.windowListeners.get('monkeh:privacy')({ detail: { aiEnabled: false } });
  config.resolve({ proxyOrigin: 'https://proxy.example' });
  await pending;
  assert.equal(app.requests.length, 0);
  assert.equal(app.get('ai-submit').disabled, false);
  assert.equal(app.get('ai-cancel').hidden, true);
});
