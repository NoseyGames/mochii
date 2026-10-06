import { defaults, normalizePrivacy } from './privacy.js';
import './devtools-guard.js';
import { createDisplayMasker, maskCharacters } from './display-text.js';
export { maskCharacters } from './display-text.js';

export const cloakPresets = Object.freeze({ monkeh: ['mochii', 'm', '#444444'], google: ['Google', 'G', '#4285f4'], classroom: ['Google Classroom', 'C', '#137333'], clever: ['Clever', 'C', '#1565c0'], desmos: ['Desmos', 'D', '#248b48'], wikipedia: ['Wikipedia', 'W', '#777777'], gmail: ['Gmail', 'M', '#c5221f'], drive: ['Google Drive', 'D', '#188038'], newtab: ['New Tab', '+', '#777777'], bing: ['Bing', 'b', '#008373'] });
export const fonts = Object.freeze({ default: ['Default', 'Inter, system-ui, sans-serif'], outfit: ['Outfit', 'Outfit, system-ui, sans-serif'], 'space-mono': ['Space Mono', '"Space Mono", monospace'], obscured: ['Obscured', '"Libre Barcode 128 Text", monospace'], codystar: ['Codystar', 'Codystar, sans-serif'], silkscreen: ['Silkscreen', 'Silkscreen, monospace'] });
export const userAgentPresets = Object.freeze([
  ['default', 'Browser default', ''],
  ['chrome-windows', 'Chrome · Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'],
  ['chrome-mac', 'Chrome · macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'],
  ['safari-mac', 'Safari · macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15'],
  ['firefox', 'Firefox · Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0'],
  ['iphone', 'Safari · iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1'],
  ['ipad', 'Safari · iPad', 'Mozilla/5.0 (iPad; CPU OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1'],
  ['android', 'Chrome · Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'],
  ['webos', 'LG TV · webOS', 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.31 Safari/537.36 WebAppManager'],
  ['fire-tv', 'Amazon Fire TV', 'Mozilla/5.0 (Linux; Android 9; AFTKA Build/PS7233) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.91 Safari/537.36'],
  ['playstation', 'PlayStation 5', 'Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0 Safari/605.1.15'],
  ['xbox', 'Xbox Series X', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox Series X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0']
].map(preset => Object.freeze(preset)));

export function createCharacterMasker(doc, elements) {
  if (elements === undefined && doc.createTextNode) {
    const controller = createDisplayMasker(doc);
    return enabled => controller.setEnabled(enabled);
  }
  elements ||= doc.querySelectorAll('.hero-content > .title, #settings-modal .modal-title, #settings-modal .setting-title, #general-preferences .preferences-section > summary, #games-popover .modal-title, #apps-popover .modal-title');
  const labels = [...elements].filter(element => !element.children.length && !element.closest?.('input, textarea, select, [contenteditable], #browser-tools, #zone-viewer, .game-item, .music-item'))
    .map(element => ({ element, original: element.textContent }));
  let active = false;
  return enabled => {
    if (Boolean(enabled) === active) return;
    active = Boolean(enabled);
    for (const { element, original } of labels) {
      element.textContent = '';
      if (active) {
        const visual = doc.createElement('span'); visual.setAttribute('aria-hidden', 'true'); visual.textContent = maskCharacters(original);
        const accessible = doc.createElement('span'); accessible.className = 'preference-sr-only'; accessible.textContent = original;
        element.append(visual, accessible);
      } else element.textContent = original;
    }
  };
}

export function serializePreferences(value) {
  return JSON.stringify({ app: 'mochii', version: 1, preferences: normalizePrivacy(value) }, null, 2);
}

export function parsePreferences(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > 65536) throw new Error('Choose a settings JSON file smaller than 64 KB.');
  const parsed = JSON.parse(text);
  if (!parsed || parsed.app !== 'mochii' || parsed.version !== 1 || !parsed.preferences || typeof parsed.preferences !== 'object' || Array.isArray(parsed.preferences)) throw new Error('This is not a supported Mochii settings file.');
  return normalizePrivacy(parsed.preferences);
}

export function hotkeyFor(event) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return '';
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (!/^(?:[a-z0-9]|Escape|F[1-9]|F1[0-2])$/.test(key)) return '';
  return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', key].filter(Boolean).join('+');
}

