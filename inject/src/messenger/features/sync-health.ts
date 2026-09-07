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
import { RetryAfterWindow } from "../lib/rate-limit";
import {
  isMessengerSyncRequest,
  SampledPersistence,
  STUCK_LOADING_SAMPLES,
  SyncHealthTracker,
  syncResponseSucceeded,
} from "../lib/sync-health";
import { isMessengerContentPath } from "../lib/threads";
import {
  clearRateLimitOnRecovery,
  RATE_LIMIT_EVENT,
  RATE_LIMIT_RETRY_STATE_EVENT,
  rateLimitRemainingMs,
  reportRateLimit,
  retryRateLimitNow,
} from "./rate-limit";

// Hidden/minimized webviews throttle or suspend page timers on every
// platform, so this interval alone would lag in the background. The native
// watchdog already evals `window.__carrierHeartbeat?.()` into the page every
// 5s (webview_watchdog.rs), which wakes a suspended renderer and lets pending
// timers fire — that keeps this check ticking well enough while hidden. The
// spinner detector additionally requires a visible document by design.
const SYNC_CHECK_INTERVAL_MS = 10_000;

export function initSyncHealth() {
  const tracker = new SyncHealthTracker();
  const serverDelays = new RetryAfterWindow();
  const emitSyncAlert = (kind: "degraded" | "recovered" | "rate-limited") =>
    invoke("plugin:event|emit", { event: "carrier:sync-alert", payload: { kind } })?.catch?.(
      () => {},
    );
  let sawRateLimit = false;
  let recoveryObservedAt: number | null = null;
  const observeResponse = (id: number, status: number, retryHeader: string | null) => {
    const now = Date.now();
    const delay =
      status === 429 && navigator.onLine ? serverDelays.observe(retryHeader, now) : undefined;
    if (tracker.response(id, status, now, navigator.onLine)) {
      reportRateLimit("http-429", delay);
    } else if (
      syncResponseSucceeded(status) &&
      rateLimitRemainingMs() <= 0 &&
      !tracker.degraded(now)
    ) {
      // Let Facebook normalize HTTP-200 GraphQL errors before accepting
      // transport success as recovery. The existing health tick settles it.
      recoveryObservedAt ??= now;
    } else if (!syncResponseSucceeded(status)) {
      recoveryObservedAt = null;
    }
  };

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
          // Facebook uses /api/graphql on login/checkpoint surfaces too; only
          // Messenger content pages say anything about Messenger sync.
          if (
            url &&
            isMessengerContentPath(location.pathname) &&
            isMessengerSyncRequest(url, location.href)
          ) {
            tracked = tracker.started(Date.now());
          }
        } catch (_) {}
        const result = Reflect.apply(target, thisArg, args);
        if (tracked !== undefined) {
          const id = tracked;
          // Observe the outcome without altering the promise Messenger gets.
          // Failures while offline and local aborts (route changes cancel
          // in-flight queries) say nothing about Facebook — drop them.
          result.then(
            (response) => {
              observeResponse(
                id,
                response.status,
                response.status === 429 ? response.headers.get("Retry-After") : null,
              );
            },
            (error: unknown) => {
              const aborted = (error as { name?: string } | null)?.name === "AbortError";
              if (navigator.onLine && !aborted) tracker.failed(id, Date.now());
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
        if (
          url &&
          isMessengerContentPath(location.pathname) &&
          isMessengerSyncRequest(url, location.href)
        ) {
          const id = tracker.started(Date.now());
          // `once`: a reused XHR instance must not stack listeners across
          // sends. A local abort fires before loadend and abandons the sample,
          // so the loadend status-0 that follows records nothing.
          this.addEventListener("abort", () => tracker.abandoned(id), { once: true });
          this.addEventListener(
            "loadend",
            () => {
              observeResponse(
                id,
                this.status,
                this.status === 429 ? this.getResponseHeader("Retry-After") : null,
              );
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
  // An animated spinner hidden via visibility/opacity or parked off-screen
  // keeps a nonzero rect; only what the user can actually see counts.
  const isActuallyVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (
      rect.width <= 1 ||
      rect.height <= 1 ||
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= innerHeight ||
      rect.left >= innerWidth
    ) {
      return false;
    }
    let current: Element | null = el;
    while (current) {
      const style = getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number(style.opacity) <= 0
      ) {
        return false;
      }
      current = current.parentElement;
    }
    return true;
  };
  const loadingSpinnerVisible = () => {
    try {
      for (const el of document.querySelectorAll('[role="progressbar"], [role="status"]')) {
        if (isActuallyVisible(el) && hasRunningAnimation(el)) return true;
      }
    } catch (_) {}
    return false;
  };

  // Constant in-window indicator: a warning pill pinned to the top of the
  // window for as long as sync is degraded. Reconciled every tick so a page
  // re-render that drops it just brings it back. No CSS animation and no
  // status role, so it can never trip the spinner detector above.
  const SYNC_BANNER_ID = "carrier-sync-banner";
  let manualRetryPending = false;
  const showSyncBanner = (limited = false) => {
    try {
      const existing = document.getElementById(SYNC_BANNER_ID);
      const banner = existing || document.createElement("div");
      banner.id = SYNC_BANNER_ID;
      let label = banner.querySelector("span");
      if (!label) {
        label = document.createElement("span");
        label.setAttribute("role", "alert");
        banner.appendChild(label);
      }
      const message = limited
        ? rateLimitRemainingMs() > 0
          ? `Messenger is rate limiting this session. Retrying automatically in ${Math.max(1, Math.ceil(rateLimitRemainingMs() / 60_000))} min. Chats may be out of date.`
          : "Messenger rate-limit cooldown ended. Automatic recovery is waiting for connectivity and any draft or call to finish."
        : "⚠ Messenger sync is broken — chats may be out of date";
      if (label.textContent !== message) label.textContent = message;
      let retry = banner.querySelector("button");
      if (limited && !retry) {
        retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "Try again";
        Object.assign(retry.style, {
          background: "#1c1e21",
          color: "#fff",
          border: "none",
          borderRadius: "6px",
          padding: "6px 10px",
          font: "inherit",
          flexShrink: "0",
          cursor: "pointer",
          pointerEvents: "auto",
        });
        retry.addEventListener("click", (event) => {
          if (!event.isTrusted || manualRetryPending) return;
          retryRateLimitNow();
        });
        banner.appendChild(retry);
      }
      if (retry) {
        retry.hidden = !limited;
        retry.disabled = manualRetryPending || rateLimitRemainingMs() <= 0;
        retry.textContent = retry.disabled ? "Retry pending…" : "Try again";
      }
      if (existing) return;
      Object.assign(banner.style, {
        display: "flex",
        alignItems: "center",
        gap: "12px",
        boxSizing: "border-box",
        position: "fixed",
        top: "10px",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: "2147483646",
        background: "#ffba00",
        color: "#1c1e21",
        padding: "6px 14px",
        borderRadius: "12px",
        boxShadow: "0 4px 16px rgba(0,0,0,.35)",
        font: "600 12px -apple-system, system-ui, sans-serif",
        pointerEvents: "none",
        maxWidth: "90vw",
        whiteSpace: "normal",
        overflow: "hidden",
        textOverflow: "ellipsis",
      });
      (document.body || document.documentElement).appendChild(banner);
    } catch (_) {}
  };
  window.addEventListener(RATE_LIMIT_RETRY_STATE_EVENT, (event) => {
    manualRetryPending = (event as CustomEvent<unknown>).detail === true;
    showSyncBanner(true);
  });
  const hideSyncBanner = () => {
    try {
      document.getElementById(SYNC_BANNER_ID)?.remove();
    } catch (_) {}
  };

  // Requests caught in flight by an offline transition must not be swept as
  // hung "failures" on the first tick after connectivity returns.
  window.addEventListener("offline", () => tracker.abandonOutstanding());

  let degraded = false;
  const showRateLimit = () => {
    if (rateLimitRemainingMs() > 0) {
      recoveryObservedAt = null;
      if (!sawRateLimit) emitSyncAlert("rate-limited");
      sawRateLimit = true;
      tracker.abandonOutstanding();
      stuckLoading.observe(false);
    }
    if (sawRateLimit) showSyncBanner(true);
  };
  window.addEventListener(RATE_LIMIT_EVENT, showRateLimit);
  showRateLimit();
  setInterval(() => {
    if (rateLimitRemainingMs() > 0) {
      showRateLimit();
      return;
    }
    // While offline everything fails and spinners hang for local reasons; the
    // realtime recovery machinery owns that state. Freeze the detector (and
    // whatever the banner currently shows) until connectivity returns.
    if (!navigator.onLine) {
      tracker.abandonOutstanding();
      return;
    }
    const now = Date.now();
    tracker.sweep(now);
    if (
      recoveryObservedAt !== null &&
      now - recoveryObservedAt >= SYNC_CHECK_INTERVAL_MS &&
      !tracker.degraded(now)
    ) {
      sawRateLimit = false;
      recoveryObservedAt = null;
      if (clearRateLimitOnRecovery()) {
        serverDelays.clear();
        emitSyncAlert("recovered");
      }
    }
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
    if (sawRateLimit) showSyncBanner(true);
    else if (degraded) showSyncBanner();
    else hideSyncBanner();
  }, SYNC_CHECK_INTERVAL_MS);
}
