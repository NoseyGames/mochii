import './privacy.js';

export function makeParticles(effect, width, height, density = 'normal', random = Math.random) {
  const count = Math.min(density === 'low' ? 32 : 70, Math.max(12, Math.round(width * height / (density === 'low' ? 34000 : 18000))));
  return Array.from({ length: count }, () => ({
    x: random() * width, y: random() * height, phase: random() * Math.PI * 2,
    radius: effect === 'bubbles' ? 5 + random() * 13 : 1 + random() * 2.5,
    speed: effect === 'rain' ? 180 + random() * 240 : 12 + random() * 28
  }));
}

export function mountParticles(win = window, doc = win.document) {
  const root = doc.querySelector('.app-viewport');
  if (!root || !win.MonkehPrivacy) return null;
  const canvas = doc.createElement('canvas');
  canvas.className = 'shell-particles';
  canvas.setAttribute('aria-hidden', 'true');
  root.prepend(canvas);
  const context = canvas.getContext('2d');
  if (!context) { canvas.remove(); return null; }
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
  const viewer = doc.getElementById('zone-viewer');
  let animation = null;
  let resizeTimer;
  let previous = 0;
  let particles = [];
  let width = 0;
  let height = 0;
  let effect = 'none';
  let color = '#c5d0da';
  let preferenceKey = '';
  let disposed = false;
  function blocked() { return disposed || effect === 'none' || doc.hidden || reduced.matches || viewer?.classList.contains('active'); }
  function stop() {
    if (animation !== null) win.cancelAnimationFrame(animation);
    animation = null;
    previous = 0;
    canvas.hidden = true;
    context.clearRect(0, 0, width, height);
  }
  function draw(now) {
    animation = null;
    if (blocked()) { stop(); return; }
    if (previous && now - previous < 32) { animation = win.requestAnimationFrame(draw); return; }
    const step = previous ? Math.min(.06, (now - previous) / 1000) : 0;
    previous = now;
    context.clearRect(0, 0, width, height);
    context.fillStyle = context.strokeStyle = color;
    context.lineWidth = effect === 'rain' ? 1 : 1.2;
    for (const particle of particles) {
      particle.y += particle.speed * step * (effect === 'bubbles' ? -1 : 1);
      if (particle.y > height + 25) particle.y = -25;
      if (particle.y < -25) particle.y = height + 25;
      const x = particle.x + Math.sin(now / 3500 + particle.phase) * (effect === 'rain' ? 0 : 12);
      context.globalAlpha = effect === 'bubbles' ? .22 : effect === 'rain' ? .3 : .55;
      context.beginPath();
      if (effect === 'rain') {
        context.moveTo(x, particle.y); context.lineTo(x - 3, particle.y + 14); context.stroke();
      } else {
        context.arc(x, particle.y, particle.radius, 0, Math.PI * 2);
        if (effect === 'bubbles') context.stroke(); else context.fill();
      }
    }
    animation = win.requestAnimationFrame(draw);
  }
  function apply() {
    stop();
    if (disposed) return;
    const settings = win.MonkehPrivacy.get();
    preferenceKey = [settings.particleEffect, settings.particleDensity, settings.mode].join('|');
    effect = ['snow', 'rain', 'bubbles'].includes(settings.particleEffect) ? settings.particleEffect : 'none';
    if (blocked()) return;
    width = Math.max(1, win.innerWidth);
    height = Math.max(1, win.innerHeight);
    const ratio = Math.min(win.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    color = settings.mode === 'light' ? '#536778' : '#d2e1ec';
    particles = makeParticles(effect, width, height, settings.particleDensity);
    canvas.hidden = false;
    animation = win.requestAnimationFrame(draw);
  }
  const observer = viewer ? new win.MutationObserver(apply) : null;
  observer?.observe(viewer, { attributes: true, attributeFilter: ['class'] });
  function resize() { win.clearTimeout(resizeTimer); resizeTimer = win.setTimeout(apply, 120); }
  function preferencesChanged() {
    const settings = win.MonkehPrivacy.get();
    if ([settings.particleEffect, settings.particleDensity, settings.mode].join('|') !== preferenceKey) apply();
  }
  function dispose() {
    disposed = true; stop(); win.clearTimeout(resizeTimer); observer?.disconnect();
    doc.removeEventListener('visibilitychange', apply); reduced.removeEventListener('change', apply);
    win.removeEventListener('monkeh:privacy', preferencesChanged); win.removeEventListener('resize', resize);
    win.removeEventListener('pagehide', hide); win.removeEventListener('pageshow', apply); canvas.remove();
  }
  function hide() { stop(); }
  doc.addEventListener('visibilitychange', apply);
  reduced.addEventListener('change', apply);
  win.addEventListener('monkeh:privacy', preferencesChanged);
  win.addEventListener('resize', resize);
  win.addEventListener('pagehide', hide);
  win.addEventListener('pageshow', apply);
  apply();
  return { apply, dispose };
}

if (typeof window !== 'undefined') mountParticles(window);
