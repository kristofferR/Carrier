/* --------------------------- Force theme ------------------------------ */
// Force the Messenger page theme to the user's choice (Settings → Theme). The
// native window chrome is driven Rust-side from the same setting.

export function initForceTheme() {
  const html = document.documentElement;
  // Track the class we forced so switching back to "system" can undo it live
  // (settings re-apply on the same page without a reload — see carrier:settings).
  let forcedClass: string | null = null;
  const apply = () => {
    const forced = window.__CARRIER_SETTINGS__?.theme;
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
  window.addEventListener("carrier:settings", apply);
  // Re-assert if Facebook flips its own class back.
  new MutationObserver(apply).observe(html, { attributes: true, attributeFilter: ["class"] });
}
