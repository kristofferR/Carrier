/* --------------------------- Force theme ------------------------------ */
// Force the Messenger page theme to the user's choice (Settings → Theme). The
// native window chrome is driven Rust-side from the same setting.

export function initForceTheme() {
  const html = document.documentElement;
  // Track the class we forced so switching back to "system" can undo it live
  // (settings re-apply on the same page without a reload — see chatpane:settings).
  let forcedClass: string | null = null;
  const apply = () => {
    const forced = window.__CHATPANE_SETTINGS__?.theme;
    if (forced !== "light" && forced !== "dark") {
      // "system": drop any class we previously forced, then leave FB alone.
      if (forcedClass) {
        html.classList.remove(forcedClass);
        forcedClass = null;
      }
      return;
    }
    const want = forced === "dark" ? "__fb-dark-mode" : "__fb-light-mode";
    const other = forced === "dark" ? "__fb-light-mode" : "__fb-dark-mode";
    if (!html.classList.contains(want) || html.classList.contains(other)) {
      html.classList.remove(other);
      html.classList.add(want);
    }
    forcedClass = want;
  };
  apply();
  window.addEventListener("chatpane:settings", apply);
  // Re-assert if Facebook flips its own class back.
  new MutationObserver(apply).observe(html, { attributes: true, attributeFilter: ["class"] });
}

/* --------------------------- Theme markers ----------------------------- */
// Mark <html> while Messenger renders dark, so theme files (Settings → Theme)
// can key their dark colors on it. Messenger follows the webview's color
// scheme, which Chatpane sets from the light/dark choice, so the media query is
// the source of truth. The second name keeps themes written for other
// Messenger apps working unchanged.
const DARK_MARKERS = ["data-carrier-dark", "data-fmess-dark"];

export function initThemeMarkers() {
  const html = document.documentElement;
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    for (const marker of DARK_MARKERS) {
      if (query.matches) html.setAttribute(marker, "");
      else html.removeAttribute(marker);
    }
  };
  apply();
  query.addEventListener("change", apply);
}
