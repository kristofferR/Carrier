import { diag } from "../bridge";
import {
  createFacebookModuleDefineInterceptor,
  FacebookFTSIdleCoordinator,
  type FacebookModuleDefine,
  isConversationSearchInput,
} from "../lib/facebook-modules";
import { nicknameMode } from "../lib/nicknames";
import { isFacebookRateLimitError } from "../lib/rate-limit";
import { reportRateLimit } from "./rate-limit";
import { syncProcessing } from "./sync-processing";
import { workerRecovery, workerReplacement } from "./worker-recovery";

const SEARCH_INDEX_WAKE_MS = 5 * 60_000;
const SHARED_ENGINE_KEY = "__carrier_shared_engine__";

/**
 * macOS keeps Messenger's encrypted engine per window (#295), and Facebook lets
 * only one such engine hold the session. Once a second window opens, native
 * moves every window to Facebook's shared engine: a window built afterwards
 * carries the flag, and an open one reloads with it in session storage.
 */
const usesSharedEngine = () => {
  if (window.__CARRIER_SHARED_ENGINE__ === true) return true;
  try {
    return sessionStorage.getItem(SHARED_ENGINE_KEY) === "1";
  } catch (_) {
    return false;
  }
};

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
  const nicknamePreference = {
    getSnapshot: () => nicknameMode(window.__CARRIER_SETTINGS__),
    subscribe: (listener: () => void) => {
      window.addEventListener("carrier:settings", listener);
      return () => window.removeEventListener("carrier:settings", listener);
    },
  };
  let pauseTimer: number | undefined;
  // Chosen once Facebook installs its module loader. A document never changes
  // engines while it runs; switching takes a reload.
  let dedicatedEngine: boolean | undefined;
  window.__carrierUseSharedEngine = () => {
    if (dedicatedEngine === false) return;
    try {
      sessionStorage.setItem(SHARED_ENGINE_KEY, "1");
    } catch (_) {
      diag("sync.shared-engine", "could not keep the shared engine choice across a reload");
      return;
    }
    location.reload();
  };

  const wakeSearchIndex = () => {
    searchIndex.wake();
    if (pauseTimer !== undefined) window.clearTimeout(pauseTimer);
    pauseTimer = window.setTimeout(() => {
      pauseTimer = undefined;
      searchIndex.pause();
    }, SEARCH_INDEX_WAKE_MS);
  };
  window.__carrierWakeSearchIndex = wakeSearchIndex;

  // Messenger focuses a real input when conversation search opens. Unlike its
  // translated button label, this control shape is locale-independent.
  document.addEventListener(
    "focusin",
    (event) => {
      const input = event.target instanceof HTMLInputElement ? event.target : null;
      if (
        input &&
        isConversationSearchInput({
          hasAccessibleName: input.hasAttribute("aria-label"),
          insideForm: input.closest("form") !== null,
          insideMain: input.closest('[role="main"]') !== null,
          role: input.getAttribute("role"),
          type: input.type,
        })
      ) {
        wakeSearchIndex();
      }
    },
    true,
  );

  const wrap = (value: unknown): unknown => {
    if (typeof value !== "function" || wrappedDefines.has(value)) return value;
    dedicatedEngine ??= /mac/i.test(navigator.platform) && !usesSharedEngine();
    const wrapped = createFacebookModuleDefineInterceptor(
      value as FacebookModuleDefine,
      shouldBlockTelemetry,
      (restore) => searchIndex.register(restore),
      (error) => {
        if (isFacebookRateLimitError(error)) reportRateLimit("graphql-1675004");
      },
      (exports) => workerRecovery.observeSetupExports(exports),
      (exports) => syncProcessing.observeLogger(exports),
      (exports) => {
        workerRecovery.observeLifecycleExports(exports);
        workerReplacement.observeLifecycleExports(exports);
      },
      dedicatedEngine,
      nicknamePreference,
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
