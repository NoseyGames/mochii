try {
  importScripts('/ultrav/uv.bundle.js');
  importScripts('/ultrav/uv.config.js');
} catch (e) {
  console.error("Failed to import Ultraviolet scripts:", e);
}

const uv = new UVServiceWorker();

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  event.respondWith(
    (async () => {
      if (event.request.url.startsWith(location.origin + __uv$config.prefix)) {
        return await uv.fetch(event);
      }
      return await fetch(event.request);
    })()
  );
});
