                                                                                 
const MAX_TEXT = 5000;
const MAX_CHILDREN = 250;
const COMPUTED_PROPERTIES = [
  'display', 'position', 'width', 'height', 'color', 'background-color',
  'font-family', 'font-size', 'font-weight', 'line-height', 'margin', 'padding',
  'border', 'border-radius', 'box-sizing', 'overflow', 'opacity', 'z-index',
  'flex-direction', 'align-items', 'justify-content', 'gap', 'grid-template-columns',
];

function truncate(value, limit = MAX_TEXT) {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

                                                                                  
export function formatValue(value) {
  const seen = new WeakSet();
  let budget = MAX_TEXT;
  function write(text) {
    const result = truncate(text, Math.max(1, budget));
    budget -= result.length;
    return result;
  }
  function format(item, depth, nested = false) {
    if (budget <= 0) return '…';
    if (item === null) return write('null');
    switch (typeof item) {
      case 'string': return write(nested ? JSON.stringify(truncate(item)) : item);
      case 'undefined': return write('undefined');
      case 'bigint': return write(`${item}n`);
      case 'symbol': return write(String(item));
      case 'number': return write(Object.is(item, -0) ? '-0' : String(item));
      case 'boolean': return write(String(item));
      case 'function': {
        let name = '';
        try { name = Object.getOwnPropertyDescriptor(item, 'name')?.value || ''; } catch {                      }
        return write(`[Function${typeof name === 'string' && name ? `: ${name}` : ''}]`);
      }
    }
    if (seen.has(item)) return write('[Circular]');
    seen.add(item);
    try {
      const array = Array.isArray(item);
      const descriptors = Object.getOwnPropertyDescriptors(item);
      let label = '';
      if (!array) {
        const prototype = Object.getPrototypeOf(item);
        const constructor = prototype && Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
        const name = constructor && Object.getOwnPropertyDescriptor(constructor, 'name')?.value;
        if (typeof name === 'string' && name !== 'Object') label = `${name} `;
      }
      if (depth >= 3) return write(array ? '[…]' : `${label}{…}`);
                                                                                               
      if (/Error $/.test(label) && typeof descriptors.message?.value === 'string') {
        return write(`${label.trim()}: ${descriptors.message.value}`);
      }
      const entries = Object.entries(descriptors).filter(([key, descriptor]) =>
        key !== 'length' && (descriptor.enumerable || array));
      const values = [];
      for (const [key, descriptor] of entries.slice(0, 40)) {
        if (budget <= 0) { values.push('…'); break; }
        const prefix = array && /^\d+$/.test(key) ? '' : `${truncate(key, 100)}: `;
        values.push(`${write(prefix)}${'value' in descriptor ? format(descriptor.value, depth + 1, true) : write('[Getter]')}`);
      }
      if (entries.length > 40) values.push(`… ${entries.length - 40} more`);
      return `${array ? '[' : `${label}{`}${values.join(', ')}${array ? ']' : '}'}`;
    } catch {
      return write('[Uninspectable object]');
    }
  }
  try { return truncate(format(value, 0)); } catch { return '[Uninspectable value]'; }
}

export function attachRuntime(targetWindow, { onConsole = () => {}, onSelect = () => {}, onNavigate = () => {}, onPickEnd = () => {} } = {}) {
  let document;
  try {
    document = targetWindow.document;
    if (!document?.documentElement) throw new Error('Document is not ready.');
  } catch {
    throw new Error('This page is not accessible yet. Reload it through the Monkeh browser and try again.');
  }
  let disposed = false;
  let navigationReported = false;
  let selected = null;
  let picking = false;
  let overlay = null;
  let reporting = false;
  const consoleRestores = [];
  const selectedGetter = () => selected;
  let selectedDescriptor;
  let installedSelected = false;
  const edits = [];
  let retainedNodes = 0;

  function emit(level, args) {
    if (disposed || reporting) return;
    reporting = true;
    try { onConsole({ level, args, time: Date.now() }); } catch {                                          }
    finally { reporting = false; }
  }

  function reportNavigation() {
    if (navigationReported || disposed) return;
    navigationReported = true;
    dispose();
    try { onNavigate(); } catch {                                 }
  }

  function ensureDocument() {
    if (disposed) throw new Error('This page has changed. Wait for it to finish loading and try again.');
    let current;
    try { current = targetWindow.document; } catch {                                }
    if (current !== document) {
      reportNavigation();
      throw new Error('This page has changed. Wait for it to finish loading and try again.');
    }
  }

  function ensureElement(element) {
    ensureDocument();
    if (!element || element.nodeType !== 1 || element.ownerDocument !== document || element === overlay) {
      throw new Error('Select an element in the current page first.');
    }
  }

  try {
    selectedDescriptor = Object.getOwnPropertyDescriptor(targetWindow, '$0');
    if (!selectedDescriptor || selectedDescriptor.configurable) {
      Object.defineProperty(targetWindow, '$0', { configurable: true, enumerable: false, get: selectedGetter });
      installedSelected = true;
    }
  } catch {                                                        }

  const pageConsole = targetWindow.console;
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'clear', 'assert', 'table']) {
    try {
      const original = pageConsole?.[level];
      if (typeof original !== 'function') continue;
      const originalDescriptor = Object.getOwnPropertyDescriptor(pageConsole, level);
      const wrapped = function (...args) {
        if (level === 'assert') {
          if (!args[0]) emit('error', ['Assertion failed:', ...args.slice(1)]);
        } else emit(level, args);
        return Reflect.apply(original, pageConsole, args);
      };
      Object.defineProperty(pageConsole, level, originalDescriptor
        ? { ...originalDescriptor, value: wrapped }
        : { configurable: true, writable: true, enumerable: true, value: wrapped });
      consoleRestores.push(() => {
        if (pageConsole[level] !== wrapped) return;
        if (originalDescriptor) Object.defineProperty(pageConsole, level, originalDescriptor);
        else delete pageConsole[level];
      });
    } catch {                                                                   }
  }

  function onError(event) {
    emit('error', [event.error || `${event.message || 'Page error'}${event.filename ? ` (${event.filename}:${event.lineno || 0})` : ''}`]);
  }
  function onRejection(event) { emit('error', ['Uncaught (in promise)', event.reason]); }
  targetWindow.addEventListener('error', onError);
  targetWindow.addEventListener('unhandledrejection', onRejection);
  targetWindow.addEventListener('pagehide', reportNavigation);

  function escapeSelector(value) {
    return targetWindow.CSS?.escape ? targetWindow.CSS.escape(value)
      : String(value).replace(/[^a-zA-Z0-9_-]|^\d/g, character => `\\${character.codePointAt(0).toString(16)} `);
  }

  function selectorFor(element) {
    const parts = [];
    let current = element;
    for (let depth = 0; current && depth < 4; depth++, current = current.parentElement) {
      const tag = current.localName || current.tagName.toLowerCase();
      if (current.id) { parts.unshift(`#${escapeSelector(current.id)}`); break; }
      let part = tag;
      const siblings = current.parentElement ? Array.from(current.parentElement.children).filter(sibling => sibling.localName === current.localName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  function highlight(element) {
    if (!overlay || !element || element === overlay || element.nodeType !== 1) return;
    const rect = element.getBoundingClientRect();
    for (const [property, value] of Object.entries({
      display: 'block', left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${Math.max(0, rect.width)}px`, height: `${Math.max(0, rect.height)}px`,
    })) overlay.style.setProperty(property, value, 'important');
  }

  function hoveredElement(event) {
    const found = document.elementFromPoint?.(event.clientX, event.clientY) || event.target;
    return found?.nodeType === 1 && found !== overlay ? found : null;
  }

  function pointerMove(event) {
    if (!picking) return;
    try { ensureDocument(); highlight(hoveredElement(event)); } catch { stopPicking(); }
  }
  function pickClick(event) {
    if (!picking) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const element = hoveredElement(event);
    stopPicking();
    if (element) select(element);
  }
  function pickKey(event) {
    if (event.key !== 'Escape' || !picking) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stopPicking();
  }

  function startPicking() {
    ensureDocument();
    if (picking) return;
    overlay = document.createElement('div');
    overlay.setAttribute('data-monkeh-inspector', '');
    overlay.setAttribute('aria-hidden', 'true');
    for (const [property, value] of Object.entries({
      all: 'initial', position: 'fixed', display: 'none', 'pointer-events': 'none',
      'z-index': '2147483647', border: '2px solid #8b7aff', 'background-color': 'rgba(139, 122, 255, 0.14)',
      'box-sizing': 'border-box', margin: '0', padding: '0', transition: 'none',
    })) overlay.style.setProperty(property, value, 'important');
    document.documentElement.appendChild(overlay);
    picking = true;
    document.addEventListener('pointermove', pointerMove, true);
    document.addEventListener('click', pickClick, true);
    document.addEventListener('keydown', pickKey, true);
  }

  function stopPicking() {
    const wasPicking = picking;
    picking = false;
    document.removeEventListener('pointermove', pointerMove, true);
    document.removeEventListener('click', pickClick, true);
    document.removeEventListener('keydown', pickKey, true);
    overlay?.remove();
    overlay = null;
    if (wasPicking) {
      try { onPickEnd(); } catch {                                                            }
    }
  }

  function select(element) {
    ensureElement(element);
    selected = element;
    try { onSelect(element); } catch {                                                   }
    return element;
  }

  function getChildren(element = document.documentElement) {
    ensureElement(element);
    return Array.from(element.children).filter(child => child !== overlay).slice(0, MAX_CHILDREN);
  }

  function describe(element) {
    ensureElement(element);
    const computed = targetWindow.getComputedStyle(element);
    const inlineProperties = Array.from(element.style).slice(0, 80);
    const names = [...new Set([...inlineProperties, ...COMPUTED_PROPERTIES])];
    const rect = element.getBoundingClientRect();
    return {
      tag: element.localName || element.tagName.toLowerCase(),
      selector: truncate(selectorFor(element)),
      attributes: Array.from(element.attributes).slice(0, 100).map(attribute => ({ name: attribute.name, value: truncate(attribute.value) })),
      styles: names.map(name => ({ name, value: truncate(computed.getPropertyValue(name)) })),
      rect: { width: rect.width, height: rect.height },
      text: truncate(element.textContent || ''),
      textTruncated: (element.textContent || '').length > MAX_TEXT,
      html: truncate(element.outerHTML || ''),
      canDelete: element !== document.documentElement && Boolean(element.parentNode || element.parentElement),
      canUndo: edits.length > 0,
    };
  }

  function remember(restore, node, weight = 1) {
    edits.push({ restore, node, weight });
    retainedNodes += weight;
    while (edits.length > 20 || retainedNodes > 2000) retainedNodes -= edits.shift().weight;
  }

  function editWeight(element) {
    const queue = [element];
    for (let index = 0; index < queue.length; index++) {
      for (const child of Array.from(queue[index].childNodes || queue[index].children || [])) {
        if (queue.length >= 1000) throw new Error('This element is too large to edit here. Use the console.');
        queue.push(child);
      }
    }
    return queue.length;
  }

  function editNode(element, { kind, name, value } = {}) {
    ensureElement(element);
    if (element.isConnected === false) throw new Error('This element is no longer in the page. Refresh the inspector.');
    if (kind === 'attribute' || kind === 'removeAttribute') {
      if (typeof name !== 'string' || name.length > 128 || !/^[A-Za-z_:][A-Za-z0-9_:.-]*$/.test(name)) throw new Error('Enter a valid attribute name.');
      if (kind === 'attribute' && (typeof value !== 'string' || value.length > 10000)) throw new Error('Attribute values must be at most 10,000 characters.');
      const previous = element.getAttribute(name);
      if (previous !== null && previous.length > 10000) throw new Error('This attribute is too large to edit here. Use the console.');
      if (kind === 'removeAttribute') element.removeAttribute(name);
      else element.setAttribute(name, value);
      remember(() => previous === null ? element.removeAttribute(name) : element.setAttribute(name, previous), element);
    } else if (kind === 'text') {
      if (element === document.documentElement) throw new Error('Select an element inside the document to replace its text.');
      if (typeof value !== 'string' || value.length > 10000) throw new Error('Text must be at most 10,000 characters.');
      const weight = editWeight(element);
      const previous = Array.from(element.childNodes);
      element.textContent = value;
      remember(() => element.replaceChildren(...previous), element, weight);
    } else if (kind === 'delete') {
      const parent = element.parentNode || element.parentElement;
      if (element === document.documentElement || !parent) throw new Error('The document root cannot be deleted.');
      const weight = editWeight(element);
      const next = element.nextSibling;
      element.remove();
      remember(() => parent.insertBefore(element, next?.parentNode === parent ? next : null), element, weight);
      selected = parent;
      return parent;
    } else throw new Error('Unsupported element edit.');
    return element;
  }

  function undo() {
    ensureDocument();
    const edit = edits.pop();
    if (!edit) throw new Error('There are no inspector edits to undo.');
    retainedNodes -= edit.weight;
    edit.restore();
    selected = edit.node;
    return edit.node;
  }

  function setStyle(element, property, value) {
    ensureElement(element);
    const name = String(property).trim();
    const rawValue = String(value).trim();
    if (!/^(?:--[\w-]+|-?[a-zA-Z][a-zA-Z0-9-]*)$/.test(name)) throw new Error('Enter a valid CSS property, such as color or font-size.');
    const previous = element.style.getPropertyValue(name);
    const previousPriority = element.style.getPropertyPriority(name);
    const saveUndo = () => remember(() => previous ? element.style.setProperty(name, previous, previousPriority) : element.style.removeProperty(name), element);
    if (!rawValue) { element.style.removeProperty(name); saveUndo(); return; }
    const important = /\s*!important\s*$/i.test(rawValue);
    const cssValue = important ? rawValue.replace(/\s*!important\s*$/i, '').trim() : rawValue;
    if (targetWindow.CSS?.supports && !targetWindow.CSS.supports(name, cssValue)) {
      throw new Error(`The browser does not support ${name}: ${cssValue}.`);
    }
    element.style.setProperty(name, cssValue, important ? 'important' : '');
    saveUndo();
  }

  async function evaluate(source) {
    ensureDocument();
    if (typeof source !== 'string') throw new TypeError('Console code must be text.');
    return await Reflect.apply(targetWindow.eval, targetWindow, [source]);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stopPicking();
                                                                                 
                                                                                 
    for (const [type, listener] of [['error', onError], ['unhandledrejection', onRejection], ['pagehide', reportNavigation]]) {
      try { targetWindow.removeEventListener(type, listener); } catch {                                       }
    }
    for (const restore of consoleRestores) { try { restore(); } catch {                                                           } }
    if (installedSelected) {
      try {
        if (Object.getOwnPropertyDescriptor(targetWindow, '$0')?.get === selectedGetter) {
          if (selectedDescriptor) Object.defineProperty(targetWindow, '$0', selectedDescriptor);
          else delete targetWindow.$0;
        }
      } catch {                                                             }
    }
    selected = null;
    edits.length = 0;
    retainedNodes = 0;
  }

  return { document, evaluate, startPicking, stopPicking, select, getChildren, describe, setStyle, editNode, undo, dispose };
}
