/* ----------------------------- Page zoom ------------------------------ */
// The persisted zoom level lives in the Rust Settings struct (source of
// truth) and reaches the page via __CARRIER_SETTINGS__ / carrier:settings.
// Rust applies it as native WebView zoom; CSS `zoom` grew the layout past the
// window (#318). Keyboard/menu zoom reports its changes back with a
// carrier:zoom event, which Rust applies and persists. The old localStorage
// key is only kept as a migration source for pre-settings installs (see
// initZoomLevel below).
import { invoke } from "../bridge";
import { clampZoom } from "../lib/zoom";

const ZOOM_KEY = "carrier:zoom";

let zoomLevel = 100; // the level Rust last applied (or was asked to)

function setZoomLevel(percent: number, fromSettings?: boolean) {
  const clamped = clampZoom(percent);
  const changed = clamped !== zoomLevel;
  zoomLevel = clamped;
  // Keep the page-side settings snapshot and its localStorage cache in step,
  // so a Facebook-triggered reload (which re-runs the init script off that
  // cache) keeps stepping from the same level without waiting for a push.
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
  // Report a local change (keyboard / View menu) so Rust applies and persists
  // it. Never re-emit for a settings push — Rust already has that value, and echoing
  // it back could feed a loop.
  if (changed && !fromSettings) {
    invoke("plugin:event|emit", { event: "carrier:zoom", payload: clamped })?.catch?.(() => {});
  }
}

export const zoomIn = () => setZoomLevel(zoomLevel + 10);
export const zoomOut = () => setZoomLevel(zoomLevel - 10);
export const zoomReset = () => setZoomLevel(100);

// Follow the zoom in settings: applied at load and whenever Rust pushes a
// settings change (e.g. the Settings window's Page zoom select).
function syncZoomFromSettings() {
  const s = window.__CARRIER_SETTINGS__ || {};
  const z = typeof s.zoom === "number" && Number.isFinite(s.zoom) ? clampZoom(s.zoom) : 100;
  if (z !== zoomLevel) setZoomLevel(z, true);
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
  if (z !== zoomLevel) setZoomLevel(z, true);
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
