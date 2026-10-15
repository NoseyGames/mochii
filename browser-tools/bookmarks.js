import { bindOverlay } from './dialog-controller.js';

export const bookmarkKey = 'mochii.browser.bookmarks.v1';
export function bookmarkUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) throw new Error('Enter a complete HTTP or HTTPS address without spaces.');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS address without login details.');
  return url.href;
}
export function normalizeBookmarks(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set(), ids = new Set(), list = [];
  for (const item of value.slice(0, 40)) {
    try {
      const url = bookmarkUrl(item?.url);
      if (seen.has(url)) continue;
      let id = typeof item.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(item.id) ? item.id : `bookmark-${list.length}`;
      let suffix = 0;
      while (ids.has(id)) id = `bookmark-${list.length}-${++suffix}`;
      ids.add(id); seen.add(url);
      list.push({ id, title: String(item.title || new URL(url).hostname).trim().slice(0, 120) || new URL(url).hostname, url });
    } catch {}
  }
  return list;
}
export function createBookmarkStore(storage) {
  let entries = [];
  function reload() { try { entries = normalizeBookmarks(JSON.parse(storage.getItem(bookmarkKey) || '[]')); } catch { entries = []; } return entries.map(item => ({ ...item })); }
  reload();
  return {
    list: () => entries.map(item => ({ ...item })), reload,
    save(next) {
      const normalized = normalizeBookmarks(next);
      try { storage.setItem(bookmarkKey, JSON.stringify(normalized)); } catch { throw new Error('Bookmarks could not be saved. Browser storage may be full or disabled.'); }
      entries = normalized;
      return this.list();
    }
  };
}
export function restoreDeletedBookmark(entries, deleted) {
  if (!deleted || entries.some(item => item.id === deleted.item.id || item.url === deleted.item.url)) return entries;
  if (entries.length >= 40) throw new Error('Remove a bookmark before restoring this one; the limit is 40.');
  const result = entries.slice();
  result.splice(Math.min(deleted.index, result.length), 0, deleted.item);
  return result;
}
export function upsertBookmark(entries, { editing = null, title = '', url }) {
  const address = bookmarkUrl(url);
  const edited = editing === null ? null : entries.find(item => item.id === editing);
  if (editing !== null && !edited) throw new Error('This bookmark is no longer available. Cancel editing to add it again.');
  const duplicate = entries.find(item => item.url === address && item.id !== editing);
  if (edited && duplicate) throw new Error('That address is already saved in another bookmark.');
  const existing = edited || duplicate;
  if (!existing && entries.length >= 40) throw new Error('You can save up to 40 bookmarks.');
  const item = { id: existing?.id || `bookmark-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`, title: String(title).trim().slice(0, 120) || new URL(address).hostname, url: address };
  return existing ? entries.map(entry => entry.id === existing.id ? item : entry) : [...entries, item];
}

