/* --------------------------- Sync health ------------------------------ */
// The realtime transport can be healthy while Facebook refuses every actual
// sync query (observed 2026-07-22: a throttled session kept its MQTT socket
// but got no data — the app silently showed stale chats for hours). Nothing
// local can fix a server-side refusal, so the honest move is to say so.
// Two complementary detectors, because Messenger's sync engine lives in a
// worker whose network traffic the page cannot see:
//  - request-level: page-context GraphQL over fetch and XHR, failure-majority
//    in a rolling window;
//  - symptom-level: a loading spinner stuck visible far past any normal load.
// Degraded state shows a persistent in-window banner and raises a native
// notification (via carrier:sync-alert); both clear on recovery.

import { diag, invoke } from "../bridge";
import {
  isMessengerSyncRequest,
  SampledPersistence,
  STUCK_LOADING_SAMPLES,
  SyncHealthTracker,
  syncResponseSucceeded,
} from "../lib/sync-health";
import { isMessengerContentPath } from "../lib/threads";

// Hidden/minimized webviews throttle or suspend page timers on every
// platform, so this interval alone would lag in the background. The native
// watchdog already evals `window.__carrierHeartbeat?.()` into the page every
// 5s (webview_watchdog.rs), which wakes a suspended renderer and lets pending
// timers fire — that keeps this check ticking well enough while hidden. The
// spinner detector additionally requires a visible document by design.
const SYNC_CHECK_INTERVAL_MS = 10_000;

