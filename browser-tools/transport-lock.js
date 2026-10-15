const locks = new WeakMap();

const recoveryError = () => Object.assign(new Error('The shared proxy connection did not finish starting. Reload this page to recover; switching servers cannot repair this stalled connection.'), { code: 'PROXY_TRANSPORT_UNCERTAIN' });

export function createTransportLock({ navigator = globalThis.navigator, acquireTimeout = 12000, executionTimeout = 25000 } = {}) {
  if (![acquireTimeout, executionTimeout].every(value => Number.isFinite(value) && value > 0)) throw new TypeError('Transport deadlines must be positive.');
  let active;
  const assertAvailable = () => { if (active?.uncertain) throw recoveryError(); };
  const run = work => {
    try { assertAvailable(); } catch (error) { return Promise.reject(error); }
    if (active) return active.result;
    const controller = new AbortController();
    const record = { uncertain: false, result: null };
    let resolve;
    let reject;
    record.result = new Promise((yes, no) => { resolve = yes; reject = no; });
    active = record;
    let executionTimer;
    const lockError = new Error('Another proxy connection is not responding. Reload this page to recover the shared connection.');
    const acquisitionTimer = setTimeout(() => { controller.abort(lockError); reject(lockError); }, acquireTimeout);
    const execute = async () => {
      clearTimeout(acquisitionTimer);
      if (controller.signal.aborted) throw lockError;
      executionTimer = setTimeout(() => { record.uncertain = true; reject(recoveryError()); }, executionTimeout);
      return await work();
    };
    const finish = (value, error) => {
      clearTimeout(acquisitionTimer); clearTimeout(executionTimer);
      if (active === record) active = null;
      if (error) reject(value); else resolve(value);
    };
    Promise.resolve().then(() => navigator?.locks?.request
      ? navigator.locks.request('mochii-local-proxy-transport', { signal: controller.signal }, execute)
      : execute()).then(value => finish(value, false), error => finish(error, true));
    return record.result;
  };
  return Object.freeze({ run, assertAvailable, snapshot: () => ({ pending: Boolean(active), uncertain: active?.uncertain === true }) });
}

export function transportLockFor(win = window, options = {}) {
  if (!locks.has(win)) locks.set(win, createTransportLock({ navigator: win.navigator, ...options }));
  return locks.get(win);
}
