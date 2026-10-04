                                      
  
                               
                                                                                                    
                                                                                                       
                                                                                                                                                       
   
importScripts("/ultrav/uv.bundle.js");
importScripts("/ultrav/uv.config.js");
importScripts(__uv$config.sw || "/ultrav/uv.sw.js");
importScripts('/browser-tools/config.js');

const uv = new UVServiceWorker();
let originCheck;

function isProxyOrigin() {
	if (!originCheck) {
		originCheck = globalThis.MonkehConfig.fetchConfig().then(config => {
			return config.proxyOrigin === self.location.origin;
		}).catch(() => { originCheck = null; return false; });
	}
	return originCheck;
}

                                                                           
self.addEventListener("install", (event) => {
	event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

async function handleRequest(event) {
	if (uv.route(event)) {
		if (!await isProxyOrigin()) {
			return new Response('Proxy browsing is available only on the isolated proxy origin. Reload Monkeh.', { status: 403, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
		}
		return await uv.fetch(event);
	}

	return await fetch(event.request);
}

self.addEventListener("fetch", (event) => {
	if (uv.route(event)) {
		event.respondWith(handleRequest(event));
	}
});
