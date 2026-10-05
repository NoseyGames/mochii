import { formatValue } from './runtime.js';
import { createRemoteRuntime } from './remote-runtime.js';
import { createUserscriptStore } from './userscripts.js';

const $ = id => document.getElementById(id);
const frame = $('viewer-frame');
const panel = $('browser-tools');
const toggle = $('browser-tools-toggle');
let storage;
try { storage = window.localStorage; } catch {                                         }
const store = createUserscriptStore(storage);
let runtime = null;
let serverSwitchPending = false;
let currentDocument = null;
let currentUrl = '';
let expectedUrl = '';
let expectingDocument = false;
let selectedElement = null;
let selectedScriptId = null;
let dirty = false;
let activeTab = 'console';
let entries = [];
let commandHistory = [];
let historyPosition = 0;
let generation = 0;
let consoleRenderPending = false;
const consoleRows = new Map();
let renderedQuery = '';
let renderedLevel = '';
let treeRefresh = null;
let readyRetries = 0;
let editing = false;
let remoteNavigation = 0;

function sameNode(first, second) {
  return first === second || Boolean(first && second && first.remoteId !== undefined &&
    typeof first.remoteId === typeof second.remoteId && first.remoteId === second.remoteId);
}

function editControls(info = null) {
  const unavailable = !runtime || !selectedElement || editing;
  for (const id of ['inspector-attribute-apply', 'inspector-attribute-remove']) $(id).disabled = unavailable;
  $('inspector-delete').disabled = unavailable || !info?.canDelete;
  $('inspector-text-apply').disabled = unavailable || info?.textTruncated === true || info?.tag === 'html';
  $('inspector-undo').disabled = !runtime || editing || !info?.canUndo;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function publicUrl(value) {
  try {
    const url = new URL(value, location.href);
    const config = window.__uv$config;
    if (url.origin === location.origin && config && url.pathname.startsWith(config.prefix)) {
      return config.decodeUrl(url.href.slice(url.origin.length + config.prefix.length));
    }
    return /^https?:$/.test(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function updateServerSwitchButton() {
  $('browser-switch-server').disabled = serverSwitchPending || !runtime?.isRemote || !runtime.hasHandshake;
}

function setConnection(text, connected = false) {
  $('tools-connection').textContent = text;
  $('tools-connection').dataset.connected = String(connected);
  $('tools-target').textContent = currentUrl || 'No page connected';
  $('tools-target').title = currentUrl;
  $('console-input').disabled = !connected;
  $('inspector-pick').disabled = !connected;
  $('userscript-run').disabled = !connected;
  updateServerSwitchButton();
  if (!connected) editControls();
}

function showPanel(open = true) {
  const wasHidden = panel.hidden;
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.classList.toggle('bt-is-active', open);
  if (!open) stopPicking();
  if (open && wasHidden) renderActiveTab();
  if (open && activeTab === 'console') $('console-input').focus();
}

function renderActiveTab() {
  if (panel.hidden) return;
  if (activeTab === 'console') renderConsole();
  if (activeTab === 'inspector') void renderTree(!runtime?.document.documentElement);
}

function selectTab(name) {
  activeTab = name;
  document.querySelectorAll('[data-tool-tab]').forEach(button => {
    const selected = button.dataset.toolTab === name;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    $(`tool-${button.dataset.toolTab}`).hidden = !selected;
  });
  if (name !== 'inspector') stopPicking();
  renderActiveTab();
}

function addEntry(level, args, time = Date.now()) {
  if (level === 'clear') {
    if (!$('console-preserve').checked) resetConsoleEntries();
    return;
  }
  const text = args.map(value => formatValue(value)).join(' ').slice(0, 12000);
  entries.push({ level, text, time });
  if (entries.length > 500) entries.shift();
                                                                               
  if (panel.hidden || activeTab !== 'console') return;
                                                               
  if (!window.requestAnimationFrame) { renderConsole(); return; }
  if (!consoleRenderPending) {
    consoleRenderPending = true;
    window.requestAnimationFrame(() => { consoleRenderPending = false; renderConsole(); });
  }
}

function renderConsole() {
  if (panel.hidden || activeTab !== 'console') return;
  const output = $('console-output');
  const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 50;
  const query = $('console-filter').value.toLowerCase();
  const level = $('console-level').value;
  const visible = entries.filter(entry => (!query || entry.text.toLowerCase().includes(query)) &&
    (level === 'all' || entry.level === level || (level === 'log' && ['info', 'debug', 'result', 'command'].includes(entry.level))));
  if (query !== renderedQuery || level !== renderedLevel) {
    consoleRows.clear();
    output.replaceChildren();
    renderedQuery = query;
    renderedLevel = level;
  }
  const visibleEntries = new Set(visible);
  for (const [entry, row] of consoleRows) {
    if (!visibleEntries.has(entry)) { row.remove(); consoleRows.delete(entry); }
  }
  if (!visible.length) {
    output.replaceChildren(element('div', 'bt-empty-state', entries.length ? 'No messages match this filter.' : 'Console is listening. Run JavaScript in the current page.'));
    return;
  }
  if (!consoleRows.size) output.replaceChildren();
  const content = document.createDocumentFragment();
  for (const entry of visible) {
    if (consoleRows.has(entry)) continue;
    const row = element('div', 'bt-console-entry');
    row.dataset.level = entry.level;
    row.append(element('span', 'bt-log-time', new Date(entry.time).toLocaleTimeString([], { hour12: false })));
    row.append(element('span', 'bt-log-level', entry.level === 'command' ? '›' : entry.level === 'result' ? '←' : entry.level));
    row.append(element('pre', 'bt-log-text', entry.text));
    consoleRows.set(entry, row);
    content.append(row);
  }
  output.append(content);
  if (atBottom) output.scrollTop = output.scrollHeight;
}

function resetConsoleEntries() {
  entries = [];
  consoleRows.clear();
                                                                            
  $('console-output').replaceChildren();
  renderConsole();
}

function clearConsole() {
  commandHistory = [];
  historyPosition = 0;
  $('console-input').value = '';
  resetConsoleEntries();
}

function stopPicking() {
  runtime?.stopPicking()?.catch?.(() => {});
  $('inspector-pick').setAttribute('aria-pressed', 'false');
  $('inspector-pick').textContent = 'Pick element';
}

function disconnect() {
  generation++;
  remoteNavigation++;
  stopPicking();
  runtime?.dispose();
  runtime = null;
  currentDocument = null;
  selectedElement = null;
  editing = false;
  $('inspector-tree').replaceChildren(element('div', 'bt-empty-state', 'Open a page to inspect its elements.'));
  $('inspector-summary').textContent = 'Select an element';
  $('inspector-attributes').replaceChildren();
  $('inspector-styles').replaceChildren();
  $('inspector-text').value = '';
  $('inspector-edit-status').textContent = '';
  setConnection('Waiting for page');
}

async function describeSelection(node) {
  selectedElement = node;
  stopPicking();
  const target = runtime;
  const session = generation;
  try {
    const info = await target.describe(node);
    if (target !== runtime || session !== generation || selectedElement !== node) return;
    $('inspector-summary').textContent = `${info.selector} · ${Math.round(info.rect.width)} × ${Math.round(info.rect.height)}`;
    $('inspector-summary').title = info.selector;
    const attributes = info.attributes.map(({ name, value }) => {
      const row = element('div', 'bt-attribute-row');
      row.append(element('code', '', name), element('span', '', value));
      row.addEventListener('click', () => {
        $('inspector-attribute-name').value = name;
        $('inspector-attribute-value').value = value;
      });
      return row;
    });
    $('inspector-attributes').replaceChildren(...(attributes.length ? attributes : [element('p', 'bt-empty-state', 'No attributes')]));
    $('inspector-styles').replaceChildren(...info.styles.map(({ name, value }) => {
      const row = element('div', 'bt-style-row');
      row.append(element('code', '', name), element('span', '', value));
      row.addEventListener('click', () => {
        $('inspector-property').value = name;
        $('inspector-value').value = value;
      });
      return row;
    }));
    $('inspector-text').value = info.text || '';
    $('inspector-text').disabled = info.textTruncated === true;
    $('inspector-text').title = info.textTruncated ? 'Text is too large to edit here. Use the console.' : 'Replaces this element’s text and nested contents.';
    editControls(info);
    await renderTree(false);
  } catch (error) { addEntry('error', [error.message]); }
}

async function renderTree(refresh = true) {
  const tree = $('inspector-tree');
  if (!runtime || panel.hidden || activeTab !== 'inspector') return;
  const target = runtime;
  const session = generation;
  try {
    if (refresh) {
      if (treeRefresh?.target !== target || treeRefresh.session !== session) {
        treeRefresh = { target, session, promise: target.refreshTree(selectedElement) };
      }
      const pending = treeRefresh;
      try { await pending.promise; }
      finally { if (treeRefresh === pending) treeRefresh = null; }
    }
    if (target !== runtime || session !== generation || panel.hidden || activeTab !== 'inspector') return;
  } catch (error) {
    if (target === runtime && session === generation) tree.replaceChildren(element('div', 'bt-empty-state', error.message));
    return;
  }
  if (!target.document.documentElement) {
    tree.replaceChildren(element('div', 'bt-empty-state', 'The page is loading. Refresh the inspector after it appears.'));
    return;
  }
  const ancestors = new Set();
  const parents = new Map();
  const search = [target.document.documentElement];
  let found;
  for (let index = 0; index < search.length && index < 800; index++) {
    const node = search[index];
    if (sameNode(node, selectedElement)) { found = node; break; }
    for (const child of target.getChildren(node)) {
      if (parents.has(child) || child === target.document.documentElement || search.length >= 800) continue;
      parents.set(child, node); search.push(child);
    }
  }
  for (let node = found; node; node = parents.get(node)) ancestors.add(node);
  let count = 0;
  let rowId = 0;
  let selectedButton;
  function branch(node, depth = 0) {
    const wrapper = element('div', 'bt-tree-branch');
    wrapper.setAttribute('role', 'none');
    const row = element('div', 'bt-tree-row');
    const children = target.getChildren(node);
    const expand = element('button', 'bt-tree-expand', children.length ? '▸' : '·');
    expand.type = 'button';
    expand.disabled = !children.length;
    expand.setAttribute('aria-label', `Expand ${node.localName || 'element'}`);
    expand.setAttribute('aria-expanded', 'false');
    const label = `${node.localName || node.tagName?.toLowerCase()}${node.id ? '#' + node.id : ''}${typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/\s+/).slice(0, 3).join('.') : ''}`;
    const button = element('button', 'bt-tree-node', `<${label}>`);
    button.type = 'button';
    button.setAttribute('role', 'treeitem');
    const isSelected = sameNode(node, selectedElement);
    button.id = `inspector-node-${++rowId}`;
    button.setAttribute('aria-selected', String(isSelected));
    button.classList.toggle('bt-tree-selected', isSelected);
    if (isSelected) selectedButton = button;
    button.inspectedElement = node;
    button.addEventListener('click', () => { void target.select(node).catch(error => addEntry('error', [error.message])); });
    row.append(expand, button);
    const nested = element('div', 'bt-tree-children');
    nested.setAttribute('role', 'group');
    nested.hidden = true;
    let filled = false;
    const toggleChildren = () => {
      if (!filled) {
        for (const child of children) {
          if (++count > 800) { nested.append(element('div', 'bt-empty-state', 'Tree limit reached. Find an element with a CSS selector.')); break; }
          nested.append(branch(child, depth + 1));
        }
        filled = true;
      }
      nested.hidden = !nested.hidden;
      expand.textContent = nested.hidden ? '▸' : '▾';
      expand.setAttribute('aria-expanded', String(!nested.hidden));
      expand.setAttribute('aria-label', `${nested.hidden ? 'Expand' : 'Collapse'} ${node.localName || 'element'}`);
    };
    expand.addEventListener('click', toggleChildren);
    wrapper.append(row, nested);
    if ((depth < 2 || ancestors.has(node)) && children.length) toggleChildren();
    return wrapper;
  }
  try {
    tree.replaceChildren(branch(target.document.documentElement));
    if (selectedElement && !selectedButton) {
      tree.append(element('p', 'bt-help', 'The selected element is outside this bounded tree. Its details and edit controls are available below.'));
    }
    if (selectedButton) {
      tree.setAttribute('aria-activedescendant', selectedButton.id);
      selectedButton.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    } else tree.removeAttribute?.('aria-activedescendant');
  }
  catch (error) { tree.replaceChildren(element('div', 'bt-empty-state', error.message)); }
}

async function connectFrame(force = false) {
  if (!expectingDocument) return;
  try {
    const source = new URL(frame.src, location.href);
    if (source.protocol === 'about:') return;
    if (source.origin !== window.MonkehProxyOrigin || source.pathname !== '/proxy-host.html' || source.origin === location.origin) {
      disconnect();
      setConnection(source.origin === location.origin ? 'Local app · tools paused' : 'Isolated content · tools unavailable');
      return;
    }
    if (runtime && currentDocument === frame.src && !force) return;
    disconnect();
    currentDocument = frame.src;
    currentUrl = publicUrl(expectedUrl);
    setConnection('Connecting to isolated page');
    const target = createRemoteRuntime(frame, window.MonkehProxyOrigin, {
      onPage: page => {
        if (runtime !== target) return;
        generation++;
        selectedElement = null;
        editing = false;
        currentUrl = page.url;
        $('browser-url').value = currentUrl;
        $('inspector-summary').textContent = 'Select an element';
        $('inspector-attributes').replaceChildren();
        $('inspector-styles').replaceChildren();
        $('inspector-text').value = '';
        $('inspector-edit-status').textContent = '';
        setConnection(page.isError ? 'Proxy error · tools connected' : 'Connected · isolated page', true);
        $('inspector-tree').replaceChildren(element('div', 'bt-empty-state', 'Open Inspect to load this page’s elements.'));
        renderActiveTab();
        addEntry('info', ['Page connected. Console capture starts here.']);
                                                                                
                                                                     
        if (store.list().some(script => script.enabled)) {
          addEntry('warn', ['Automatic userscripts are paused for isolated pages. Review the page and use Run to send a script manually.']);
        }
      },
      onConsole: event => { if (runtime === target) addEntry(event.level, event.args, event.time); },
      onSelect: node => { if (runtime === target) { selectTab('inspector'); showPanel(); void describeSelection(node); } },
      onPickEnd: () => {
        if (runtime !== target) return;
        $('inspector-pick').setAttribute('aria-pressed', 'false');
        $('inspector-pick').textContent = 'Pick element';
      },
      onNavigate: () => {
        if (runtime !== target) return;
        generation++;
        selectedElement = null;
        editing = false;
        setConnection('Loading isolated page');
        if (!$('console-preserve').checked) resetConsoleEntries();
      },
      onNetwork: state => {
        if (runtime !== target) return;
        updateServerSwitchButton();
        if (typeof window.networkStatusChanged === 'function') window.networkStatusChanged(state);
      },
      onError: error => { if (runtime === target) addEntry('warn', [error.message]); },
    });
    runtime = target;
  } catch (error) {
    disconnect();
    setConnection('Page connection unavailable');
    addEntry('warn', ['Reload the isolated page to reconnect browser tools.', error.message]);
  }
}

function scriptStatus(message, error = false) {
  $('userscript-status').textContent = message;
  $('userscript-status').dataset.error = String(error);
}

function draft() {
  return {
    ...(selectedScriptId ? { id: selectedScriptId } : {}),
    name: $('userscript-name').value,
    match: $('userscript-match').value,
    code: $('userscript-code').value,
    enabled: $('userscript-enabled').checked,
  };
}

function renderScripts() {
  const scripts = store.list();
  const list = $('userscript-list');
  list.replaceChildren(...scripts.map(script => {
    const button = element('button', 'bt-script-item');
    button.type = 'button';
    button.setAttribute('aria-selected', String(script.id === selectedScriptId));
    button.append(element('span', 'bt-script-name', script.name), element('span', 'bt-script-meta', script.enabled ? 'Auto-run paused · manual run available' : 'Manual run'));
    button.addEventListener('click', () => {
      if (dirty && !confirm('Discard unsaved changes to this script?')) return;
      editScript(script);
    });
    return button;
  }));
  if (!scripts.length) list.append(element('div', 'bt-empty-state', 'Your scripts live here. Create one and make a page your own.'));
}

function editScript(script = null) {
  selectedScriptId = script?.id || null;
  $('userscript-name').value = script?.name || 'My page script';
  let match = 'https://example.com/*';
  try { if (currentUrl) match = new URL(currentUrl).origin + '/*'; } catch {                     }
  $('userscript-match').value = script?.match || match;
  $('userscript-code').value = script?.code ?? '// Runs in the viewed page. Save to keep this script.\nconsole.log("Hello from my userscript", document.title);\n';
  $('userscript-enabled').checked = script?.enabled || false;
  $('userscript-delete').disabled = !script;
  dirty = false;
  renderScripts();
  scriptStatus(script ? 'Saved locally. Changes to the page last until reload.' : 'New script · not saved yet');
}

function saveScript() {
  try {
    const script = store.save(draft());
    selectedScriptId = script.id;
    dirty = false;
    $('userscript-delete').disabled = false;
    renderScripts();
    scriptStatus('Saved locally · ready to run manually. Auto-run is paused to keep saved scripts private from isolated pages.');
  } catch (error) { scriptStatus(error.message, true); }
}

async function runScript(script, target = runtime, automatic = false) {
  if (!target) { scriptStatus('Open a page before running a script.', true); return; }
  const session = generation;
  const label = script.name.trim() || 'Untitled script';
  if (!automatic) scriptStatus(`Running ${label}…`);
  try {
    if (!script.code.trim()) throw new Error('Write some JavaScript first.');
                                                                                
    const result = await target.evaluate(`(async function() {\n${script.code}\n}).call(window)\n//# sourceURL=monkeh-userscript-${(script.id || 'draft').replace(/[^\w-]/g, '')}.js`);
    if (session !== generation) return;
    addEntry('info', [`${automatic ? 'Auto-ran' : 'Ran'} userscript: ${label}`, ...(result === undefined ? [] : [result])]);
    if (!automatic) scriptStatus(`Ran ${label} in this page${dirty ? ' · editor changes are not saved.' : '.'}`);
  } catch (error) {
    if (session !== generation) return;
    addEntry('error', [`Userscript ${label}: ${error.message}`]);
    if (!automatic) scriptStatus(error.message, true);
  }
}

toggle.addEventListener('click', () => showPanel(panel.hidden));
$('tools-close').addEventListener('click', () => { showPanel(false); toggle.focus(); });
document.querySelectorAll('[data-tool-tab]').forEach(button => {
  button.addEventListener('click', () => selectTab(button.dataset.toolTab));
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('[data-tool-tab]')];
    const index = tabs.indexOf(button);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    selectTab(tabs[next].dataset.toolTab);
    tabs[next].focus();
  });
});
$('console-filter').addEventListener('input', renderConsole);
$('console-level').addEventListener('change', renderConsole);
$('console-clear').addEventListener('click', clearConsole);
$('console-form').addEventListener('submit', async event => {
  event.preventDefault();
  const source = $('console-input').value.trim();
  if (!source || !runtime) return;
  const target = runtime;
  const session = generation;
  commandHistory.push(source);
  commandHistory = commandHistory.slice(-100);
  historyPosition = commandHistory.length;
  $('console-input').value = '';
  addEntry('command', [source]);
  try {
    const result = await target.evaluate(source);
    if (session === generation) addEntry('result', [result]);
  } catch (error) { if (session === generation) addEntry('error', [error.message]); }
});
$('console-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('console-form').requestSubmit();
  } else if (['ArrowUp', 'ArrowDown'].includes(event.key) && !event.target.value.includes('\n')) {
    event.preventDefault();
    historyPosition = Math.max(0, Math.min(commandHistory.length, historyPosition + (event.key === 'ArrowUp' ? -1 : 1)));
    event.target.value = commandHistory[historyPosition] || '';
  }
});
$('inspector-pick').addEventListener('click', async () => {
  if (!runtime) return;
  if ($('inspector-pick').getAttribute('aria-pressed') === 'true') { stopPicking(); return; }
  try { await runtime.startPicking(); }
  catch (error) { addEntry('error', [error.message]); return; }
  $('inspector-pick').setAttribute('aria-pressed', 'true');
  $('inspector-pick').textContent = 'Click an element · Esc to cancel';
});
$('inspector-refresh').addEventListener('click', renderTree);
$('inspector-selector').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    if (!runtime) throw new Error('Open a page first.');
    await runtime.selectSelector($('inspector-query').value);
  } catch (error) { $('inspector-summary').textContent = error.message; }
});
$('inspector-style-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    if (!selectedElement || !runtime) throw new Error('Select an element first.');
    const target = runtime;
    const selected = selectedElement;
    await target.setStyle(selected, $('inspector-property').value.trim(), $('inspector-value').value.trim());
    if (runtime === target && selectedElement === selected) await describeSelection(selected);
  } catch (error) { $('inspector-summary').textContent = error.message; }
});

