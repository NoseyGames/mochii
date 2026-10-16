import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransportLock } from '../browser-tools/transport-lock.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('a queued transport lock deadline aborts without executing the mutation', async () => {
  let ran = false;
  let cancelled = false;
  const lock = createTransportLock({ acquireTimeout: 5, navigator: { locks: { request: (name, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason); }, { once: true });
  }) } } });
  await assert.rejects(lock.run(() => { ran = true; }), /Reload this page/);
  await tick();
  assert.equal(cancelled, true); assert.equal(ran, false);
  assert.deepEqual(lock.snapshot(), { pending: false, uncertain: false });
});

test('an executing transport timeout retains the lock and rejects further work immediately', async () => {
  let finish; let released = 0; let mutations = 0;
  const lock = createTransportLock({ executionTimeout: 5, navigator: { locks: { request: async (name, options, action) => {
    try { return await action(); } finally { released++; }
  } } } });
  const activation = lock.run(() => { mutations++; return new Promise(resolve => { finish = resolve; }); });
  await assert.rejects(activation, error => error.code === 'PROXY_TRANSPORT_UNCERTAIN' && /Reload this page/.test(error.message));
  assert.equal(released, 0); assert.deepEqual(lock.snapshot(), { pending: true, uncertain: true });
  await assert.rejects(lock.run(() => { mutations++; }), error => error.code === 'PROXY_TRANSPORT_UNCERTAIN');
  assert.throws(lock.assertAvailable, /switching servers cannot repair/);
  assert.equal(mutations, 1); assert.equal(released, 0);
  finish(); await tick();
  assert.equal(released, 1); assert.deepEqual(lock.snapshot(), { pending: false, uncertain: false });
  await lock.run(() => { mutations++; }); assert.equal(mutations, 2);
});

test('late transport rejection is handled and only unlocks after the actual work settles', async () => {
  let fail; let released = 0;
  const lock = createTransportLock({ executionTimeout: 5, navigator: { locks: { request: async (name, options, action) => {
    try { return await action(); } finally { released++; }
  } } } });
  await assert.rejects(lock.run(() => new Promise((resolve, reject) => { fail = reject; })), /Reload this page/);
  assert.equal(released, 0);
  fail(new Error('Late worker rejection')); await tick();
  assert.equal(released, 1); assert.equal(lock.snapshot().pending, false);
  await assert.doesNotReject(lock.run(async () => {}));
});

test('without Web Locks, an uncertain activation still cannot race a second mutation', async () => {
  let finish; let calls = 0;
  const lock = createTransportLock({ navigator: {}, executionTimeout: 5 });
  const first = lock.run(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  assert.equal(lock.run(() => { calls++; }), first);
  await assert.rejects(first, /Reload this page/);
  await assert.rejects(lock.run(() => { calls++; }), /Reload this page/);
  assert.equal(calls, 1);
  finish(); await tick();
});
