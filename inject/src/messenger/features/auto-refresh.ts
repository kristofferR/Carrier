/* --------------------------- Sync recovery ---------------------------- */
// Messenger's live sync can stall inside a system WebView. Native heartbeats
// detect a suspended renderer, while page-side lifecycle and transport checks
// catch stale connections. Every recovery defers around drafts and calls.

import { diag, invoke } from "../bridge";
import { AutoRefreshWatchdog, type RefreshReason } from "../lib/auto-refresh";
import { RealtimeRecoveryTracker } from "../lib/realtime-health";
import { monitorRealtimeHealth } from "./realtime-health";

export function initAutoRefresh() {
  // A full reload re-boots the whole Facebook SPA, so only do it after a
  // lifecycle signal that makes its live connection suspect. Drafts and calls
  // are always protected, even for a forced catch-up after sleep or refocus.
  const pageIsActive = () => !document.hidden && document.hasFocus();
  const watchdog = new AutoRefreshWatchdog(Date.now(), pageIsActive());
  let pending = false;
  let reloadWhileActive = false;
  let pendingReason: RefreshReason | "online" = "background";
  let timer: number | undefined;
  const RECOVERY_MIN_GAP_MS = 60_000;
  const RECOVERY_STORAGE_KEY = "carrier-sync-recovery-at";
  const clearPending = () => {
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
  const emitHeartbeat = () => {
    if (typeof heartbeatId !== "number") return;
    const protectedNow = heartbeatProtection();
    lastHeartbeatProtection = protectedNow;
    invoke("plugin:event|emit", {
      event: "carrier:webview-heartbeat",
      payload: { id: heartbeatId, protected: protectedNow },
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
  const maybeReload = () => {
    timer = undefined;
    if (!pending) return;
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
    if (pendingReason !== "background") {
      diag("sync.refresh", `reloading stale Messenger view after ${pendingReason}`);
    }
    if (pendingReason === "realtime") {
      try {
        sessionStorage.setItem(RECOVERY_STORAGE_KEY, String(Date.now()));
      } catch (_) {}
    }
    pending = false;
    location.reload();
  };
  const schedule = (delay: number, reason: RefreshReason | "online", allowWhileActive = false) => {
    if (pageIsActive() && !allowWhileActive) {
      return;
    }
    pending = true;
    reloadWhileActive ||= allowWhileActive;
    pendingReason = reason;
    clearTimeout(timer);
    timer = setTimeout(maybeReload, delay);
  };
  const realtimeRecoveryDelay = () => {
    try {
      const lastRecoveryAt = Number(sessionStorage.getItem(RECOVERY_STORAGE_KEY)) || 0;
      return Math.max(1000, RECOVERY_MIN_GAP_MS - Math.max(0, Date.now() - lastRecoveryAt));
    } catch (_) {
      return 1000;
    }
  };
  const realtimeRecovery = new RealtimeRecoveryTracker();
  const realtime = monitorRealtimeHealth({
    onHealthy: (source) => {
      realtimeRecovery.healthy(source);
      if (pending && pendingReason === "realtime" && !realtimeRecovery.needsRecovery()) {
        clearPending();
      }
    },
    onStale: (source) => {
      realtimeRecovery.stale(source);
      schedule(realtimeRecoveryDelay(), "realtime", true);
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

  // Check often enough that an overdue callback recovers immediately when a
  // suspended WebView resumes. The same tick checks Messenger's realtime MQTT
  // transport for disconnects, stuck reconnects, and half-open silence.
  setInterval(() => {
    emitHeartbeat();
    const reason = watchdog.heartbeat(pageIsActive(), Date.now());
    if (reason) {
      schedule(reason === "background" ? 2000 : 1000, reason, reason !== "background");
    }
    realtime.check();
  }, 5_000);
}