export function mountBookmarks(win) {
  const doc = win.document;
  const quick = doc.getElementById('home-shortcuts');
  if (!quick) return null;
  let storage;
  try { storage = win.localStorage; } catch { storage = { getItem: () => null, setItem: () => { throw new Error('Unavailable'); } }; }
  const store = createBookmarkStore(storage);
  const el = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };
  const button = (text, fn, label = text) => { const node = el('button', 'viewer-btn', text); node.type = 'button'; node.setAttribute('aria-label', label); node.addEventListener('click', fn); return node; };
  const overlay = el('div', 'overlay-backdrop'); overlay.id = 'bookmarks-dialog'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-labelledby', 'bookmarks-heading');
  const card = el('div', 'modal-card'), header = el('div', 'modal-header'), heading = el('h2', 'modal-title', 'Bookmarks'); heading.id = 'bookmarks-heading';
  const closeButton = button('×', () => dialog.close(), 'Close bookmarks'); closeButton.className = 'close-btn';
  header.append(heading, closeButton);
  const body = el('div', 'bookmark-body'), form = el('form', 'bookmark-form'), title = el('input'), url = el('input');
  title.maxLength = 120; title.placeholder = 'Name'; title.setAttribute('aria-label', 'Bookmark name');
  url.type = 'url'; url.required = true; url.maxLength = 4096; url.placeholder = 'https://example.com'; url.setAttribute('aria-label', 'Bookmark address');
  const submit = el('button', 'viewer-btn', 'Add bookmark'); submit.type = 'submit';
  const cancel = button('Cancel edit', () => resetForm()); cancel.hidden = true;
  form.append(title, url, submit, cancel);
  const status = el('p', 'setting-desc'); status.setAttribute('role', 'status');
  const list = el('div', 'bookmark-list'), undo = button('Undo delete', () => {
    try { if (deleted && save(restoreDeletedBookmark(store.list(), deleted))) { deleted = null; undo.hidden = true; } }
    catch (error) { status.textContent = error.message; }
  }); undo.hidden = true;
  body.append(form, status, undo, list); card.append(header, body); overlay.append(card); doc.body.append(overlay);
  let editing = null, deleted = null;
  const dialog = bindOverlay(win, { element: overlay, initialFocus: () => url });
  function resetForm() { editing = null; title.value = ''; url.value = ''; submit.textContent = 'Add bookmark'; cancel.hidden = true; }
  function save(entries) {
    try { store.save(entries); status.textContent = 'Saved on this device.'; render(); return true; }
    catch (error) { status.textContent = error.message; return false; }
  }
  function move(id, step) {
    const entries = store.list(), at = entries.findIndex(item => item.id === id), next = at + step;
    if (at < 0 || next < 0 || next >= entries.length) return;
    [entries[at], entries[next]] = [entries[next], entries[at]]; save(entries);
    list.querySelector(`[data-bookmark-id="${id}"] button`)?.focus();
  }
  function openBookmark(item) { dialog.close(); win.openViewer(item.title, 'Bookmark', item.url, true); }
  function render() {
    quick.replaceChildren(); list.replaceChildren();
    const entries = store.list();
    for (const item of entries.slice(0, 6)) quick.append(button(item.title, () => openBookmark(item)));
    quick.append(button(entries.length ? 'Edit bookmarks' : '+ Bookmark', () => api.open()));
    if (!entries.length) list.append(el('p', 'setting-desc', 'Save a few sites for quick access. Bookmarks stay on this device.'));
    entries.forEach((item, index) => {
      const row = el('div', 'bookmark-row'); row.dataset.bookmarkId = item.id;
      const launch = button(item.title, () => openBookmark(item)); launch.title = item.url; launch.className = 'bookmark-link';
      const actions = el('div', 'bookmark-actions');
      const edit = button('Edit', () => { editing = item.id; title.value = item.title; url.value = item.url; submit.textContent = 'Save changes'; cancel.hidden = false; title.focus(); }, `Edit ${item.title}`);
      const up = button('↑', () => move(item.id, -1), `Move ${item.title} up`); up.disabled = index === 0;
      const down = button('↓', () => move(item.id, 1), `Move ${item.title} down`); down.disabled = index === entries.length - 1;
      const remove = button('Delete', () => { const before = store.list(); if (save(before.filter(entry => entry.id !== item.id))) { deleted = { item, index }; undo.hidden = false; if (editing === item.id) resetForm(); } }, `Delete ${item.title}`);
      actions.append(edit, up, down, remove); row.append(launch, actions); list.append(row);
    });
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    try {
      const address = bookmarkUrl(url.value.trim());
      if (new URL(address).origin === win.location.origin) throw new Error('Save the website address shown in the browser bar.');
      if (save(upsertBookmark(store.list(), { editing, title: title.value, url: address }))) resetForm();
    } catch (error) { status.textContent = error.message || 'Enter a valid website address.'; }
  });
  const api = {
    close: () => dialog.close(),
    open(current) {
      win.closeGamesPopover?.(); win.closeAppsPopover?.(); win.closeSettingsModal?.();
      resetForm(); status.textContent = ''; render(); dialog.open();
      if (current) { title.value = current.title || ''; url.value = current.url || ''; title.focus(); }
    }
  };
  win.addEventListener('mochii:library-import', event => { if (event.detail?.keys?.includes(bookmarkKey)) { deleted = null; undo.hidden = true; store.reload(); render(); } });
  win.addEventListener('storage', event => { if (event.key === bookmarkKey || event.key === null) { deleted = null; undo.hidden = true; store.reload(); render(); } });
  doc.getElementById('browser-bookmark')?.addEventListener('click', () => {
    const address = doc.getElementById('browser-url')?.value || '';
    win.hideViewer?.(); api.open({ title: doc.getElementById('viewer-title')?.textContent || '', url: address });
  });
  render();
  win.MochiiBookmarks = api;
  return api;
}