export function bindSettingsDialog(win, { onClose = () => {}, isCapturing = () => false } = {}) {
  const doc = win.document;
  const modal = doc.getElementById('settings-modal');
  if (!modal || typeof win.openSettingsModal !== 'function' || typeof win.closeSettingsModal !== 'function') return null;
  const open = win.openSettingsModal;
  const close = win.closeSettingsModal;
  let opener;
  const isOpen = () => modal.classList.contains('active');
  function sync() { const active = isOpen(); modal.inert = !active; modal.setAttribute('aria-hidden', String(!active)); }
  win.openSettingsModal = (...args) => {
    if (!isOpen()) opener = doc.activeElement;
    const result = open(...args); sync();
    doc.getElementById('settings-search')?.focus({ preventScroll: true });
    return result;
  };
  win.closeSettingsModal = (...args) => {
    const active = isOpen();
    const result = close(...args); sync(); onClose();
    if (active && opener?.isConnected !== false) opener?.focus?.({ preventScroll: true });
    return result;
  };
  modal.addEventListener('click', event => { if (event.target === modal) win.closeSettingsModal(); });
  win.addEventListener('keydown', event => {
    if (!isOpen() || isCapturing()) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); win.closeSettingsModal(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...modal.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]')].filter(input => !input.disabled && input.tabIndex >= 0 && input.getClientRects().length > 0);
    const first = controls[0]; const last = controls.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (doc.activeElement === first || !modal.contains(doc.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (doc.activeElement === last || !modal.contains(doc.activeElement))) { event.preventDefault(); first.focus(); }
  }, true);
  sync();
  return { isOpen };
}

