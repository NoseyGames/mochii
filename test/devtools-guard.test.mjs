import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDevtoolsGuard, isNativeDevtoolsShortcut } from '../browser-tools/devtools-guard.js';

function events() {
  const handlers = new Map();
  return {
    addEventListener(type, listener) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      handlers.get(type)?.delete(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of handlers.get(type) || []) listener(event);
    },
    dispatchEvent(event) {
      this.dispatch(event.type, event);
      return true;
    },
    listenerCount() {
      return [...handlers.values()].reduce((count, listeners) => count + listeners.size, 0);
    }
  };
}

function fixture(options) {
  const timers = new Map();
  const redirects = [];
  let nextTimer = 0;
  const win = {
    ...events(),
    CustomEvent,
    document: { ...events(), visibilityState: 'visible', fullscreenElement: null },
    location: { pathname: '/math', replace: path => redirects.push(path) },
    outerWidth: 1440, outerHeight: 1000, innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1,
    navigator: { maxTouchPoints: 0 },
    matchMedia: () => ({ matches: true }),
    setInterval(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearInterval: id => timers.delete(id)
  };
  const guard = createDevtoolsGuard(win, options);
  return {
    win, guard, timers, redirects,
    tick(count = 1) {
      for (let i = 0; i < count; i++) {
        for (const { callback } of [...timers.values()]) callback();
      }
    },
    key(event = {}) {
      let prevented = false;
      win.dispatch('keydown', { key: 'F12', isTrusted: true, preventDefault() { prevented = true; }, ...event });
      return prevented;
    }
  };
}

test('native shortcuts cover common desktop browser tools without capturing ordinary editing shortcuts', () => {
  for (const key of ['I', 'j', 'c']) {
    assert.equal(isNativeDevtoolsShortcut({ key, ctrlKey: true, shiftKey: true }), true);
    assert.equal(isNativeDevtoolsShortcut({ key, metaKey: true, altKey: true }), true);
  }
  assert.equal(isNativeDevtoolsShortcut({ key: 'F12' }), true);
  for (const event of [
    { key: 'i', ctrlKey: true }, { key: 'c', ctrlKey: true }, { key: 'j', metaKey: true },
    { key: 'k', ctrlKey: true, shiftKey: true }, { key: 'F12', shiftKey: true },
    { key: 'F12', repeat: true }, { key: 'F12', isComposing: true },
    { key: 'i', ctrlKey: true, shiftKey: true, getModifierState: name => name === 'AltGraph' }
  ]) assert.equal(isNativeDevtoolsShortcut(event), false);
});

test('trusted native shortcut redirects once to the fixed local error page', () => {
  const f = fixture();
  const leaving = [];
  f.win.addEventListener('monkeh:leaving', event => leaving.push({ reason: event.detail.reason, redirected: f.redirects.length }));
  assert.equal(f.key(), true);
  assert.deepEqual(f.redirects, ['/oops.html']);
  assert.deepEqual(leaving, [{ reason: 'devtools-guard', redirected: 0 }]);
  assert.equal(f.key(), false);
  assert.equal(f.guard.getState().redirected, true);
  assert.equal(f.timers.size, 0);
  f.guard.dispose();
});

test('untrusted shortcuts and built-in inspector interactions do not redirect', () => {
  const f = fixture();
  assert.equal(f.key({ isTrusted: false }), false);
  f.win.dispatch('click', { target: { id: 'tools-inspect' }, isTrusted: true });
  f.win.dispatch('monkeh:inspect', { detail: { mode: 'select' } });
  assert.deepEqual(f.redirects, []);
  f.guard.dispose();
});

test('a configured panic shortcut takes priority over the matching native tools shortcut', () => {
  const f = fixture();
  f.win.MonkehPrivacy = { get: () => ({ panicKey: 'Ctrl+Shift+i' }) };
  assert.equal(f.key({ key: 'I', ctrlKey: true, shiftKey: true }), false);
  assert.deepEqual(f.redirects, []);
  assert.equal(f.key({ key: 'J', ctrlKey: true, shiftKey: true }), true);
  assert.deepEqual(f.redirects, ['/oops.html']);
  f.guard.dispose();
});

test('native guard remains active in typing fields where the panic shortcut is ignored', () => {
  const f = fixture();
  f.win.MonkehPrivacy = { get: () => ({ panicKey: 'F12' }) };
  assert.equal(f.key({ target: { closest: () => ({}) } }), true);
  assert.deepEqual(f.redirects, ['/oops.html']);
  f.guard.dispose();
});

test('disabled guard does not intercept keys and can be enabled through privacy settings', () => {
  const f = fixture({ enabled: false });
  assert.equal(f.key(), false);
  f.win.dispatch('monkeh:privacy', { detail: { nativeDevtoolsGuard: true } });
  assert.equal(f.key(), true);
  assert.deepEqual(f.redirects, ['/oops.html']);
  f.guard.dispose();
});

test('viewport changes never trigger redirects with the default heuristic disabled', () => {
  const f = fixture();
  f.win.innerWidth = 950;
  for (let i = 0; i < 12; i++) f.guard.sample();
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.redirects, []);
  f.guard.dispose();
});

