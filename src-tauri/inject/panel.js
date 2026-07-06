/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: inject/src/panel/index.ts (bundled by inject/build.ts via `bun run build:inject`).
 */
"use strict";
(() => {
  // inject/src/panel/index.ts
  var invoke = (cmd, args) => window.__TAURI_INTERNALS__?.invoke(cmd, args);
  var emit = (event) => invoke("plugin:event|emit", { event, payload: null })?.catch?.(() => {
  });
  function main() {
    let toastEl = null;
    let toastTimer;
    window.__carrierToast = (msg) => {
      if (!toastEl) {
        toastEl = document.createElement("div");
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
          maxWidth: "80vw"
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
    window.__carrierCheckUpdates = () => {
      window.__carrierToast?.("Checking for updates…");
      emit("carrier:check-updates");
    };
    window.__carrierToggleSettings = () => {
      emit("carrier:open-settings");
    };
  }
  if (window.top === window.self) main();
})();
