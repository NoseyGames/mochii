importScripts('/ultrav/uv.bundle.js');
importScripts('/ultrav/uv.config.js');

const uv = new UVServiceWorker();

self.addEventListener('fetch', event => {
  event.respondWith(
    uv.fetch(event)
  );
});
