import test from 'node:test';
import assert from 'node:assert/strict';
import { makeParticles, mountParticles } from '../browser-tools/particles.js';

function emitter() {
  const handlers = new Map();
  return { addEventListener(name, fn) { handlers.set(name, fn); }, removeEventListener(name) { handlers.delete(name); }, fire(name) { handlers.get(name)?.(); } };
}

test('effects keep bounded populations on large and small screens', () => {
  for (const effect of ['snow', 'rain', 'bubbles']) {
    const normal = makeParticles(effect, 7680, 4320, 'normal');
    const low = makeParticles(effect, 7680, 4320, 'low');
    assert.equal(normal.length, 70); assert.equal(low.length, 32);
    assert.ok(normal.every(item => Number.isFinite(item.speed) && item.x >= 0 && item.x < 7680));
    assert.equal(makeParticles(effect, 320, 240, 'normal').length, 12);
  }
});

test('effects stop when hidden, during games, for reduced motion and after disposal', () => {
  const frames = new Map(); let frameId = 0; let active = false; let mutations;
  const settings = { particleEffect: 'snow', particleDensity: 'normal', mode: 'dark' };
  const reduced = { ...emitter(), matches: false };
  const context = { clearRect() {}, setTransform() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {} };
  const canvas = { setAttribute() {}, getContext: () => context, remove() { this.removed = true; } };
  const doc = { ...emitter(), hidden: false, querySelector: () => ({ prepend() {} }), createElement: () => canvas,
    getElementById: () => ({ classList: { contains: () => active } }) };
  const win = { ...emitter(), document: doc, MonkehPrivacy: { get: () => settings }, innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 3,
    matchMedia: () => reduced, setTimeout, clearTimeout,
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame(id) { frames.delete(id); },
    MutationObserver: class { constructor(fn) { mutations = fn; } observe() {} disconnect() {} }
  };
  const effects = mountParticles(win, doc);
  assert.equal(frames.size, 1); assert.equal(canvas.width, 2880);
  doc.hidden = true; doc.fire('visibilitychange'); assert.equal(frames.size, 0);
  doc.hidden = false; doc.fire('visibilitychange'); assert.equal(frames.size, 1);
  active = true; mutations(); assert.equal(frames.size, 0);
  active = false; mutations(); assert.equal(frames.size, 1);
  reduced.matches = true; reduced.fire('change'); assert.equal(frames.size, 0);
  reduced.matches = false; reduced.fire('change'); assert.equal(frames.size, 1);
  win.fire('pagehide'); assert.equal(frames.size, 0);
  win.fire('pageshow'); assert.equal(frames.size, 1);
  settings.particleEffect = 'none'; win.fire('monkeh:privacy'); assert.equal(frames.size, 0);
  settings.particleEffect = 'bubbles'; win.fire('monkeh:privacy'); assert.equal(frames.size, 1);
  effects.dispose(); assert.equal(frames.size, 0); assert.equal(canvas.removed, true);
  win.fire('monkeh:privacy'); assert.equal(frames.size, 0);
});
