import './privacy.js';
import './devtools-guard.js';

export const cloakPresets = Object.freeze({ monkeh: ['mochii', 'm', '#444444'], google: ['Google', 'G', '#4285f4'], classroom: ['Google Classroom', 'C', '#137333'], clever: ['Clever', 'C', '#1565c0'], desmos: ['Desmos', 'D', '#248b48'], wikipedia: ['Wikipedia', 'W', '#777777'], gmail: ['Gmail', 'M', '#c5221f'], drive: ['Google Drive', 'D', '#188038'], newtab: ['New Tab', '+', '#777777'], bing: ['Bing', 'b', '#008373'] });
export const fonts = Object.freeze({ default: ['Default', 'Inter, system-ui, sans-serif'], outfit: ['Outfit', 'Outfit, system-ui, sans-serif'], 'space-mono': ['Space Mono', '"Space Mono", monospace'], obscured: ['Obscured', '"Libre Barcode 128 Text", monospace'], codystar: ['Codystar', 'Codystar, sans-serif'], silkscreen: ['Silkscreen', 'Silkscreen, monospace'] });

export function hotkeyFor(event) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return '';
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (!/^(?:[a-z0-9]|Escape|F[1-9]|F1[0-2])$/.test(key)) return '';
  return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', key].filter(Boolean).join('+');
}

