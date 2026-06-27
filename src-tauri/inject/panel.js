/*
 * Carrier — toast notifications, the check-for-updates flow, and the bridge
 * that opens the dedicated settings window (F3). The settings UI itself lives
 * in its own native window (dist/settings.html), not as an overlay.
 */
(function () {
  "use strict";

  // Subframes also receive init scripts (notably on Windows); only run in top.
  if (window.top !== window.self) return;

  // Internal bridge directly (no global window.__TAURI__ exposed to the page).
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__?.invoke(cmd, args);
  // Facebook is a remote origin and can't call Carrier's own commands, but it
  // *can* emit events (core:event), which a Rust listener handles.
  const emit = (event) =>
    invoke("plugin:event|emit", { event, payload: null })?.catch?.(() => {});

  /* ------------------------------- Toast -------------------------------- */
  let toastEl = null;
  let toastTimer = null;
  window.__carrierToast = function (msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      Object.assign(toastEl.style, {
        position: "fixed", bottom: "24px", left: "50%", transform: "translateX(-50%)",
        zIndex: 2147483647, background: "#242526", color: "#e4e6eb",
        padding: "10px 16px", borderRadius: "10px", boxShadow: "0 8px 28px rgba(0,0,0,.45)",
        font: "13px -apple-system, system-ui, sans-serif", opacity: "0",
        transition: "opacity .2s, transform .2s", pointerEvents: "none", maxWidth: "80vw",
      });
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    requestAnimationFrame(() => {
      toastEl.style.opacity = "1";
      toastEl.style.transform = "translateX(-50%) translateY(0)";
    });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.style.opacity = "0";
      toastEl.style.transform = "translateX(-50%) translateY(8px)";
    }, 2600);
  };

  /* --------------------------- Update check ----------------------------- */
  // Rust runs the check (and reports the result with a native notification).
  window.__carrierCheckUpdates = function () {
    window.__carrierToast("Checking for updates…");
    emit("carrier:check-updates");
  };

  /* --------------------------- Settings window -------------------------- */
  // F3 / the menu opens the dedicated settings window (handled in Rust).
  window.__carrierToggleSettings = function () {
    emit("carrier:open-settings");
  };
})();
