import {
  createFacebookModuleDefineInterceptor,
  FacebookFTSIdleCoordinator,
  type FacebookModuleDefine,
} from "../lib/facebook-modules";

const SEARCH_INDEX_WAKE_MS = 5 * 60_000;

/**
 * Intercept the few Facebook modules Carrier intentionally replaces before the
 * page's bootloader registers them. Failure is harmless: the original module
 * loader remains installed and messenger.css still hides Facebook's chrome.
 */
export function initFacebookModuleInterception() {
  const page = window as unknown as Record<string, unknown>;
  const shouldBlockTelemetry = () => window.__CARRIER_SETTINGS__?.block_telemetry === true;
  const wrappedDefines = new WeakSet<object>();
  const searchIndex = new FacebookFTSIdleCoordinator();
  let pauseTimer: number | undefined;

  const wakeSearchIndex = () => {
    searchIndex.wake();
    if (pauseTimer !== undefined) window.clearTimeout(pauseTimer);
    pauseTimer = window.setTimeout(() => {
      pauseTimer = undefined;
      searchIndex.pause();
    }, SEARCH_INDEX_WAKE_MS);
  };
  window.__carrierWakeSearchIndex = wakeSearchIndex;

  // Direct clicks do not pass through Carrier's shortcut helpers.
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const button = target?.closest<HTMLElement>(
        '[role="button"][aria-label], button[aria-label]',
      );
      if (!button?.closest('[role="main"]')) return;
      const label = (button.getAttribute("aria-label") || "").trim().toLowerCase();
      if (label === "search" || label === "search in conversation") wakeSearchIndex();
    },
    true,
  );

  const wrap = (value: unknown): unknown => {
    if (typeof value !== "function" || wrappedDefines.has(value)) return value;
    const wrapped = createFacebookModuleDefineInterceptor(
      value as FacebookModuleDefine,
      shouldBlockTelemetry,
      (restore) => searchIndex.register(restore),
    );
    wrappedDefines.add(wrapped);
    return wrapped;
  };

  try {
    const inherited = Object.getOwnPropertyDescriptor(window, "__d");
    if (typeof inherited?.get === "function" && typeof inherited.set === "function") {
      Object.defineProperty(window, "__d", {
        configurable: inherited.configurable,
        enumerable: inherited.enumerable,
        get: () => inherited.get?.call(window),
        set: (value) => inherited.set?.call(window, wrap(value)),
      });
      return;
    }

    let current = wrap(page.__d);
    Object.defineProperty(window, "__d", {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (value) => {
        current = wrap(value);
      },
    });
  } catch (_) {
    // Fail open if Facebook makes the loader property non-configurable.
  }
}
