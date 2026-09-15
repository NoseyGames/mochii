/* 
  Service Worker Entry Point for mochii 
  This intercepts iframe requests and routes them through the Ultraviolet backend
*/

importScripts('/uv/uv.bundle.js');
importScripts('/uv/uv.config.js');
importScripts('/uv/uv.sw.js');

// Initialize the UV proxy service worker class imported from uv.sw.js
const uv = new UVServiceWorker();

// Install Event: Activate immediately
self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
});

// Activate Event: Take control of all pages immediately
self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// Fetch Event: Intercept network requests
self.addEventListener('fetch', (event) => {
    event.respondWith(
        (async () => {
            // Check if the request is destined for the proxy prefix (e.g., /service/ or /uv/service/)
            if (event.request.url.startsWith(location.origin + __uv$config.prefix)) {
                // Route the request through Ultraviolet
                return await uv.fetch(event);
            }
            
            // Otherwise, let normal traffic (images, local css, etc) pass through normally
            return await fetch(event.request);
        })()
    );
});
