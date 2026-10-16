import { mountCatalogDialogs } from './dialog-controller.js';
import { mountBookmarks } from './bookmarks.js';

function mount() {
  mountCatalogDialogs(window);
  mountBookmarks(window);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
