/*global UVServiceWorker,__uv$config*/
/*
 * Stock service worker script.
 * Users can provide their own sw.js if they need to extend the functionality of the service worker.
 * Ideally, this will be registered under the scope in uv.config.js so it will not need to be modified.
 * However, if a user changes the location of uv.bundle.js/uv.config.js or sw.js is not relative to them, they will need to modify this script locally.
 */
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

// Control the first visit before the frontend navigates to a proxied page.
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