export function mountPreferences(win = window) {
  const doc = win.document;
  const privacy = win.MonkehPrivacy;
  if (!privacy) return;
  let capturing = false;
  let leaving = false;
  const baseTitle = doc.title;
  let favicon = doc.querySelector('link[rel~="icon"]');
  const oldIcon = favicon?.href || '';
  if (!favicon) { favicon = doc.createElement('link'); favicon.rel = 'icon'; doc.head.append(favicon); }
  let fontLink;
  let currentFont = '';
  const settingsRoot = doc.getElementById('general-preferences');
  function option(value, label) { const el = doc.createElement('option'); el.value = value; el.textContent = label; return el; }
  function field(parent, title, key, choices, description = '') {
    const row = doc.createElement('label'); row.className = 'setting-item';
    const info = doc.createElement('span'); info.className = 'setting-info';
    const text = doc.createElement('span'); text.className = 'setting-title'; text.textContent = title; info.append(text);
    if (description) { const desc = doc.createElement('span'); desc.className = 'setting-desc'; desc.textContent = description; info.append(desc); }
    const input = doc.createElement(Array.isArray(choices) ? 'select' : 'input');
    if (Array.isArray(choices)) choices.forEach(([value, name]) => input.append(option(value, name)));
    else input.type = choices;
    input.dataset.preference = key; input.setAttribute('aria-label', title);
    input.addEventListener('change', () => {
      if (input.type === 'url' && input.value && (!input.validity.valid || !input.value.startsWith('https://'))) { input.setCustomValidity('Enter a complete HTTPS URL.'); input.reportValidity(); return; }
      input.setCustomValidity('');
      privacy.update({ [key]: input.type === 'checkbox' ? input.checked : input.value });
    });
    input.addEventListener('input', () => input.setCustomValidity(''));
    row.append(info, input); parent.append(row); return input;
  }
  function section(name, open = false) {
    const group = doc.createElement('details'); group.className = 'preferences-section'; group.open = open;
    const summary = doc.createElement('summary'); summary.textContent = name; group.append(summary);
    const body = doc.createElement('div'); body.className = 'preferences-fields'; group.append(body); settingsRoot.append(group); return body;
  }
  function button(parent, title, callback) { const el = doc.createElement('button'); el.type = 'button'; el.className = 'preference-button'; el.textContent = title; el.addEventListener('click', callback); parent.append(el); return el; }
  function notice(message) { const status = doc.getElementById('privacy-status'); if (status) status.textContent = message; }
  function panic() {
    leaving = true;
    let destination = win;
    try { if (win.top?.document) destination = win.top; } catch {}
    destination.dispatchEvent(new win.CustomEvent('monkeh:leaving'));
    destination.location.replace(privacy.get().panicUrl);
  }
  function openCloaked() {
    const popup = win.open('about:blank', '_blank');
    if (!popup) { notice('Allow this window to open, then try again.'); return; }
    popup.opener = null;
    const frame = popup.document.createElement('iframe');
    frame.src = new URL('/math.html', win.location.origin).href;
    frame.title = 'Monkeh'; frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0';
    frame.allow = 'autoplay; fullscreen; gamepad'; frame.allowFullscreen = true;
    popup.document.body.append(frame);
    popup.document.title = cloakPresets[privacy.get().cloak][0];
    if (privacy.get().blobCloak) {
      const markup = '<!doctype html><meta charset="utf-8"><title>' + popup.document.title + '</title>' + frame.outerHTML;
      const url = win.URL.createObjectURL(new Blob([markup], { type: 'text/html' }));
      popup.location.replace(url);
      win.setTimeout(() => win.URL.revokeObjectURL(url), 60000);
    }
    notice('Opened a cloaked window. This changes its address bar, not network visibility.');
  }
  if (settingsRoot) {
    const appearance = section('Appearance', true);
    field(appearance, 'Mode', 'mode', [['dark', 'Dark'], ['light', 'Light']]);
    const fontSelect = field(appearance, 'Font', 'font', Object.entries(fonts).map(([key, [name]]) => [key, name]));
    const search = doc.createElement('input'); search.type = 'search'; search.placeholder = 'Find a font'; search.setAttribute('aria-label', 'Find a font'); search.className = 'preference-search';
    search.addEventListener('input', () => { for (const item of fontSelect.options) item.hidden = !item.textContent.toLowerCase().includes(search.value.trim().toLowerCase()); }); appearance.append(search);
    const themes = doc.createElement('div'); themes.className = 'preference-actions'; themes.setAttribute('aria-label', 'Color themes');
    for (const [name, color] of [['Amber', '#d99b28'], ['Cyan', '#269db5'], ['Emerald', '#36a079'], ['Rose', '#d66a82'], ['Slate', '#a6abb1']]) button(themes, name, () => privacy.update({ accent: color }));
    appearance.append(themes);
    field(appearance, 'Custom accent color', 'accent', 'color');
    field(appearance, 'Background', 'background', [['none', 'None'], ['hive', 'Hive'], ['grid', 'Grid'], ['synthwave', 'Synthwave'], ['cat', 'Cat'], ['doubleu', 'Doubleu'], ['custom', 'Custom image']]);
    field(appearance, 'Custom background URL', 'backgroundUrl', 'url', 'An HTTPS image URL. The image host receives a request when this background is selected.');
    const cloaking = section('Tab and window');
    field(cloaking, 'Tab cloak', 'cloak', Object.entries(cloakPresets).map(([key, [name]]) => [key, key === 'monkeh' ? 'Monkeh' : name]));
    field(cloaking, 'Auto cloak', 'autoCloak', 'checkbox', 'Use the chosen tab name and icon only when you switch away.');
    field(cloaking, 'Use a blob window', 'blobCloak', 'checkbox', 'Use a blob address instead of about:blank for the cloaked window.');
    button(cloaking, 'Open cloaked window', openCloaked);
    const safety = section('Panic shortcut and behavior');
    const hotkey = doc.createElement('p'); hotkey.id = 'panic-key-label'; hotkey.className = 'setting-desc'; safety.append(hotkey);
    const capture = button(safety, 'Capture shortcut', () => { capturing = true; win.MonkehDevtoolsGuard?.setEnabled(false); capture.textContent = 'Press a key combination…'; });
    button(safety, 'Clear shortcut', () => { capturing = false; capture.textContent = 'Capture shortcut'; privacy.update({ panicKey: '' }); });
    field(safety, 'Panic URL', 'panicUrl', 'url', 'The shortcut immediately leaves Monkeh for this HTTPS address.');
    const presets = doc.createElement('div'); presets.className = 'preference-actions';
    for (const [name, url] of [['Classroom', 'https://classroom.google.com/'], ['Docs', 'https://docs.google.com/'], ['Google', 'https://www.google.com/'], ['Wikipedia', 'https://www.wikipedia.org/'], ['Gmail', 'https://mail.google.com/']]) button(presets, name, () => privacy.update({ panicUrl: url }));
    safety.append(presets); button(safety, 'Test panic shortcut', panic);
    field(safety, 'Close protection', 'closeProtection', 'checkbox', 'Ask the browser to warn before you leave. Browsers may suppress this prompt.');
    field(safety, 'Skip loading animations', 'skipLoading', 'checkbox', 'Show content immediately and remove interface transitions.');
    field(safety, 'Redirect native DevTools shortcuts', 'nativeDevtoolsGuard', 'checkbox', 'Show the error page for native DevTools shortcuts. Monkeh’s own browser tools stay available.');
    field(safety, 'Detect docked DevTools', 'detectDocked', 'checkbox', 'Experimental: browser side panels can look the same. Undocked DevTools cannot reliably be detected.');
    const info = section('Information'); const p = doc.createElement('p'); p.className = 'setting-desc'; p.textContent = 'Game catalogs: GN-Math, Seraph, Hydra, 3kh0, Truffled and TGLSC. Games run from their source hosts through Monkeh. Favorites, recent games and settings stay in this browser; there is no account sync.'; info.append(p);
  }
  function cloak() {
    const settings = privacy.get();
    const choice = settings.autoCloak && !doc.hidden ? 'monkeh' : settings.cloak;
    if (choice === 'monkeh') { doc.title = baseTitle; if (oldIcon) favicon.href = oldIcon; else favicon.removeAttribute('href'); return; }
    const [title, symbol, color] = cloakPresets[choice]; doc.title = title;
    favicon.href = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="6" fill="${color}"/><text x="16" y="23" text-anchor="middle" font-family="sans-serif" font-size="23" fill="white">${symbol}</text></svg>`);
  }
  function apply() {
    const settings = privacy.get(); const root = doc.documentElement;
    root.dataset.mode = settings.mode; root.dataset.background = settings.background; root.dataset.skipLoading = String(settings.skipLoading);
    root.style.setProperty('--user-accent', settings.accent); root.style.setProperty('--user-font', fonts[settings.font][1]);
    root.style.setProperty('--user-background', settings.background === 'custom' && settings.backgroundUrl ? `url(${JSON.stringify(settings.backgroundUrl)})` : 'none');
    if (currentFont !== settings.font) {
      currentFont = settings.font; fontLink?.remove(); fontLink = null;
      if (settings.font !== 'default') { fontLink = doc.createElement('link'); fontLink.rel = 'stylesheet'; const family = settings.font === 'obscured' ? 'Libre Barcode 128 Text' : fonts[settings.font][0]; fontLink.href = 'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(family).replace(/%20/g, '+') + '&display=swap'; doc.head.append(fontLink); }
    }
    for (const input of doc.querySelectorAll('[data-preference]')) { const value = settings[input.dataset.preference]; if (input.type === 'checkbox') input.checked = value; else input.value = value; }
    const label = doc.getElementById('panic-key-label'); if (label) label.textContent = 'Current shortcut: ' + (settings.panicKey || 'Not set');
    cloak();
  }
  doc.addEventListener('visibilitychange', cloak);
  win.addEventListener('monkeh:privacy', apply);
  win.addEventListener('monkeh:leaving', () => { leaving = true; });
  win.addEventListener('blur', () => { if (capturing) { capturing = false; win.MonkehDevtoolsGuard?.setEnabled(privacy.get().nativeDevtoolsGuard); const button = [...(settingsRoot?.querySelectorAll('button') || [])].find(el => el.textContent === 'Press a key combination…'); if (button) button.textContent = 'Capture shortcut'; } });
  win.addEventListener('storage', event => { if (event.key === 'monkeh.privacy.v1' || event.key === null) { try { privacy.sync(JSON.parse(event.newValue)); } catch {} } });
  win.addEventListener('pageshow', () => { leaving = false; });
  win.addEventListener('beforeunload', event => { if (!leaving && privacy.get().closeProtection) { event.preventDefault(); event.returnValue = ''; } });
  win.addEventListener('keydown', event => {
    const key = hotkeyFor(event);
    if (capturing) { event.preventDefault(); event.stopImmediatePropagation(); if (!key) return; capturing = false; privacy.update({ panicKey: key }); const capture = [...(settingsRoot?.querySelectorAll('button') || [])].find(el => el.textContent === 'Press a key combination…'); if (capture) capture.textContent = 'Capture shortcut'; return; }
    if (key && key === privacy.get().panicKey && !event.repeat && !event.isComposing && !event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) { event.preventDefault(); panic(); }
  }, true);
  apply();
  return { apply, openCloaked };
}

if (typeof window !== 'undefined') mountPreferences(window);
