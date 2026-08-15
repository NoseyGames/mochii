if (navigator.userAgent.includes("Firefox")) {
	Object.defineProperty(globalThis, "crossOriginIsolated", {
		value: true,
		writable: false,
	});
}

// s16 asked me to credit swium, so here you go. happy now?

importScripts("/homework/math.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

const CONFIG = {
	blocked: [
		"youtube.com/get_video_info?*adformat=*",
		"youtube.com/api/stats/ads/*",
		"youtube.com/pagead/*",
		".facebook.com/ads/*",
		".facebook.com/tr/*",
		".fbcdn.net/ads/*",
		"graph.facebook.com/ads/*",
		"ads-api.twitter.com/*",
		"analytics.twitter.com/*",
		".twitter.com/i/ads/*",
		".ads.yahoo.com",
		".advertising.com",
		".adtechus.com",
		".oath.com",
		".verizonmedia.com",
		".amazon-adsystem.com",
		"aax.amazon-adsystem.com/*",
		"c.amazon-adsystem.com/*",
		".adnxs.com",
		".adnxs-simple.com",
		"ab.adnxs.com/*",
		".rubiconproject.com",
		".magnite.com",
		".pubmatic.com",
		"ads.pubmatic.com/*",
		".criteo.com",
		"bidder.criteo.com/*",
		"static.criteo.net/*",
		".openx.net",
		".openx.com",
		".indexexchange.com",
		".casalemedia.com",
		".adcolony.com",
		".chartboost.com",
		".unityads.unity3d.com",
		".inmobiweb.com",
		".tapjoy.com",
		".applovin.com",
		".vungle.com",
		".ironsrc.com",
		".fyber.com",
		".smaato.net",
		".supersoniads.com",
		".startappservice.com",
		".airpush.com",
		".outbrain.com",
		".taboola.com",
		".revcontent.com",
		".zedo.com",
		".mgid.com",
		"*/ads/*",
		"*/adserver/*",
		"*/adclick/*",
		"*/banner_ads/*",
		"*/sponsored/*",
		"*/promotions/*",
		"*/tracking/ads/*",
		"*/promo/*",
		"*/affiliates/*",
		"*/partnerads/*",
	],
	inject: {
		html: "\x3c!-- pr0x1ed by vapor's static sj --\x3e",
	},
};

/** @type {{ origin: string, html: string, css: string, js: string } | undefined} */
let playgroundData;

/**
 * @param {string} pattern
 * @returns {RegExp}
 */
function toRegex(pattern) {
	const escaped = pattern
		.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "{{DOUBLE_STAR}}")
		.replace(/\*/g, "[^/]*")
		.replace(/{{DOUBLE_STAR}}/g, ".*");
	return new RegExp(`^${escaped}$`);
}

/**
 * @param {string} hostname
 * @param {string} pathname
 * @returns {boolean}
 */
function isBlocked(hostname, pathname) {
	return CONFIG.blocked.some((pattern) => {
		if (pattern.startsWith("#")) {
			pattern = pattern.substring(1);
		}
		if (pattern.startsWith("*")) {
			pattern = pattern.substring(1);
		}

		if (pattern.includes("/")) {
			const [hostPattern, ...pathParts] = pattern.split("/");
			const pathPattern = pathParts.join("/");
			const hostRegex = toRegex(hostPattern);
			const pathRegex = toRegex(`/${pathPattern}`);
			return hostRegex.test(hostname) && pathRegex.test(pathname);
		}
		const hostRegex = toRegex(pattern);
		return hostRegex.test(hostname);
	});
}

/**
 * @param {string} html
 * @returns {string}
 */
function inject(html) {
	return html.replace(/<head[^>]*>/i, (match) => `${match}${CONFIG.inject.html}`);
}

/**
 * Fetch with one automatic retry on network failure.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(request) {
	try {
		return await fetch(request);
	} catch (firstErr) {
		console.warn("[mochii sw] fetch failed, retrying once:", firstErr);
		try {
			// Clone needed because the body stream may have been consumed
			return await fetch(request.clone ? request.clone() : request);
		} catch (secondErr) {
			console.error("[mochii sw] fetch retry also failed:", secondErr);
			throw secondErr;
		}
	}
}

/**
 * @param {FetchEvent} event
 * @returns {Promise<Response>}
 */
async function handleRequest(event) {
	await scramjet.loadConfig();

	if (scramjet.route(event)) {
		let response;
		try {
			response = await scramjet.fetch(event);
		} catch (err) {
			console.error("[mochii sw] scramjet.fetch failed:", err);
			return new Response(
				`<html><body style="background:#111;color:#fff;font-family:sans-serif;padding:2rem">
					<h2>⚠️ Proxy Error</h2>
					<p>Scramjet couldn't load this page. This is usually a Wisp server issue.</p>
					<p style="opacity:.6;font-size:13px">${err.message}</p>
					<button onclick="location.reload()" style="margin-top:1rem;padding:8px 18px;border-radius:8px;border:none;background:#7c3aed;color:#fff;cursor:pointer">Retry</button>
				</body></html>`,
				{ status: 503, headers: { "content-type": "text/html" } }
			);
		}

		const contentType = response.headers.get("content-type") || "";

		if (contentType.includes("text/html")) {
			const originalText = await response.text();
			const modifiedHtml = inject(originalText);
			const encoder = new TextEncoder();
			const byteLength = encoder.encode(modifiedHtml).length;
			const newHeaders = new Headers(response.headers);
			newHeaders.set("content-length", byteLength.toString());

			return new Response(modifiedHtml, {
				status: response.status,
				statusText: response.statusText,
				headers: newHeaders,
			});
		}

		return response;
	}

	return fetchWithRetry(event.request);
}

self.addEventListener("install", () => {
	// Take control immediately so new SW activates without a page reload
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	// Claim all existing clients so they use the new SW right away
	event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
	const url = event.request.url;

	if (url.includes("supabase.co")) {
		return;
	}

	event.respondWith(handleRequest(event));
});

self.addEventListener("message", ({ data }) => {
	if (data.type === "playgroundData") {
		playgroundData = data;
	}
});

scramjet.addEventListener("request", (e) => {
	if (isBlocked(e.url.hostname, e.url.pathname)) {
		e.response = new Response("Site Blocked", { status: 403 });
		return;
	}

	if (playgroundData && e.url.href.startsWith(playgroundData.origin)) {
		const routes = {
			"/": { content: playgroundData.html, type: "text/html" },
			"/style.css": { content: playgroundData.css, type: "text/css" },
			"/script.js": { content: playgroundData.js, type: "application/javascript" },
		};

		const route = routes[e.url.pathname];

		if (route) {
			let content = route.content;

			if (route.type === "text/html") {
				content = inject(content);
			}

			const headers = { "content-type": route.type };
			e.response = new Response(content, { headers });
			e.response.rawHeaders = headers;
			e.response.rawResponse = {
				body: e.response.body,
				headers: headers,
				status: e.response.status,
				statusText: e.response.statusText,
			};
			e.response.finalURL = e.url.toString();
		} else {
			e.response = new Response("empty response", { headers: {} });
		}
	}
});
