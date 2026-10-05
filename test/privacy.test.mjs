import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { defaults, normalizePrivacy, frameSandbox } from '../browser-tools/privacy.js';

test('privacy preferences accept known typed values without arbitrary search URLs', () => {
  assert.deepEqual(normalizePrivacy(null), defaults);
  const result = normalizePrivacy({ searchEngine: 'https://evil.test/', allowPopups: 'true', showCovers: false, unknown: true });
  assert.equal(result.searchEngine, 'duckduckgo');
  assert.equal(result.allowPopups, false);
  assert.equal(result.showCovers, false);
  assert.equal(result.unknown, undefined);
  assert.equal(normalizePrivacy({ searchEngine: 'brave' }).searchEngine, 'brave');
});

test('sandbox preferences preserve isolation and restrict popups by default', () => {
  const local = frameSandbox(defaults, false).split(' ');
  const remote = frameSandbox(defaults, true).split(' ');
  assert.ok(!local.includes('allow-same-origin'));
  assert.ok(remote.includes('allow-same-origin'));
  assert.ok(!remote.includes('allow-popups'));
  assert.ok(!remote.includes('allow-top-navigation'));
  assert.ok(!frameSandbox({ ...defaults, allowDownloads: false }, true).includes('allow-downloads'));
  assert.ok(frameSandbox({ ...defaults, allowPopups: true }, true).includes('allow-popups'));
});

test('appearance and cloak preferences accept only known names and six-digit colors', () => {
  const selected = normalizePrivacy({ mode: 'light', font: 'space-mono', background: 'custom', cloak: 'classroom', accent: '#Aa12Ef' });
  assert.equal(selected.mode, 'light');
  assert.equal(selected.font, 'space-mono');
  assert.equal(selected.background, 'custom');
  assert.equal(selected.cloak, 'classroom');
  assert.equal(selected.accent, '#aa12ef');
  for (const bad of ['<img src=x onerror=alert(1)>', '__proto__', 'constructor', '', null]) {
    const value = normalizePrivacy({ mode: bad, font: bad, background: bad, cloak: bad, accent: bad });
    for (const key of ['mode', 'font', 'background', 'cloak', 'accent']) assert.equal(value[key], defaults[key]);
  }
});

test('background and panic addresses reject executable schemes, credentials, and oversized URLs', () => {
  const selected = normalizePrivacy({ backgroundUrl: 'https://images.example/picture.png', panicUrl: 'https://example.com' });
  assert.equal(selected.backgroundUrl, 'https://images.example/picture.png');
  assert.equal(selected.panicUrl, 'https://example.com/');
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'http://example.com/', '//example.com/', 'https://user:secret@example.com/', 'https://example.com/' + 'a'.repeat(2048)]) {
    const value = normalizePrivacy({ backgroundUrl: bad, panicUrl: bad });
    assert.equal(value.backgroundUrl, defaults.backgroundUrl);
    assert.equal(value.panicUrl, defaults.panicUrl);
  }
});

test('new behavior preferences preserve typed boolean settings without coercion', () => {
  const keys = ['autoCloak', 'blobCloak', 'closeProtection', 'skipLoading', 'nativeDevtoolsGuard', 'detectDocked', 'characterMasking', 'glassMode'];
  for (const key of keys) {
    assert.equal(normalizePrivacy({ [key]: !defaults[key] })[key], !defaults[key]);
    assert.equal(normalizePrivacy({ [key]: String(!defaults[key]) })[key], defaults[key]);
  }
});

test('user agents accept printable bounded headers without control characters or implicit coercion', () => {
  assert.equal(normalizePrivacy({ userAgent: '  Example/1.0 (Device)  ' }).userAgent, 'Example/1.0 (Device)');
  assert.equal(normalizePrivacy({ userAgent: 'a'.repeat(512) }).userAgent.length, 512);
  for (const value of ['a'.repeat(513), 'test\r\nInjected: yes', 'test\n', 'test\t', 'test\0', 'test\x7f', 'tést', null, 123, ['agent'], { toString() { throw new Error('No coercion'); } }]) {
    assert.equal(normalizePrivacy({ userAgent: value }).userAgent, '');
  }
});

