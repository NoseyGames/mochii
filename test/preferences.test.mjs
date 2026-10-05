import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPreferences, hotkeyFor, createCharacterMasker, maskCharacters, parsePreferences, serializePreferences, userAgentPresets } from '../browser-tools/preferences.js';
import { normalizePrivacy } from '../browser-tools/privacy.js';

function events() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    emit(type, options = {}) {
      const event = {
        type, key: '', target: null, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; },
        stopImmediatePropagation() { this.stopped = true; },
        ...options
      };
      for (const listener of listeners.get(type) || []) { listener(event); if (event.stopped) break; }
      return event;
    },
    dispatchEvent(event) { this.emit(event.type, event); return true; }
  };
}

function documentFixture() {
  const all = [];
  function element(tag) {
    const item = {
      ...events(), tagName: tag.toUpperCase(), type: tag === 'select' ? 'select-one' : '', dataset: {}, children: [],
      value: '', checked: false, hidden: false, _text: '', validity: { valid: true },
      style: { values: {}, setProperty(name, value) { this.values[name] = value; } },
      append(...children) { for (const child of children) { if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child); child.parent = this; this.children.push(child); } },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
      setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { delete this[name]; },
      setCustomValidity(value) { this.customValidity = value; },
      reportValidity() { this.reported = true; },
      focus() { this.focused = true; },
      closest(selector) {
        if (selector === '.setting-item') { let item = this; while (item) { if (item.className === 'setting-item') return item; item = item.parent; } }
        return this.excludedFromMask ? this : null;
      },
      querySelectorAll(selector) {
        const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
        if (selector === '*') return descendants;
        if (selector === 'button') return descendants.filter(child => child.tagName === 'BUTTON');
        return [];
      },
      get options() { return this.children; },
      get textContent() { return this._text + this.children.map(child => child.textContent).join(''); },
      set textContent(value) { this._text = value; this.children = []; },
      get outerHTML() { return `<iframe src="${this.src}" title="${this.title}"></iframe>`; }
    };
    all.push(item);
    return item;
  }
  const head = element('head');
  const body = element('body');
  const root = element('html');
  const settings = element('div'); settings.id = 'general-preferences'; body.append(settings);
  const status = element('p'); status.id = 'privacy-status'; body.append(status);
  const network = element('div'); network.id = 'proxy-network-setting'; network.className = 'setting-item'; network.textContent = 'Proxy network'; body.append(network);
  for (const key of ['searchEngine', 'httpsOnly', 'allowPopups', 'allowDownloads', 'aiEnabled', 'clearConsoleOnClose', 'showCovers']) {
    const row = element('label'); row.className = 'setting-item';
    const text = element('span'); text.textContent = key;
    const input = element('input'); input.type = key === 'searchEngine' ? 'select-one' : 'checkbox'; input.dataset.privacy = key;
    row.append(text, input); body.append(row);
  }
  const icon = element('link'); icon.rel = 'icon'; icon.href = '/favicon.svg'; head.append(icon);
  return {
    ...events(), all, head, body, documentElement: root, title: 'Monkeh Browser', hidden: false,
    createElement: element,
    getElementById: id => all.find(item => item.id === id) || null,
    querySelector: selector => selector === 'link[rel~="icon"]' ? icon : selector.startsWith('[data-privacy=') ? all.find(item => item.dataset.privacy === selector.match(/^\[data-privacy="([^"]+)"\]$/)?.[1]) || null : null,
    querySelectorAll: selector => selector === '[data-preference]' ? all.filter(item => item.dataset.preference)
      : selector === '[data-privacy]' ? all.filter(item => item.dataset.privacy)
        : selector === '[data-preference="particleDensity"]' ? all.filter(item => item.dataset.preference === 'particleDensity') : []
  };
}

function fixture(patch = {}) {
  const doc = documentFixture();
  const redirects = [];
  const popups = [];
  const blobs = [];
  const revoked = [];
  const timeouts = [];
  const writes = [];
  let settings = normalizePrivacy(patch);
  const win = {
    ...events(), document: doc, CustomEvent,
    location: { origin: 'https://monkeh.example', replace: url => redirects.push(url) },
    URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:https://monkeh.example/session'; }, revokeObjectURL: url => revoked.push(url) },
    setTimeout(callback, delay) { timeouts.push({ callback, delay }); },
    open(url, target) {
      const popup = { opener: win, document: documentFixture(), location: { replace: next => { popup.redirect = next; } } };
      popups.push({ url, target, popup });
      return popup;
    }
  };
  win.MonkehPrivacy = {
    get: () => ({ ...settings }),
    update(next) { settings = normalizePrivacy({ ...settings, ...next }); writes.push({ ...settings }); win.emit('monkeh:privacy', { detail: { ...settings } }); return { ...settings }; },
    sync(next) { settings = normalizePrivacy(next); win.emit('monkeh:privacy', { detail: { ...settings } }); return { ...settings }; }
  };
  const app = mountPreferences(win);
  return {
    win, doc, app, redirects, popups, blobs, revoked, timeouts, writes,
    update: win.MonkehPrivacy.update,
    button(label) { return doc.all.find(item => item.tagName === 'BUTTON' && item.textContent === label); },
    input(key) { return doc.all.find(item => item.dataset.preference === key); }
  };
}

