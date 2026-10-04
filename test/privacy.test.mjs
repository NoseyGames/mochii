import test from 'node:test';
import assert from 'node:assert/strict';
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
