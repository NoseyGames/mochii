const profiles = Object.freeze({
  windows2000: 'https://copy.sh/v86/?profile=windows2000',
  windows98: 'https://copy.sh/v86/?profile=windows98',
});

export function desktopProfileUrl(profile) {
  if (!Object.hasOwn(profiles, profile)) throw new Error('Unknown desktop profile.');
  return profiles[profile];
}

export function validateDesktopGateway(value) {
  if (!value || typeof value !== 'object' || typeof value.url !== 'string' || value.url.length > 2048 || /[\u0000-\u0020\u007f]/.test(value.url)) return null;
  try {
    const url = new URL(value.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search) return null;
    const label = typeof value.label === 'string' ? value.label.trim().slice(0, 80) : 'Your Windows desktop';
    if (!label || /[\u0000-\u001f\u007f]/.test(label)) return null;
    return { url: url.href, label };
  } catch { return null; }
}

export function openDesktopInMonkeh(url, context = window) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Desktop addresses must use HTTPS without embedded login details.');
  try {
    const host = context.parent;
    if (host === context || host.location.origin !== context.location.origin || typeof host.handleHeroSearch !== 'function') return false;
    host.handleHeroSearch(target.href);
    return true;
  } catch { return false; }
}

export function mountDesktopLauncher(doc = document, context = window) {
  const status = doc.getElementById('launch-status');
  const help = doc.getElementById('standalone-help');
  const buttons = ['launch-windows2000', 'launch-windows98', 'launch-gateway'].map(id => doc.getElementById(id));
  let launching = false;
  let disposed = false;
  const controller = new AbortController();
  const timer = context.setTimeout(() => controller.abort(), 5000);

  function launch(url) {
    if (launching || disposed) return;
    launching = true;
    buttons.forEach(button => { button.disabled = true; });
    status.textContent = 'Opening the desktop through Monkeh…';
    help.hidden = true;
    if (!openDesktopInMonkeh(url, context)) {
      status.textContent = 'The proxy launcher is available inside Monkeh.';
      help.hidden = false;
      launching = false;
      buttons.forEach(button => { button.disabled = false; });
    }
  }
  doc.getElementById('launch-windows2000').addEventListener('click', () => launch(desktopProfileUrl('windows2000')));
  doc.getElementById('launch-windows98').addEventListener('click', () => launch(desktopProfileUrl('windows98')));

  // Gateway discovery never blocks the account-free emulators, and never opens
  // a third-party page until the user clicks a launch button.
  const ready = context.fetch('/api/config', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal }).then(async response => {
    if (!response.ok) return;
    const config = await response.json();
    if (disposed) return;
    const gateway = validateDesktopGateway(config?.windowsVm);
    if (!gateway) return;
    doc.getElementById('gateway-title').textContent = gateway.label;
    doc.getElementById('launch-gateway').addEventListener('click', () => launch(gateway.url));
    doc.getElementById('gateway-card').hidden = false;
  }).catch(() => {}).finally(() => context.clearTimeout(timer));

  function dispose() { disposed = true; controller.abort(); context.clearTimeout(timer); }
  context.addEventListener('pagehide', dispose, { once: true });
  return { ready, dispose };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') mountDesktopLauncher();
