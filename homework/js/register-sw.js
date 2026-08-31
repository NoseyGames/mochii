"use strict";

const stockSW = "/uv/sw.js";
const swAllowedHostnames = ["localhost", "127.0.0.1", "0.0.0.0"];

async function registerSW() {
  if (!navigator.serviceWorker) {
    if (
      location.protocol !== "https:" &&
      !swAllowedHostnames.includes(location.hostname)
    ) {
      console.warn("Service workers work best with HTTPS or localhost");
    }
    throw new Error("Your browser doesn't support service workers.");
  }

  try {
    const registration = await navigator.serviceWorker.register(stockSW, {
      scope: '/uv/'
    });
    console.log('Service worker registered:', registration);
    return registration;
  } catch (err) {
    console.error('Service worker registration failed:', err);
    throw err;
  }
}

// Auto-register service worker on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    registerSW().catch(err => console.log('SW registration error:', err));
  });
} else {
  registerSW().catch(err => console.log('SW registration error:', err));
}

// Periodic check for service worker
setInterval(() => {
  if (navigator.serviceWorker && !navigator.serviceWorker.controller) {
    registerSW().catch(err => console.log('Periodic SW registration error:', err));
  }
}, 5000);
