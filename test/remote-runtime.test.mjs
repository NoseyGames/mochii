import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteRuntime } from '../browser-tools/remote-runtime.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(t, options = {}) {
  const requests = [];
  const events = { pages: [], logs: [], selections: [], errors: [], networks: [] };
  let hostPort;
  const frame = { src: 'https://proxy.test/proxy-host.html#https%3A%2F%2Fexample.com', contentWindow: {
    postMessage(message, origin, ports) {
      assert.deepEqual(message, { type: 'monkeh-proxy:init' });
      assert.equal(origin, 'https://proxy.test');
      assert.equal(ports.length, 1);
      hostPort = ports[0];
      hostPort.onmessage = ({ data }) => requests.push(data);
      hostPort.start();
    }
  } };
  const runtime = createRemoteRuntime(frame, 'https://proxy.test', {
    onPage: value => events.pages.push(value), onConsole: value => events.logs.push(value),
    onSelect: value => events.selections.push(value), onError: value => events.errors.push(value),
    onNetwork: value => events.networks.push(value),
  }, options);
  t.after(() => { runtime.dispose(); hostPort.close(); });
  return {
    runtime, events, requests,
    async send(event, data = {}) { hostPort.postMessage({ event, data }); await tick(); await tick(); },
    async response(id, result, error) { hostPort.postMessage({ id, result, error }); await tick(); await tick(); },
  };
}

const tree = () => ({ rootId: 'root', nodes: [
  { id: 'root', localName: 'html', children: ['body'] },
  { id: 'body', localName: 'body', elementId: 'demo', className: 'page', children: [] },
] });
const info = extra => ({ selector: 'body#demo', tag: 'body', rect: { width: 800, height: 600 }, attributes: [{ name: 'id', value: 'demo' }], styles: [{ name: 'color', value: 'red' }], ...extra });

test('remote tools require an exact configured proxy host URL before handing out a port', () => {
  for (const src of ['https://evil.test/proxy-host.html', 'https://proxy.test/math.html', 'javascript:alert(1)']) {
    assert.throws(() => createRemoteRuntime({ src }, 'https://proxy.test'), /configured proxy host/);
  }
  assert.throws(() => createRemoteRuntime({ src: 'https://proxy.test/proxy-host.html' }, 'https://proxy.test/wrong'), /configured proxy host/);
});

test('manual evaluation uses RPC and returns only a bounded formatted string', async t => {
  const app = harness(t);
  await app.send('ready');
  assert.equal(app.runtime.hasHandshake, true);
  const evaluated = app.runtime.evaluate('document.title');
  await tick();
  assert.deepEqual(app.requests[0], { id: 1, method: 'evaluate', params: { code: 'document.title' } });
  await app.response(1, 'x'.repeat(20000));
  assert.equal((await evaluated).length, 12000);
  await assert.rejects(app.runtime.evaluate('x'.repeat(110001)), /110,000/);
  assert.equal(app.runtime.request, undefined, 'the facade does not expose generic page commands');
});

test('page events become inert bounded trees with cycles and duplicate edges removed', async t => {
  const app = harness(t);
  const snapshot = tree();
  snapshot.nodes[0].children = ['body', 'body', 'root'];
  snapshot.nodes[1].children = ['root'];
  snapshot.nodes[1].className = 'x'.repeat(5000);
  await app.send('page', { url: 'https://example.com/', title: 'x'.repeat(1000), tree: snapshot });
  assert.equal(app.events.pages[0].title.length, 300);
  const children = app.runtime.getChildren();
  assert.equal(children.length, 1);
  assert.equal(children[0].className.length, 500);
  assert.equal(app.runtime.getChildren(children[0]).length, 0);
  assert.equal(children[0].ownerDocument, undefined);
  await app.send('page', { url: 'javascript:alert(1)', tree: snapshot });
  assert.equal(app.events.pages.length, 1);
});

