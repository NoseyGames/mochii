/*global UVServiceWorker,__uv$config*/
/*
 * Stock service worker script for Ultraviolet proxy
 */
importScripts('uv.bundle.js');
importScripts('uv.config.js');
importScripts(__uv$config.sw || 'uv.sw.js');

const sw = new UVServiceWorker();

self.addEventListener('fetch', (event) => {
  try {
    event.respondWith(sw.fetch(event));
  } catch (err) {
    console.error('Service worker fetch error:', err);
  }
});
