const KEY = 'monkeh.privacy.v1';
export const defaults = Object.freeze({
  httpsOnly: true, allowPopups: false, allowDownloads: true,
  clearConsoleOnClose: true, showCovers: true, aiEnabled: true,
  searchEngine: 'duckduckgo'
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
  window.MonkehPrivacy = Object.freeze({
    get: () => ({ ...settings }),
    sandbox: proxied => frameSandbox(settings, proxied),
    search: query => searchEngines[settings.searchEngine] + encodeURIComponent(query)
  });
  function bind() {
    const status = document.getElementById('privacy-status');
    for (const input of document.querySelectorAll('[data-privacy]')) {
      const key = input.dataset.privacy;
      if (!Object.hasOwn(defaults, key)) continue;
      if (input.type === 'checkbox') input.checked = settings[key];
      else input.value = settings[key];
      input.addEventListener('change', () => {
        settings = normalizePrivacy({ ...settings, [key]: input.type === 'checkbox' ? input.checked : input.value });
        try {
          localStorage.setItem(KEY, JSON.stringify(settings));
          status.textContent = 'Saved. Popup and download changes apply when you next open or reload a page.';
        } catch { status.textContent = 'Applied for this visit. Your browser blocked saving preferences.'; }
        window.dispatchEvent(new CustomEvent('monkeh:privacy', { detail: { ...settings } }));
        window.renderGames?.();
        window.renderApps?.();
      });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
}