test('particles and shell visual settings reject unknown choices and clamp only finite numeric inputs', () => {
  assert.equal(normalizePrivacy({ particleEffect: 'snow', particleDensity: 'low' }).particleEffect, 'snow');
  assert.equal(normalizePrivacy({ particleEffect: 'rain', particleDensity: 'low' }).particleDensity, 'low');
  for (const value of ['snow;alert(1)', 'constructor', '__proto__', 1, true, null]) {
    assert.equal(normalizePrivacy({ particleEffect: value }).particleEffect, 'none');
    assert.equal(normalizePrivacy({ particleDensity: value }).particleDensity, 'normal');
  }
  assert.equal(normalizePrivacy({ backgroundOpacity: 120 }).backgroundOpacity, 100);
  assert.equal(normalizePrivacy({ backgroundBlur: -1 }).backgroundBlur, 0);
  assert.equal(normalizePrivacy({ glassOpacity: 1 }).glassOpacity, 40);
  assert.equal(normalizePrivacy({ glassBlur: 19.6 }).glassBlur, 20);
  for (const key of ['backgroundOpacity', 'backgroundBlur', 'glassOpacity', 'glassBlur']) {
    for (const value of [NaN, Infinity, '50', true, null]) assert.equal(normalizePrivacy({ [key]: value })[key], defaults[key]);
  }
});

test('panic hotkeys allow supported keys and reject unhandled keys and HTML', () => {
  for (const key of ['a', 'Escape', 'F12', 'Ctrl+Shift+p', 'Ctrl+Alt+Shift+Meta+0']) assert.equal(normalizePrivacy({ panicKey: key }).panicKey, key);
  for (const key of ['Enter', 'Tab', 'ArrowLeft', 'Ctrl+', 'Ctrl+P', 'Ctrl+<script>', '<img>', ' ', null]) assert.equal(normalizePrivacy({ panicKey: key }).panicKey, '');
});

test('panic hotkeys canonicalize modifier order and remove duplicate modifiers', () => {
  assert.equal(normalizePrivacy({ panicKey: 'Shift+Ctrl+p' }).panicKey, 'Ctrl+Shift+p');
  assert.equal(normalizePrivacy({ panicKey: 'Ctrl+Ctrl+Shift+Ctrl+p' }).panicKey, 'Ctrl+Shift+p');
  assert.equal(normalizePrivacy({ panicKey: 'Meta+Alt+Shift+Ctrl+Alt+a' }).panicKey, 'Ctrl+Alt+Shift+Meta+a');
});

test('cross-tab preference sync replaces state without writing another storage event', async () => {
  const source = await readFile(new URL('../browser-tools/privacy.js', import.meta.url), 'utf8');
  const writes = [];
  const changes = [];
  const status = { textContent: '' };
  const win = { dispatchEvent: event => changes.push(event.detail) };
  const context = {
    window: win, URL, CustomEvent,
    document: { readyState: 'complete', getElementById: () => status, querySelectorAll: () => [] },
    localStorage: {
      getItem: () => JSON.stringify({ mode: 'light', cloak: 'google', panicKey: 'Escape' }),
      setItem: (key, value) => writes.push({ key, value })
    }
  };
  vm.runInNewContext(source.replace(/^export /gm, ''), context, { filename: 'privacy.js' });
  const privacy = win.MonkehPrivacy;
  assert.equal(privacy.get().mode, 'light');
  privacy.sync({ mode: 'dark', cloak: 'classroom' });
  assert.equal(privacy.get().cloak, 'classroom');
  assert.equal(privacy.get().panicKey, '');
  assert.equal(changes.length, 1);
  assert.deepEqual(writes, []);
  assert.match(status.textContent, /another tab/);
  privacy.update({ mode: 'light' });
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].value).cloak, 'classroom');
  privacy.sync(null);
  assert.equal(privacy.get().mode, defaults.mode);
  assert.equal(privacy.get().cloak, defaults.cloak);
  assert.equal(writes.length, 1);
});
