"use strict";
/**
 * @type {HTMLFormElement}
 */
const form = document.getElementById("uv-form-test");
/**
 * @type {HTMLInputElement}
 */
const address = document.getElementById("uv-addressloc");
/**
 * @type {HTMLInputElement}
 */
const searchEngine = document.getElementById("uv-search-enginepref");

// Wait for config to load
window.addEventListener('load', () => {
  setupForm();
});

function setupForm() {
  if (!form || !address || !searchEngine) {
    console.error('Form elements not found');
    return;
  }
  
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    console.log('Form submitted');

    try {
      if (navigator.serviceWorker) {
        await registerSW();
      }
    } catch (err) {
      console.error('Service worker registration error:', err);
    }

    const url = search(address.value, searchEngine.value);
    if (url) {
      try {
        console.log('Original URL:', url);
        const encoded = __uv$config.encodeUrl(url);
        const proxyUrl = __uv$config.prefix + encoded;
        console.log('Proxy URL:', proxyUrl);
        location.href = proxyUrl;
      } catch (err) {
        console.error('Encoding error:', err);
        alert('Error: Could not encode URL. Check console for details.');
      }
    } else {
      alert('Please enter a valid URL or search term');
    }
  });

  // Allow Enter key to submit
  address.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      form.dispatchEvent(new Event('submit'));
    }
  });

  console.log('Form setup complete');
}
