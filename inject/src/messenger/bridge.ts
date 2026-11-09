/* ------------------------- Tauri bridge + toast ----------------------- */
import {
  downloadAccessDeniedToast,
  downloadRevealLabel,
  isDownloadAccessDenied,
  isDownloadCancellation,
} from "./lib/downloads";
import { stripFacebookTracking } from "./lib/links";

// Use the always-present internal bridge directly instead of the global
// `window.__TAURI__` (which `withGlobalTauri` would also expose to Facebook's
// own scripts).
export const invoke = (cmd: string, args?: Record<string, unknown>) =>
  window.__TAURI_INTERNALS__?.invoke(cmd, args);

export const toast = (msg: string, action?: ChatpaneToastAction, options?: ChatpaneToastOptions) =>
  window.__chatpaneToast
    ? window.__chatpaneToast(msg, action, options)
    : console.log("[chatpane]", msg);

/* ----------------------------- Diagnostics ---------------------------- */
// Every page feature hangs off Facebook's unstable DOM, and failures used to
// vanish into empty `catch {}` blocks — when Messenger shipped new markup a
// feature just silently died. `diag()` reports failures to the native log
// (Settings → Advanced → Open log folder) so field breakage is visible, and
// mirrors them to the console when `localStorage.__chatpane_debug = "1"`.
// Reports carry only Chatpane's own strings (selector names, counts) — never
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
        if (localStorage.__chatpane_debug === "1") console.warn(`[chatpane] ${key}: ${msg}`);
      } catch (_) {}
      invoke("plugin:event|emit", {
        event: "chatpane:diag",
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
  window.__CHATPANE_SETTINGS__?.strip_link_tracking === false
    ? url
    : stripFacebookTracking(url, location.href);

export const openUrl = (url: string) =>
  invoke("plugin:opener|open_url", { url: cleanSharedUrl(url), with: null })?.catch?.(() =>
    diag("ipc.open-url", "opener invoke failed"),
  );

export const toastDownloadSaved = (url: string) =>
  toast(
    window.__CHATPANE_SETTINGS__?.download_behavior === "ask"
      ? "Download saved"
      : "Saved to Downloads",
    {
      label: downloadRevealLabel(navigator.userAgent),
      kind: "reveal-download",
      url,
    },
  );

// A folder-access refusal has its own toast (`toastDownloadAccessDenied`),
// shown for every download, so the generic failure must not replace it.
export const toastDownloadFailure = (error: unknown, message = "Download failed") => {
  if (isDownloadCancellation(error) || isDownloadAccessDenied(error)) return;
  toast(message);
};

export const toastDownloadAccessDenied = () => {
  const { message, action } = downloadAccessDeniedToast(chatpaneMediaPlatform);
  toast(message, action, { warning: true });
};