async function applyElementEdit(change = null) {
  if (editing) return;
  const target = runtime;
  const session = generation;
  if (!target || (change && !selectedElement)) {
    $('inspector-edit-status').textContent = 'Select an element in the viewed page first.';
    return;
  }
  editing = true;
  editControls();
  $('inspector-edit-status').textContent = change ? 'Applying edit…' : 'Undoing edit…';
  try {
    const node = change ? await target.editNode(selectedElement, change) : await target.undo();
    if (target !== runtime || session !== generation) return;
    editing = false;
    await describeSelection(node);
    $('inspector-edit-status').textContent = change?.kind === 'delete'
      ? 'Element deleted. Undo restores it.' : change ? 'Updated this page. Changes last until reload.' : 'Edit undone.';
  } catch (error) {
    if (target === runtime && session === generation) $('inspector-edit-status').textContent = error.message;
  } finally {
    if (target === runtime && session === generation) {
      editing = false;
      if (selectedElement) {
        try { editControls(await target.describe(selectedElement)); } catch { editControls(); }
      } else editControls();
    }
  }
}

$('inspector-attribute-form').addEventListener('submit', event => {
  event.preventDefault();
  return applyElementEdit({ kind: 'attribute', name: $('inspector-attribute-name').value.trim(), value: $('inspector-attribute-value').value });
});
$('inspector-attribute-remove').addEventListener('click', () => applyElementEdit({ kind: 'removeAttribute', name: $('inspector-attribute-name').value.trim() }));
$('inspector-text-form').addEventListener('submit', event => {
  event.preventDefault();
  return applyElementEdit({ kind: 'text', value: $('inspector-text').value });
});
$('inspector-delete').addEventListener('click', () => applyElementEdit({ kind: 'delete' }));
$('inspector-undo').addEventListener('click', () => applyElementEdit());
$('userscript-new').addEventListener('click', () => {
  if (!dirty || confirm('Discard unsaved changes to this script?')) { editScript(); $('userscript-name').focus(); }
});
$('userscript-save').addEventListener('click', saveScript);
$('userscript-run').addEventListener('click', () => void runScript(draft()));
$('userscript-delete').addEventListener('click', () => {
  if (!selectedScriptId || !confirm('Delete this saved userscript from this browser?')) return;
  try { store.remove(selectedScriptId); editScript(); scriptStatus('Script deleted. Reload the page to clear any changes it made.'); }
  catch (error) { scriptStatus(error.message, true); }
});
for (const id of ['userscript-name', 'userscript-match', 'userscript-code', 'userscript-enabled']) {
  $(id).addEventListener('input', () => { dirty = true; scriptStatus('Unsaved changes'); });
}
$('userscript-code').addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveScript(); }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void runScript(draft()); }
  if (event.key === 'Tab') {
    event.preventDefault();
    const input = event.target;
    input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
window.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'j' && $('zone-viewer').classList.contains('active')) {
    event.preventDefault(); showPanel(); selectTab('console'); $('console-input').focus();
  }
  if (event.key === 'Escape') stopPicking();
});
$('browser-address').addEventListener('submit', event => {
  event.preventDefault();
  window.handleHeroSearch($('browser-url').value);
});
$('browser-reload').addEventListener('click', async () => {
  if (!currentUrl) return;
  try {
    const expectedSandbox = window.MonkehPrivacy?.sandbox?.(true);
    const changedPermissions = runtime?.isRemote && typeof expectedSandbox === 'string' && frame.getAttribute('sandbox') !== expectedSandbox;
    const expectedIdentity = window.MonkehPrivacy?.get?.()?.userAgent || '';
    const changedIdentity = runtime?.isRemote && (new URL(frame.src || 'about:blank', location.href).searchParams.get('ua') || '') !== expectedIdentity;
    if (changedPermissions || changedIdentity) await window.retryViewerNavigation?.();
    else if (runtime) await runtime.reload();
                                                                             
                                                                               
    else await window.retryViewerNavigation?.();
  } catch (error) { addEntry('warn', [error.message]); }
});
$('browser-switch-server').addEventListener('click', async () => {
  const target = runtime;
  if (!target?.isRemote || typeof target.switchServer !== 'function') {
    addEntry('warn', ['Open a proxied page before switching servers.']);
    return;
  }
  const button = $('browser-switch-server');
  if (button.disabled) return;
  serverSwitchPending = true;
  button.disabled = true;
  try {
    const switched = await target.switchServer();
    if (runtime === target) addEntry(switched ? 'info' : 'warn', [switched
      ? 'Proxy server switched. The current page was kept open; form submissions were not repeated.'
      : 'No alternative server connected. See the page notice for details.']);
  } catch (error) { if (runtime === target) addEntry('warn', [error.message]); }
  finally { serverSwitchPending = false; updateServerSwitchButton(); }
});

