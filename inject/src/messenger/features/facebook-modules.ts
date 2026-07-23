import {
  createFacebookModuleDefineInterceptor,
  type FacebookModuleDefine,
} from "../lib/facebook-modules";

/**
 * Intercept the few Facebook modules Carrier intentionally replaces before the
 * page's bootloader registers them. Failure is harmless: the original module
 * loader remains installed and messenger.css still hides Facebook's chrome.
 */
export function initFacebookModuleInterception() {
  const page = window as unknown as Record<string, unknown>;
  const shouldBlockTelemetry = () => window.__CARRIER_SETTINGS__?.block_telemetry === true;
  const wrappedDefines = new WeakSet<object>();

  const wrap = (value: unknown): unknown => {
    if (typeof value !== "function" || wrappedDefines.has(value)) return value;
    const wrapped = createFacebookModuleDefineInterceptor(
      value as FacebookModuleDefine,
      shouldBlockTelemetry,
    );
    wrappedDefines.add(wrapped);
    return wrapped;
  };

  try {
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
