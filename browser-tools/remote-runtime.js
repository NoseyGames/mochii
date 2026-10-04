                                                                                
                                                                                
const MAX_NODES = 800;
const text = (value, limit = 5000) => typeof value === 'string' ? value.slice(0, limit) : '';
const validId = value => Number.isSafeInteger(value) && value >= 0 || typeof value === 'string' && value.length > 0 && value.length <= 128;
const keyFor = value => `${typeof value}:${value}`;

function description(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid element description');
  const pairs = items => (Array.isArray(items) ? items.slice(0, 100) : []).filter(item => item && typeof item.name === 'string')
    .map(item => ({ name: text(item.name, 128), value: text(item.value) }));
  const dimension = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1e7, value)) : 0;
  return {
    tag: text(value.tag, 100), selector: text(value.selector),
    attributes: pairs(value.attributes), styles: pairs(value.styles),
    rect: { width: dimension(value.rect?.width), height: dimension(value.rect?.height) },
    text: text(value.text), html: text(value.html),
    textTruncated: value.textTruncated === true,
    canDelete: value.canDelete === true, canUndo: value.canUndo === true,
  };
}

function targetUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 8192) return '';
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.href;
  } catch { return ''; }
}

export function createRemoteRuntime(frame, origin, callbacks = {}, options = {}) {
  const allowed = new URL(origin);
  const source = new URL(frame.src);
  if (!['http:', 'https:'].includes(allowed.protocol) || allowed.origin !== origin || allowed.username || allowed.password ||
      source.origin !== origin || source.pathname !== '/proxy-host.html') {
    throw new Error('The browser tools target is not the configured proxy host.');
  }
  const Channel = options.MessageChannel || globalThis.MessageChannel;
  if (!Channel) throw new Error('This browser does not support isolated browser tools.');
  const channel = new Channel();
  const port = channel.port1;
  const pending = new Map();
  let nodes = new Map();
  let descriptions = new Map();
  let requestId = 0;
  let disposed = false;
  let hasHandshake = false;
  let consoleWindow = 0;
  let consoleCount = 0;
  let eventWindow = 0;
  let eventCount = 0;
  let stateEventCount = 0;
  let pageEventCount = 0;
  const document = { documentElement: null };
  const handshake = setTimeout(() => {
    callbacks.onError?.(new Error('The isolated browser did not respond. Reload the page to reconnect.'));
    dispose();
  }, options.handshakeTimeout ?? 15000);

  function rejectPending(message, keepNavigation = false) {
    for (const [id, { reject, timer, method }] of pending) {
      if (keepNavigation && method === 'navigate') continue;
      clearTimeout(timer); reject(new Error(message)); pending.delete(id);
    }
  }

  function setTree(tree) {
    if (!tree || !validId(tree.rootId) || !Array.isArray(tree.nodes)) throw new Error('Invalid page tree');
    const incoming = new Map();
    const childIds = new Map();
    for (const record of tree.nodes.slice(0, MAX_NODES)) {
      if (!record || !validId(record.id) || incoming.has(keyFor(record.id))) continue;
      const key = keyFor(record.id);
      const node = nodes.get(key) || { remoteId: record.id };
      Object.assign(node, { localName: text(record.localName, 100) || 'element',
        id: text(record.elementId, 200), className: text(record.className, 500), children: [] });
      incoming.set(key, node);
      childIds.set(key, Array.isArray(record.children) ? record.children.slice(0, 250).filter(validId) : []);
    }
    const root = incoming.get(keyFor(tree.rootId));
    if (!root) throw new Error('The page tree has no root');
                                                                                
                                               
    const visited = new Set();
    function visit(node, depth) {
      const key = keyFor(node.remoteId);
      visited.add(key);
      if (depth >= 64) return;
      for (const id of childIds.get(key) || []) {
        const child = incoming.get(keyFor(id));
        if (!child || visited.has(keyFor(id))) continue;
        node.children.push(child);
        visit(child, depth + 1);
      }
    }
    visit(root, 0);
    nodes = incoming;
    document.documentElement = root;
  }

  function getNode(id, info) {
    if (!validId(id)) throw new Error('Invalid selected element');
    const key = keyFor(id);
    if (!nodes.has(key)) {
                                                                         
      if (nodes.size >= MAX_NODES + 50) throw new Error('Refresh the inspector to select more elements.');
      nodes.set(key, { remoteId: id, localName: info?.tag || 'element', id: '', className: '', children: [] });
    }
    return nodes.get(key);
  }

  function acceptSelection(value) {
    if (!value || typeof value !== 'object') throw new Error('Invalid selected element');
    const info = description(value.info);
    if (value.tree) setTree(value.tree);
    const node = getNode(value.id, info);
    descriptions.set(keyFor(value.id), info);
    callbacks.onSelect?.(node);
    return node;
  }

  function request(method, params = {}) {
    if (disposed) return Promise.reject(new Error('The page connection is closed.'));
    if (pending.size >= 32) return Promise.reject(new Error('Too many pending tool commands. Wait for the page to respond.'));
    const id = ++requestId;
    return new Promise((resolve, reject) => {
                                                                              
                                                                                
      const timeout = options.requestTimeout ?? (method === 'switchServer' ? 30000 : 10000);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('The page did not respond to this command.')); }, timeout);
      pending.set(id, { resolve, reject, timer, method });
      try { port.postMessage({ id, method, params }); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  port.onmessage = ({ data }) => {
    if (disposed || !data || typeof data !== 'object' || Array.isArray(data)) return;
    clearTimeout(handshake);
    hasHandshake = true;
    if (Number.isSafeInteger(data.id) && pending.has(data.id)) {
      const task = pending.get(data.id);
      pending.delete(data.id);
      clearTimeout(task.timer);
      if (typeof data.error === 'string') task.reject(new Error(text(data.error)));
      else task.resolve(data.result);
      return;
    }
    if (typeof data.event !== 'string' || !data.data || typeof data.data !== 'object') return;
    const receivedAt = Date.now();
    if (receivedAt - eventWindow >= 1000) {
      eventWindow = receivedAt;
      eventCount = 0;
      stateEventCount = 0;
      pageEventCount = 0;
    }
    if (++eventCount > 120) return;
    if (data.event !== 'console' && ++stateEventCount > 30) return;
    if (data.event === 'page' && ++pageEventCount > 4) return;
    const event = data.data;
    try {
      switch (data.event) {
        case 'page': {
          const url = targetUrl(event.url);
          if (!url) return;
          rejectPending('The page changed while the command was running.', true);
          descriptions = new Map();
          if (event.tree) setTree(event.tree);
          else { nodes = new Map(); document.documentElement = null; }
          callbacks.onPage?.({ url, title: text(event.title, 300), isError: event.isError === true });
          break;
        }
        case 'console': {
          const now = Date.now();
          if (now - consoleWindow >= 1000) { consoleWindow = now; consoleCount = 0; }
          const level = event.level === 'table' ? 'log' : event.level;
          if (++consoleCount > 100 || !['log', 'info', 'warn', 'error', 'debug', 'clear'].includes(level)) return;
          callbacks.onConsole?.({ level, args: Array.isArray(event.args) ? event.args.slice(0, 40).map(item => text(item)) : [],
            time: Number.isFinite(event.time) && Math.abs(event.time - now) < 86400000 * 365 ? event.time : now });
          break;
        }
        case 'select': {
          acceptSelection(event);
          break;
        }
        case 'pickEnd': callbacks.onPickEnd?.(); break;
        case 'pagehide':
          rejectPending('The page is navigating.', true);
          callbacks.onNavigate?.();
          break;
        case 'network':
          callbacks.onNetwork?.({ status: text(event.status, 40), activeEndpoint: text(event.activeEndpoint, 8192),
            configuredCount: Number.isSafeInteger(event.configuredCount) ? Math.max(0, Math.min(32, event.configuredCount)) : 0,
            error: text(event.error, 1000) });
          break;
                                                                            
                                                                                 
      }
    } catch (error) { callbacks.onError?.(new Error(text(error.message))); }
  };
  port.onmessageerror = () => callbacks.onError?.(new Error('An invalid browser tools message was ignored.'));
  port.start?.();

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(handshake);
    rejectPending('The page connection is closed.');
    port.onmessage = null;
    port.onmessageerror = null;
    port.close();
    channel.port2.close?.();
  }

  try { frame.contentWindow.postMessage({ type: 'monkeh-proxy:init' }, origin, [channel.port2]); }
  catch (error) { dispose(); throw error; }

  return {
    isRemote: true, document, dispose,
    get hasHandshake() { return hasHandshake; },
    async evaluate(code) {
      if (typeof code !== 'string' || code.length > 110000) throw new Error('Commands must be at most 110,000 characters.');
      return text(await request('evaluate', { code }), 12000);
    },
    async refreshTree(selected = null) {
      setTree(await request('tree', selected ? { id: selected.remoteId } : {}));
      descriptions = new Map();
    },
    getChildren(node = document.documentElement) { return node?.children || []; },
    async describe(node) {
      const key = keyFor(node.remoteId);
      if (!descriptions.has(key)) descriptions.set(key, description(await request('describe', { id: node.remoteId })));
      return descriptions.get(key);
    },
    async select(node) { await request('select', { id: node.remoteId }); },
    async selectSelector(selector) {
      if (typeof selector !== 'string' || selector.length > 1000) throw new Error('Use a CSS selector of at most 1,000 characters.');
      await request('select', { selector });
    },
    async setStyle(node, property, value) {
      if (typeof property !== 'string' || property.length > 128 || typeof value !== 'string' || value.length > 5000) throw new Error('This style value is too long.');
      const info = description(await request('style', { id: node.remoteId, property, value }));
      descriptions.set(keyFor(node.remoteId), info);
      return info;
    },
    async editNode(node, { kind, name, value } = {}) {
      if (!['text', 'attribute', 'removeAttribute', 'delete'].includes(kind)) throw new Error('Unsupported element edit.');
      if (name !== undefined && (typeof name !== 'string' || name.length > 128)) throw new Error('Attribute names must be at most 128 characters.');
      if (value !== undefined && (typeof value !== 'string' || value.length > 10000)) throw new Error('Edit values must be at most 10,000 characters.');
      return acceptSelection(await request('edit', { id: node.remoteId, kind, name, value }));
    },
    async undo() { return acceptSelection(await request('undo')); },
    async navigate(url) {
      const destination = targetUrl(url);
      if (!destination || destination.length > 4096) throw new Error('Use an HTTP(S) address of at most 4,096 characters without embedded login details.');
      return await request('navigate', { url: destination }) === true;
    },
    startPicking: () => request('pick', { active: true }),
    stopPicking: () => request('pick', { active: false }),
    reload: () => request('reload'),
    reconnect: () => request('reconnect'),
    switchServer: async () => await request('switchServer') === true,
  };
}
