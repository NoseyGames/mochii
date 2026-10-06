const lookalikes = Object.freeze({ a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у', s: 'ѕ', i: 'і', j: 'ј', h: 'һ', A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х' });
const marker = 'data-display-mask';
const excluded = 'script, style, noscript, template, textarea, input, select, option, code, pre, kbd, samp, svg, math, canvas, iframe, [contenteditable], [data-display-plain], .material-icons, .material-symbols-outlined, .monaco-editor, .CodeMirror, .cm-editor, .editor-container, #sidebar-files-list, #tabs-list, #music-name, #browser-tools';
const address = /(?:[a-z][a-z\d+.-]*:\/\/|\bwww\.|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:^|\s)(?:\/[\w./%-]+|[\w-]+\.(?:com|net|org|dev|io|html?|js|json|css|txt|mjs|wasm|zip))\b)/i;

export function maskCharacters(value) {
  return typeof value === 'string' ? [...value].map(character => lookalikes[character] || character).join('') : '';
}

export function readDisplayText(node) {
  if (node.nodeType === 3) return node.data;
  if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return '';
  if (node.hasAttribute?.(marker)) return node.lastChild?.textContent || '';
  return [...node.childNodes].map(readDisplayText).join('');
}

export function createDisplayMasker(doc) {
  const records = new Map();
  const dirty = new Set();
  const removed = new Set();
  const Observer = doc.defaultView?.MutationObserver;
  let enabled = false;
  let scheduled = false;
  let disposed = false;
  const body = doc.body;
  const own = node => (node.nodeType === 1 ? node : node.parentElement)?.closest?.('[' + marker + ']');
  const blocked = node => (node.nodeType === 1 ? node : node.parentElement)?.closest?.(excluded);
  const observe = () => { if (enabled && !disposed && body) observer?.observe(body, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['contenteditable', 'data-display-plain', 'class'] }); };
  function restore(wrapper, record) {
    if (wrapper.parentNode) wrapper.replaceWith(record.original);
    records.delete(wrapper);
  }
  function visit(root) {
    if (!root?.isConnected || blocked(root)) return;
    const wrapper = own(root);
    if (wrapper) {
      const record = records.get(wrapper);
      if (record) record.visual.textContent = maskCharacters(record.original.data);
      return;
    }
    if (root.nodeType === 3) {
      const value = root.data;
      if (!value.trim() || address.test(value)) return;
      const masked = maskCharacters(value);
      if (masked === value) return;
      const container = doc.createElement('span');
      container.setAttribute(marker, '');
      const visual = doc.createElement('span'); visual.setAttribute('aria-hidden', 'true'); visual.textContent = masked;
      const accessible = doc.createElement('span'); accessible.className = 'display-original';
      root.replaceWith(container);
      accessible.append(root); container.append(visual, accessible);
      records.set(container, { original: root, visual });
      return;
    }
    for (const node of [...root.childNodes]) visit(node);
  }
  function collect(root, callback) {
    if (root.nodeType !== 1) return;
    if (root.hasAttribute(marker)) callback(root);
    else for (const wrapper of root.querySelectorAll('[' + marker + ']')) callback(wrapper);
  }
  function refresh(root = body) {
    if (!enabled || disposed || !root) return;
    observer?.disconnect();
    try {
      collect(root, wrapper => { const record = records.get(wrapper); if (record && (!wrapper.isConnected || blocked(wrapper))) restore(wrapper, record); });
      visit(root);
    } finally { observe(); }
  }
  function flush() {
    scheduled = false;
    if (!enabled || disposed) { dirty.clear(); removed.clear(); return; }
    observer?.disconnect();
    try {
      for (const node of removed) collect(node, wrapper => { const record = records.get(wrapper); if (record && !wrapper.isConnected) restore(wrapper, record); });
      for (const root of dirty) {
        let parent = root.parentNode;
        while (parent && !dirty.has(parent)) parent = parent.parentNode;
        if (parent) continue;
        collect(root, wrapper => { const record = records.get(wrapper); if (record && blocked(wrapper)) restore(wrapper, record); });
        visit(root);
      }
    } finally { dirty.clear(); removed.clear(); observe(); }
  }
  const observer = Observer ? new Observer(changes => {
    for (const change of changes) {
      if (change.type === 'childList') {
        for (const node of change.addedNodes) dirty.add(node);
        for (const node of change.removedNodes) removed.add(node);
      } else dirty.add(change.target);
    }
    if (!scheduled) { scheduled = true; queueMicrotask(flush); }
  }) : null;
  function setEnabled(value) {
    if (disposed || enabled === Boolean(value)) return;
    enabled = Boolean(value);
    observer?.disconnect();
    if (enabled) {
      if (!doc.getElementById('display-text-style')) {
        const style = doc.createElement('style'); style.id = 'display-text-style';
        style.textContent = '[data-display-mask]{display:contents}[data-display-mask]>.display-original{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip-path:inset(50%)!important;white-space:nowrap!important;border:0!important;user-select:none!important}';
        doc.head.append(style);
      }
      refresh();
    } else {
      for (const [wrapper, record] of records) restore(wrapper, record);
      dirty.clear(); removed.clear();
    }
  }
  return { setEnabled, refresh, dispose() { setEnabled(false); disposed = true; observer?.disconnect(); } };
}