test('unknown messages cannot ask the shell to evaluate, navigate, or send saved data', async t => {
  const app = harness(t);
  for (const event of ['evaluate', 'readStorage', 'userscripts', 'navigate', '__proto__']) {
    await app.send(event, { code: 'window.stolen=true', url: 'https://evil.test/', key: 'monkeh.userscripts.v1' });
  }
  assert.equal(app.requests.length, 0);
  assert.deepEqual(app.events.pages, []);
});

test('navigation retires pending commands so a late result cannot apply to the next page', async t => {
  const app = harness(t);
  const evaluated = app.runtime.evaluate('pending()');
  const rejection = assert.rejects(evaluated, /page changed/);
  await app.send('page', { url: 'https://example.com/new', tree: tree() });
  await rejection;
  await app.response(1, 'OLD RESULT');
  assert.equal(app.events.pages.length, 1);
});

test('selection descriptions and network metadata are bounded and numeric dimensions validated', async t => {
  const app = harness(t);
  await app.send('select', { id: 'outside-tree', info: info({ rect: { width: Infinity, height: -50 }, selector: 'x'.repeat(9000), attributes: Array.from({ length: 500 }, () => ({ name: 'x'.repeat(500), value: '<script>text only</script>' })) }) });
  const selected = app.events.selections[0];
  const described = await app.runtime.describe(selected);
  assert.equal(described.selector.length, 5000);
  assert.deepEqual(described.rect, { width: 0, height: 0 });
  assert.equal(described.attributes.length, 100);
  assert.equal(described.attributes[0].name.length, 128);
  await app.send('network', { status: 'connected', activeEndpoint: 'x'.repeat(9000), configuredCount: 1000, error: '<b>text</b>' });
  assert.equal(app.events.networks[0].configuredCount, 11);
  assert.equal(app.events.networks[0].activeEndpoint.length, 8192);
});

test('console events have a per-second cap and bounded text instead of live objects', async t => {
  const app = harness(t);
  for (let i = 0; i < 105; i++) await app.send('console', { level: 'log', args: ['x'.repeat(9000), { unsafe: 'object' }], time: 0 });
  assert.equal(app.events.logs.length, 100);
  assert.equal(app.events.logs[0].args[0].length, 5000);
  assert.equal(app.events.logs[0].args[1], '');
});

test('a malicious host cannot flood shell repaint events with tree or selection updates', async t => {
  const app = harness(t);
  for (let i = 0; i < 8; i++) await app.send('page', { url: 'https://example.com/', tree: tree() });
  assert.equal(app.events.pages.length, 4);
  for (let i = 0; i < 100; i++) await app.send('select', { id: 'body', info: info() });
  assert.ok(app.events.selections.length <= 30);
});

test('style changes and selector searches use narrow RPC methods', async t => {
  const app = harness(t);
  await app.send('select', { id: 'body', info: info() });
  const selected = app.events.selections[0];
  const changed = app.runtime.setStyle(selected, 'color', 'blue');
  await tick();
  assert.equal(app.requests[0].method, 'style');
  await app.response(app.requests[0].id, info({ styles: [{ name: 'color', value: 'blue' }] }));
  await changed;
  assert.equal((await app.runtime.describe(selected)).styles[0].value, 'blue');
  const searched = app.runtime.selectSelector('#demo');
  await tick();
  assert.deepEqual(app.requests[1].params, { selector: '#demo' });
  await app.response(app.requests[1].id, { id: 'body', info: info() });
  await searched;
});

test('unanswered requests time out and dispose rejects pending commands', async t => {
  const app = harness(t, { requestTimeout: 20 });
  await app.send('ready');
  await assert.rejects(app.runtime.evaluate('never()'), /did not respond/);
  const pending = app.runtime.evaluate('later()');
  app.runtime.dispose();
  await assert.rejects(pending, /connection is closed/);
  await assert.rejects(app.runtime.evaluate('new()'), /connection is closed/);
});
