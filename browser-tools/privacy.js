const KEY = 'monkeh.privacy.v1';
export const defaults = Object.freeze({
  httpsOnly: true, allowPopups: false, allowDownloads: true,
  clearConsoleOnClose: true, showCovers: true, aiEnabled: true,
  searchEngine: 'duckduckgo', mode: 'dark', font: 'default', accent: '#a6abb1',
  background: 'none', backgroundUrl: '', cloak: 'monkeh', autoCloak: false,
  blobCloak: false, panicKey: '', panicUrl: 'https://www.google.com/',
  closeProtection: false, skipLoading: true, nativeDevtoolsGuard: true, detectDocked: false,
  characterMasking: false, userAgent: '', particleEffect: 'none', particleDensity: 'normal',
  backgroundOpacity: 40, backgroundBlur: 0, glassMode: false, glassOpacity: 88, glassBlur: 16
});
export const searchEngines = Object.freeze({
  duckduckgo: 'https://duckduckgo.com/?q=',
  brave: 'https://search.brave.com/search?q=',
  google: 'https://www.google.com/search?q='
});
export function normalizePrivacy(value) {
  const result = { ...defaults };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const key of Object.keys(defaults)) {
    if (typeof defaults[key] === 'boolean' && typeof value[key] === 'boolean') result[key] = value[key];
  }
  if (Object.hasOwn(searchEngines, value.searchEngine)) result.searchEngine = value.searchEngine;
  for (const [key, allowed] of Object.entries({ mode: ['dark', 'light'], font: ['default', 'outfit', 'space-mono', 'obscured', 'codystar', 'silkscreen'], background: ['none', 'hive', 'grid', 'synthwave', 'cat', 'doubleu', 'custom'], cloak: ['monkeh', 'google', 'classroom', 'clever', 'desmos', 'wikipedia', 'gmail', 'drive', 'newtab', 'bing'], particleEffect: ['none', 'snow', 'rain', 'bubbles'], particleDensity: ['low', 'normal'] })) {
    if (allowed.includes(value[key])) result[key] = value[key];
  }
  if (typeof value.userAgent === 'string' && value.userAgent.length <= 512 && /^[\x20-\x7e]*$/.test(value.userAgent)) result.userAgent = value.userAgent.trim();
  for (const [key, min, max] of [['backgroundOpacity', 0, 100], ['backgroundBlur', 0, 24], ['glassOpacity', 40, 100], ['glassBlur', 0, 32]]) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) result[key] = Math.max(min, Math.min(max, Math.round(value[key])));
  }
  if (/^#[0-9a-f]{6}$/i.test(value.accent)) result.accent = value.accent.toLowerCase();
  for (const key of ['backgroundUrl', 'panicUrl']) {
    try {
      const url = new URL(value[key]);
      if (url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 2048) result[key] = url.href;
    } catch {}
  }
  if (typeof value.panicKey === 'string' && /^(?:(?:Ctrl|Alt|Shift|Meta)\+)*(?:[a-z0-9]|Escape|F[1-9]|F1[0-2])$/.test(value.panicKey)) {
    const parts = value.panicKey.split('+'); const key = parts.pop();
    result.panicKey = [...['Ctrl', 'Alt', 'Shift', 'Meta'].filter(modifier => parts.includes(modifier)), key].join('+');
  }
  return result;
}
export function frameSandbox(settings, proxied) {
  const flags = ['allow-scripts', 'allow-forms', 'allow-pointer-lock'];
  if (proxied) flags.push('allow-same-origin');
  if (settings.allowDownloads) flags.push('allow-downloads');
  if (settings.allowPopups) flags.push('allow-popups');
  return flags.join(' ');
}

if (typeof window !== 'undefined') {
  let settings;
  try { settings = normalizePrivacy(JSON.parse(localStorage.getItem(KEY))); }
  catch { settings = { ...defaults }; }
  function update(patch, { persist = true, replace = false } = {}) {
    settings = normalizePrivacy(replace ? patch : { ...settings, ...patch });
    let saved = true;
    if (persist) { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { saved = false; } }
    const status = document.getElementById('privacy-status');
    if (status) status.textContent = !persist ? 'Preferences updated from another tab.' : saved ? 'Saved in this browser.' : 'Applied for this visit. Your browser blocked saving preferences.';
    window.dispatchEvent(new CustomEvent('monkeh:privacy', { detail: { ...settings } }));
    return { ...settings };
  }
  window.MonkehPrivacy = Object.freeze({
    get: () => ({ ...settings }),
    update,
    sync: value => update(value, { persist: false, replace: true }),
    sandbox: proxied => frameSandbox(settings, proxied),
    search: query => searchEngines[settings.searchEngine] + encodeURIComponent(query)
  });
  function bind() {
    for (const input of document.querySelectorAll('[data-privacy]')) {
      const key = input.dataset.privacy;
      if (!Object.hasOwn(defaults, key)) continue;
      if (input.type === 'checkbox') input.checked = settings[key];
      else input.value = settings[key];
      input.addEventListener('change', () => {
        update({ [key]: input.type === 'checkbox' ? input.checked : input.value });
        window.renderGames?.();
        window.renderApps?.();
      });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
}
