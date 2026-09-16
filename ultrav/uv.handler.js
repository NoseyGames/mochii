/**
 * @type {import('../uv').UltravioletCtor}
 */
const Ultraviolet = self.Ultraviolet;

/**
 * @type {import('../uv').UVClientCtor}
 */
const UVClient = self.UVClient;

/**
 * @type {import('../uv').UVConfig}
 */
const __uv$config = self.__uv$config;

/**
 * @type {string}
 */
const __uv$cookies = self.__uv$cookies;

if (typeof __uv$cookies !== "string")
	throw new TypeError("Unable to load global UV data");

if (!self.__uv) __uvHook(self);

self.__uvHook = __uvHook;

/**
 *
 * @param {typeof globalThis} window
 * @returns
 */
function __uvHook(window) {
	if ("__uv" in window && window.__uv instanceof Ultraviolet) return false;

	if (window.document && !!window.window) {
		window.document
			.querySelectorAll("script[__uv-script]")
			.forEach((node) => node.remove());
	}

	const worker = !window.window;
	const master = "__uv";
	const methodPrefix = "__uv$";
	const __uv = new Ultraviolet(__uv$config);

	/*if (typeof config.construct === 'function') {
        config.construct(__uv, worker ? 'worker' : 'window');
    }*/
	let bareClient;
	if (!worker) {
		// websockets
		bareClient = new Ultraviolet.BareClient();
	} else {
		bareClient = new Ultraviolet.BareClient(
			new Promise((resolve) => {
				addEventListener("message", ({ data }) => {
					if (typeof data !== "object") return;
					if ("__uv$type" in data && data.__uv$type === "baremuxinit") {
						resolve(data.port);
					}
				});
			})
		);
	}

	const client = new UVClient(window, bareClient, worker);
	const {
		HTMLMediaElement,
		HTMLScriptElement,
		HTMLAudioElement,
		HTMLVideoElement,
		HTMLInputElement,
		HTMLEmbedElement,
		HTMLTrackElement,
		HTMLAnchorElement,
		HTMLIFrameElement,
		HTMLAreaElement,
		HTMLLinkElement,
		HTMLBaseElement,
		HTMLFormElement,
		HTMLImageElement,
		HTMLSourceElement,
	} = window;

	client.nativeMethods.defineProperty(window, "__uv", {
		value: __uv,
		enumerable: false,
	});

	__uv.meta.origin = location.origin;
	__uv.location = client.location.emulate(
		(href) => {
			if (href === "about:srcdoc") return new URL(href);
			if (href.startsWith("blob:")) href = href.slice("blob:".length);
			return new URL(__uv.sourceUrl(href));
		},
		(href) => {
			return __uv.rewriteUrl(href);
		}
	);

	let cookieStr = __uv$cookies;

	__uv.meta.url = __uv.location;
	__uv.domain = __uv.meta.url.host;
	__uv.blobUrls = new window.Map();
	__uv.referrer = "";
	__uv.cookies = [];
	__uv.localStorageObj = {};
	__uv.sessionStorageObj = {};

	if (__uv.location.href === "about:srcdoc") {
		__uv.meta = window.parent.__uv.meta;
	}

	if (window.EventTarget) {
		__uv.addEventListener = window.EventTarget.prototype.addEventListener;
		__uv.removeListener = window.EventTarget.prototype.removeListener;
		__uv.dispatchEvent = window.EventTarget.prototype.dispatchEvent;
	}

	// Storage wrappers
	client.nativeMethods.defineProperty(
		client.storage.storeProto,
		"__uv$storageObj",
		{
			get() {
				if (this === client.storage.sessionStorage)
					return __uv.sessionStorageObj;
				if (this === client.storage.localStorage) return __uv.localStorageObj;
			},
			enumerable: false,
		}
	);

	if (window.localStorage) {
		for (const key in window.localStorage) {
			if (key.startsWith(methodPrefix + __uv.location.origin + "@")) {
				__uv.localStorageObj[
					key.slice((methodPrefix + __uv.location.origin + "@").length)
				] = window.localStorage.getItem(key);
			}
		}

		__uv.lsWrap = client.storage.emulate(
			client.storage.localStorage,
			__uv.localStorageObj
		);
	}

	if (window.sessionStorage) {
		for (const key in window.sessionStorage) {
			if (key.startsWith(methodPrefix + __uv.location.origin + "@")) {
				__uv.sessionStorageObj[
					key.slice((methodPrefix + __uv.location.origin + "@").length)
				] = window.sessionStorage.getItem(key);
			}
		}

		__uv.ssWrap = client.storage.emulate(
			client.storage.sessionStorage,
			__uv.sessionStorageObj
		);
	}
}
