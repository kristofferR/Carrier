/*
 * Carrier — toast notifications and the bridge that opens the dedicated
 * settings window (F2/F3). The settings UI itself lives
 * in its own native window (dist/settings.html), not as an overlay.
 *
 * Source of the generated src-tauri/inject/panel.js (see inject/build.ts).
 */

// Internal bridge directly (no global window.__TAURI__ exposed to the page).
const invoke = (cmd: string, args?: Record<string, unknown>) =>
  window.__TAURI_INTERNALS__?.invoke(cmd, args);
// Facebook is a remote origin and can't call Carrier's own commands, but it
// *can* emit events (core:event), which a Rust listener handles.
const emit = (event: string) =>
  invoke("plugin:event|emit", { event, payload: null })?.catch?.(() => {});

function main() {
  /* ------------------------------- Toast -------------------------------- */
  let toastEl: HTMLDivElement | null = null;
  let toastTimer: number | undefined;
  window.__carrierToast = (msg: string) => {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("aria-live", "polite");
      toastEl.setAttribute("aria-atomic", "true");
      Object.assign(toastEl.style, {
        position: "fixed",
        bottom: "24px",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 2147483647,
        background: "#242526",
        color: "#e4e6eb",
        padding: "10px 16px",
        borderRadius: "10px",
        boxShadow: "0 8px 28px rgba(0,0,0,.45)",
        font: "13px -apple-system, system-ui, sans-serif",
        opacity: "0",
        transition: "opacity .2s, transform .2s",
        pointerEvents: "none",
        maxWidth: "80vw",
      });
      document.body.appendChild(toastEl);
    }
    const el = toastEl;
    el.textContent = msg;
    requestAnimationFrame(() => {
      el.style.opacity = "1";
      el.style.transform = "translateX(-50%) translateY(0)";
    });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateX(-50%) translateY(8px)";
    }, 2600);
  };

  /* --------------------------- Update check ----------------------------- */
  // Updates can replace and restart the app, so the remote Facebook origin
  // only opens trusted Settings, where the user explicitly confirms install.
  window.__carrierCheckUpdates = () => {
    window.__carrierToast?.("Opening Settings to check for updates…");
    emit("carrier:open-settings");
  };

  /* --------------------------- Settings window -------------------------- */
  // F3 / the menu opens the dedicated settings window (handled in Rust).
  window.__carrierToggleSettings = () => {
    emit("carrier:open-settings");
  };
}

// Subframes also receive init scripts (notably on Windows); only run in top.
if (window.top === window.self) main();