test('opt-in docked detection requires several stable samples and stops sampling after redirect', () => {
  const f = fixture({ detectDocked: true });
  assert.equal([...f.timers.values()][0].delay, 500);
  f.win.innerWidth = 1000;
  f.tick(3);
  assert.deepEqual(f.redirects, []);
  f.tick();
  assert.deepEqual(f.redirects, ['/oops.html']);
  assert.equal(f.timers.size, 0);
  f.guard.dispose();
});

test('a transient panel or an ordinary browser-window resize does not redirect', () => {
  const f = fixture({ detectDocked: true });
  f.win.innerWidth = 1000;
  f.tick(3);
  f.win.innerWidth = 1440;
  f.tick(5);
  f.win.outerWidth = 1000;
  f.win.innerWidth = 1000;
  f.tick(5);
  assert.deepEqual(f.redirects, []);
  f.guard.dispose();
});

test('zoom, touch devices, fullscreen, and hidden documents reset optional viewport detection', () => {
  for (const mutate of [
    win => { win.devicePixelRatio = 1.25; },
    win => { win.navigator.maxTouchPoints = 1; },
    win => { win.document.fullscreenElement = {}; },
    win => { win.document.visibilityState = 'hidden'; },
    win => { win.matchMedia = () => ({ matches: false }); },
    win => { win.innerWidth = 400; }
  ]) {
    const f = fixture({ detectDocked: true });
    f.win.innerWidth = 1000;
    mutate(f.win);
    f.tick(8);
    assert.deepEqual(f.redirects, []);
    f.guard.dispose();
  }
});

test('already docked panels establish the initial baseline instead of immediately redirecting', () => {
  const f = fixture({ detectDocked: true });
  f.guard.setEnabled(false);
  f.win.innerWidth = 1000;
  f.guard.setEnabled(true);
  f.tick(8);
  assert.deepEqual(f.redirects, []);
  f.guard.dispose();
});

test('privacy changes stop optional polling and reject non-boolean changes', () => {
  const f = fixture({ detectDocked: true });
  f.win.dispatch('monkeh:privacy', { detail: { detectDocked: false } });
  assert.equal(f.timers.size, 0);
  f.win.dispatch('monkeh:privacy', { detail: { nativeDevtoolsGuard: 'false', detectDocked: 'true' } });
  assert.equal(f.guard.getState().enabled, true);
  assert.equal(f.guard.getState().detectDocked, false);
  f.guard.setDetectDocked(true);
  assert.equal(f.timers.size, 1);
  f.guard.setEnabled(false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.key(), false);
  f.guard.dispose();
});

test('dispose removes all listeners and timers without interfering with later page events', () => {
  const f = fixture({ detectDocked: true });
  assert.ok(f.win.listenerCount() > 0);
  assert.ok(f.win.document.listenerCount() > 0);
  f.guard.dispose();
  f.guard.dispose();
  assert.equal(f.timers.size, 0);
  assert.equal(f.win.listenerCount(), 0);
  assert.equal(f.win.document.listenerCount(), 0);
  f.key();
  f.win.innerWidth = 1000;
  f.tick(8);
  assert.deepEqual(f.redirects, []);
});

test('error page contains the requested message and a normal return link without the guard', async () => {
  const html = await readFile(new URL('../oops.html', import.meta.url), 'utf8');
  assert.match(html, /<h1>oops! something went wrong<\/h1>/);
  assert.match(html, /href="\/math\.html"/);
  assert.doesNotMatch(html, /<script\b|http-equiv="refresh"/i);
});

