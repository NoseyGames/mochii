                                      
  
                               
                                                                                                    
                                                                                                       
                                                                                                                                                       
   
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
		return await fetchThroughUV(event);
	}

	return await fetch(event.request);
}

function localRuntime(url) {
	return url.origin === self.location.origin && (
		['/sw.js', '/proxy-host.html', '/flyflix-provider.html'].includes(url.pathname) ||
		['/ultrav/', '/bearmux/', '/browser-tools/'].some(prefix => url.pathname.startsWith(prefix))
	);
}

function proxiedDestination(value) {
	try {
		const prefix = self.location.origin + __uv$config.prefix;
		if (typeof value !== 'string' || !value.startsWith(prefix)) return null;
		const target = new URL(__uv$config.decodeUrl(value.slice(prefix.length)));
		if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return null;
		return target;
	} catch { return null; }
}

function cdnGameDocument(value) {
	try {
		const url = new URL(value);
		return url.origin === 'https://cdn.jsdelivr.net' && !url.username && !url.password &&
			/^\/gh\/(?:zennedu\/(?:hydra|3kh)|securlycdn\/html)(?:@[a-zA-Z0-9._-]+)?\/.+\.html$/i.test(url.pathname);
	} catch { return false; }
}

async function repairGameDocument(response) {
	const contentType = response.headers.get('content-type') || '';
	if (response.status !== 200 || !cdnGameDocument(response.finalURL) || !/^text\/plain(?:\s*;|$)/i.test(contentType) || !response.body) return response;
	const reader = response.body.getReader();
	const buffered = [];
	const prefix = new Uint8Array(1024);
	let length = 0;
	let complete = false;
	for (let reads = 0; length < prefix.length && reads < 16; reads++) {
		const { done, value } = await reader.read();
		if (done) { complete = true; break; }
		buffered.push(value);
		const part = value.subarray(0, prefix.length - length);
		prefix.set(part, length);
		length += part.length;
	}
	const html = /^\s*(?:<!doctype\s+html\b|<html(?:\s|>))/i.test(new TextDecoder().decode(prefix.subarray(0, length)));
	const stream = new ReadableStream({
		start(controller) {
			for (const value of buffered) controller.enqueue(value);
			if (complete) { controller.close(); reader.releaseLock(); }
		},
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) { controller.close(); reader.releaseLock(); }
				else controller.enqueue(value);
			} catch (error) { controller.error(error); reader.releaseLock(); }
		},
		async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } }
	});
	const repaired = new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
	repaired.rawHeaders = { ...response.rawHeaders };
	if (html) {
		for (const key of Object.keys(repaired.rawHeaders)) if (key.toLowerCase() === 'content-type') delete repaired.rawHeaders[key];
		repaired.rawHeaders['content-type'] = contentType.replace(/^text\/plain/i, 'text/html');
		repaired.headers.set('content-type', repaired.rawHeaders['content-type']);
	}
	repaired.finalURL = response.finalURL;
	repaired.rawResponse = { ...response.rawResponse, body: repaired.body, headers: repaired.rawHeaders };
	return repaired;
}

function fetchThroughUV(event) {
	const request = event.request;
	const target = proxiedDestination(request.url);
	if (request.method !== 'GET' || !['document', 'iframe'].includes(request.destination) || !target || !cdnGameDocument(target.href)) return uv.fetch(event);
	const scoped = Object.create(uv);
	scoped.emit = uv.emit.bind(uv);
	scoped.bareClient = { fetch: async (...args) => repairGameDocument(await uv.bareClient.fetch(...args)) };
	return scoped.fetch(event);
}

async function handleCompatibilityRequest(event, requested) {
	let client;
	try { client = await self.clients.get(event.clientId); } catch { return Response.error(); }
	const original = proxiedDestination(client?.url);
	if (!original) return fetch(event.request);
	if (!await isProxyOrigin()) {
		return new Response('Proxy browsing is available only on the isolated proxy origin. Reload Monkeh.', { status: 403, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
	}
	const destination = requested.origin === self.location.origin
		? new URL(requested.pathname + requested.search + requested.hash, original.origin)
		: requested;
	if (destination.username || destination.password) return Response.error();
	const rewritten = self.location.origin + __uv$config.prefix + __uv$config.encodeUrl(destination.href);
	const request = new Proxy(event.request, {
		get(target, property) {
			if (property === 'url') return rewritten;
			const value = Reflect.get(target, property, target);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
	return fetchThroughUV({ request });
}

self.addEventListener("fetch", (event) => {
	if (uv.route(event)) {
		event.respondWith(handleRequest(event));
		return;
	}
	if (!event.clientId) return;
	const requested = new URL(event.request.url);
	if (!['http:', 'https:'].includes(requested.protocol) || localRuntime(requested)) return;
	event.respondWith(handleCompatibilityRequest(event, requested));
});
