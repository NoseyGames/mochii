                                      
  
                               
                                                                                                    
                                                                                                       
                                                                                                                                                       
   
importScripts("/ultrav/uv.bundle.js");
importScripts("/ultrav/uv.config.js");
importScripts(__uv$config.sw || "/ultrav/uv.sw.js");
importScripts('/browser-tools/config.js');

const uv = new UVServiceWorker();
let originCheck;
const identityOwners = new Map();
const identityCache = 'monkeh-proxy-identity-v2';
const identityGraceMs = 120000;

function hostIdentity(client) {
	try {
		const url = new URL(client.url);
		if (url.origin !== self.location.origin || url.pathname !== '/proxy-host.html') return null;
		const value = url.searchParams.get('ua') || '';
		return value.length <= 512 && /^[\x20-\x7e]*$/.test(value) ? value.trim() : '';
	} catch { return null; }
}

function identityKey(id) { return self.location.origin + '/__monkeh_identity__/' + encodeURIComponent(id); }

async function readIdentityRecord(response) {
	if (!response) return null;
	try {
		const text = await response.text();
		if (text.length > 512) return null;
		const record = JSON.parse(text);
		return record && typeof record.owner === 'string' && record.owner.length > 0 && record.owner.length <= 128 && Number.isFinite(record.createdAt) && record.createdAt >= 0 ? record : null;
	} catch { return null; }
}

async function rememberIdentity(clientId, owner, cache) {
	identityOwners.set(clientId, owner);
	try {
		if (typeof caches !== 'undefined') cache ||= await caches.open(identityCache);
		if (cache) await cache.put(identityKey(clientId), Response.json({ owner, createdAt: Date.now() }));
	} catch {}
	if (identityOwners.size > 256) identityOwners.delete(identityOwners.keys().next().value);
	if (identityOwners.size % 32 === 0) await pruneIdentities();
}

function bootstrapNonce(client) {
	try {
		const url = new URL(client.url);
		const nonce = url.searchParams.get('nonce');
		return url.origin === self.location.origin && url.pathname === '/proxy-bootstrap.html' && /^[a-f0-9]{32}$/.test(nonce || '') ? nonce : null;
	} catch { return null; }
}

async function identityMessage(event) {
	const reply = event.ports[0];
	try {
		if (!await isProxyOrigin()) throw new Error();
		const sender = await self.clients.get(event.source.id);
		const data = event.data;
		if (!/^[a-f0-9]{32}$/.test(data.nonce || '')) throw new Error();
		if (data.type === 'monkeh:identity:client' && bootstrapNonce(sender) === data.nonce) {
			reply.postMessage({ ok: true, clientId: sender.id });
		} else if (data.type === 'monkeh:identity:bind' && hostIdentity(sender) !== null && typeof data.clientId === 'string' && data.clientId.length <= 128) {
			const child = await self.clients.get(data.clientId);
			if (!child || !/^[a-f0-9]{32}$/.test(data.nonce || '') || bootstrapNonce(child) !== data.nonce) throw new Error();
			await rememberIdentity(child.id, sender.id);
			reply.postMessage({ ok: true });
		} else throw new Error();
	} catch { reply.postMessage({ ok: false }); }
	finally { reply.close(); }
}

self.addEventListener('message', event => {
	if (!event.source?.id || event.ports?.length !== 1 || !['monkeh:identity:client', 'monkeh:identity:bind'].includes(event.data?.type)) return;
	event.waitUntil(identityMessage(event));
});

async function requestIdentity(event) {
	if (!event.clientId || !self.clients?.get) return '';
	try {
		const client = await self.clients.get(event.clientId);
		let owner = event.clientId;
		let value = hostIdentity(client);
		let cache;
		if (value === null) {
			owner = identityOwners.get(event.clientId);
			if (!owner && typeof caches !== 'undefined') {
				cache = await caches.open(identityCache);
				const record = await readIdentityRecord(await cache.match(identityKey(event.clientId)));
				owner = record?.owner || '';
				if (owner) identityOwners.set(event.clientId, owner);
			}
			value = owner ? hostIdentity(await self.clients.get(owner)) : null;
		}
		if (value === null) return '';
		if (event.resultingClientId) {
			await rememberIdentity(event.resultingClientId, owner, cache);
		}
		return value;
	} catch { return ''; }
}

async function pruneIdentities() {
	if (typeof caches === 'undefined' || !self.clients?.matchAll) return;
	try {
		const clients = await self.clients.matchAll({ type: 'all', includeUncontrolled: true });
		const active = new Set(clients.map(client => identityKey(client.id)));
		const owners = new Set(clients.filter(client => hostIdentity(client) !== null).map(client => client.id));
		const cache = await caches.open(identityCache);
		const keys = await cache.keys();
		const now = Date.now();
		const records = await Promise.all(keys.map(async key => ({ key, record: await readIdentityRecord(await cache.match(key)) })));
		const retained = records.filter(({ key, record }) => record && owners.has(record.owner) && (active.has(key.url) || record.createdAt <= now && now - record.createdAt < identityGraceMs));
		retained.sort((a, b) => b.record.createdAt - a.record.createdAt);
		const keep = new Set(retained.slice(0, 256).map(({ key }) => key.url));
		await Promise.all(keys.filter(key => !keep.has(key.url)).map(key => cache.delete(key)));
	} catch {}
}

function identityScript(value) {
	const encoded = JSON.stringify(value).replace(/</g, '\\u003c');
	return `(()=>{try{Object.defineProperty(navigator,'userAgent',{configurable:true,get:()=>${encoded}});Object.defineProperty(navigator,'userAgentData',{configurable:true,get:()=>undefined});}catch{}})();`;
}

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
	event.waitUntil(Promise.all([self.clients.claim(), pruneIdentities()]));
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
		['/sw.js', '/proxy-host.html', '/proxy-bootstrap.html', '/flyflix-provider.html'].includes(url.pathname) ||
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

async function fetchThroughUV(event) {
	const request = event.request;
	const target = proxiedDestination(request.url);
	const repair = request.method === 'GET' && ['document', 'iframe'].includes(request.destination) && target && cdnGameDocument(target.href);
	const userAgent = await requestIdentity(event);
	if (!repair && !userAgent) return uv.fetch(event);
	const scoped = Object.create(uv);
	scoped.emit = (name, context) => {
		if (name === 'request' && userAgent) {
			for (const key of Object.keys(context.data.headers)) if (/^sec-ch-ua/i.test(key)) delete context.data.headers[key];
			context.data.headers['user-agent'] = userAgent;
		}
		return uv.emit(name, context);
	};
	if (userAgent) {
		const script = identityScript(userAgent);
		scoped.config = { ...uv.config, construct(instance, mode) {
			uv.config.construct?.(instance, mode);
			const html = instance.createHtmlInject.bind(instance);
			instance.createHtmlInject = (...args) => {
				const node = { tagName: 'script', nodeName: 'script', namespaceURI: 'http://www.w3.org/1999/xhtml', childNodes: [], attrs: [{ name: '__uv-script', value: '1', skip: true }], skip: true };
				node.childNodes.push({ nodeName: '#text', value: script, parentNode: node });
				return [node, ...html(...args)];
			};
			if (instance.createJsInject) {
				const js = instance.createJsInject.bind(instance);
				instance.createJsInject = (...args) => js(...args) + script;
			}
		} };
	}
	if (repair) scoped.bareClient = { fetch: async (...args) => repairGameDocument(await uv.bareClient.fetch(...args)) };
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
	return fetchThroughUV({ request, clientId: event.clientId, resultingClientId: event.resultingClientId });
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
