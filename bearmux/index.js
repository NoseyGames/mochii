(function (global, factory) {
	typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
	typeof define === 'function' && define.amd ? define(['exports'], factory) :
	(global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.BareMux = {}));
})(this, (function (exports) { 'use strict';

	const maxRedirects = 20;

	                                                                                       
	                                                                                                        
	const fetch = globalThis.fetch;
	const WebSocket = globalThis.WebSocket;
	const Request = globalThis.Request;
	const Response = globalThis.Response;
	const WebSocketFields = {
	    prototype: {
	        send: WebSocket.prototype.send,
	    },
	    CLOSED: WebSocket.CLOSED,
	    CLOSING: WebSocket.CLOSING,
	    CONNECTING: WebSocket.CONNECTING,
	    OPEN: WebSocket.OPEN,
	};

	async function searchForPort() {
	                       
	    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
	    const promise = Promise.race([...clients.map((x) => tryGetPort(x)), new Promise((_, reject) => setTimeout(reject, 1000, new Error("")))]);
	    try {
	        return await promise;
	    }
	    catch {
	        console.warn("bare-mux: failed to get a bare-mux SharedWorker MessagePort within 1s, retrying");
	        return await searchForPort();
	    }
	}
	function tryGetPort(client) {
	    let channel = new MessageChannel();
	    return new Promise(resolve => {
	        client.postMessage({ type: "getPort", port: channel.port2 }, [channel.port2]);
	        channel.port1.onmessage = event => {
	            resolve(event.data);
	        };
	    });
	}
	function createPort(path, channel, registerHandlers) {
	    const worker = new SharedWorker(path, "bare-mux-worker");
	    if (registerHandlers) {
	                                                            
	        if (navigator.serviceWorker) {
	            navigator.serviceWorker.addEventListener("message", event => {
	                if (event.data.type === "getPort" && event.data.port) {
	                    console.debug("bare-mux: recieved request for port from sw");
	                    const worker = new SharedWorker(path, "bare-mux-worker");
	                    event.data.port.postMessage(worker.port, [worker.port]);
	                }
	            });
	        }
	        channel.onmessage = (event) => {
	            if (event.data.type === "getPath") {
	                console.debug("bare-mux: recieved request for worker path from broadcast channel");
	                channel.postMessage({ type: "path", path: path });
	            }
	        };
	    }
	    return worker.port;
	}
	class WorkerConnection {
	    constructor(workerPath) {
	        this.channel = new BroadcastChannel("bare-mux");
	        this.createChannel(workerPath, true);
	    }
	    createChannel(workerPath, inInit) {
	                           
	        if (self.clients) {
	                                         
	                                                                         
	            this.port = searchForPort();
	            this.channel.onmessage = (event) => {
	                if (event.data.type === "refreshPort") {
	                    this.port = searchForPort();
	                }
	            };
	        }
	        else if (workerPath && SharedWorker) {
	                                                           
	                                                                                         
	            if (!workerPath.startsWith("/") && !workerPath.includes("://"))
	                throw new Error("Invalid URL. Must be absolute or start at the root.");
	            this.port = createPort(workerPath, this.channel, inInit);
	        }
	        else if (SharedWorker) {
	                                                               
	                                                            
	            this.port = new Promise(resolve => {
	                this.channel.onmessage = (event) => {
	                    if (event.data.type === "path") {
	                        resolve(createPort(event.data.path, this.channel, inInit));
	                    }
	                };
	                this.channel.postMessage({ type: "getPath" });
	            });
	        }
	        else {
	                                          
	            throw new Error("Unable to get a channel to the SharedWorker.");
	        }
	    }
	    async sendMessage(message, transferable) {
	        if (this.port instanceof Promise)
	            this.port = await this.port;
	        const pingChannel = new MessageChannel();
	        const pingPromise = new Promise((resolve, reject) => {
	            pingChannel.port1.onmessage = event => {
	                if (event.data.type === "pong") {
	                    resolve();
	                }
	            };
	            setTimeout(reject, 1500);
	        });
	        this.port.postMessage({ message: { type: "ping" }, port: pingChannel.port2 }, [pingChannel.port2]);
	        try {
	            await pingPromise;
	        }
	        catch {
	            console.warn("bare-mux: Failed to get a ping response from the worker within 1.5s. Assuming port is dead.");
	            this.createChannel();
	            return await this.sendMessage(message, transferable);
	        }
	        const channel = new MessageChannel();
	        const toTransfer = [channel.port2, ...(transferable || [])];
	        const promise = new Promise((resolve, reject) => {
	            channel.port1.onmessage = event => {
	                const message = event.data;
	                if (message.type === "error") {
	                    reject(message.error);
	                }
	                else {
	                    resolve(message);
	                }
	            };
	        });
	        this.port.postMessage({ message: message, port: channel.port2 }, toTransfer);
	        return await promise;
	    }
	}

	const validChars = "!#$%&'*+-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ^_`abcdefghijklmnopqrstuvwxyz|~";
	function validProtocol(protocol) {
	    for (let i = 0; i < protocol.length; i++) {
	        const char = protocol[i];
	        if (!validChars.includes(char)) {
	            return false;
	        }
	    }
	    return true;
	}
	                         
	Object.getOwnPropertyDescriptor(WebSocket.prototype, 'readyState').get;
	const wsProtocols = ['ws:', 'wss:'];
	const statusEmpty = [101, 204, 205, 304];
	const statusRedirect = [301, 302, 303, 307, 308];
	class BareMuxConnection {
	    constructor(workerPath) {
	        this.worker = new WorkerConnection(workerPath);
	    }
	    async getTransport() {
	        return (await this.worker.sendMessage({ type: "get" })).name;
	    }
	    async setTransport(path, options) {
	        await this.setManualTransport(`
			const { default: BareTransport } = await import("${path}");
			return [new BareTransport(${options.map(x => JSON.stringify(x)).join(", ")}), "${path}"];
		`);
	    }
	    async setManualTransport(functionBody) {
	        await this.worker.sendMessage({
	            type: "set",
	            client: functionBody,
	        });
	    }
	}
	class BareClient {
	       
                                                                                                    
        
	    constructor(workerPath) {
	        this.worker = new WorkerConnection(workerPath);
	    }
	    createWebSocket(remote, protocols = [], webSocketImpl, requestHeaders, arrayBufferImpl) {
	        try {
	            remote = new URL(remote);
	        }
	        catch (err) {
	            throw new DOMException(`Faiiled to construct 'WebSocket': The URL '${remote}' is invalid.`);
	        }
	        if (!wsProtocols.includes(remote.protocol))
	            throw new DOMException(`Failed to construct 'WebSocket': The URL's scheme must be either 'ws' or 'wss'. '${remote.protocol}' is not allowed.`);
	        if (!Array.isArray(protocols))
	            protocols = [protocols];
	        protocols = protocols.map(String);
	        for (const proto of protocols)
	            if (!validProtocol(proto))
	                throw new DOMException(`Failed to construct 'WebSocket': The subprotocol '${proto}' is invalid.`);
	        let wsImpl = (webSocketImpl || WebSocket);
	        const socket = new wsImpl("ws://127.0.0.1:1", protocols);
	        let fakeProtocol = '';
	        let fakeReadyState = WebSocketFields.CONNECTING;
	        let initialErrorHappened = false;
	        socket.addEventListener("error", (e) => {
	            if (!initialErrorHappened) {
	                fakeReadyState = WebSocket.CONNECTING;
	                e.stopImmediatePropagation();
	                initialErrorHappened = true;
	            }
	        });
	        let initialCloseHappened = false;
	        socket.addEventListener("close", (e) => {
	            if (!initialCloseHappened) {
	                e.stopImmediatePropagation();
	                initialCloseHappened = true;
	            }
	        });
	                                             
	        arrayBufferImpl = arrayBufferImpl || wsImpl.constructor.constructor("return ArrayBuffer")().prototype;
	        requestHeaders = requestHeaders || {};
	        requestHeaders['Host'] = (new URL(remote)).host;
	                                             
	        requestHeaders['Pragma'] = 'no-cache';
	        requestHeaders['Cache-Control'] = 'no-cache';
	        requestHeaders['Upgrade'] = 'websocket';
	                                                              
	        requestHeaders['Connection'] = 'Upgrade';
	        const onopen = (protocol) => {
	            fakeReadyState = WebSocketFields.OPEN;
	            fakeProtocol = protocol;
	            socket.meta = {
	                headers: {
	                    "sec-websocket-protocol": protocol,
	                }
	            };                           
	            socket.dispatchEvent(new Event("open"));
	        };
	        const onmessage = async (payload) => {
	            if (typeof payload === "string") {
	                socket.dispatchEvent(new MessageEvent("message", { data: payload }));
	            }
	            else if ("byteLength" in payload) {
	                if (socket.binaryType === "blob") {
	                    payload = new Blob([payload]);
	                }
	                else {
	                    Object.setPrototypeOf(payload, arrayBufferImpl);
	                }
	                socket.dispatchEvent(new MessageEvent("message", { data: payload }));
	            }
	            else if ("arrayBuffer" in payload) {
	                if (socket.binaryType === "arraybuffer") {
	                    payload = await payload.arrayBuffer();
	                    Object.setPrototypeOf(payload, arrayBufferImpl);
	                }
	                socket.dispatchEvent(new MessageEvent("message", { data: payload }));
	            }
	        };
	        const onclose = (code, reason) => {
	            fakeReadyState = WebSocketFields.CLOSED;
	            socket.dispatchEvent(new CloseEvent("close", { code, reason }));
	        };
	        const onerror = () => {
	            fakeReadyState = WebSocketFields.CLOSED;
	            socket.dispatchEvent(new Event("error"));
	        };
	        const channel = new MessageChannel();
	        channel.port1.onmessage = event => {
	            if (event.data.type === "open") {
	                onopen(event.data.args[0]);
	            }
	            else if (event.data.type === "message") {
	                onmessage(event.data.args[0]);
	            }
	            else if (event.data.type === "close") {
	                onclose(event.data.args[0], event.data.args[1]);
	            }
	            else if (event.data.type === "error") {
	                onerror(                         );
	            }
	        };
	        this.worker.sendMessage({
	            type: "websocket",
	            websocket: {
	                url: remote.toString(),
	                origin: origin,
	                protocols: protocols,
	                requestHeaders: requestHeaders,
	                channel: channel.port2,
	            },
	        }, [channel.port2]);
	                                                        
	                                               
	                                                                    
	        const getReadyState = () => fakeReadyState;
	                                                
	        Object.defineProperty(socket, 'readyState', {
	            get: getReadyState,
	            configurable: true,
	            enumerable: true,
	        });
	           
                                                                                                                                      
            
	        const getSendError = () => {
	            const readyState = getReadyState();
	            if (readyState === WebSocketFields.CONNECTING)
	                return new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.");
	        };
	                                          
	                                                                    
	                                                                                                                                                   
	        socket.send = function (...args) {
	            const error = getSendError();
	            if (error)
	                throw error;
	            let data = args[0];
	                                                  
	            if (data.buffer)
	                data = data.buffer;
	            channel.port1.postMessage({ type: "data", data: data }, data instanceof ArrayBuffer ? [data] : []);
	        };
	        socket.close = function (code, reason) {
	            channel.port1.postMessage({ type: "close", closeCode: code, closeReason: reason });
	        };
	        Object.defineProperty(socket, 'url', {
	            get: () => remote.toString(),
	            configurable: true,
	            enumerable: true,
	        });
	        const getProtocol = () => fakeProtocol;
	        Object.defineProperty(socket, 'protocol', {
	            get: getProtocol,
	            configurable: true,
	            enumerable: true,
	        });
	        return socket;
	    }
	    async fetch(url, init) {
	                                                                                                                   
	                                                
	        const req = new Request(url, init);
	                                                                             
	                                                                             
	                                                                                          
	        const inputHeaders = init?.headers || req.headers;
	        const headers = inputHeaders instanceof Headers
	            ? Object.fromEntries(inputHeaders)
	            : inputHeaders;
	        const body = req.body;
	        let urlO = new URL(req.url);
	        if (urlO.protocol.startsWith('blob:')) {
	            const response = await fetch(urlO);
	            const result = new Response(response.body, response);
	            result.rawHeaders = Object.fromEntries(response.headers);
	            result.rawResponse = response;
	            return result;
	        }
	        for (let i = 0;; i++) {
	            if ('host' in headers)
	                headers.host = urlO.host;
	            else
	                headers.Host = urlO.host;
	            let resp = (await this.worker.sendMessage({
	                type: "fetch",
	                fetch: {
	                    remote: urlO.toString(),
	                    method: req.method,
	                    headers: headers,
	                    body: body || undefined,
	                },
	            }, body ? [body] : [])).fetch;
	            let responseobj = new Response(statusEmpty.includes(resp.status) ? undefined : resp.body, {
	                headers: new Headers(resp.headers),
	                status: resp.status,
	                statusText: resp.statusText,
	            });
	            responseobj.rawHeaders = resp.headers;
	            responseobj.rawResponse = new Response(resp.body);
	            responseobj.finalURL = urlO.toString();
	            const redirect = init?.redirect || req.redirect;
	            if (statusRedirect.includes(responseobj.status)) {
	                switch (redirect) {
	                    case 'follow': {
	                        const location = responseobj.headers.get('location');
	                        if (maxRedirects > i && location !== null) {
	                            urlO = new URL(location, urlO);
	                            continue;
	                        }
	                        else
	                            throw new TypeError('Failed to fetch');
	                    }
	                    case 'error':
	                        throw new TypeError('Failed to fetch');
	                    case 'manual':
	                        return responseobj;
	                }
	            }
	            else {
	                return responseobj;
	            }
	        }
	    }
	}

	exports.BareClient = BareClient;
	exports.BareMuxConnection = BareMuxConnection;
	exports.WebSocketFields = WebSocketFields;
	exports.WorkerConnection = WorkerConnection;
	exports.default = BareClient;
	exports.maxRedirects = maxRedirects;
	exports.validProtocol = validProtocol;

	Object.defineProperty(exports, '__esModule', { value: true });

}));
                                 
