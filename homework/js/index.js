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
/**
 * @type {HTMLParagraphElement}
 */
const error = document.getElementById("uv-error");
/**
 * @type {HTMLPreElement}
 */
const errorCode = document.getElementById("uv-error-code");

// Wait for config to load
window.addEventListener('load', () => {
  setupForm();
});

function setupForm() {
  if (!form) return;
  
  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      await registerSW();
    } catch (err) {
      console.error('Service worker registration error:', err);
    }

    const url = search(address.value, searchEngine.value);
    if (url) {
      try {
        const encoded = __uv$config.encodeUrl(url);
        location.href = __uv$config.prefix + encoded;
      } catch (err) {
        console.error('Encoding error:', err);
        location.href = __uv$config.prefix + encodeURIComponent(url);
      }
    }
  });

  // Allow Enter key to submit
  address.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      form.dispatchEvent(new Event('submit'));
    }
  });
}