export function mountPreferences(win = window) {
  const doc = win.document;
  const privacy = win.MonkehPrivacy;
  if (!privacy) return;
  let capturing = false;
  let captureButton;
  let leaving = false;
  const baseTitle = doc.title;
  let favicon = doc.querySelector('link[rel~="icon"]');
  const oldIcon = favicon?.href || '';
  if (!favicon) { favicon = doc.createElement('link'); favicon.rel = 'icon'; doc.head.append(favicon); }
  let fontLink;
  let currentFont = '';
  let uaPresetSelect;
  let uaCustom;
  const settingsRoot = doc.getElementById('general-preferences');
  const groups = [];
  const searchMetadata = new WeakMap();
  const dirtyInputs = new WeakSet();
  let controls = [];
  let applied;
  function setPreferences(patch) {
    for (const input of controls) if (Object.hasOwn(patch, input.dataset.preference || input.dataset.privacy)) { dirtyInputs.delete(input); input.setCustomValidity?.(''); input.removeAttribute('aria-invalid'); }
    privacy.update(patch);
    syncControls(privacy.get(), new Set(Object.keys(patch)));
  }
  const relatedFields = { font: 'font', accent: 'accent', background: 'background', backgroundUrl: 'background', backgroundOpacity: 'background', backgroundBlur: 'background', glassMode: 'glass', glassOpacity: 'glass', glassBlur: 'glass', userAgent: 'identity', particleEffect: 'particles', particleDensity: 'particles', panicUrl: 'panic' };
  function option(value, label) { const el = doc.createElement('option'); el.value = value; el.textContent = label; return el; }
  function field(parent, title, key, choices, description = '') {
    const row = doc.createElement('label'); row.className = 'setting-item';
    row.dataset.preferenceGroup = relatedFields[key] || key;
    const info = doc.createElement('span'); info.className = 'setting-info';
    const text = doc.createElement('span'); text.className = 'setting-title'; text.textContent = title; info.append(text);
    if (description) { const desc = doc.createElement('span'); desc.className = 'setting-desc'; desc.textContent = description; info.append(desc); }
    const input = doc.createElement(Array.isArray(choices) ? 'select' : 'input');
    if (Array.isArray(choices)) choices.forEach(([value, name]) => input.append(option(value, name)));
    else input.type = choices;
    input.dataset.preference = key; input.setAttribute('aria-label', title);
    function valid(report) {
      input.setCustomValidity('');
      let error = '';
      if (input.type === 'url' && input.value) {
        try { const url = new URL(input.value); if (url.protocol !== 'https:' || url.username || url.password || input.value.length > 2048) error = 'Enter a complete HTTPS URL without login details.'; }
        catch { error = 'Enter a complete HTTPS URL.'; }
      }
      if (input.type === 'number' && (input.value === '' || !Number.isInteger(Number(input.value)) || Number(input.value) < Number(input.min) || Number(input.value) > Number(input.max))) error = 'Enter a whole number from ' + input.min + ' to ' + input.max + '.';
      if (key === 'userAgent' && (input.value.length > 512 || !/^[\x20-\x7e]*$/.test(input.value))) error = 'Use up to 512 printable ASCII characters, without line breaks.';
      if (error) { if (report) { input.setCustomValidity(error); input.setAttribute('aria-invalid', 'true'); input.reportValidity(); } return false; }
      input.removeAttribute('aria-invalid');
      return true;
    }
    const inputValue = () => input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
    input.addEventListener('change', () => {
      if (!valid(true)) { dirtyInputs.add(input); return; }
      dirtyInputs.delete(input);
      const settings = privacy.update({ [key]: inputValue() });
      if (input.type !== 'checkbox' && String(input.value) !== String(settings[key])) input.value = settings[key];
    });
    input.addEventListener('input', () => {
      dirtyInputs.add(input); input.setCustomValidity(''); input.removeAttribute('aria-invalid');
      if (['color', 'number'].includes(input.type) && valid(false)) privacy.update({ [key]: inputValue() }, { deferSave: true });
    });
    input.addEventListener('blur', () => privacy.flush?.());
    row.append(info, input); parent.append(row); return input;
  }
  function section(name, open = false) {
    const group = doc.createElement('details'); group.className = 'preferences-section'; group.open = open;
    const summary = doc.createElement('summary'); summary.textContent = name; group.append(summary);
    const body = doc.createElement('div'); body.className = 'preferences-fields'; group.append(body); settingsRoot.append(group); groups.push({ group, summary, body, name, open }); return body;
  }
  function moveLegacy(parent, key) {
    const input = doc.querySelector('[data-privacy="' + key + '"]');
    const row = input?.closest?.('.setting-item');
    if (row) parent.append(row);
  }
  function numberField(parent, title, key, min, max, description = '') {
    const input = field(parent, title, key, 'number', description); input.min = String(min); input.max = String(max); input.step = '1'; return input;
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
    const settingsSearch = doc.createElement('input'); settingsSearch.type = 'search'; settingsSearch.id = 'settings-search'; settingsSearch.className = 'preference-search settings-search'; settingsSearch.placeholder = 'Find a setting'; settingsSearch.setAttribute('aria-label', 'Search settings'); settingsSearch.setAttribute('aria-controls', 'general-preferences'); settingsRoot.append(settingsSearch);
    const appearance = section('Appearance', true);
    field(appearance, 'Mode', 'mode', [['dark', 'Dark'], ['light', 'Light']]);
    const fontSelect = field(appearance, 'Font', 'font', Object.entries(fonts).map(([key, [name]]) => [key, name]));
    const search = doc.createElement('input'); search.type = 'search'; search.placeholder = 'Find a font'; search.setAttribute('aria-label', 'Find a font'); search.className = 'preference-search'; search.dataset.preferenceGroup = 'font';
    search.addEventListener('input', () => { for (const item of fontSelect.options) item.hidden = !item.textContent.toLowerCase().includes(search.value.trim().toLowerCase()); }); appearance.append(search);
    const themes = doc.createElement('div'); themes.className = 'preference-actions'; themes.setAttribute('aria-label', 'Color themes'); themes.dataset.preferenceGroup = 'accent';
    for (const [name, color] of [['Amber', '#d99b28'], ['Cyan', '#269db5'], ['Emerald', '#36a079'], ['Rose', '#d66a82'], ['Slate', '#a6abb1']]) button(themes, name, () => setPreferences({ accent: color }));
    appearance.append(themes);
    field(appearance, 'Custom accent color', 'accent', 'color');
    field(appearance, 'Background', 'background', [['none', 'None'], ['hive', 'Hive'], ['grid', 'Grid'], ['synthwave', 'Synthwave'], ['cat', 'Cat'], ['doubleu', 'Doubleu'], ['custom', 'Custom image']]);
    field(appearance, 'Custom background URL', 'backgroundUrl', 'url', 'An HTTPS image URL. The image host receives a request when this background is selected.');
    numberField(appearance, 'Background opacity', 'backgroundOpacity', 0, 100, 'Image visibility, from 0 to 100 percent.');
    numberField(appearance, 'Background blur', 'backgroundBlur', 0, 24, 'Softens the background image, from 0 to 24 pixels.');
    field(appearance, 'Glass panels', 'glassMode', 'checkbox', 'Make shell panels translucent over your background.');
    numberField(appearance, 'Glass opacity', 'glassOpacity', 40, 100, 'Higher values make panels easier to read.');
    numberField(appearance, 'Glass blur', 'glassBlur', 0, 32);
    moveLegacy(appearance, 'showCovers');
    const effects = section('Background effects');
    field(effects, 'Particle effect', 'particleEffect', [['none', 'None'], ['snow', 'Snow'], ['rain', 'Rain'], ['bubbles', 'Bubbles']], 'Decorative motion behind the site interface. Reduced-motion preferences are respected.');
    field(effects, 'Particle density', 'particleDensity', [['low', 'Low'], ['normal', 'Normal']], 'Low uses fewer particles. Effects pause while the page is hidden.');
    const browser = section('Browser and proxy');
    const network = doc.getElementById('proxy-network-setting'); if (network) browser.append(network);
    moveLegacy(browser, 'searchEngine');
    const uaRow = doc.createElement('label'); uaRow.className = 'setting-item'; uaRow.dataset.preferenceGroup = 'identity';
    const uaInfo = doc.createElement('span'); uaInfo.className = 'setting-info';
    const uaTitle = doc.createElement('span'); uaTitle.className = 'setting-title'; uaTitle.textContent = 'Browser identity'; uaInfo.append(uaTitle);
    const uaDescription = doc.createElement('span'); uaDescription.className = 'setting-desc'; uaDescription.textContent = 'Choose a user-agent string for proxied pages. Reload the viewed page to apply it. This does not emulate device hardware or provide anonymity.'; uaInfo.append(uaDescription);
    uaPresetSelect = doc.createElement('select'); uaPresetSelect.id = 'user-agent-preset'; uaPresetSelect.setAttribute('aria-label', 'Browser identity');
    userAgentPresets.forEach(([id, label]) => uaPresetSelect.append(option(id, label))); uaPresetSelect.append(option('custom', 'Custom'));
    uaPresetSelect.addEventListener('change', () => { if (uaPresetSelect.value === 'custom') { uaCustom?.focus?.(); return; } const preset = userAgentPresets.find(([id]) => id === uaPresetSelect.value); if (preset) setPreferences({ userAgent: preset[2] }); });
    uaRow.append(uaInfo, uaPresetSelect); browser.append(uaRow);
    uaCustom = field(browser, 'Custom user agent', 'userAgent', 'text', 'Leave empty to use this browser’s default. Printable ASCII only, up to 512 characters.'); uaCustom.maxLength = 512; uaCustom.spellcheck = false; uaCustom.autocomplete = 'off';
    const permissions = section('Privacy and permissions');
    for (const key of ['httpsOnly', 'allowPopups', 'allowDownloads', 'aiEnabled']) moveLegacy(permissions, key);
    const cloaking = section('Tab and cloaking');
    field(cloaking, 'Tab cloak', 'cloak', Object.entries(cloakPresets).map(([key, [name]]) => [key, key === 'monkeh' ? 'Monkeh' : name]));
    field(cloaking, 'Auto cloak', 'autoCloak', 'checkbox', 'Use the chosen tab name and icon only when you switch away.');
    field(cloaking, 'Use a blob window', 'blobCloak', 'checkbox', 'Use a blob address instead of about:blank for the cloaked window.');
    button(cloaking, 'Open cloaked window', openCloaked);
    field(cloaking, 'Character masking', 'characterMasking', 'checkbox', 'Use lookalike letters throughout the interface and catalogs. Search, screen readers, editable text, addresses, and viewed pages keep their original content.');
    const safety = section('Shortcuts and behavior');
    const hotkey = doc.createElement('p'); hotkey.id = 'panic-key-label'; hotkey.className = 'setting-desc'; hotkey.dataset.preferenceGroup = 'panic'; safety.append(hotkey);
    const capture = button(safety, 'Capture shortcut', () => { capturing = true; win.MonkehDevtoolsGuard?.setEnabled(false); capture.textContent = 'Press a key combination…'; });
    captureButton = capture;
    capture.dataset.preferenceGroup = 'panic';
    button(safety, 'Clear shortcut', () => { stopCapture(); privacy.update({ panicKey: '' }); }).dataset.preferenceGroup = 'panic';
    field(safety, 'Panic URL', 'panicUrl', 'url', 'The shortcut immediately leaves Monkeh for this HTTPS address.');
    const presets = doc.createElement('div'); presets.className = 'preference-actions'; presets.dataset.preferenceGroup = 'panic';
    for (const [name, url] of [['Classroom', 'https://classroom.google.com/'], ['Docs', 'https://docs.google.com/'], ['Google', 'https://www.google.com/'], ['Wikipedia', 'https://www.wikipedia.org/'], ['Gmail', 'https://mail.google.com/']]) button(presets, name, () => setPreferences({ panicUrl: url }));
    safety.append(presets); button(safety, 'Test panic shortcut', panic).dataset.preferenceGroup = 'panic';
    field(safety, 'Close protection', 'closeProtection', 'checkbox', 'Ask the browser to warn before you leave. Browsers may suppress this prompt.');
    field(safety, 'Skip loading animations', 'skipLoading', 'checkbox', 'Show content immediately and remove interface transitions.');
    field(safety, 'Redirect native DevTools shortcuts', 'nativeDevtoolsGuard', 'checkbox', 'Show the error page for native DevTools shortcuts. Monkeh’s own browser tools stay available.');
    field(safety, 'Detect docked DevTools', 'detectDocked', 'checkbox', 'Experimental: browser side panels can look the same. Undocked DevTools cannot reliably be detected.');
    const data = section('Data and preferences');
    moveLegacy(data, 'clearConsoleOnClose');
    const dataDescription = doc.createElement('p'); dataDescription.className = 'setting-desc'; dataDescription.textContent = 'Export or import these preferences. Game history, favorites, userscripts, passwords, and sessions are not included.'; data.append(dataDescription);
    button(data, 'Export preferences', () => {
      const url = win.URL.createObjectURL(new Blob([serializePreferences(privacy.get())], { type: 'application/json' }));
      const link = doc.createElement('a'); link.href = url; link.download = 'mochii-settings.json'; doc.body.append(link); link.click(); link.remove(); win.setTimeout(() => win.URL.revokeObjectURL(url), 1000); notice('Preferences exported.');
    });
    const importFile = doc.createElement('input'); importFile.type = 'file'; importFile.accept = 'application/json,.json'; importFile.hidden = true; importFile.setAttribute('aria-label', 'Import preferences JSON'); data.append(importFile);
    button(data, 'Import preferences', () => importFile.click());
    importFile.addEventListener('change', async () => {
      const file = importFile.files?.[0]; if (!file) return;
      try { if (file.size > 65536) throw new Error('Choose a settings JSON file smaller than 64 KB.'); setPreferences(parsePreferences(await file.text())); notice('Preferences imported. Reload any open proxied page to apply browser identity changes.'); }
      catch (error) { notice('Could not import preferences: ' + error.message); }
      finally { importFile.value = ''; }
    });
    let beforeReset;
    button(data, 'Reset preferences', () => { beforeReset = privacy.get(); setPreferences(defaults); undoReset.hidden = false; notice('Preferences reset. You can undo this until you leave this page.'); });
    const undoReset = button(data, 'Undo reset', () => { if (beforeReset) setPreferences(beforeReset); beforeReset = null; undoReset.hidden = true; }); undoReset.hidden = true;
    const info = section('Information'); const p = doc.createElement('p'); p.className = 'setting-desc'; p.textContent = 'Game catalogs preserve their source credits. Games run from their source hosts through Monkeh. Favorites, recent games and settings stay in this browser; there is no account sync.'; info.append(p);
    const empty = doc.createElement('p'); empty.className = 'setting-desc'; empty.id = 'settings-empty'; empty.textContent = 'No settings match your search.'; empty.hidden = true; settingsRoot.append(empty);
    const searchable = value => value.toLocaleLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    for (const { body } of groups) {
      const related = new Map();
      for (const row of body.children) {
        const key = row.dataset.preferenceGroup;
        if (key) related.set(key, (related.get(key) || '') + ' ' + row.textContent);
      }
      for (const row of body.children) searchMetadata.set(row, searchable(related.get(row.dataset.preferenceGroup) || row.textContent));
    }
    let searchOpenStates;
    settingsSearch.addEventListener('input', () => {
      const query = searchable(settingsSearch.value).slice(0, 150);
      if (query && !searchOpenStates) searchOpenStates = new Map(groups.map(({ group }) => [group, group.open]));
      let matched = 0;
      for (const { group, body, name } of groups) {
        const groupMatch = searchable(name).includes(query);
        let visible = 0;
        for (const row of body.children) {
          if (row === importFile || row === undoReset) continue;
          row.hidden = Boolean(query) && !groupMatch && !searchMetadata.get(row)?.includes(query);
          if (!row.hidden) visible++;
        }
        group.hidden = !visible; matched += visible;
        group.open = query ? visible > 0 : searchOpenStates?.get(group) ?? group.open;
      }
      if (!query) searchOpenStates = null;
      empty.hidden = matched > 0;
    });
  }
  controls = [...doc.querySelectorAll('[data-preference]'), ...doc.querySelectorAll('[data-privacy]')];
  const maskLabels = createCharacterMasker(doc);
  let currentCloak;
  function cloak() {
    const settings = privacy.get();
    const choice = settings.autoCloak && !doc.hidden ? 'monkeh' : settings.cloak;
    if (choice === currentCloak) return;
    currentCloak = choice;
    if (choice === 'monkeh') { doc.title = baseTitle; if (oldIcon) favicon.href = oldIcon; else favicon.removeAttribute('href'); return; }
    const [title, symbol, color] = cloakPresets[choice]; doc.title = title;
    favicon.href = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="6" fill="${color}"/><text x="16" y="23" text-anchor="middle" font-family="sans-serif" font-size="23" fill="white">${symbol}</text></svg>`);
  }
  function syncControls(settings, changed) {
    for (const input of controls) {
      const key = input.dataset.preference || input.dataset.privacy;
      if (!changed.has(key) || dirtyInputs.has(input)) continue;
      const value = settings[key];
      if (input.type === 'checkbox') { if (input.checked !== value) input.checked = value; }
      else if (String(input.value) !== String(value)) input.value = value;
    }
  }
  function apply() {
    const settings = privacy.get(); const root = doc.documentElement;
    const changed = new Set(Object.keys(settings).filter(key => !applied || settings[key] !== applied[key]));
    if (!changed.size) return;
    if (changed.has('mode')) root.dataset.mode = settings.mode;
    if (changed.has('background')) root.dataset.background = settings.background;
    if (changed.has('skipLoading')) root.dataset.skipLoading = String(settings.skipLoading);
    if (changed.has('glassMode')) root.dataset.glass = String(settings.glassMode);
    if (changed.has('accent')) root.style.setProperty('--user-accent', settings.accent);
    if (changed.has('font')) root.style.setProperty('--user-font', fonts[settings.font][1]);
    if (changed.has('background') || changed.has('backgroundUrl')) root.style.setProperty('--user-background', settings.background === 'custom' && settings.backgroundUrl ? `url(${JSON.stringify(settings.backgroundUrl)})` : 'none');
    if (changed.has('backgroundOpacity')) root.style.setProperty('--background-opacity', String(settings.backgroundOpacity / 100));
    if (changed.has('backgroundBlur')) root.style.setProperty('--background-blur', settings.backgroundBlur + 'px');
    if (changed.has('glassOpacity')) root.style.setProperty('--glass-opacity', settings.glassOpacity + '%');
    if (changed.has('glassBlur')) root.style.setProperty('--glass-blur', settings.glassBlur + 'px');
    if (currentFont !== settings.font) {
      currentFont = settings.font; fontLink?.remove(); fontLink = null;
      if (settings.font !== 'default') { fontLink = doc.createElement('link'); fontLink.rel = 'stylesheet'; const family = settings.font === 'obscured' ? 'Libre Barcode 128 Text' : fonts[settings.font][0]; fontLink.href = 'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(family).replace(/%20/g, '+') + '&display=swap'; doc.head.append(fontLink); }
    }
    syncControls(settings, changed);
    if (uaPresetSelect && changed.has('userAgent')) uaPresetSelect.value = userAgentPresets.find(preset => preset[2] === settings.userAgent)?.[0] || 'custom';
    if (changed.has('particleEffect')) for (const input of controls) if (input.dataset.preference === 'particleDensity') input.disabled = settings.particleEffect === 'none';
    if (changed.has('panicKey')) { const label = doc.getElementById('panic-key-label'); if (label) label.textContent = 'Current shortcut: ' + (settings.panicKey || 'Not set'); }
    if (changed.has('cloak') || changed.has('autoCloak')) cloak();
    if (changed.has('characterMasking')) maskLabels(settings.characterMasking);
    applied = settings;
  }
  function stopCapture() {
    if (!capturing) return;
    capturing = false;
    win.MonkehDevtoolsGuard?.setEnabled(privacy.get().nativeDevtoolsGuard);
    if (captureButton) captureButton.textContent = 'Capture shortcut';
  }
  bindSettingsDialog(win, { isCapturing: () => capturing, onClose: () => { stopCapture(); privacy.flush?.(); } });
  doc.addEventListener('visibilitychange', cloak);
  win.addEventListener('monkeh:privacy', apply);
  win.addEventListener('monkeh:leaving', () => { leaving = true; });
  win.addEventListener('blur', () => { stopCapture(); privacy.flush?.(); });
  win.addEventListener('storage', event => { if (event.key === 'monkeh.privacy.v1' || event.key === null) { try { privacy.sync(JSON.parse(event.newValue)); } catch {} } });
  win.addEventListener('pageshow', () => { leaving = false; });
  win.addEventListener('beforeunload', event => { if (!leaving && privacy.get().closeProtection) { event.preventDefault(); event.returnValue = ''; } });
  win.addEventListener('keydown', event => {
    const key = hotkeyFor(event);
    if (capturing) { event.preventDefault(); event.stopImmediatePropagation(); if (!key) return; stopCapture(); privacy.update({ panicKey: key }); return; }
    if (key && key === privacy.get().panicKey && !event.repeat && !event.isComposing && !event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) { event.preventDefault(); panic(); }
  }, true);
  apply();
  return { apply, openCloaked };
}

if (typeof window !== 'undefined') mountPreferences(window);
