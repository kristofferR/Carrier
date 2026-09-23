/* --------------------------- Sync recovery ---------------------------- */
// Messenger's live sync can stall inside a system WebView. Native heartbeats
// detect a suspended renderer. Responsive pages repair their worker in place;
// only an explicit reload or the server rate-limit flow navigates this page.

import { diag, invoke } from "../bridge";
import {
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
import { SILENT_RECOVERY_RELOAD_EVENT } from "../lib/worker-recovery";
import {
  hasRateLimitEpisode,
  RATE_LIMIT_EVENT,
  RATE_LIMIT_RETRY_EVENT,
  RATE_LIMIT_RETRY_STATE_EVENT,
  rateLimitAccountScope,
  rateLimitRemainingMs,
} from "./rate-limit";
import { monitorRealtimeHealth } from "./realtime-health";
import { createSilentRecovery } from "./silent-recovery";
import { sampleSyncProcessing } from "./sync-processing";

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
  const isMac = /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
  // macOS has an exact AppKit sleep/display-wake signal. Its maintenance
  // dark-wakes create the same wall-clock gap as a real resume, so never infer
  // one from page timers there.
  // A document can start during a dark wake, after the sleep event was sent.
  // Wait for the native snapshot before allowing recovery on macOS.
  let systemSleeping = isMac;
  let pending = false;
  let pendingReason: ScheduledRefreshReason = "rate-limit";
  let timer: number | undefined;
  const clearPending = () => {
    if (pending && pendingReason === "rate-limit-manual") {
      window.dispatchEvent(new CustomEvent(RATE_LIMIT_RETRY_STATE_EVENT, { detail: false }));
    }
    pending = false;
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
        // Native supervision still owns unresponsive/blank/error pages. It
        // must not race a responsive page's non-navigating worker recovery.
        realtime: ["stale", "never"].includes(realtimeStatus()) ? "managed" : realtimeStatus(),
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
  const processingActive = () =>
    !systemSleeping &&
    !document.hidden &&
    navigator.onLine &&
    rateLimitRemainingMs() <= 0 &&
    isMessengerContentPath(location.pathname);
  const captureRecovery = async () => {
    // Counts and booleans only: never serialize DOM, URLs, names, or drafts.
    const processing = sampleSyncProcessing(processingActive());
    const snapshot = `age=${Math.round(nativeNow())} ready=${document.readyState} visible=${!document.hidden} focused=${document.hasFocus()} nodes=${document.getElementsByTagName("*").length} articles=${document.querySelectorAll('[role="article"]').length} protected=${heartbeatProtection()} realtime=${realtimeStatus()} processing=${JSON.stringify(processing)}`;
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
  const recoveryHeld = () =>
    window.__CARRIER_SETTINGS__?.hold_failures &&
    pendingReason !== "rate-limit-manual" &&
    pendingReason !== "manual";
  const maybeReload = async () => {
    timer = undefined;
    if (!pending || capturingRecovery) return;
    if (recoveryHeld()) {
      diag("recovery.held", `automatic ${pendingReason} recovery paused for investigation`);
      return;
    }
    if (systemSleeping || (rateLimitRemainingMs() > 0 && pendingReason !== "rate-limit-manual")) {
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
    if (pendingReason === "rate-limit" && Date.now() >= rateLimitRetryGrantUntil) {
      // Native arbitration also covers fallback reloads in other windows.
      timer = setTimeout(maybeReload, 8000);
      emitHeartbeat(true);
      return;
    }
    diag("sync.refresh", `reloading Messenger view after ${pendingReason}`);
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
    if (recoveryHeld()) {
      diag("recovery.held", `automatic ${pendingReason} recovery paused for investigation`);
      return;
    }
    if (
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
  window.addEventListener("carrier:settings", () => {
    if (pending && timer === undefined && !recoveryHeld()) {
      timer = setTimeout(maybeReload, 0);
    }
  });
  window.__carrierRateLimitRetry = (expectedId, expires) => {
    if (expectedId !== heartbeatId || !Number.isFinite(expires) || expires <= Date.now()) return;
    if (!pending || pendingReason !== "rate-limit") return;
    rateLimitRetryGrantUntil = expires;
    clearTimeout(timer);
    maybeReload();
  };
  const schedule = (delay: number, reason: ScheduledRefreshReason) => {
    if (systemSleeping || (rateLimitRemainingMs() > 0 && reason !== "rate-limit-manual")) return;
    if (!canReplacePendingRefresh(pending ? pendingReason : null, reason)) return;
    pending = true;
    pendingReason = reason;
    clearTimeout(timer);
    timer = setTimeout(maybeReload, delay);
    if (reason === "rate-limit-manual") {
      window.dispatchEvent(new CustomEvent(RATE_LIMIT_RETRY_STATE_EVENT, { detail: true }));
    }
  };
  const realtime = monitorRealtimeHealth({
    onHealthy: (source) => {
      realtimeRecovery.healthy(source, Date.now());
    },
    onStale: (source) => {
      realtimeRecovery.stale(source);
    },
    onUnknown: (source) => {
      realtimeRecovery.withdraw(source);
    },
  });

  const silentRecovery = createSilentRecovery({
    blocked: (manual) =>
      (!manual && !!window.__CARRIER_SETTINGS__?.hold_failures) ||
      systemSleeping ||
      !navigator.onLine ||
      heartbeatProtection() ||
      rateLimitRemainingMs() > 0 ||
      !isMessengerContentPath(location.pathname) ||
      onFacebookErrorPage(),
    needsRecovery: () => ["stale", "never"].includes(realtimeStatus()),
    isHealthy: () => realtimeStatus() === "ok" && realtime.isVerifiedHealthy(),
    check: () => realtime.check(),
  });
  // These events are reasons to check sync, not evidence that it is broken.
  const noteLifecycle = () => {
    sampleSyncProcessing(processingActive());
    if (!systemSleeping && navigator.onLine && rateLimitRemainingMs() <= 0) realtime.check();
  };
  window.addEventListener("focus", noteLifecycle);
  window.addEventListener("blur", noteLifecycle);
  document.addEventListener("visibilitychange", noteLifecycle);
  window.addEventListener("online", noteLifecycle);
  window.addEventListener("offline", noteLifecycle);
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
    sampleSyncProcessing(processingActive());
    if (systemSleeping) {
      silentRecovery.resetSettle();
      clearPending();
    } else if (resumed) {
      silentRecovery.resetSettle();
      noteLifecycle();
    }
  });

  window.__carrierOnNotification = noteLifecycle;

  window.addEventListener(RATE_LIMIT_RETRY_EVENT, () => schedule(1000, "rate-limit-manual"));
  window.addEventListener(SILENT_RECOVERY_RELOAD_EVENT, () => schedule(0, "manual"));

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

  // Windows/Linux do not emit AppKit power snapshots. A timer gap gives fresh
  // probes time to run before mutation, even when performance.now pauses in sleep.
  let lastHealthTickAt = Date.now();
  setInterval(() => {
    const tickAt = Date.now();
    if (
      !isMac &&
      (tickAt - lastHealthTickAt > REALTIME_UNOBSERVED_SETTLE_MS || tickAt < lastHealthTickAt)
    ) {
      silentRecovery.resetSettle();
    }
    lastHealthTickAt = tickAt;
    sampleSyncProcessing(processingActive());
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
      schedule(1000, "rate-limit");
    }
    realtime.check();
    silentRecovery.tick();
    emitHeartbeat();
  }, 5_000);
}
