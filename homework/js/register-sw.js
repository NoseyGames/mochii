"use strict";

const stockSW = "/homework/uv/sw.js";
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
    // First unregister any existing registrations
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (let registration of registrations) {
      if (registration.scope.includes('/homework/')) {
        await registration.unregister();
      }
    }

    // Register with correct scope
    const registration = await navigator.serviceWorker.register(stockSW, {
      scope: '/homework/'
    });
    console.log('Service worker registered with scope:', registration.scope);
    return registration;
  } catch (err) {
    console.error('Service worker registration failed:', err);
    throw err;
  }
}

// Auto-register service worker on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => registerSW().catch(err => console.log('SW registration error:', err)), 500);
  });
} else {
  setTimeout(() => registerSW().catch(err => console.log('SW registration error:', err)), 500);
}
