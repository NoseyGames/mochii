importScripts('/ultrav/uv.bundle.js');
importScripts('/ultrav/uv.config.js');

const uv = new UVServiceWorker();

self.addEventListener('fetch', (event) => {
  if (event.request.url.startsWith(location.origin + __uv$config.prefix)) {
    event.respondWith(uv.fetch(event));
  }
});
