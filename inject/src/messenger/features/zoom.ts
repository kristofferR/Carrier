/* ----------------------------- Page zoom ------------------------------ */
// The persisted zoom level lives in the Rust Settings struct (source of
// truth) and reaches the page via __CARRIER_SETTINGS__ / carrier:settings.
// Keyboard/menu zoom reports its changes back with a carrier:zoom event so
// Rust can persist them. The old localStorage key is only kept as a
// migration source for pre-settings installs (see initZoomLevel below).
import { invoke } from "../bridge";
import { clampZoom } from "../lib/zoom";

const ZOOM_KEY = "carrier:zoom";
const isWindows = /windows/i.test(navigator.userAgent);

let zoomLevel = 100; // the level currently applied to the page

function applyZoom(percent: number, fromSettings?: boolean) {
  const clamped = clampZoom(percent);
  if (isWindows) {
    // WebView2 ignores `zoom`; fall back to a transform.
    const scale = clamped / 100;
    document.body.style.transformOrigin = "top left";
    document.body.style.transform = `scale(${scale})`;
    document.body.style.width = `${100 / scale}%`;
    document.body.style.height = `${100 / scale}%`;
    // The transform does not resize the layout viewport, so features that
    // position privacy masks and login surfaces off `resize` need an explicit
    // relayout signal just like the non-Windows zoom path.
    window.dispatchEvent(new Event("resize"));
  } else {
    document.documentElement.style.zoom = `${clamped}%`;
    window.dispatchEvent(new Event("resize"));
  }
  const changed = clamped !== zoomLevel;
  zoomLevel = clamped;
  // Keep the page-side settings snapshot and its localStorage cache in step,
  // so a Facebook-triggered reload (which re-runs the init script off that
  // cache) restores the same level without waiting for a settings push.
  try {
    localStorage.setItem(ZOOM_KEY, String(clamped));
    const settings =
      window.__CARRIER_SETTINGS__ &&
      typeof window.__CARRIER_SETTINGS__ === "object" &&
      !Array.isArray(window.__CARRIER_SETTINGS__)
        ? window.__CARRIER_SETTINGS__
        : null;
    if (settings) settings.zoom = clamped;
    const cached = JSON.parse(
      localStorage.getItem("__carrier_settings") || "null",
    ) as CarrierSettings | null;
    const nextSettings =
      cached && typeof cached === "object" && !Array.isArray(cached)
        ? cached
        : settings
          ? Object.assign({}, settings)
          : null;
    if (nextSettings) {
      nextSettings.zoom = clamped;
      localStorage.setItem("__carrier_settings", JSON.stringify(nextSettings));
    }
  } catch (_) {}
  // Report a local change (keyboard / View menu) so Rust persists it. Never
  // re-emit for a settings push — Rust already has that value, and echoing
  // it back could feed a loop.
  if (changed && !fromSettings) {
    invoke("plugin:event|emit", { event: "carrier:zoom", payload: clamped })?.catch?.(() => {});
  }
}

export const zoomIn = () => applyZoom(zoomLevel + 10);
export const zoomOut = () => applyZoom(zoomLevel - 10);
export const zoomReset = () => applyZoom(100);

// Follow the zoom in settings: applied at load and whenever Rust pushes a
// settings change (e.g. the Settings window's Page zoom select).
function syncZoomFromSettings() {
  const s = window.__CARRIER_SETTINGS__ || {};
  const z = typeof s.zoom === "number" && Number.isFinite(s.zoom) ? clampZoom(s.zoom) : 100;
  if (z !== zoomLevel) applyZoom(z, true);
}

function initZoomLevel() {
  const s = window.__CARRIER_SETTINGS__ || {};
  let z = typeof s.zoom === "number" && Number.isFinite(s.zoom) ? clampZoom(s.zoom) : 100;
  // Migrate pre-settings installs: keyboard zoom used to persist only to
  // localStorage. If settings still hold the default but the old key has a
  // level, adopt it and report it once so it lands in settings.json.
  const stored = parseInt(localStorage.getItem(ZOOM_KEY) || "", 10);
  if (z === 100 && Number.isFinite(stored) && clampZoom(stored) !== 100) {
    z = clampZoom(stored);
    invoke("plugin:event|emit", { event: "carrier:zoom", payload: z })?.catch?.(() => {});
  }
  if (z !== zoomLevel) applyZoom(z, true);
  window.addEventListener("carrier:settings", syncZoomFromSettings);
}

export function initZoom() {
  // Expose zoom controls so the native menu (View ▸ Zoom) can drive them.
  window.__carrierZoomIn = zoomIn;
  window.__carrierZoomOut = zoomOut;
  window.__carrierZoomReset = zoomReset;

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", initZoomLevel, { once: true });
  else initZoomLevel();
}
