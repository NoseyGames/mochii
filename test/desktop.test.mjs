import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopProfileUrl, validateDesktopGateway, openDesktopInMonkeh, mountDesktopLauncher } from '../apps/desktop.js';

function harness(config = {}) {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, textContent: '', disabled: false, listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; }, click() { this.listeners.click?.(); } });
    return nodes.get(id);
  };
  const opened = [];
  const calls = [];
  const timers = new Set();
  const location = { origin: 'https://monkeh.example' };
  const context = {
    location,
    parent: { location, handleHeroSearch: url => { opened.push(url); } },
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => config }; },
    setTimeout(fn) { timers.add(fn); return fn; },
    clearTimeout(fn) { timers.delete(fn); },
    listeners: {},
    addEventListener(type, handler) { this.listeners[type] = handler; },
  };
  const doc = { getElementById: get };
  return { get, context, doc, calls, opened, timers };
}

test('desktop URLs select verified classic Windows profiles only', () => {
  assert.equal(desktopProfileUrl('windows2000'), 'https://copy.sh/v86/?profile=windows2000');
  assert.equal(desktopProfileUrl('windows98'), 'https://copy.sh/v86/?profile=windows98');
  for (const invalid of ['windows11', '__proto__', 'constructor', 'https://evil.example']) assert.throws(() => desktopProfileUrl(invalid), /Unknown/);
});

test('desktop gateway rejects executable URLs, credentials, malformed configuration and query secrets', () => {
  for (const gateway of [null, {}, { url: 'javascript:alert(1)' }, { url: 'data:text/html,test' }, { url: 'http://example.com/' }, { url: '//example.com/' }, { url: 'https://user:password@example.com/' }, { url: 'https://example.com/?token=secret' }, { url: 'https://example.com/\n' }, { url: 'https://example.com/', label: '\u0000' }]) {
    assert.equal(validateDesktopGateway(gateway), null);
  }
  assert.deepEqual(validateDesktopGateway({ url: 'https://desktop.example/guacamole/#/', label: ' My PC ' }), { url: 'https://desktop.example/guacamole/#/', label: 'My PC' });
});

test('desktop opens via the same-origin Monkeh parent without direct navigation fallback', () => {
  const app = harness();
  assert.equal(openDesktopInMonkeh(desktopProfileUrl('windows2000'), app.context), true);
  assert.deepEqual(app.opened, [desktopProfileUrl('windows2000')]);
  assert.throws(() => openDesktopInMonkeh('javascript:alert(1)', app.context), /HTTPS/);
  app.context.parent = app.context;
  assert.equal(openDesktopInMonkeh(desktopProfileUrl('windows2000'), app.context), false);
  app.context.parent = { location: { origin: 'https://other.example' }, handleHeroSearch() { assert.fail('Cross-origin parent must not launch'); } };
  assert.equal(openDesktopInMonkeh(desktopProfileUrl('windows2000'), app.context), false);
  Object.defineProperty(app.context, 'parent', { get() { throw new Error('cross origin'); } });
  assert.equal(openDesktopInMonkeh(desktopProfileUrl('windows2000'), app.context), false);
});

test('launcher performs no third-party navigation until a user clicks and deduplicates clicks', async () => {
  const app = harness();
  const mounted = mountDesktopLauncher(app.doc, app.context);
  await mounted.ready;
  assert.deepEqual(app.opened, []);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].url, '/api/config');
  assert.equal(app.calls[0].options.credentials, 'same-origin');
  assert.equal(app.timers.size, 0);
  assert.equal(app.get('gateway-card').hidden, true);
  app.get('launch-windows2000').click();
  app.get('launch-windows98').click();
  assert.deepEqual(app.opened, [desktopProfileUrl('windows2000')]);
  assert.equal(app.get('launch-windows2000').disabled, true);
  mounted.dispose();
});

test('optional configured gateway label is rendered as text and URL opens only after click', async () => {
  const app = harness({ windowsVm: { url: 'https://desktop.example/guacamole/', label: '<img src=x onerror=alert(1)>' } });
  const mounted = mountDesktopLauncher(app.doc, app.context);
  await mounted.ready;
  assert.equal(app.get('gateway-card').hidden, false);
  assert.equal(app.get('gateway-title').textContent, '<img src=x onerror=alert(1)>');
  assert.deepEqual(app.opened, []);
  app.get('launch-gateway').click();
  assert.deepEqual(app.opened, ['https://desktop.example/guacamole/']);
  mounted.dispose();
});

test('configuration failures preserve the working emulator launcher', async () => {
  const app = harness();
  app.context.fetch = async () => { throw new Error('offline'); };
  const mounted = mountDesktopLauncher(app.doc, app.context);
  await mounted.ready;
  app.get('launch-windows98').click();
  assert.deepEqual(app.opened, [desktopProfileUrl('windows98')]);
  assert.equal(app.get('gateway-card').hidden, true);
  assert.equal(app.timers.size, 0);
  mounted.dispose();
});

test('standalone launch gives recovery instructions and leaves buttons usable', async () => {
  const app = harness();
  app.context.parent = app.context;
  const mounted = mountDesktopLauncher(app.doc, app.context);
  await mounted.ready;
  app.get('launch-windows2000').click();
  assert.equal(app.get('standalone-help').hidden, false);
  assert.match(app.get('launch-status').textContent, /inside Monkeh/);
  assert.equal(app.get('launch-windows2000').disabled, false);
  assert.deepEqual(app.opened, []);
  mounted.dispose();
});

test('page teardown aborts gateway fetch and ignores late configuration', async () => {
  const app = harness();
  let finish;
  app.context.fetch = () => new Promise(resolve => { finish = resolve; });
  const mounted = mountDesktopLauncher(app.doc, app.context);
  app.context.listeners.pagehide();
  finish({ ok: true, json: async () => ({ windowsVm: { url: 'https://desktop.example/', label: 'VM' } }) });
  await mounted.ready;
  assert.equal(app.get('gateway-card').hidden, true);
  assert.equal(app.timers.size, 0);
  app.get('launch-windows2000').click();
  assert.deepEqual(app.opened, []);
});
