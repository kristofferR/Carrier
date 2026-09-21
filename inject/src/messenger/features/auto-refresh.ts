/* --------------------------- Sync recovery ---------------------------- */
// Messenger's live sync can stall inside a system WebView. Native heartbeats
// detect a suspended renderer, while page-side lifecycle and transport checks
// catch stale connections. Every recovery defers around drafts and calls.

import { diag, invoke } from "../bridge";
import {
  AutoRefreshWatchdog,
  canReplacePendingRefresh,
  type PowerSnapshot,
  PowerStateTracker,
  type ScheduledRefreshReason,
} from "../lib/auto-refresh";
import {
  looksLikeFacebookErrorPage,
  REALTIME_UNOBSERVED_SETTLE_MS,
  RealtimeRecoveryTracker,
} from "../lib/realtime-health";
import { RenderHealthProbe } from "../lib/render-health";
import { isMessengerContentPath } from "../lib/threads";
import {
  hasRateLimitEpisode,
  RATE_LIMIT_EVENT,
  RATE_LIMIT_RETRY_EVENT,
  RATE_LIMIT_RETRY_STATE_EVENT,
  rateLimitAccountScope,
  rateLimitRemainingMs,
} from "./rate-limit";
import { monitorRealtimeHealth } from "./realtime-health";