test('panic hotkeys use a consistent modifier order and ignore unsupported keys', () => {
  assert.equal(hotkeyFor({ key: 'P', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+p');
  assert.equal(hotkeyFor({ key: 'F12', metaKey: true, altKey: true }), 'Alt+Meta+F12');
  assert.equal(hotkeyFor({ key: 'Escape' }), 'Escape');
  for (const key of ['Control', 'Meta', 'Enter', 'Tab', 'ArrowLeft', ' ']) assert.equal(hotkeyFor({ key }), '');
});

test('selected appearance settings apply and custom background stays inactive until chosen', () => {
  const f = fixture({ mode: 'light', accent: '#112233', font: 'space-mono', backgroundUrl: 'https://images.example/wall.png' });
  assert.equal(f.doc.documentElement.dataset.mode, 'light');
  assert.equal(f.doc.documentElement.style.values['--user-accent'], '#112233');
  assert.match(f.doc.documentElement.style.values['--user-font'], /Space Mono/);
  assert.equal(f.doc.documentElement.style.values['--user-background'], 'none');
  assert.ok(f.doc.head.children.some(link => link.href === 'https://fonts.googleapis.com/css2?family=Space+Mono&display=swap'));
  f.update({ font: 'default', background: 'custom', skipLoading: false });
  assert.equal(f.doc.documentElement.style.values['--user-background'], 'url("https://images.example/wall.png")');
  assert.equal(f.doc.documentElement.dataset.skipLoading, 'false');
  assert.equal(f.doc.head.children.filter(link => link.rel === 'stylesheet').length, 0);
});

test('auto cloak changes the tab title and icon only while the page is hidden', () => {
  const f = fixture({ cloak: 'classroom', autoCloak: true });
  const icon = f.doc.querySelector('link[rel~="icon"]');
  assert.equal(f.doc.title, 'Monkeh Browser');
  assert.equal(icon.href, '/favicon.svg');
  f.doc.hidden = true;
  f.doc.emit('visibilitychange');
  assert.equal(f.doc.title, 'Google Classroom');
  assert.ok(icon.href.startsWith('data:image/svg+xml,'));
  f.doc.hidden = false;
  f.doc.emit('visibilitychange');
  assert.equal(f.doc.title, 'Monkeh Browser');
  assert.equal(icon.href, '/favicon.svg');
  f.update({ autoCloak: false, cloak: 'google' });
  assert.equal(f.doc.title, 'Google');
});

test('URL setting fields reject invalid input before saving and recover when corrected', () => {
  const f = fixture();
  const input = f.input('backgroundUrl');
  input.value = 'javascript:alert(1)';
  input.emit('change');
  assert.equal(input.customValidity, 'Enter a complete HTTPS URL.');
  assert.equal(input.reported, true);
  assert.equal(f.win.MonkehPrivacy.get().backgroundUrl, '');
  input.value = 'https://images.example/bg.png';
  input.emit('input');
  input.emit('change');
  assert.equal(input.customValidity, '');
  assert.equal(f.win.MonkehPrivacy.get().backgroundUrl, input.value);
});

test('captured panic shortcut saves once and does not navigate until used again', () => {
  const f = fixture();
  f.button('Capture shortcut').emit('click');
  const capture = f.win.emit('keydown', { key: 'P', ctrlKey: true, shiftKey: true });
  assert.equal(capture.prevented, true);
  assert.equal(capture.stopped, true);
  assert.equal(f.win.MonkehPrivacy.get().panicKey, 'Ctrl+Shift+p');
  assert.deepEqual(f.redirects, []);
  assert.ok(f.button('Capture shortcut'));
  f.win.emit('keydown', { key: 'P', ctrlKey: true, shiftKey: true });
  assert.deepEqual(f.redirects, ['https://www.google.com/']);
});

test('panic ignores typing fields, repeated keys and composition without disabling normal escape', () => {
  const f = fixture({ panicKey: 'Escape', panicUrl: 'https://classroom.google.com/', closeProtection: true });
  for (const options of [{ repeat: true }, { isComposing: true }, { target: { closest: () => ({}) } }]) f.win.emit('keydown', { key: 'Escape', ...options });
  assert.deepEqual(f.redirects, []);
  assert.equal(f.win.emit('beforeunload').prevented, true);
  assert.equal(f.win.emit('keydown', { key: 'Escape' }).prevented, true);
  assert.deepEqual(f.redirects, ['https://classroom.google.com/']);
  assert.equal(f.win.emit('beforeunload').prevented, false);
});

test('clear shortcut restores normal keyboard behavior and privacy changes update controls', () => {
  const f = fixture({ panicKey: 'Escape' });
  f.button('Clear shortcut').emit('click');
  f.win.emit('keydown', { key: 'Escape' });
  assert.deepEqual(f.redirects, []);
  f.update({ closeProtection: true, mode: 'light' });
  assert.equal(f.input('closeProtection').checked, true);
  assert.equal(f.input('mode').value, 'light');
  assert.equal(f.doc.getElementById('panic-key-label').textContent, 'Current shortcut: Not set');
});

test('capture pauses the native guard and restores the saved choice when focus leaves', () => {
  const f = fixture({ nativeDevtoolsGuard: true });
  const enabled = [];
  f.win.MonkehDevtoolsGuard = { setEnabled: value => enabled.push(value) };
  f.button('Capture shortcut').emit('click');
  assert.deepEqual(enabled, [false]);
  f.win.emit('blur');
  assert.deepEqual(enabled, [false, true]);
  assert.ok(f.button('Capture shortcut'));
  f.win.emit('keydown', { key: 'p' });
  assert.equal(f.win.MonkehPrivacy.get().panicKey, '');
});

test('intentional native guard departure bypasses the close warning', () => {
  const f = fixture({ closeProtection: true });
  assert.equal(f.win.emit('beforeunload').prevented, true);
  f.win.emit('monkeh:leaving', { detail: { reason: 'devtools-guard' } });
  assert.equal(f.win.emit('beforeunload').prevented, false);
});

test('returning from the back-forward cache restores close protection after an intentional departure', () => {
  const f = fixture({ closeProtection: true });
  f.win.emit('monkeh:leaving');
  assert.equal(f.win.emit('beforeunload').prevented, false);
  f.win.emit('pageshow', { persisted: true });
  assert.equal(f.win.emit('beforeunload').prevented, true);
});

test('panic from the cloaked shell navigates the accessible outer window', () => {
  const f = fixture({ panicKey: 'Escape', panicUrl: 'https://classroom.google.com/' });
  const outerRedirects = [];
  const outerEvents = [];
  f.win.top = { document: {}, dispatchEvent: event => outerEvents.push(event.type), location: { replace: url => outerRedirects.push(url) } };
  f.win.emit('keydown', { key: 'Escape' });
  assert.deepEqual(outerEvents, ['monkeh:leaving']);
  assert.deepEqual(outerRedirects, ['https://classroom.google.com/']);
  assert.deepEqual(f.redirects, []);
});

test('cloaked popup contains only the local shell and detaches its opener', () => {
  const f = fixture({ cloak: 'wikipedia' });
  f.app.openCloaked();
  assert.equal(f.popups.length, 1);
  const { url, target, popup } = f.popups[0];
  assert.equal(url, 'about:blank');
  assert.equal(target, '_blank');
  assert.equal(popup.opener, null);
  assert.equal(popup.document.title, 'Wikipedia');
  const frame = popup.document.body.children.find(item => item.tagName === 'IFRAME');
  assert.equal(frame.src, 'https://monkeh.example/math.html');
  assert.equal(frame.allow, 'autoplay; fullscreen; gamepad');
  assert.equal(frame.allowFullscreen, true);
  assert.match(f.doc.getElementById('privacy-status').textContent, /not network visibility/);
});

test('blob cloak revokes its object URL after giving the popup time to load', async () => {
  const f = fixture({ blobCloak: true, cloak: 'google' });
  f.app.openCloaked();
  assert.equal(f.blobs.length, 1);
  assert.equal(f.blobs[0].type, 'text/html');
  const markup = await f.blobs[0].text();
  assert.match(markup, /<title>Google<\/title>/);
  assert.match(markup, /src="https:\/\/monkeh.example\/math.html"/);
  assert.equal(f.popups[0].popup.redirect, 'blob:https://monkeh.example/session');
  assert.equal(f.timeouts[0].delay, 60000);
  assert.deepEqual(f.revoked, []);
  f.timeouts[0].callback();
  assert.deepEqual(f.revoked, ['blob:https://monkeh.example/session']);
});

test('blocked cloaked popup reports a recoverable message without starting a blob', () => {
  const f = fixture({ blobCloak: true });
  f.win.open = () => null;
  assert.doesNotThrow(() => f.app.openCloaked());
  assert.match(f.doc.getElementById('privacy-status').textContent, /Allow this window/);
  assert.deepEqual(f.blobs, []);
});

test('storage changes update settings while malformed storage is ignored', () => {
  const f = fixture();
  f.win.emit('storage', { key: 'monkeh.privacy.v1', newValue: JSON.stringify({ mode: 'light', cloak: 'drive' }) });
  assert.equal(f.doc.documentElement.dataset.mode, 'light');
  assert.equal(f.doc.title, 'Google Drive');
  assert.doesNotThrow(() => f.win.emit('storage', { key: 'monkeh.privacy.v1', newValue: '{not JSON' }));
  f.win.emit('storage', { key: 'unrelated', newValue: JSON.stringify({ mode: 'dark' }) });
  assert.equal(f.doc.documentElement.dataset.mode, 'light');
  assert.deepEqual(f.writes, []);
});

test('removing preferences or clearing browser storage restores defaults in the other tab', () => {
  for (const key of ['monkeh.privacy.v1', null]) {
    const f = fixture({ mode: 'light', cloak: 'google', panicKey: 'Escape', closeProtection: true });
    f.win.emit('storage', { key, newValue: null });
    assert.equal(f.doc.documentElement.dataset.mode, 'dark');
    assert.equal(f.doc.title, 'Monkeh Browser');
    assert.equal(f.win.MonkehPrivacy.get().panicKey, '');
    assert.equal(f.win.MonkehPrivacy.get().closeProtection, false);
    assert.equal(f.input('closeProtection').checked, false);
    assert.deepEqual(f.writes, []);
  }
});

test('settings organize existing live controls inside searchable categories without replacing their nodes', () => {
  const f = fixture();
  const parentSection = item => { let current = item; while (current && current.tagName !== 'DETAILS') current = current.parent; return current; };
  const sections = f.doc.all.filter(item => item.tagName === 'DETAILS');
  assert.deepEqual(sections.map(section => section.children[0].textContent), ['Appearance', 'Background effects', 'Browser and proxy', 'Privacy and permissions', 'Tab and cloaking', 'Shortcuts and behavior', 'Data and preferences', 'Information']);
  assert.equal(parentSection(f.doc.getElementById('proxy-network-setting')).children[0].textContent, 'Browser and proxy');
  assert.equal(parentSection(f.doc.querySelector('[data-privacy="showCovers"]')).children[0].textContent, 'Appearance');
  assert.equal(parentSection(f.doc.querySelector('[data-privacy="allowPopups"]')).children[0].textContent, 'Privacy and permissions');
  assert.equal(parentSection(f.doc.querySelector('[data-privacy="clearConsoleOnClose"]')).children[0].textContent, 'Data and preferences');
  const input = f.doc.getElementById('settings-search');
  input.value = 'user agent'; input.emit('input');
  assert.equal(sections.filter(section => !section.hidden).length, 1);
  assert.equal(sections.find(section => !section.hidden).children[0].textContent, 'Browser and proxy');
  assert.equal(sections.find(section => !section.hidden).open, true);
  input.value = 'not-a-setting'; input.emit('input');
  assert.equal(f.doc.getElementById('settings-empty').hidden, false);
  input.value = ''; input.emit('input');
  assert.equal(sections[0].open, true);
  assert.equal(sections[1].open, false);
  assert.equal(sections.every(section => !section.hidden), true);
});

test('user-agent presets and custom input save validated strings while particle controls use agreed keys', () => {
  const f = fixture();
  const select = f.doc.getElementById('user-agent-preset');
  select.value = 'android'; select.emit('change');
  assert.equal(f.win.MonkehPrivacy.get().userAgent, userAgentPresets.find(preset => preset[0] === 'android')[2]);
  assert.equal(f.input('userAgent').value, f.win.MonkehPrivacy.get().userAgent);
  const input = f.input('userAgent');
  input.value = 'Example/1.0'; input.emit('change');
  assert.equal(select.value, 'custom');
  assert.equal(f.win.MonkehPrivacy.get().userAgent, 'Example/1.0');
  input.value = 'bad\r\nHeader: yes'; input.emit('change');
  assert.match(input.customValidity, /printable ASCII/);
  assert.equal(f.win.MonkehPrivacy.get().userAgent, 'Example/1.0');
  select.value = 'default'; select.emit('change');
  assert.equal(f.win.MonkehPrivacy.get().userAgent, '');
  assert.equal(f.input('particleDensity').disabled, true);
  f.update({ particleEffect: 'bubbles', particleDensity: 'low' });
  assert.equal(f.input('particleEffect').value, 'bubbles');
  assert.equal(f.input('particleDensity').disabled, false);
  assert.equal(f.input('particleDensity').value, 'low');
});

test('character masking touches only supplied safe leaf labels and always restores the original text', () => {
  const doc = documentFixture();
  const heading = doc.createElement('h2'); heading.textContent = 'Appearance and Games';
  const input = doc.createElement('input'); input.textContent = 'User secret'; input.value = 'user input'; input.excludedFromMask = true;
  const editor = doc.createElement('span'); editor.textContent = 'const myCode = 1'; editor.excludedFromMask = true;
  const composite = doc.createElement('div'); const child = doc.createElement('span'); child.textContent = 'Keep child nodes'; composite.append(child);
  const toggle = createCharacterMasker(doc, [heading, input, editor, composite]);
  toggle(true);
  assert.equal(heading.children.length, 2);
  assert.equal(heading.children[0]['aria-hidden'], 'true');
  assert.equal(heading.children[0].textContent, maskCharacters('Appearance and Games'));
  assert.notEqual(heading.children[0].textContent, 'Appearance and Games');
  assert.equal(heading.children[1].textContent, 'Appearance and Games');
  assert.equal(heading.children[1].className, 'preference-sr-only');
  assert.equal(input.value, 'user input');
  assert.equal(input.textContent, 'User secret');
  assert.equal(editor.textContent, 'const myCode = 1');
  assert.equal(composite.children[0], child);
  toggle(true);
  assert.equal(heading.children.length, 2);
  toggle(false);
  assert.equal(heading.textContent, 'Appearance and Games');
  assert.equal(heading.children.length, 0);
  assert.equal(maskCharacters('123 <>& ü'), '123 <>& ü');
});

test('preference import and export whitelist supported settings and never include other storage or unsafe values', () => {
  const exported = serializePreferences({ mode: 'light', userAgent: 'Safe/1', particleEffect: 'snow', password: 'not-exported', session: 'not-exported' });
  assert(!exported.includes('not-exported'));
  const parsed = parsePreferences(exported);
  assert.equal(parsed.mode, 'light');
  assert.equal(parsed.userAgent, 'Safe/1');
  assert.equal(parsed.particleEffect, 'snow');
  assert.equal(parsed.password, undefined);
  const hostile = parsePreferences(JSON.stringify({ app: 'mochii', version: 1, preferences: { userAgent: 'agent\nInjected: yes', backgroundUrl: 'javascript:alert(1)', unknown: 1 } }));
  assert.equal(hostile.userAgent, '');
  assert.equal(hostile.backgroundUrl, '');
  assert.equal(hostile.unknown, undefined);
  for (const content of ['', '{', 'null', '[]', '{}', '{"app":"other","version":1,"preferences":{}}', '{"app":"mochii","version":1,"preferences":[]}', ' '.repeat(65537)]) assert.throws(() => parsePreferences(content));
});

test('visual numeric fields reject invalid entries and reset preferences can be undone', () => {
  const f = fixture({ mode: 'light', particleEffect: 'rain', userAgent: 'Safe/1', glassMode: true });
  assert.equal(f.doc.documentElement.dataset.glass, 'true');
  const blur = f.input('backgroundBlur');
  blur.value = '100'; blur.emit('change');
  assert.match(blur.customValidity, /0 to 24/);
  assert.equal(f.win.MonkehPrivacy.get().backgroundBlur, 0);
  blur.value = '12'; blur.emit('input'); blur.emit('change');
  assert.equal(f.doc.documentElement.style.values['--background-blur'], '12px');
  f.button('Reset preferences').emit('click');
  assert.equal(f.win.MonkehPrivacy.get().mode, 'dark');
  assert.equal(f.win.MonkehPrivacy.get().userAgent, '');
  assert.equal(f.button('Undo reset').hidden, false);
  f.button('Undo reset').emit('click');
  assert.equal(f.win.MonkehPrivacy.get().mode, 'light');
  assert.equal(f.win.MonkehPrivacy.get().userAgent, 'Safe/1');
  assert.equal(f.button('Undo reset').hidden, true);
});