const resize = $('tools-resize');
function setWidth(width) {
  const viewport = typeof innerWidth === 'number' ? innerWidth : 1280;
  const max = Math.max(140, Math.min(900, viewport * 0.7));
  const min = Math.min(280, max);
  const value = Math.round(Math.max(min, Math.min(max, width)));
  panel.style.setProperty('--tools-width', `${value}px`);
  resize.setAttribute('aria-orientation', 'vertical');
  resize.setAttribute('aria-valuenow', String(value));
  resize.setAttribute('aria-valuemin', String(min));
  resize.setAttribute('aria-valuemax', String(max));
}
resize.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  event.preventDefault();
  const width = panel.getBoundingClientRect().width || 420;
  const start = event.clientX;
  resize.setPointerCapture(event.pointerId);
  frame.style.pointerEvents = 'none';
  const move = update => setWidth(width + start - update.clientX);
  const finish = () => {
    resize.removeEventListener('pointermove', move);
    resize.removeEventListener('pointerup', finish);
    resize.removeEventListener('pointercancel', finish);
    resize.removeEventListener('lostpointercapture', finish);
    frame.style.pointerEvents = '';
  };
  resize.addEventListener('pointermove', move);
  resize.addEventListener('pointerup', finish, { once: true });
  resize.addEventListener('pointercancel', finish, { once: true });
  resize.addEventListener('lostpointercapture', finish, { once: true });
});
resize.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  setWidth((panel.getBoundingClientRect().width || 420) + (event.key === 'ArrowLeft' ? 24 : -24));
});
window.addEventListener('resize', () => { if (!panel.hidden) setWidth(panel.getBoundingClientRect().width || 420); });
frame.addEventListener('load', () => connectFrame());
window.addEventListener('message', event => {
  if (!expectingDocument || event.source !== frame.contentWindow || event.origin !== window.MonkehProxyOrigin || event.data?.type !== 'monkeh-proxy:ready') return;
  if (runtime?.hasHandshake || readyRetries++ >= 3) return;
  void connectFrame(true);
});
window.MonkehTools = {
  clearConsole,
  async navigateRemote(url) {
    const target = runtime;
    let destination;
    try {
      destination = new URL(url);
      const source = new URL(frame.src, location.href);
      if (!expectingDocument || !target?.hasHandshake || typeof target.navigate !== 'function' ||
          source.origin !== window.MonkehProxyOrigin || source.pathname !== '/proxy-host.html' || source.origin === location.origin ||
          !['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password ||
          destination.href.length > 4096 || [location.origin, source.origin].includes(destination.origin)) return false;
    } catch { return false; }
    const token = ++remoteNavigation;
    generation++;
    stopPicking();
    selectedElement = null;
    editing = false;
    expectedUrl = currentUrl = destination.href;
    $('browser-url').value = currentUrl;
    $('inspector-tree').replaceChildren(element('div', 'bt-empty-state', 'Loading page elements…'));
    $('inspector-summary').textContent = 'Select an element';
    $('inspector-attributes').replaceChildren();
    $('inspector-styles').replaceChildren();
    $('inspector-text').value = '';
    $('inspector-edit-status').textContent = '';
    if (!$('console-preserve').checked) resetConsoleEntries();
    setConnection('Loading isolated page');
    try {
      const accepted = await target.navigate(destination.href);
      return accepted === true && target === runtime && token === remoteNavigation;
    } catch (error) {
      if (target === runtime && token === remoteNavigation) addEntry('warn', ['Reopening the browser connection.', error.message]);
      return false;
    }
  },
  prepareNavigation(url) {
    disconnect();
    expectingDocument = false;
    expectedUrl = url;
    readyRetries = 0;
    currentUrl = publicUrl(url);
    $('browser-url').value = currentUrl;
    $('browser-url').focus();
    if (!$('console-preserve').checked) resetConsoleEntries();
    setConnection('Loading page');
  },
  expectDocument(url) { expectedUrl = url; expectingDocument = true; },
  async reconnect() {
    if (!runtime) {
      await connectFrame(true);
      if (!runtime) { addEntry('warn', ['Open a proxied page before reconnecting.']); return false; }
    }
    try { await runtime.reconnect(); return true; }
    catch (error) { addEntry('warn', [error.message]); return false; }
  },
  closeViewer() {
    expectingDocument = false; disconnect(); showPanel(false);
    let clearOnClose = true;
    try { clearOnClose = window.MonkehPrivacy?.get?.().clearConsoleOnClose !== false; } catch {                                 }
    if (clearOnClose) clearConsole();
    $('hero-search').focus();
  },
};

selectTab('console');
renderConsole();
editScript(store.list()[0]);
if (store.warning) scriptStatus(store.warning, true);
setConnection('Open a page');
setWidth(420);
