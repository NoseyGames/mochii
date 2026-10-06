                                      
  
                               
                                                                                                    
                                                                                                       
                                                                                                                                                       
   
importScripts("/ultrav/uv.bundle.js");
importScripts("/ultrav/uv.config.js");
importScripts(__uv$config.sw || "/ultrav/uv.sw.js");
importScripts('/browser-tools/config.js');

const uv = new UVServiceWorker();
let originCheck;
const identityOwners = new Map();
const identityCache = 'monkeh-proxy-identity-v2';
const identityGraceMs = 120000;
const gameStages = new Map();
const gameLimits = Object.freeze({ source: 32 * 1024 * 1024, output: 48 * 1024 * 1024, total: 64 * 1024 * 1024, entries: 8, ttl: 30000 });
let gameBytes = 0;
let gameFetches = 0;

function hostIdentity(client) {
	try {
		const url = new URL(client.url);
		if (url.origin !== self.location.origin || !['/proxy-host.html', '/proxy-host'].includes(url.pathname)) return null;
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
		return url.origin === self.location.origin && ['/proxy-bootstrap.html', '/proxy-bootstrap'].includes(url.pathname) && /^[a-f0-9]{32}$/.test(nonce || '') ? nonce : null;
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
	if (!event.source?.id) return;
	if (event.ports?.length === 1 && ['monkeh:identity:client', 'monkeh:identity:bind'].includes(event.data?.type)) event.waitUntil(identityMessage(event));
	else if (['monkeh:game:prepare', 'monkeh:game:cancel'].includes(event.data?.type) && (event.data.type === 'monkeh:game:cancel' || event.ports?.length === 1)) event.waitUntil(gameMessage(event));
});

function gameError(message) {
	const error = new Error(message);
	error.gamePreparation = true;
	return error;
}

function discardGameStage(record) {
	if (gameStages.get(record.owner) !== record) return;
	gameStages.delete(record.owner);
	clearTimeout(record.timer);
	gameBytes -= record.bytes;
	record.bytes = 0;
	record.controller.abort();
	void record.response?.body?.cancel().catch(() => {});
}

function reserveGameBytes(record, bytes) {
	if (record.controller.signal.aborted || gameStages.get(record.owner) !== record) throw gameError('Game loading was cancelled.');
	if (gameBytes - record.bytes + bytes > gameLimits.total) throw gameError('Too many large games are loading. Close another game and retry.');
	gameBytes += bytes - record.bytes;
	record.bytes = bytes;
}