export function initSyncHealth() {
  const tracker = new SyncHealthTracker();

  try {
    const nativeFetch = window.fetch;
    const wrappedFetch = new Proxy(nativeFetch, {
      apply(target, thisArg, args: Parameters<typeof fetch>) {
        let tracked: number | undefined;
        try {
          const input = args[0];
          const url =
            typeof input === "string" || input instanceof URL
              ? String(input)
              : input instanceof Request
                ? input.url
                : "";
          if (url && isMessengerSyncRequest(url, location.href)) {
            tracked = tracker.started(Date.now());
          }
        } catch (_) {}
        const result = Reflect.apply(target, thisArg, args);
        if (tracked !== undefined) {
          const id = tracked;
          // Observe the outcome without altering the promise Messenger gets.
          // Failures while offline say nothing about Facebook — drop them.
          result.then(
            (response) => {
              if (syncResponseSucceeded(response.status)) tracker.succeeded(id, Date.now());
              else if (navigator.onLine) tracker.failed(id, Date.now());
              else tracker.abandoned(id);
            },
            () => {
              if (navigator.onLine) tracker.failed(id, Date.now());
              else tracker.abandoned(id);
            },
          );
        }
        return result;
      },
    });
    Object.defineProperty(window, "fetch", {
      value: wrappedFetch,
      writable: true,
      configurable: true,
    });
  } catch (_) {
    diag("sync.requests", "could not observe Messenger sync fetches");
  }

  try {
    const xhrUrls = new WeakMap<XMLHttpRequest, string>();
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      ...args: Parameters<XMLHttpRequest["open"]>
    ) {
      try {
        xhrUrls.set(this, String(args[1]));
      } catch (_) {}
      return nativeOpen.apply(this, args);
    } as typeof XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.send = function (
      this: XMLHttpRequest,
      ...args: Parameters<XMLHttpRequest["send"]>
    ) {
      try {
        const url = xhrUrls.get(this);
        if (url && isMessengerSyncRequest(url, location.href)) {
          const id = tracker.started(Date.now());
          // `once`: a reused XHR instance must not stack listeners across sends.
          this.addEventListener(
            "loadend",
            () => {
              if (syncResponseSucceeded(this.status)) tracker.succeeded(id, Date.now());
              else if (navigator.onLine) tracker.failed(id, Date.now());
              else tracker.abandoned(id);
            },
            { once: true },
          );
        }
      } catch (_) {}
      return nativeSend.apply(this, args);
    } as typeof XMLHttpRequest.prototype.send;
  } catch (_) {
    diag("sync.requests", "could not observe Messenger sync XHRs");
  }

  const stuckLoading = new SampledPersistence(STUCK_LOADING_SAMPLES);
  // Messenger renders its loading spinners as `role="status"` (sometimes
  // `role="progressbar"`) elements. Those roles are generic live-regions, so
  // require a running CSS animation — that is what separates an actual
  // spinner from static status text, without depending on localized labels.
  const hasRunningAnimation = (root: Element): boolean => {
    const nodes = [root, ...Array.from(root.querySelectorAll("*")).slice(0, 8)];
    for (const node of nodes) {
      const style = getComputedStyle(node);
      if (style.animationName !== "none" && style.animationPlayState !== "paused") return true;
    }
    return false;
  };
  const loadingSpinnerVisible = () => {
    try {
      for (const el of document.querySelectorAll('[role="progressbar"], [role="status"]')) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 1 && rect.height > 1 && hasRunningAnimation(el)) return true;
      }
    } catch (_) {}
    return false;
  };

  // Constant in-window indicator: a warning pill pinned to the top of the
  // window for as long as sync is degraded. Reconciled every tick so a page
  // re-render that drops it just brings it back. No CSS animation and no
  // status role, so it can never trip the spinner detector above.
  const SYNC_BANNER_ID = "carrier-sync-banner";
  const showSyncBanner = () => {
    try {
      if (document.getElementById(SYNC_BANNER_ID)) return;
      const banner = document.createElement("div");
      banner.id = SYNC_BANNER_ID;
      banner.setAttribute("role", "alert");
      banner.textContent = "⚠ Messenger sync is broken — chats may be out of date";
      Object.assign(banner.style, {
        position: "fixed",
        top: "10px",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: "2147483646",
        background: "#ffba00",
        color: "#1c1e21",
        padding: "6px 14px",
        borderRadius: "999px",
        boxShadow: "0 4px 16px rgba(0,0,0,.35)",
        font: "600 12px -apple-system, system-ui, sans-serif",
        pointerEvents: "none",
        maxWidth: "90vw",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      });
      (document.body || document.documentElement).appendChild(banner);
    } catch (_) {}
  };
  const hideSyncBanner = () => {
    try {
      document.getElementById(SYNC_BANNER_ID)?.remove();
    } catch (_) {}
  };

  // The banner is the in-window signal; the native notification reaches a
  // buried window. The Rust side applies mute and an episode gate to the
  // alerts, and renders its own fixed strings.
  const emitSyncAlert = (kind: "degraded" | "recovered") =>
    invoke("plugin:event|emit", {
      event: "carrier:sync-alert",
      payload: { kind },
    })?.catch?.(() => {});

  let degraded = false;
  setInterval(() => {
    // While offline everything fails and spinners hang for local reasons; the
    // realtime recovery machinery owns that state. Freeze the detector (and
    // whatever the banner currently shows) until connectivity returns.
    if (!navigator.onLine) return;
    const now = Date.now();
    tracker.sweep(now);
    // Only sample the spinner while the page is visible Messenger content — a
    // hidden window may legitimately pause loading work mid-spinner.
    if (!document.hidden && isMessengerContentPath(location.pathname)) {
      stuckLoading.observe(loadingSpinnerVisible());
    }
    const degradedNow = tracker.degraded(now) || stuckLoading.persistent();
    if (degradedNow && !degraded) {
      degraded = true;
      const reason = stuckLoading.persistent()
        ? "loading UI stuck"
        : `requests failing (${tracker.summary(now)})`;
      diag("sync.stalled", `messenger sync degraded: ${reason}`);
      emitSyncAlert("degraded");
    } else if (!degradedNow && degraded) {
      degraded = false;
      diag("sync.stalled", "messenger sync recovered");
      emitSyncAlert("recovered");
    }
    if (degraded) showSyncBanner();
    else hideSyncBanner();
  }, SYNC_CHECK_INTERVAL_MS);
}
