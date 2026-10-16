export function bindOverlay(win, { element, open, close, initialFocus, onClose = () => {} }) {
  const doc = win.document;
  let opener;
  const isOpen = () => element.classList.contains('active');
  const sync = () => { element.inert = !isOpen(); element.setAttribute('aria-hidden', String(!isOpen())); };
  const controller = {
    isOpen,
    open(...args) {
      if (!isOpen()) opener = doc.activeElement;
      const result = open?.(...args);
      element.classList.add('active'); sync();
      (initialFocus?.() || element.querySelector('button, input, select'))?.focus?.({ preventScroll: true });
      return result;
    },
    close(...args) {
      const active = isOpen();
      const result = close?.(...args);
      element.classList.remove('active'); sync();
      if (active) {
        onClose();
        if (opener?.isConnected !== false) opener?.focus?.({ preventScroll: true });
      }
      return result;
    }
  };
  element.addEventListener('click', event => { if (event.target === element) controller.close(); });
  element.addEventListener('keydown', event => {
    if (!isOpen()) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); controller.close(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...element.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]')]
      .filter(input => !input.disabled && input.tabIndex >= 0 && input.getClientRects().length > 0);
    const first = controls[0], last = controls.at(-1);
    if (!first) { event.preventDefault(); element.focus?.(); }
    else if (event.shiftKey && (doc.activeElement === first || !element.contains(doc.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (doc.activeElement === last || !element.contains(doc.activeElement))) { event.preventDefault(); first.focus(); }
  });
  sync();
  return controller;
}

export function mountCatalogDialogs(win) {
  for (const [id, openName, closeName, focusId] of [
    ['games-popover', 'openGamesPopover', 'closeGamesPopover', 'popover-search-input'],
    ['apps-popover', 'openAppsPopover', 'closeAppsPopover', 'apps-search-input']
  ]) {
    const element = win.document.getElementById(id);
    if (!element || typeof win[openName] !== 'function') continue;
    const controller = bindOverlay(win, { element, open: win[openName], close: win[closeName], initialFocus: () => win.document.getElementById(focusId) });
    win[openName] = (...args) => { win.MochiiBookmarks?.close(); win.closeSettingsModal?.(); win.MochiiMusic?.close?.(); return controller.open(...args); };
    win[closeName] = controller.close;
  }
}
