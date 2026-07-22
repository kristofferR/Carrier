/* ------------------------- Tauri bridge + toast ----------------------- */
import { downloadRevealLabel } from "./lib/downloads";
import { stripFacebookTracking } from "./lib/links";

// Use the always-present internal bridge directly instead of the global
// `window.__TAURI__` (which `withGlobalTauri` would also expose to Facebook's
// own scripts).
export const invoke = (cmd: string, args?: Record<string, unknown>) =>
  window.__TAURI_INTERNALS__?.invoke(cmd, args);

export const toast = (msg: string, action?: CarrierToastAction) =>
  window.__carrierToast ? window.__carrierToast(msg, action) : console.log("[carrier]", msg);

/* ----------------------------- Diagnostics ---------------------------- */
// Every page feature hangs off Facebook's unstable DOM, and failures used to
// vanish into empty `catch {}` blocks — when Messenger shipped new markup a
// feature just silently died. `diag()` reports failures to the native log
// (Settings → Advanced → Open log folder) so field breakage is visible, and
// mirrors them to the console when `localStorage.__carrier_debug = "1"`.
// Reports carry only Carrier's own strings (selector names, counts) — never
// message text, names, or URLs.
export const diag = (() => {
  const RATE_MS = 60_000; // at most one report per key per minute
  const lastSent = new Map<string, number>();
  return (key: string, msg: string) => {
    try {
      const now = Date.now();
      if (now - (lastSent.get(key) || 0) < RATE_MS) return;
      lastSent.set(key, now);
      try {
        if (localStorage.__carrier_debug === "1") console.warn(`[carrier] ${key}: ${msg}`);
      } catch (_) {}
      invoke("plugin:event|emit", {
        event: "carrier:diag",
        payload: { key: String(key), msg: String(msg) },
      })?.catch?.(() => {});
    } catch (_) {}
  };
})();

/* ------------------------ Plugin command bridges ---------------------- */
// Facebook is a *remote* origin: Tauri v2 lets it call plugin commands (gated
// by the capability ACL) but NOT the app's own custom commands. So page
// features route through plugins, matching how the upstream app works.
export const cleanSharedUrl = (url: string) =>
  window.__CARRIER_SETTINGS__?.strip_link_tracking === false
    ? url
    : stripFacebookTracking(url, location.href);

export const openUrl = (url: string) =>
  invoke("plugin:opener|open_url", { url: cleanSharedUrl(url), with: null })?.catch?.(() =>
    diag("ipc.open-url", "opener invoke failed"),
  );

export const revealDownload = (url: string) =>
  invoke("plugin:event|emit", {
    event: "carrier:reveal-download",
    payload: { url },
  })?.catch?.(() => diag("ipc.reveal-download", "reveal event failed"));

export const toastDownloadSaved = (url: string) =>
  toast("Saved to Downloads", {
    label: downloadRevealLabel(navigator.userAgent),
    onClick: () => revealDownload(url),
  });
