/* --------------------------- Auto-refresh ----------------------------- */
// Facebook's live message sync sometimes stalls inside a system WebView, so
// the open conversation can lag behind. Reload to catch up: at least once per
// new-message notification, plus a periodic refresh while in the background.
// A reload is deferred while a message is half-typed so a draft is never lost.

export function initAutoRefresh() {
  // A full reload re-boots the whole Facebook SPA — seconds of CPU — so gate
  // it on *staleness*, not a fixed cadence. The page counts as fresh while
  // focused (live sync works there) and right after a reload; only once it
  // has been unfocused long enough does the periodic refresh kick in. The
  // reload doubles as a memory bound: it resets Facebook's ever-growing heap.
  const PERIODIC_MS = 15 * 60 * 1000; // reload after this long unfocused
  const NOTIF_GAP_MS = 5 * 60 * 1000; // floor between notification reloads
  let lastFresh = Date.now();
  let pending = false;
  let timer: number | undefined;
  const clearPending = () => {
    pending = false;
    clearTimeout(timer);
    timer = undefined;
    lastFresh = Date.now();
  };
  const composerHasText = () => {
    try {
      for (const el of document.querySelectorAll('[contenteditable="true"]')) {
        if ((el.textContent || "").trim().length > 0) return true;
      }
    } catch (_) {}
    return false;
  };
  // A visible window can be intentionally left unfocused on another monitor.
  // Treat visibility as active reading just like keyboard focus.
  const pageIsActive = () => !document.hidden || document.hasFocus();
  const maybeReload = () => {
    timer = undefined;
    if (!pending) return;
    if (pageIsActive()) {
      clearPending();
      return;
    }
    // Never yank the page out from under a draft or an in-progress call.
    if (composerHasText() || window.__carrierInCall) {
      timer = setTimeout(maybeReload, 8000);
      return;
    }
    pending = false;
    lastFresh = Date.now();
    location.reload();
  };
  const schedule = (delay: number) => {
    if (pageIsActive()) {
      lastFresh = Date.now();
      return;
    }
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(maybeReload, delay);
  };
  window.addEventListener("focus", clearPending);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) clearPending();
  });
  // Reload shortly after a new-message notification, but only while the window
  // is unfocused — that's when Facebook's live sync throttles and the view
  // goes stale. When you're actively reading, live sync works, so we leave the
  // page alone. (Debounced to batch a burst of notifications into one reload;
  // the gap floor keeps a chatty thread from reloading every few minutes.)
  window.__carrierOnNotification = () => {
    if (!pageIsActive() && Date.now() - lastFresh >= NOTIF_GAP_MS) schedule(4000);
  };
  // Regular refresh so an unfocused, stale window keeps catching up. The
  // tradeoff: a badge cleared by reading on another device can take up to
  // PERIODIC_MS to clear while hidden; it corrects instantly on focus.
  setInterval(() => {
    if (pageIsActive()) {
      lastFresh = Date.now();
      return;
    }
    if (Date.now() - lastFresh >= PERIODIC_MS) schedule(2000);
  }, 60 * 1000);
}
