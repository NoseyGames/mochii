const ERROR_PATH = '/oops.html';
const MIN_GAP_CHANGE = 240;
const REQUIRED_SAMPLES = 4;

export function isNativeDevtoolsShortcut(event) {
  if (!event || event.repeat || event.isComposing || event.getModifierState?.('AltGraph') === true) return false;
  const key = String(event.key || '').toLowerCase();
  if (key === 'f12') return !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
  if (!['i', 'j', 'c'].includes(key)) return false;
  return Boolean(
    (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) ||
    (event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey)
  );
}

function dimensions(win) {
  const values = ['outerWidth', 'outerHeight', 'innerWidth', 'innerHeight', 'devicePixelRatio'];
  const result = {};
  for (const key of values) {
    const value = Number(win[key]);
    if (!Number.isFinite(value) || value <= 0) return null;
    result[key] = value;
  }
  return result;
}

function sameWindowSize(left, right) {
  return Math.abs(left.outerWidth - right.outerWidth) <= 8 &&
    Math.abs(left.outerHeight - right.outerHeight) <= 8 &&
    Math.abs(left.devicePixelRatio - right.devicePixelRatio) <= 0.02;
}

export function createDevtoolsGuard(win, { enabled = true, detectDocked = false } = {}) {
  const doc = win.document;
  let active = enabled === true;
  let docked = detectDocked === true;
  let disposed = false;
  let redirected = false;
  let baseline = null;
  let candidate = null;
  let candidateSamples = 0;
  let timer = null;

  function reset() {
    baseline = dimensions(win);
    candidate = null;
    candidateSamples = 0;
  }

  function redirect(reason) {
    if (!active || disposed || redirected || win.location.pathname === ERROR_PATH) return false;
    redirected = true;
    stopTimer();
    win.dispatchEvent(new win.CustomEvent('monkeh:leaving', { detail: { reason: 'devtools-guard' } }));
    win.location.replace(ERROR_PATH);
    return reason;
  }

  function onKeydown(event) {
    if (!active || disposed || redirected || event.isTrusted !== true || !isNativeDevtoolsShortcut(event)) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const hotkey = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', key].filter(Boolean).join('+');
    if (hotkey === win.MonkehPrivacy?.get().panicKey && !event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    redirect('shortcut');
  }

  function sample() {
    if (!active || !docked || disposed || redirected) return false;
    const current = dimensions(win);
    if (!current || doc.visibilityState !== 'visible' || doc.fullscreenElement ||
        Number(win.navigator?.maxTouchPoints || 0) > 0 ||
        win.matchMedia?.('(pointer: fine)').matches !== true ||
        current.innerWidth < 640 || current.innerHeight < 240) {
      reset();
      return false;
    }
    if (!baseline || !sameWindowSize(baseline, current)) {
      reset();
      return false;
    }
    const widthChange = baseline.innerWidth - current.innerWidth;
    const heightChange = baseline.innerHeight - current.innerHeight;
    const axis = widthChange >= MIN_GAP_CHANGE && Math.abs(heightChange) <= 24 ? 'width' :
      heightChange >= MIN_GAP_CHANGE && Math.abs(widthChange) <= 24 ? 'height' : null;
    if (!axis) {
      candidate = null;
      candidateSamples = 0;
      if (current.innerWidth > baseline.innerWidth || current.innerHeight > baseline.innerHeight) baseline = current;
      return false;
    }
    const stable = candidate && candidate.axis === axis &&
      Math.abs(candidate.innerWidth - current.innerWidth) <= 8 &&
      Math.abs(candidate.innerHeight - current.innerHeight) <= 8;
    candidateSamples = stable ? candidateSamples + 1 : 1;
    candidate = { axis, innerWidth: current.innerWidth, innerHeight: current.innerHeight };
    if (candidateSamples >= REQUIRED_SAMPLES) return redirect('docked-panel');
    return false;
  }

  function stopTimer() {
    if (timer !== null) win.clearInterval(timer);
    timer = null;
  }

  function syncTimer() {
    stopTimer();
    reset();
    if (active && docked && !disposed && !redirected) timer = win.setInterval(sample, 500);
  }

  function onVisibilityChange() {
    reset();
  }

  function onPreferenceChange(event) {
    const preferences = event?.detail;
    if (!preferences || typeof preferences !== 'object') return;
    if (typeof preferences.nativeDevtoolsGuard === 'boolean') active = preferences.nativeDevtoolsGuard;
    if (typeof preferences.detectDocked === 'boolean') docked = preferences.detectDocked;
    syncTimer();
  }

  win.addEventListener('keydown', onKeydown, true);
  win.addEventListener('monkeh:privacy', onPreferenceChange);
  doc.addEventListener('visibilitychange', onVisibilityChange);
  doc.addEventListener('fullscreenchange', onVisibilityChange);
  syncTimer();

  return Object.freeze({
    setEnabled(value) {
      active = value === true;
      syncTimer();
    },
    setDetectDocked(value) {
      docked = value === true;
      syncTimer();
    },
    sample,
    getState: () => ({ enabled: active, detectDocked: docked, redirected, disposed }),
    dispose() {
      if (disposed) return;
      disposed = true;
      stopTimer();
      win.removeEventListener('keydown', onKeydown, true);
      win.removeEventListener('monkeh:privacy', onPreferenceChange);
      doc.removeEventListener('visibilitychange', onVisibilityChange);
      doc.removeEventListener('fullscreenchange', onVisibilityChange);
    }
  });
}

if (typeof window !== 'undefined' && window.top === window && window.location.pathname !== ERROR_PATH && !window.MonkehDevtoolsGuard) {
  const preferences = window.MonkehPrivacy?.get() || {};
  window.MonkehDevtoolsGuard = createDevtoolsGuard(window, {
    enabled: preferences.nativeDevtoolsGuard !== false,
    detectDocked: preferences.detectDocked === true
  });
}
