const STORAGE_KEY = 'monkeh:mirror-reported:v1';

export function publicMirrorOrigin(raw) {
  try {
    const url = new URL(raw);
    if (url.hostname.endsWith('.chatgpt.site')) return '';
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(url.hostname) || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) return '';
    return url.origin;
  } catch { return ''; }
}

export async function reportMirror(win, endpoint, { fetcher = win.fetch.bind(win) } = {}) {
  const origin = publicMirrorOrigin(win.location.origin);
  let reportUrl;
  try {
    reportUrl = new URL(endpoint);
    if (reportUrl.protocol !== 'https:' || reportUrl.username || reportUrl.password || reportUrl.port || reportUrl.pathname !== '/report' || reportUrl.search || reportUrl.hash) return false;
  } catch { return false; }
  if (!origin || win.top !== win.self) return false;
  const identity = JSON.stringify([origin, reportUrl.href]);
  try { if (win.localStorage.getItem(STORAGE_KEY) === identity) return true; } catch {}
  try {
    const response = await fetcher(reportUrl.href, {
      method: 'POST', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin }), signal: AbortSignal.timeout(6000)
    });
    if (![200, 202].includes(response.status)) return false;
    try { win.localStorage.setItem(STORAGE_KEY, identity); } catch {}
    return true;
  } catch { return false; }
}

export function scheduleMirrorReport(win = window) {
  let stopped = false;
  const run = async () => {
    if (stopped || !publicMirrorOrigin(win.location.origin) || win.top !== win.self) return;
    try {
      const response = await win.fetch('/mirror-report.json', { credentials: 'omit', signal: AbortSignal.timeout(4000) });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return;
      const config = await response.json();
      if (!stopped && typeof config.endpoint === 'string') await reportMirror(win, config.endpoint);
    } catch {}
  };
  const idle = () => {
    if (win.requestIdleCallback) win.requestIdleCallback(() => void run(), { timeout: 10000 });
    else win.setTimeout(() => void run(), 3000);
  };
  if (win.document.readyState === 'complete') idle();
  else win.addEventListener('load', idle, { once: true });
  win.addEventListener('pagehide', () => { stopped = true; }, { once: true });
}

if (typeof window !== 'undefined') scheduleMirrorReport(window);
