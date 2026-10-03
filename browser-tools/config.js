// Shared by classic pages, modules and the service worker. Never fall back to
// proxying on the shell origin when the deployment has no working config API.
(() => {
  const maximumBytes = 65536;
  const routingError = 'The proxy backend is not connected: /api/config returned a web page instead of JSON. The site owner must route /api/config to the running Monkeh backend; static hosting alone cannot run the proxy.';

  async function cancelBody(response) {
    try { await response.body?.cancel(); } catch { /* Preserve the useful error. */ }
  }

  async function readText(response) {
    if (Number(response.headers.get('content-length')) > maximumBytes) {
      await cancelBody(response);
      throw new Error('Proxy configuration exceeds the 64 KiB limit.');
    }
    if (!response.body?.getReader) {
      const text = await response.text();
      if (new TextEncoder().encode(text).length > maximumBytes) throw new Error('Proxy configuration exceeds the 64 KiB limit.');
      return text;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maximumBytes) throw new Error('Proxy configuration exceeds the 64 KiB limit.');
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } catch (error) {
      try { await reader.cancel(); } catch { /* Preserve the original error. */ }
      throw error;
    } finally { reader.releaseLock(); }
  }

  async function fetchConfig(options = {}) {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
    let response;
    try {
      response = await (options.fetch || globalThis.fetch)('/api/config', {
        cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' }, signal,
      });
    } catch (error) {
      if (signal.aborted) throw new Error('Proxy configuration request was cancelled or timed out. Check the backend connection and retry.');
      throw new Error('The proxy backend could not be reached. Check your connection and retry.');
    }
    if (!response.ok) {
      await cancelBody(response);
      if (response.status === 401 || response.status === 403) throw new Error('Proxy access was denied. Sign in to the proxy connection and retry.');
      if (response.status === 404) throw new Error('The proxy backend is not connected: /api/config was not found. The site owner must route it to the running Monkeh backend.');
      throw new Error(`Proxy configuration returned HTTP ${response.status}. Check the backend and retry.`);
    }
    const type = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (response.redirected || !/^application\/(?:json|[\w.+-]+\+json)$/.test(type)) {
      await cancelBody(response);
      if (type === 'text/html' || type === 'application/xhtml+xml') throw new Error(routingError);
      if (response.redirected) throw new Error('Proxy configuration was redirected. Sign in if required, and have the site owner route /api/config directly to the Monkeh backend.');
      throw new Error('The proxy backend returned a non-JSON configuration. The site owner must check the /api/config route and its Content-Type.');
    }
    const text = await readText(response);
    if (text.trimStart().startsWith('<')) throw new Error(routingError);
    let config;
    try { config = JSON.parse(text); } catch { throw new Error('The proxy backend returned invalid JSON from /api/config. The site owner must check its configuration response.'); }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('The proxy backend returned an invalid configuration object.');
    return config;
  }

  globalThis.MonkehConfig = Object.freeze({ fetchConfig });
})();
