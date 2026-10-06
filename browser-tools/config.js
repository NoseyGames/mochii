                                                                              
                                                                     
(() => {
  const productionShellOrigins = Object.freeze([
    'https://testingproductionubgdontgo.pages.dev',
    'https://monkeh-noseygames.netlify.app',
    'https://monkeh-browser.robert360254.chatgpt.site',
  ]);
  const deployment = Object.freeze({
    shellOrigin: productionShellOrigins[0],
    shellOrigins: productionShellOrigins,
    proxyOrigin: 'https://monkeh.1234-imwatchingyouopenthedoor.workers.dev',
    wispEndpoints: Object.freeze([
                                                                            
                                                                               
                                                                              
      Object.freeze({ name: 'Mercury', url: 'wss://wisp.mercurywork.shop/' }),
      Object.freeze({ name: 'GL Series', url: 'wss://glseries.net/wisp/' }),
      Object.freeze({ name: 'Wispserver.dev', url: 'wss://wispserver.dev/wisp' }),
      Object.freeze({ name: 'Homebrewer', url: 'wss://seminar.drama.english.assignment.literature.homebrewer.org/wisp/' }),
      Object.freeze({ name: 'Hydrovolter', url: 'wss://admin.proxy.hydrovolter.com/scramjet/wisp/' }),
      Object.freeze({ name: 'Owoellen', url: 'wss://scram.owoellen.rocks/wisp/' }),
      Object.freeze({ name: 'America History', url: 'wss://math.americahistory.online/wisp/' }),
      Object.freeze({ name: 'Lichology', url: 'wss://lichology.com/wisp/' }),
      Object.freeze({ name: 'Mages', url: 'wss://mages.io/wisp/' }),
      Object.freeze({ name: 'Onlinegames', url: 'wss://onlinegames.ro/wisp/' }),
      Object.freeze({ name: 'RHW', url: 'wss://wisp.rhw.one/ws/' }),
      Object.freeze({ name: 'Wisp-server.com', url: 'wss://wisp-server.com/wisp/' }),
      Object.freeze({ name: 'Classroom', url: 'wss://wisp.classroom.lat/' }),
      Object.freeze({ name: 'Radius', url: 'wss://radiusproxy.app/wisp/' }),
      Object.freeze({ name: 'Anura root', url: 'wss://anura.pro/' }),
      Object.freeze({ name: 'Phantom', url: 'wss://phantom.lol/wisp/' }),
      Object.freeze({ name: 'Axis Education', url: 'wss://geometry.axiseducation.one/' }),
      Object.freeze({ name: 'OnlineOS', url: 'wss://onlineosdev.nl/' }),
      Object.freeze({ name: 'Webmath', url: 'wss://webmath.help/wisp/' }),
      Object.freeze({ name: 'Explore Chemistry', url: 'wss://explorechemistry.online/wisp/' }),
      Object.freeze({ name: 'Quantum Chemistry', url: 'wss://quantumchemistry.club/wisp/' }),
      Object.freeze({ name: 'Henhouse', url: 'wss://henhouse.social/relay' }),
      Object.freeze({ name: 'Dragon Orange', url: 'wss://dragon-orange.exe.xyz/' }),
      Object.freeze({ name: 'Ymir', url: 'wss://strfry.ymir.cloud/' }),
      Object.freeze({ name: 'Antiprimal', url: 'wss://antiprimal.net/' }),
      Object.freeze({ name: 'Nostr', url: 'wss://nostr.me/relay' }),
      Object.freeze({ name: 'Crostr', url: 'wss://relay.crostr.com/' }),
      Object.freeze({ name: 'Solife', url: 'wss://wisp.solife.me/' }),
                                                                                
      Object.freeze({ name: 'Anura', url: 'wss://anura.pro/wisp/' }),
    ]),
    windowsVm: null,
  });

  function staticConfig(origin = globalThis.location?.origin) {
    let shellOrigins = deployment.shellOrigins;
    let proxyOrigin = deployment.proxyOrigin;
                                                                              
    if (['http://localhost:4173', 'http://localhost:4174'].includes(origin)) {
      shellOrigins = Object.freeze(['http://localhost:4173']);
      proxyOrigin = 'http://localhost:4174';
    } else if (['http://127.0.0.1:4173', 'http://127.0.0.1:4174'].includes(origin)) {
      shellOrigins = Object.freeze(['http://127.0.0.1:4173']);
      proxyOrigin = 'http://127.0.0.1:4174';
    } else if (!shellOrigins.includes(origin) && origin !== proxyOrigin) {
      throw new Error('This site address is not configured. Open ' + deployment.shellOrigin + '/math.html or update the origins in browser-tools/config.js.');
    }
    return Object.freeze({
      mode: 'static', proxyOrigin, shellOrigins,
      wispEndpoints: deployment.wispEndpoints, maxWispBackups: 31,
      requiresAuthentication: false, windowsVm: deployment.windowsVm,
    });
  }

  function redirectShell() {
    if (globalThis.MonkehUseBackendConfig === true || !globalThis.location) return false;
    const location = globalThis.location;
    let shellOrigin;
    try {
      const config = staticConfig();
      if (config.shellOrigins.includes(location.origin)) return false;
      shellOrigin = config.shellOrigins[0];
    } catch {
                                                                                    
      if (location.hostname?.endsWith('.testingproductionubgdontgo.pages.dev')) shellOrigin = deployment.shellOrigin;
      else return false;
    }
    location.replace(shellOrigin + location.pathname + location.search + location.hash);
    return true;
  }

  const maximumBytes = 65536;
  const routingError = 'The proxy backend is not connected: /api/config returned a web page instead of JSON. The site owner must route /api/config to the running Monkeh backend; static hosting alone cannot run the proxy.';

  async function cancelBody(response) {
    try { await response.body?.cancel(); } catch {                                  }
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
      try { await reader.cancel(); } catch {                                    }
      throw error;
    } finally { reader.releaseLock(); }
  }

  async function fetchBackendConfig(options = {}) {
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

  async function fetchConfig(options = {}) {
    if (globalThis.MonkehUseBackendConfig === true) return fetchBackendConfig(options);
    options.signal?.throwIfAborted();
    return staticConfig();
  }

  globalThis.MonkehConfig = Object.freeze({ fetchConfig, fetchBackendConfig, staticConfig, redirectShell });
})();
