// A WebSocket upgrade alone does not prove that an endpoint speaks Wisp.
// Wire format: https://github.com/MercuryWorkshop/wisp-protocol/blob/v2/protocol.md

function endpointUrl(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new TypeError('Proxy endpoints must be absolute WebSocket URLs.');
  }
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new TypeError('Proxy endpoints must use ws/wss without credentials or fragments.');
  }
  return url.href;
}

function positiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive number.`);
  return value;
}

function aborted() {
  const error = new Error('Proxy connection was cancelled.');
  error.name = 'AbortError';
  return error;
}

function validateInfo(bytes) {
  if (bytes.byteLength < 7 || bytes[5] !== 2) throw new Error('Unsupported Wisp greeting.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const extensions = new Set();
  let offset = 7;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 5) throw new Error('Truncated Wisp extension.');
    const id = bytes[offset];
    const length = view.getUint32(offset + 1, true);
    offset += 5;
    if (length > bytes.byteLength - offset || extensions.has(id)) throw new Error('Invalid Wisp extension.');
    extensions.add(id);
    if ((id === 1 || id === 5) && length !== 0) throw new Error('Invalid Wisp extension.');
    if (id === 2 || id === 3) {
      if (length < 1 || bytes[offset] > 1 || (id === 2 && length !== 1)) throw new Error('Invalid Wisp authentication.');
      if (bytes[offset]) throw new Error('This proxy requires unsupported Wisp authentication.');
    }
    offset += length;
  }
}

/** Probe the actual Wisp handshake, without opening any destination stream. */
export function probeWisp(url, {
  WebSocketCtor = globalThis.WebSocket,
  timeoutMs = 5000,
  signal,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  return new Promise((resolve, reject) => {
    const endpoint = endpointUrl(url);
    positiveNumber(timeoutMs, 'timeoutMs');
    if (signal?.aborted) { reject(aborted()); return; }
    if (typeof WebSocketCtor !== 'function') { reject(new Error('WebSocket is unavailable in this browser.')); return; }
    let socket;
    let timer;
    let settled = false;
    let receivedInfo = false;

    function finish(error, greeting) {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimer(timer);
      signal?.removeEventListener('abort', onAbort);
      if (socket) {
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
        try { socket.close(); } catch { /* The failed socket may already be closed. */ }
      }
      if (error) reject(error);
      else resolve(greeting);
    }
    function onAbort() { finish(aborted()); }
    function onError() { finish(new Error('Proxy WebSocket connection failed.')); }
    function onClose() { finish(new Error('Proxy closed before completing the Wisp handshake.')); }
    function onMessage(event) {
      try {
        const data = event.data;
        const bytes = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
        if (!bytes || bytes.byteLength < 5 || bytes.byteLength > 65536) throw new Error('Invalid Wisp greeting.');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint32(1, true) !== 0) throw new Error('Invalid Wisp handshake stream.');
        if (bytes[0] === 3) {
          if (bytes.byteLength !== 9 || view.getUint32(5, true) === 0) throw new Error('Invalid Wisp flow-control greeting.');
          finish(null, { endpoint, version: receivedInfo ? 2 : 1, bufferSize: view.getUint32(5, true) });
        } else if (bytes[0] === 5 && !receivedInfo) {
          validateInfo(bytes);
          receivedInfo = true;
          // Some servers send INFO even without subprotocol negotiation. Complete
          // their handshake and wait for CONTINUE; INFO alone is not readiness.
          socket.send(new Uint8Array([5, 0, 0, 0, 0, 2, Math.min(bytes[6], 1)]));
        } else {
          throw new Error('Proxy rejected or sent an unexpected Wisp handshake.');
        }
      } catch (error) { finish(error); }
    }
    try {
      // Omitting a subprotocol requests v1, supported by both v1 and v2 servers.
      socket = new WebSocketCtor(endpoint);
      socket.binaryType = 'arraybuffer';
      socket.addEventListener('message', onMessage);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimer(() => finish(new Error('Proxy Wisp handshake timed out.')), timeoutMs);
      if (signal?.aborted) onAbort();
    } catch (error) { finish(error); }
  });
}

/**
 * Races valid Wisp handshakes while serializing transport replacement and health
 * checks for up to 32 endpoints. Optional fallback endpoints are tried only
 * after the ordinary endpoint race is exhausted. It never reloads a page.
 *
 * connect({ force: true }) probes and replaces the active transport, and bypasses
 * cooldown for an explicit Retry action.
 * reportFailure() checks the proxy itself: a broken destination page is not
 * sufficient reason to replace a healthy proxy.
 * switchEndpoint({ failedEndpoint }) explicitly selects a different endpoint
 * without marking a destination TLS failure as a global proxy outage. It only
 * changes the transport; the caller decides whether a safe request may retry.
 */
export function createProxyNetwork({
  endpoints,
  fallbackEndpoints = [],
  probe = probeWisp,
  activate,
  onStatus = () => {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  monitorIntervalMs = 30000,
  failureThreshold = 2,
  cooldownMs = 5000,
  maxCooldownMs = 120000,
  retryMs = 10000,
  maxRetryMs = 60000,
  probeTimeoutMs = 5000,
  online: initiallyOnline = true,
} = {}) {
  if (!Array.isArray(endpoints) || !endpoints.length || endpoints.length > 32) {
    throw new TypeError('Configure between one and 32 proxy endpoints.');
  }
  const urls = [...new Set(endpoints.map(endpointUrl))];
  if (!Array.isArray(fallbackEndpoints) || fallbackEndpoints.length > 32) throw new TypeError('Fallback endpoints must be a subset of configured proxies.');
  const fallbackUrls = new Set(fallbackEndpoints.map(endpointUrl));
  if ([...fallbackUrls].some(url => !urls.includes(url))) throw new TypeError('Fallback endpoints must be a subset of configured proxies.');
  if (typeof activate !== 'function' || typeof probe !== 'function') throw new TypeError('Proxy activation and probe callbacks are required.');
  for (const [name, value] of Object.entries({ monitorIntervalMs, failureThreshold, cooldownMs, maxCooldownMs, retryMs, maxRetryMs, probeTimeoutMs })) positiveNumber(value, name);
  if (!Number.isInteger(failureThreshold)) throw new TypeError('failureThreshold must be an integer.');
  const failures = new Map(urls.map(url => [url, { count: 0, until: 0 }]));
  let active = null;
  let nextIndex = 0;
  let healthFailures = 0;
  let exhaustedCount = 0;
  let disposed = false;
  let online = Boolean(initiallyOnline);
  let pending = null;
  let switching = null;
  let switchEpoch = 0;
  let lifecycleEpoch = 0;
  let controller = null;
  let timer = null;
  let snapshot = Object.freeze({ status: online ? 'idle' : 'offline', activeEndpoint: null, configuredCount: urls.length, healthFailures: 0, retryAt: null, error: null });

  function publish(status, extra = {}) {
    snapshot = Object.freeze({ status, activeEndpoint: active, configuredCount: urls.length, healthFailures, retryAt: null, error: null, ...extra });
    // Display errors must not interrupt transport recovery.
    try { onStatus(snapshot); } catch { /* The network remains operational. */ }
  }
  function clearScheduled() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function assertCurrent(signal) {
    if (disposed || !online || signal.aborted) throw aborted();
  }
  function failed(url) {
    const record = failures.get(url);
    record.count += 1;
    record.until = now() + Math.min(maxCooldownMs, cooldownMs * 2 ** Math.min(record.count - 1, 20));
  }
  function scheduleNext() {
    clearScheduled();
    if (disposed || !online || pending || switching) return;
    let delay = monitorIntervalMs;
    if (!active) {
      const earliest = Math.min(...[...failures.values()].map(record => record.until));
      delay = Math.min(maxRetryMs, Math.max(retryMs * 2 ** Math.min(Math.max(exhaustedCount - 1, 0), 20), earliest - now()));
      publish('unavailable', { error: snapshot.error || 'No proxy is currently available.', retryAt: now() + delay });
    }
    // A status subscriber can synchronously retry, go offline, or dispose.
    if (disposed || !online || pending || switching) return;
    timer = setTimer(() => {
      timer = null;
      const work = active ? reportFailure() : connect();
      work.catch(() => {});
    }, delay);
  }
  function run(work) {
    clearScheduled();
    controller = new AbortController();
    const signal = controller.signal;
    const task = Promise.resolve().then(() => {
      assertCurrent(signal);
      return work(signal);
    });
    function complete() {
      pending = null;
      controller = null;
      scheduleNext();
    }
    pending = task.then(value => { complete(); return value; }, error => { complete(); throw error; });
    return pending;
  }
  async function chooseEndpoint(signal, force = false, excluded = new Set()) {
    const startIndex = nextIndex;
    const candidates = [];
    for (let step = 0; step < urls.length; step += 1) {
      assertCurrent(signal);
      const index = (startIndex + step) % urls.length;
      const url = urls[index];
      if (excluded.has(url)) continue;
      if (!force && failures.get(url).until > now()) continue;
      candidates.push({ index, url });
    }
    // A limited relay (for example Workers TCP) must not outrun a general-purpose
    // proxy just because its handshake is faster.
    for (const group of [candidates.filter(item => !fallbackUrls.has(item.url)), candidates.filter(item => fallbackUrls.has(item.url))]) {
      const winner = await raceCandidates(group, signal);
      if (winner) return winner;
    }
    assertCurrent(signal);
    exhaustedCount += 1;
    const error = new Error(excluded.size ? 'No alternative proxy server is currently available.' : 'None of the configured proxy servers is available.');
    publish('unavailable', { error: error.message });
    throw error;
  }
  async function raceCandidates(candidates, signal) {
    if (!candidates.length) return null;
    assertCurrent(signal);
    let remaining = candidates.length;
    let finished = false;
    let wake = null;
    let attempted = 0;
    const ready = [];
    const entries = candidates.map(candidate => ({ ...candidate, controller: new AbortController() }));
    const notify = () => { const resolve = wake; wake = null; resolve?.(); };
    const cancel = () => { for (const entry of entries) entry.controller.abort(); notify(); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      publish('connecting', { attempt: 0, candidates: candidates.length });
      assertCurrent(signal);
      for (const entry of entries) {
        // Every rejection gets a handler immediately. Late results from canceled
        // probes cannot mutate cooldowns, queue a stale activation, or block a
        // replacement race even if a custom probe ignores AbortSignal.
        Promise.resolve().then(() => {
          if (finished || entry.controller.signal.aborted) throw aborted();
          return probe(entry.url, { signal: entry.controller.signal, timeoutMs: probeTimeoutMs, setTimer, clearTimer });
        }).then(() => {
          if (!finished && !entry.controller.signal.aborted) ready.push(entry);
        }, () => {
          if (!finished && !entry.controller.signal.aborted) failed(entry.url);
        }).then(() => { remaining -= 1; notify(); });
      }
      while (true) {
        assertCurrent(signal);
        if (!ready.length) {
          if (!remaining) return null;
          await new Promise(resolve => { wake = resolve; });
          continue;
        }
        const { url, index } = ready.shift();
        publish('connecting', { endpoint: url, attempt: ++attempted, candidates: candidates.length });
        assertCurrent(signal);
        try {
          // Keep the operation pending until activation settles, including on
          // cancellation: a late setTransport must never overwrite a new one.
          await activate(url, { signal });
          assertCurrent(signal);
          active = url;
          nextIndex = (index + 1) % urls.length;
          healthFailures = 0;
          exhaustedCount = 0;
          failures.set(url, { count: 0, until: 0 });
          publish('connected');
          assertCurrent(signal);
          return url;
        } catch {
          assertCurrent(signal);
          failed(url);
        }
      }
    } finally {
      finished = true;
      signal.removeEventListener('abort', cancel);
      cancel();
    }
  }
  function existingOrCancelled(options, next) {
    if (!pending) return null;
    // Let a cancelled activation settle before a fresh one starts. Multiple
    // callers following that same cancellation still coalesce through run().
    if (controller?.signal.aborted) return pending.catch(() => {}).then(() => next(options));
    return pending;
  }
  function connectCore({ force = false, excluded = new Set() } = {}) {
    if (disposed) return Promise.reject(aborted());
    if (!online) return Promise.reject(new Error('Your device is offline.'));
    // Preserve an explicit retry while a monitor is still checking the active
    // endpoint. Its first failed probe alone must not swallow the Retry action.
    if (force && active && pending && !controller?.signal.aborted) {
      return pending.catch(() => {}).then(() => connectCore({ force: true, excluded }));
    }
    const inFlight = existingOrCancelled({ force, excluded }, connectCore);
    if (inFlight) return inFlight;
    if (active) {
      if (!force) return Promise.resolve(active);
      // Rebuild a broken transport even if a fresh handshake is healthy. The
      // current endpoint wins equal-time ties; faster valid peers may replace it.
      nextIndex = urls.indexOf(active);
      active = null;
    }
    return run(signal => chooseEndpoint(signal, force, excluded));
  }
  function connect({ force = false } = {}) {
    if (!switching) return connectCore({ force });
    if (disposed) return Promise.reject(aborted());
    if (!online) return Promise.reject(new Error('Your device is offline.'));
    // A reconnect after going offline must wait for the canceled switch's
    // activation to settle, then start a new operation in the new lifecycle.
    if (switchEpoch !== lifecycleEpoch) return switching.catch(() => {}).then(() => connect({ force }));
    return switching;
  }
  function switchEndpoint({ failedEndpoint = active } = {}) {
    if (disposed) return Promise.reject(aborted());
    if (!online) return Promise.reject(new Error('Your device is offline.'));
    let failedUrl;
    try {
      failedUrl = failedEndpoint === null ? null : endpointUrl(failedEndpoint);
      if (failedUrl !== null && !failures.has(failedUrl)) throw new TypeError('The failed endpoint must be a configured proxy.');
    } catch (error) { return Promise.reject(error); }
    if (switching) {
      if (switchEpoch !== lifecycleEpoch) return switching.catch(() => {}).then(() => switchEndpoint({ failedEndpoint: failedUrl }));
      return switching;
    }
    clearScheduled();
    const epoch = lifecycleEpoch;
    switchEpoch = epoch;
    const work = Promise.resolve().then(async () => {
      // Health checks and mutations already in progress retain their real
      // lifetime. Never race a new setTransport against a late old activation.
      if (pending) await pending.catch(() => {});
      if (disposed || !online || epoch !== lifecycleEpoch) throw aborted();
      // The preceding health check may already have selected another server.
      if (failedUrl !== null && active && active !== failedUrl) return active;
      const omitted = failedUrl ?? active;
      const excluded = new Set(omitted === null ? [] : [omitted]);
      return connectCore({ force: true, excluded });
    });
    const complete = () => { switching = null; scheduleNext(); };
    switching = work.then(value => { complete(); return value; }, error => { complete(); throw error; });
    return switching;
  }
  function reportFailure() {
    if (disposed) return Promise.reject(aborted());
    if (!online) return Promise.reject(new Error('Your device is offline.'));
    if (switching) return connect();
    const inFlight = existingOrCancelled(undefined, reportFailure);
    if (inFlight) return inFlight;
    if (!active) return connect();
    return run(async signal => {
      const checkedEndpoint = active;
      try {
        await probe(checkedEndpoint, { signal, timeoutMs: probeTimeoutMs, setTimer, clearTimer });
        assertCurrent(signal);
        healthFailures = 0;
        publish('connected');
        return active;
      } catch (error) {
        assertCurrent(signal);
        healthFailures += 1;
        if (healthFailures < failureThreshold) {
          publish('degraded', { error: 'The proxy did not respond. Checking again before switching.' });
          return active;
        }
        failed(checkedEndpoint);
        active = null;
        return chooseEndpoint(signal);
      }
    });
  }
  function setOnline(value) {
    if (disposed) return Promise.reject(aborted());
    const next = Boolean(value);
    if (next === online) return next ? connect() : Promise.resolve(null);
    online = next;
    if (!online) {
      lifecycleEpoch += 1;
      clearScheduled();
      controller?.abort();
      active = null;
      healthFailures = 0;
      publish('offline');
      return Promise.resolve(null);
    }
    return connect({ force: true });
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    lifecycleEpoch += 1;
    clearScheduled();
    controller?.abort();
    active = null;
    publish('disposed');
  }
  return Object.freeze({ connect, switchEndpoint, reportFailure, setOnline, dispose, get activeEndpoint() { return active; }, get state() { return snapshot; } });
}