export function initAutoRefresh() {
  // Capture these at document start, before Facebook wraps the scheduling APIs.
  const renderProbe = new RenderHealthProbe(
    window.requestAnimationFrame.bind(window),
    window.cancelAnimationFrame.bind(window),
    performance.now.bind(performance),
  );
  const documentEpochMs = Math.floor(performance.timeOrigin);
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeNow = performance.now.bind(performance);
  let reloadRequestedAt: number | undefined;
  let unloadObserved = false;
  window.addEventListener("beforeunload", () => {
    unloadObserved = true;
  });
  window.addEventListener("visibilitychange", () => renderProbe.reset());
  window.addEventListener("pagehide", () => renderProbe.reset());
  // A full reload re-boots the whole Facebook SPA, so only do it after a
  // lifecycle signal that makes its live connection suspect. Drafts and calls
  // are always protected, even for a forced catch-up after sleep or refocus.
  const pageIsActive = () => !document.hidden && document.hasFocus();
  const isMac = /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
  // macOS has an exact AppKit sleep/display-wake signal. Its maintenance
  // dark-wakes create the same wall-clock gap as a real resume, so never infer
  // one from page timers there.
  const watchdog = new AutoRefreshWatchdog(Date.now(), pageIsActive(), !isMac);
  // A document can start during a dark wake, after the sleep event was sent.
  // Wait for the native snapshot before allowing recovery on macOS.
  let systemSleeping = isMac;
  let pending = false;
  let reloadWhileActive = false;
  let pendingReason: ScheduledRefreshReason = "background";
  let timer: number | undefined;
  const RECOVERY_MIN_GAP_MS = 60_000;
  const RECOVERY_STORAGE_KEY = "carrier-sync-recovery-at";
  const clearPending = () => {
    if (pending && pendingReason === "rate-limit-manual") {
      window.dispatchEvent(new CustomEvent(RATE_LIMIT_RETRY_STATE_EVENT, { detail: false }));
    }
    pending = false;
    reloadWhileActive = false;
    clearTimeout(timer);
    timer = undefined;
  };
  const composerHasText = () => {
    try {
      for (const el of document.querySelectorAll('[contenteditable="true"]')) {
        if ((el.textContent || "").trim().length > 0) return true;
      }
    } catch (_) {}
    return false;
  };
  const heartbeatId = window.__CARRIER_HEARTBEAT_ID__;
  try {
    delete window.__CARRIER_HEARTBEAT_ID__;
  } catch (_) {
    window.__CARRIER_HEARTBEAT_ID__ = undefined;
  }
  let lastHeartbeatProtection: boolean | undefined;
  const heartbeatProtection = () => composerHasText() || !!window.__carrierInCall;
  // Constructed before the first emitHeartbeat() call below. Non-content paths
  // (login, checkpoint) report "pending": the native watchdog must neither act
  // there nor treat them as proof the transport works.
  const realtimeRecovery = new RealtimeRecoveryTracker(Date.now());
  const onFacebookErrorPage = () => {
    try {
      return looksLikeFacebookErrorPage({
        hasBackLink: !!document.getElementById("back"),
        hasIconImage: document.getElementById("icon") instanceof HTMLImageElement,
        elementCount: document.getElementsByTagName("*").length,
      });
    } catch (_) {
      return false;
    }
  };
  const realtimeStatus = () => {
    if (systemSleeping || rateLimitRemainingMs() > 0) return "pending";
    if (!isMessengerContentPath(location.pathname)) return "pending";
    if (onFacebookErrorPage()) return "error";
    return realtimeRecovery.status(Date.now());
  };
  const messengerContentPresent = () => {
    // The renderer can stay JavaScript-responsive after Facebook's app root has
    // disappeared, leaving only Messenger's background colour behind. Avoid
    // coupling recovery to the feature selectors (which Facebook may rename):
    // any visible page control is enough to prove this is not that blank state.
    // Error/login/checkpoint UI also has controls, so it remains user-driven.
    if (!isMessengerContentPath(location.pathname)) return true;
    const candidates = document.querySelectorAll<HTMLElement>(
      'a[href], button, input, textarea, [contenteditable="true"], [role="navigation"], [role="main"]',
    );
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (
        rect.width <= 1 ||
        rect.height <= 1 ||
        rect.bottom <= 0 ||
        rect.right <= 0 ||
        rect.top >= innerHeight ||
        rect.left >= innerWidth
      ) {
        continue;
      }
      let current: HTMLElement | null = el;
      let hidden = false;
      while (current) {
        const style = getComputedStyle(current);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          style.contentVisibility === "hidden" ||
          Number(style.opacity) <= 0
        ) {
          hidden = true;
          break;
        }
        current = current.parentElement;
      }
      if (!hidden) return true;
    }
    return false;
  };
  let rateLimitRetryGrantUntil = 0;
  const emitHeartbeat = (requestRateLimitRetry = false) => {
    if (typeof heartbeatId !== "number") return;
    const protectedNow = heartbeatProtection();
    const contentPresent = messengerContentPresent();
    const visible = !document.hidden && !systemSleeping;
    lastHeartbeatProtection = protectedNow;
    invoke("plugin:event|emit", {
      event: "carrier:webview-heartbeat",
      payload: {
        id: heartbeatId,
        protected: protectedNow,
        content_present: contentPresent,
        render: {
          ...renderProbe.sample(
            visible &&
              document.readyState === "complete" &&
              contentPresent &&
              isMessengerContentPath(location.pathname),
          ),
          document_epoch_ms: documentEpochMs,
          document_age_ms: Math.round(nativeNow()),
          visible,
          focused: document.hasFocus(),
          content_page: isMessengerContentPath(location.pathname),
        },
        realtime: realtimeStatus(),
        rate_limit_ms: rateLimitRemainingMs(),
        rate_limit_account: rateLimitAccountScope(),
        rate_limit_retry: requestRateLimitRetry,
      },
    })?.catch?.(() => {});
  };
  const emitProtectionChange = () => {
    if (heartbeatProtection() !== lastHeartbeatProtection) emitHeartbeat();
  };
  window.__carrierHeartbeat = (expectedId) => {
    if (expectedId === heartbeatId) emitHeartbeat();
  };
  window.addEventListener("input", emitProtectionChange, true);
  window.addEventListener("carrier:protection-change", emitProtectionChange);
  emitHeartbeat();
  const captureRecovery = async () => {
    // Counts and booleans only: never serialize DOM, URLs, names, or drafts.
    const snapshot = `age=${Math.round(nativeNow())} ready=${document.readyState} visible=${!document.hidden} focused=${document.hasFocus()} nodes=${document.getElementsByTagName("*").length} articles=${document.querySelectorAll('[role="article"]').length} protected=${heartbeatProtection()} realtime=${realtimeStatus()}`;
    await Promise.race([
      invoke("plugin:event|emit", {
        event: "carrier:diag",
        payload: { key: "recovery.snapshot", msg: snapshot },
      })?.catch?.(() => {}),
      new Promise<void>((resolve) => nativeSetTimeout(resolve, 500)),
    ]);
  };
  window.__carrierCaptureRecovery = captureRecovery;
  let capturingRecovery = false;
  const maybeReload = async () => {
    timer = undefined;
    if (!pending || capturingRecovery) return;
    if (window.__CARRIER_SETTINGS__?.hold_failures && pendingReason !== "rate-limit-manual") {
      diag("recovery.held", `automatic ${pendingReason} recovery paused for investigation`);
      clearPending();
      return;
    }
    if (systemSleeping || (rateLimitRemainingMs() > 0 && pendingReason !== "rate-limit-manual")) {
      clearPending();
      return;
    }
    if (pageIsActive() && !reloadWhileActive) {
      clearPending();
      return;
    }
    // Never yank the page out from under a draft or an in-progress call.
    if (composerHasText() || window.__carrierInCall) {
      timer = setTimeout(maybeReload, 8000);
      return;
    }
    if (!navigator.onLine) {
      timer = setTimeout(maybeReload, 8000);
      return;
    }
    // The recovery gap is long enough for the transport to prove itself in the
    // meantime. Re-check at the moment of truth so a page that has gone quiet
    // for a reason that resolved itself is never reloaded out from under you.
    if (pendingReason === "realtime" && !realtimeRecovery.needsRecovery(Date.now())) {
      clearPending();
      return;
    }
    if (pendingReason === "rate-limit" && Date.now() >= rateLimitRetryGrantUntil) {
      // Native arbitration also covers fallback reloads in other windows.
      timer = setTimeout(maybeReload, 8000);
      emitHeartbeat(true);
      return;
    }
    if (pendingReason !== "background") {
      diag("sync.refresh", `reloading stale Messenger view after ${pendingReason}`);
    }
    if (pendingReason === "realtime") {
      try {
        sessionStorage.setItem(RECOVERY_STORAGE_KEY, String(Date.now()));
      } catch (_) {}
    }
    const capturedReason = pendingReason;
    capturingRecovery = true;
    try {
      await captureRecovery();
    } catch (_) {
      diag("recovery.snapshot-failed", "could not capture page state before recovery");
    } finally {
      capturingRecovery = false;
    }
    if (!pending || capturedReason !== pendingReason) return;
    // Settings or a draft/call may have changed while IPC was pending.
    if (
      (window.__CARRIER_SETTINGS__?.hold_failures && pendingReason !== "rate-limit-manual") ||
      heartbeatProtection() ||
      systemSleeping ||
      !navigator.onLine ||
      (rateLimitRemainingMs() > 0 && pendingReason !== "rate-limit-manual")
    ) {
      clearPending();
      return;
    }
    pending = false;
    // A reload request is not proof of a replacement document. This timeout
    // disappears on real navigation; surviving it exposes cancelled/stuck loads.
    if (reloadRequestedAt === undefined) {
      reloadRequestedAt = nativeNow();
      unloadObserved = false;
      nativeSetTimeout(() => {
        diag(
          "sync.reload-unfinished",
          `same document alive ${Math.round(nativeNow() - (reloadRequestedAt ?? 0))}ms after reload; beforeunload=${unloadObserved} ready=${document.readyState} visible=${!document.hidden}`,
        );
        reloadRequestedAt = undefined;
      }, 15_000);
    }
    location.reload();
  };
  window.__carrierRateLimitRetry = (expectedId, expires) => {
    if (expectedId !== heartbeatId || !Number.isFinite(expires) || expires <= Date.now()) return;
    if (!pending || pendingReason !== "rate-limit") return;
    rateLimitRetryGrantUntil = expires;
    clearTimeout(timer);
    maybeReload();
  };
  const schedule = (delay: number, reason: ScheduledRefreshReason, allowWhileActive = false) => {
    if (systemSleeping || (rateLimitRemainingMs() > 0 && reason !== "rate-limit-manual")) return;
    if (!canReplacePendingRefresh(pending ? pendingReason : null, reason)) return;
    if (pageIsActive() && !allowWhileActive) {
      return;
    }
    pending = true;
    reloadWhileActive ||= allowWhileActive;
    pendingReason = reason;
    clearTimeout(timer);
    timer = setTimeout(maybeReload, delay);
    if (reason === "rate-limit-manual") {
      window.dispatchEvent(new CustomEvent(RATE_LIMIT_RETRY_STATE_EVENT, { detail: true }));
    }
  };
  const realtimeRecoveryDelay = () => {
    try {
      const lastRecoveryAt = Number(sessionStorage.getItem(RECOVERY_STORAGE_KEY)) || 0;
      return Math.max(1000, RECOVERY_MIN_GAP_MS - Math.max(0, Date.now() - lastRecoveryAt));
    } catch (_) {
      return 1000;
    }
  };
  const clearRealtimeRecoveryIfSettled = () => {
    if (pending && pendingReason === "realtime" && !realtimeRecovery.needsRecovery(Date.now())) {
      clearPending();
    }
  };
  const realtime = monitorRealtimeHealth({
    onHealthy: (source) => {
      realtimeRecovery.healthy(source, Date.now());
      clearRealtimeRecoveryIfSettled();
    },
    onStale: (source) => {
      realtimeRecovery.stale(source);
      // Another source vouching for the transport means messages are still
      // flowing; reloading the page would churn it for nothing.
      if (!realtimeRecovery.needsRecovery(Date.now())) return;
      schedule(realtimeRecoveryDelay(), "realtime", true);
    },
    onUnknown: (source) => {
      realtimeRecovery.withdraw(source);
      clearRealtimeRecoveryIfSettled();
    },
  });

  const noteLifecycle = () => {
    const reason = watchdog.setActive(pageIsActive(), Date.now());
    if (reason) {
      schedule(1000, reason, true);
    } else if (pageIsActive() && !reloadWhileActive) {
      clearPending();
    }
  };
  window.addEventListener("focus", noteLifecycle);
  window.addEventListener("blur", noteLifecycle);
  document.addEventListener("visibilitychange", noteLifecycle);
  window.addEventListener("online", () => schedule(1000, "online", true));
  const powerState = new PowerStateTracker(performance.timeOrigin);
  window.addEventListener("carrier:power-state", (event) => {
    const snapshot = (event as CustomEvent<PowerSnapshot>).detail;
    if (
      !snapshot ||
      typeof snapshot.sleeping !== "boolean" ||
      !Number.isSafeInteger(snapshot.resume_generation)
    ) {
      return;
    }
    const resumed = powerState.update(snapshot);
    systemSleeping = snapshot.sleeping;
    if (systemSleeping) clearPending();
    else if (resumed && isMessengerContentPath(location.pathname)) schedule(1000, "resume", true);
  });

  // Reload shortly after a new-message notification, but only while the window
  // is unfocused — that's when Facebook's live sync throttles and the view
  // goes stale. When you're actively reading, live sync works, so we leave the
  // page alone. (Debounced to batch a burst of notifications into one reload;
  // the gap floor keeps a chatty thread from reloading every few minutes.)
  window.__carrierOnNotification = () => {
    if (!pageIsActive() && watchdog.canRefreshFromNotification(Date.now())) {
      schedule(4000, "background");
    }
  };

  window.addEventListener(RATE_LIMIT_RETRY_EVENT, () => schedule(1000, "rate-limit-manual", true));

  let waitingForRateLimit = rateLimitRemainingMs() > 0;
  window.addEventListener(RATE_LIMIT_EVENT, (event) => {
    if (!hasRateLimitEpisode()) {
      // Another window recovering does not refresh this document's data.
      // Keep followers queued for their own serialized retry.
      if ((event as CustomEvent<unknown>).detail === "recovered-here") {
        waitingForRateLimit = false;
        if (pending && pendingReason === "rate-limit") clearPending();
      }
      emitHeartbeat();
      return;
    }
    if (rateLimitRemainingMs() <= 0) return;
    rateLimitRetryGrantUntil = 0;
    waitingForRateLimit = true;
    clearPending();
    emitHeartbeat();
  });

  // Check often enough that an overdue callback recovers immediately when a
  // suspended WebView resumes. The same tick checks Messenger's realtime MQTT
  // transport for disconnects, stuck reconnects, and half-open silence — before
  // the heartbeat, so the emitted realtime status reflects this tick.
  setInterval(() => {
    if (systemSleeping || rateLimitRemainingMs() > 0) {
      emitHeartbeat();
      return;
    }
    if (waitingForRateLimit && !window.__CARRIER_SETTINGS__?.hold_failures) {
      waitingForRateLimit = false;
      window.dispatchEvent(new Event(RATE_LIMIT_EVENT));
      diag(
        "sync.rate-limit",
        "cooldown ended; scheduling one recovery attempt (access not yet confirmed)",
      );
      schedule(1000, "rate-limit", true);
    }
    realtime.check();
    // No source reports stale when none can observe the transport at all (the
    // worker bridge is gone and the page socket was never replaced), so that
    // state has to arm recovery here or nothing ever would. Give the probe
    // realtime.check() just started room to answer — a view resuming from
    // suspension looks unobserved synchronously while its worker heartbeat is
    // still in flight.
    //
    // Yield to any pending reload rather than replacing it. Re-arming each
    // tick would keep pushing this deadline out of reach, and overwriting a
    // lifecycle, online, or notification reload would be worse still: a
    // worker probe that then succeeds clears the realtime request, and the
    // catch-up reload it displaced would never run. Whatever is already
    // pending reboots the page anyway, and a document that is still
    // unobservable afterwards re-arms this on its own.
    if (realtimeRecovery.needsRecovery(Date.now()) && !pending) {
      schedule(Math.max(realtimeRecoveryDelay(), REALTIME_UNOBSERVED_SETTLE_MS), "realtime", true);
    }
    emitHeartbeat();
    const reason = watchdog.heartbeat(pageIsActive(), Date.now());
    if (reason) {
      schedule(reason === "background" ? 2000 : 1000, reason, reason !== "background");
    }
  }, 5_000);
}