async function readGameBytes(response, maximum, record) {
	const declared = response.headers.get('content-length');
	if (declared && /^\d+$/.test(declared) && Number(declared) > maximum) {
		void response.body?.cancel().catch(() => {});
		throw gameError('This game page exceeds the loading size limit.');
	}
	if (!response.body) throw gameError('This game did not return any page code.');
	const reader = response.body.getReader();
	const signal = record.controller.signal;
	const cancel = () => { void reader.cancel().catch(() => {}); };
	const chunks = [];
	let length = 0;
	signal.addEventListener('abort', cancel, { once: true });
	try {
		while (true) {
			if (signal.aborted) throw gameError('Game loading was cancelled.');
			const { done, value } = await reader.read();
			if (signal.aborted) throw gameError('Game loading was cancelled.');
			if (done) break;
			length += value.byteLength;
			if (length > maximum) throw gameError('This game page exceeds the loading size limit.');
			reserveGameBytes(record, Math.max(record.bytes, length));
			chunks.push(value);
		}
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
		return bytes;
	} finally {
		signal.removeEventListener('abort', cancel);
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

function gameTarget(value, config) {
	if (typeof value !== 'string' || value.length > 4096) throw gameError('This game has an invalid page address.');
	let target;
	try { target = new URL(value); } catch { throw gameError('This game has an invalid page address.'); }
	if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.origin === self.location.origin || config.shellOrigins?.includes(target.origin)) throw gameError('This game has an unsupported page address.');
	return target.href;
}

function gameProxyUrl(target) { return self.location.origin + __uv$config.prefix + __uv$config.encodeUrl(target); }

async function prepareGameSource(response, record) {
	if ([301, 302, 303, 307, 308].includes(response.status)) {
		void response.body?.cancel().catch(() => {});
		const empty = new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
		empty.rawHeaders = { ...response.rawHeaders };
		empty.finalURL = response.finalURL;
		return empty;
	}
	if (!response.ok) {
		void response.body?.cancel().catch(() => {});
		throw gameError(`The game source returned HTTP ${response.status}.`);
	}
	let bytes = await readGameBytes(response, gameLimits.source, record);
	const charset = /(?:^|;)\s*charset\s*=\s*["']?([^;\s"']+)/i.exec(response.headers.get('content-type') || '')?.[1];
	let decoder;
	try { decoder = new TextDecoder(charset || (bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8')); }
	catch { throw gameError('This game page uses an unsupported text encoding.'); }
	let prefix = decoder.decode(bytes.subarray(0, 8192)).replace(/^\uFEFF/, '').trimStart();
	while (prefix.startsWith('<!--')) {
		const end = prefix.indexOf('-->');
		if (end < 0) break;
		prefix = prefix.slice(end + 3).trimStart();
	}
	if (!/^<(?:!doctype\s+html\b|(?:html|head|body|title|meta|link|style|script|div|canvas|iframe)(?:\s|>))/i.test(prefix) || prefix.includes('\u0000')) throw gameError('This game source did not return an HTML game page.');
	if (decoder.encoding !== 'utf-8') {
		bytes = new TextEncoder().encode(decoder.decode(bytes));
		if (bytes.byteLength > gameLimits.source) throw gameError('This game page exceeds the loading size limit.');
		reserveGameBytes(record, Math.max(record.bytes, bytes.byteLength));
	}
	const headers = new Headers(response.headers);
	headers.set('content-type', 'text/html; charset=utf-8');
	headers.delete('content-length');
	headers.delete('content-encoding');
	const prepared = new Response(bytes, { status: response.status, statusText: response.statusText, headers });
	prepared.rawHeaders = { ...response.rawHeaders };
	for (const name of Object.keys(prepared.rawHeaders)) if (/^(?:content-type|content-length|content-encoding)$/i.test(name)) delete prepared.rawHeaders[name];
	prepared.rawHeaders['content-type'] = 'text/html; charset=utf-8';
	prepared.finalURL = response.finalURL;
	return prepared;
}

async function fetchGameCode(record, target, config) {
	const visited = new Set();
	for (let redirects = 0; redirects <= 6; redirects++) {
		if (visited.has(target)) throw gameError('This game source has a redirect loop.');
		visited.add(target);
		const url = gameProxyUrl(target);
		record.canonicalUrl = url;
		const original = new Request(url, { method: 'GET', redirect: 'manual', credentials: 'omit', referrer: '', headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }, signal: record.controller.signal });
		const request = new Proxy(original, { get(value, property) {
			if (property === 'destination') return 'iframe';
			if (property === 'mode') return 'navigate';
			const field = Reflect.get(value, property, value);
			return typeof field === 'function' ? field.bind(value) : field;
		} });
		const response = await fetchThroughUV({ request, clientId: record.owner }, record);
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			void response.body?.cancel().catch(() => {});
			if (redirects === 6) throw gameError('This game source redirected too many times.');
			const location = response.headers.get('location');
			if (!location) throw gameError('This game source returned an invalid redirect.');
			const destination = proxiedDestination(new URL(location, url).href);
			if (!destination) throw gameError('This game source returned an invalid redirect.');
			target = gameTarget(destination.href, config);
			continue;
		}
		if (!response.ok) { void response.body?.cancel().catch(() => {}); throw gameError('The proxy could not prepare this game page. Try another proxy server.'); }
		const bytes = await readGameBytes(response, gameLimits.output, record);
		reserveGameBytes(record, bytes.byteLength);
		const headers = new Headers(response.headers);
		headers.delete('content-length');
		headers.delete('content-encoding');
		headers.set('content-disposition', 'inline');
		headers.set('cache-control', 'no-store');
		record.response = new Response(bytes, { status: response.status, statusText: response.statusText, headers });
		return url;
	}
}

async function gameMessage(event) {
	const reply = event.ports?.[0];
	let record;
	try {
		if (!await isProxyOrigin()) throw gameError('Game loading requires the isolated proxy.');
		const sender = await self.clients.get(event.source.id);
		if (!sender || hostIdentity(sender) === null || !/^[a-f0-9]{32}$/.test(event.data.nonce || '')) throw gameError('The game loading request was rejected.');
		const previous = gameStages.get(sender.id);
		if (event.data.type === 'monkeh:game:cancel') {
			if (previous?.nonce === event.data.nonce) discardGameStage(previous);
			return;
		}
		if (previous) discardGameStage(previous);
		for (const entry of gameStages.values()) if (entry.expires <= Date.now()) discardGameStage(entry);
		if ([...gameStages.values()].some(entry => entry.nonce === event.data.nonce)) throw gameError('The game loading request was rejected.');
		if (gameStages.size >= gameLimits.entries) throw gameError('Too many games are loading. Close another game and retry.');
		record = { owner: sender.id, nonce: event.data.nonce, url: self.location.origin + '/__monkeh_game__/' + event.data.nonce, controller: new AbortController(), bytes: 0, expires: Date.now() + gameLimits.ttl, response: null };
		gameStages.set(sender.id, record);
		const timeout = new Promise((resolve, reject) => {
			record.timer = setTimeout(() => { reject(gameError('The game source took too long to load. Try another proxy server.')); discardGameStage(record); }, gameLimits.ttl);
		});
		const cancelled = new Promise((resolve, reject) => record.controller.signal.addEventListener('abort', () => reject(gameError('Game loading was cancelled.')), { once: true }));
		const prepare = async () => {
			const config = await globalThis.MonkehConfig.fetchConfig();
			if (record.controller.signal.aborted) throw gameError('Game loading was cancelled.');
			return fetchGameCode(record, gameTarget(event.data.url, config), config);
		};
		const url = await Promise.race([prepare(), timeout, cancelled]);
		if (gameStages.get(sender.id) !== record || record.controller.signal.aborted) throw gameError('Game loading was cancelled.');
		clearTimeout(record.timer);
		record.expires = Date.now() + gameLimits.ttl;
		record.timer = setTimeout(() => discardGameStage(record), gameLimits.ttl);
		reply?.postMessage({ ok: true, url: record.url, canonicalUrl: url });
	} catch (error) {
		if (record) discardGameStage(record);
		try { reply?.postMessage({ ok: false, error: error.gamePreparation ? error.message : 'The proxy could not fetch this game page. Try another proxy server.' }); } catch {}
	} finally { try { reply?.close(); } catch {} }
}

async function preparedGameResponse(event) {
	const failure = (message, status = 410) => new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
	try {
		if (!await isProxyOrigin() || event.request.method !== 'GET' || !['iframe', 'document'].includes(event.request.destination)) return failure('This game page can only open inside the isolated game viewer.', 403);
		const record = [...gameStages.values()].find(entry => entry.url === event.request.url);
		if (!record?.response) return failure('This prepared game page expired. Open the game again from the catalog.');
		if (record.expires <= Date.now() || hostIdentity(await self.clients.get(record.owner)) === null) { discardGameStage(record); return failure('This prepared game page expired. Open the game again from the catalog.'); }
		if (event.clientId) {
			const client = await self.clients.get(event.clientId);
			let owner = hostIdentity(client) !== null ? event.clientId : identityOwners.get(event.clientId);
			if (!owner && typeof caches !== 'undefined') owner = (await readIdentityRecord(await (await caches.open(identityCache)).match(identityKey(event.clientId))))?.owner;
			if (owner !== record.owner) return failure('This prepared game belongs to another viewer.', 403);
		}
		const response = record.response;
		record.response = null;
		discardGameStage(record);
		if (event.resultingClientId) await rememberIdentity(event.resultingClientId, record.owner);
		return response;
	} catch { return failure('This prepared game page could not open. Open the game again from the catalog.'); }
}

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
		['/sw.js', '/proxy-host.html', '/proxy-host', '/proxy-bootstrap.html', '/proxy-bootstrap', '/flyflix-provider.html'].includes(url.pathname) ||
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

function proxyPageCleanup() {
	const win = window;
	const doc = win.document;
	const key = Symbol.for('monkeh.pageCleanup');
	const previous = win[key];
	if (previous?.document === doc) { previous.start(); return; }
	previous?.dispose();
	let timer;
	let disposed = false;
	function setStyle(style, property, value) {
		if (style && (style.getPropertyValue(property) !== value || style.getPropertyPriority(property) !== 'important')) style.setProperty(property, value, 'important');
	}
	function cleanup(current) {
		try {
			current.querySelectorAll('[id^="securly"],[class^="securly"],#securly-overlay,.securly-ui-container').forEach(element => element.remove());
			setStyle(current.body?.style, 'overflow', 'auto');
			setStyle(current.body?.style, 'position', 'static');
			setStyle(current.documentElement?.style, 'overflow', 'auto');
		} catch {}
	}
	function run() {
		if (disposed || win.document !== doc) { dispose(); return; }
		const pending = [doc];
		const seen = new Set();
		while (pending.length) {
			const current = pending.pop();
			if (!current || seen.has(current)) continue;
			seen.add(current);
			if (current !== doc) {
				try { const owner = current.defaultView?.[key]; if (owner?.document === current && owner.active) continue; } catch {}
			}
			cleanup(current);
			try {
				for (const frame of current.querySelectorAll('iframe, frame')) {
					try { const child = frame.contentDocument || frame.contentWindow?.document; if (child) pending.push(child); } catch {}
				}
			} catch {}
		}
	}
	function start() {
		if (disposed || timer !== undefined) return;
		run();
		if (!disposed) timer = win.setInterval(run, 500);
	}
	function stop() { if (timer !== undefined) win.clearInterval(timer); timer = undefined; }
	function hide(event) { if (event.persisted) stop(); else dispose(); }
	function dispose() {
		if (disposed) return;
		disposed = true;
		stop();
		win.removeEventListener('pagehide', hide);
		win.removeEventListener('pageshow', start);
		if (win[key] === controller) delete win[key];
	}
	const controller = { document: doc, get active() { return !disposed && timer !== undefined; }, start, dispose };
	Object.defineProperty(win, key, { configurable: true, value: controller });
	win.addEventListener('pagehide', hide);
	win.addEventListener('pageshow', start);
	start();
}

async function fetchThroughUV(event, game = null) {
	const request = event.request;
	const target = proxiedDestination(request.url);
	const repair = request.method === 'GET' && ['document', 'iframe'].includes(request.destination) && target && cdnGameDocument(target.href);
	const userAgent = await requestIdentity(event);
	const page = ['document', 'iframe'].includes(request.destination);
	if (!repair && !userAgent && !game && !page) return uv.fetch(event);
	const scoped = Object.create(uv);
	scoped.emit = (name, context) => {
		if (name === 'request' && userAgent) {
			for (const key of Object.keys(context.data.headers)) if (/^sec-ch-ua/i.test(key)) delete context.data.headers[key];
			context.data.headers['user-agent'] = userAgent;
		}
		return uv.emit(name, context);
	};
	if (userAgent || game || page) {
		scoped.config = { ...uv.config, construct(instance, mode) {
			uv.config.construct?.(instance, mode);
			const html = instance.createHtmlInject.bind(instance);
			instance.createHtmlInject = (...args) => {
				const nodes = [];
				const script = value => {
					const node = { tagName: 'script', nodeName: 'script', namespaceURI: 'http://www.w3.org/1999/xhtml', childNodes: [], attrs: [{ name: '__uv-script', value: '1', skip: true }], skip: true };
					node.childNodes.push({ nodeName: '#text', value, parentNode: node });
					return node;
				};
				if (game) {
					nodes.push(script(`history.replaceState(null,'',${JSON.stringify(game.canonicalUrl).replace(/</g, '\\u003c')});`));
					nodes.push({ tagName: 'meta', nodeName: 'meta', namespaceURI: 'http://www.w3.org/1999/xhtml', childNodes: [], attrs: [{ name: 'name', value: 'monkeh-game-code' }, { name: 'content', value: 'fetched' }], skip: true });
				}
				if (userAgent) nodes.push(script(identityScript(userAgent)));
				if (page || game) nodes.push(script('(' + proxyPageCleanup.toString() + ')();'));
				return [...nodes, ...html(...args)];
			};
			if (userAgent && instance.createJsInject) {
				const js = instance.createJsInject.bind(instance);
				instance.createJsInject = (...args) => js(...args) + identityScript(userAgent);
			}
		} };
	}
	let gameFailure;
	if (game) scoped.bareClient = { fetch: async (url, options) => {
		let reserved = false;
		try {
			if (game.controller.signal.aborted) throw gameError('Game loading was cancelled.');
			if (gameFetches >= gameLimits.entries) throw gameError('Too many game requests are still loading. Wait briefly and retry.');
			gameFetches++;
			reserved = true;
			const response = await uv.bareClient.fetch(url, { ...options, signal: game.controller.signal });
			return await prepareGameSource(response, game);
		} catch (error) { gameFailure = error; throw error; }
		finally { if (reserved) gameFetches--; }
	} };
	else if (repair) scoped.bareClient = { fetch: async (...args) => repairGameDocument(await uv.bareClient.fetch(...args)) };
	const response = await scoped.fetch(event);
	if (gameFailure) throw gameFailure;
	return response;
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
	const stage = new URL(event.request.url);
	if (stage.origin === self.location.origin && stage.pathname.startsWith('/__monkeh_game__/')) {
		event.respondWith(preparedGameResponse(event));
		return;
	}
	if (uv.route(event)) {
		event.respondWith(handleRequest(event));
		return;
	}
	if (!event.clientId) return;
	const requested = new URL(event.request.url);
	if (!['http:', 'https:'].includes(requested.protocol) || localRuntime(requested)) return;
	event.respondWith(handleCompatibilityRequest(event, requested));
});
