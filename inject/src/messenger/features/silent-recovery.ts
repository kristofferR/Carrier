import { diag } from "../bridge";
import { REALTIME_UNOBSERVED_SETTLE_MS } from "../lib/realtime-health";
import { probeFacebook, StuckWorkerReload } from "../lib/stuck-worker";
import { accountScopedStorageKey } from "../lib/threads";
import {
  SILENT_RECOVERY_EVENT,
  SILENT_RECOVERY_RETRY_EVENT,
  SILENT_RECOVERY_TIMEOUT_MS,
  SilentRecoveryBudget,
} from "../lib/worker-recovery";
import { workerRecovery } from "./worker-recovery";

const NETWORK_RESTORATION_GRACE_MS = 15_000;

/** A responsive document owns transport recovery; it never reloads itself. */
export function createSilentRecovery(options: {
  blocked: (manual: boolean) => boolean;
  needsRecovery: () => boolean;
  isHealthy: () => boolean;
  check: () => void;
  /** Reload the page under the usual draft and call protections. */
  reload: () => void;
  /** Withdraw a queued stuck-worker reload when its evidence is reset. */
  cancelReload: () => void;
}) {
  const budget = new SilentRecoveryBudget();
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const now = performance.now.bind(performance);
  // Captured before Facebook wraps fetch with its own instrumentation.
  const nativeFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : undefined;
  const stuckWorker = new StuckWorkerReload(
    async () => !!nativeFetch && (await probeFacebook(nativeFetch)),
    now,
  );
  let stuckReloadRequested = false;
  const resetStuckWorker = () => {
    stuckWorker.reset();
    stuckReloadRequested = false;
    options.cancelReload();
  };
  const wallNow = Date.now.bind(Date);
  let lastTickAt = wallNow();
  let restartRunningDeadline: (() => void) | undefined;
  let running = false;
  let runningTimedOut = false;
  let failed = false;
  let manualRequested = false;
  let unhealthySince: number | undefined;
  let busySince: number | undefined;
  let unverifiedSince: number | undefined;
  let outageRequests = 0;
  const accountScope = () => accountScopedStorageKey("carrier-worker-recovery", document.cookie);
  let scope = accountScope();
  let scopeEpoch = 0;
  let offlineObserved = !navigator.onLine;
  let networkRestoredAt: number | undefined;
  window.addEventListener("offline", () => {
    if (!navigator.onLine) {
      offlineObserved = true;
      networkRestoredAt = undefined;
    }
  });
  window.addEventListener("online", () => {
    if (!navigator.onLine || !offlineObserved) return;
    offlineObserved = false;
    networkRestoredAt = now();
  });
  const showFailure = (value: boolean) => {
    if (failed === value) return;
    failed = value;
    window.dispatchEvent(new CustomEvent(SILENT_RECOVERY_EVENT, { detail: value }));
  };
  const resetSettle = () => {
    unhealthySince = undefined;
    busySince = undefined;
    // After a wake, give Messenger's own reconnect a fresh chance.
    resetStuckWorker();
    budget.restartObservation(now());
    if (running && !runningTimedOut) restartRunningDeadline?.();
  };
  const tick = () => {
    lastTickAt = wallNow();
    const currentScope = accountScope();
    if (currentScope !== scope) {
      scope = currentScope;
      scopeEpoch++;
      budget.reset();
      resetStuckWorker();
      workerRecovery.clearEscalation();
      manualRequested = false;
      unhealthySince = undefined;
      busySince = undefined;
      unverifiedSince = undefined;
      outageRequests = 0;
      networkRestoredAt = undefined;
      showFailure(false);
    }
    const needed = options.needsRecovery();
    const healthy = options.isHealthy();
    if (needed) unverifiedSince ??= now();
    if (healthy && !needed && unverifiedSince !== undefined) {
      diag(
        "sync.worker-recovered",
        `verified transport restored elapsed_ms=${Math.round(now() - unverifiedSince)} recovery_requests=${outageRequests}`,
      );
      unverifiedSince = undefined;
      outageRequests = 0;
    }
    budget.observe(healthy, now());
    if (healthy && budget.attemptCount === 0) workerRecovery.clearEscalation();
    if (networkRestoredAt !== undefined) {
      if (healthy) networkRestoredAt = undefined;
      else if (now() - networkRestoredAt >= NETWORK_RESTORATION_GRACE_MS) {
        networkRestoredAt = undefined;
        if (budget.grantNetworkRestoration(now())) {
          diag("sync.network-restored", "network restored; allowing one more worker repair");
        }
      }
    }
    if (!needed) {
      manualRequested = false;
      unhealthySince = undefined;
      busySince = undefined;
      resetStuckWorker();
      showFailure(false);
      return;
    }
    if (networkRestoredAt !== undefined) {
      // Messenger has its own socket retry loop. Let it observe the restored
      // network before touching the worker; flapping cannot mint retries.
      return;
    }
    // On wake the old health sample is stale while a fresh heartbeat is still
    // in flight. Give that probe its full deadline before touching the worker.
    unhealthySince ??= now();
    if (now() - unhealthySince < REALTIME_UNOBSERVED_SETTLE_MS) return;
    if (running && runningTimedOut) showFailure(true);
    if (budget.exhausted) showFailure(true);
    if (running || options.blocked(manualRequested) || !budget.start(now())) return;
    const manual = manualRequested;
    const launchEpoch = scopeEpoch;
    manualRequested = false;
    running = true;
    outageRequests++;
    runningTimedOut = false;
    // A timeout cannot cancel a worker termination or shutdown. Keep running
    // latched until the actual promise settles, so no second repair races it.
    // Replayed setup returns at once; the adapter guards it while pending.
    let timeout: number | undefined;
    const expire = () => {
      // This timer can be the first task after resume, before the health tick
      // notices a suspension gap. Never spend the episode on time asleep.
      const gap = wallNow() - lastTickAt;
      if (gap > REALTIME_UNOBSERVED_SETTLE_MS || gap < 0) {
        resetSettle();
        return;
      }
      runningTimedOut = true;
      if (launchEpoch !== scopeEpoch) {
        if (options.needsRecovery()) showFailure(true);
        return;
      }
      if (options.isHealthy()) return;
      budget.giveUp();
      showFailure(true);
      diag(
        "sync.worker-recovery-timeout",
        `worker recovery did not settle phase=${workerRecovery.phase}; preserving the page`,
      );
    };
    restartRunningDeadline = () => {
      nativeClearTimeout(timeout);
      timeout = nativeSetTimeout(expire, SILENT_RECOVERY_TIMEOUT_MS);
    };
    restartRunningDeadline();
    void workerRecovery
      .recover(
        () => !runningTimedOut && !options.blocked(manual) && options.needsRecovery(),
        budget.attemptCount >= 2 ||
          (busySince !== undefined && now() - busySince >= SILENT_RECOVERY_TIMEOUT_MS),
      )
      .then((result) => {
        nativeClearTimeout(timeout);
        restartRunningDeadline = undefined;
        running = false;
        runningTimedOut = false;
        if (launchEpoch !== scopeEpoch) {
          options.check();
          return;
        }
        if (result === "reload") {
          // Not a repair attempt: the page waits for Facebook, then reloads.
          budget.cancel();
          outageRequests--;
          busySince = undefined;
          showFailure(false);
          const due = stuckWorker.due();
          if (due) {
            if (!stuckReloadRequested) {
              stuckReloadRequested = true;
              diag(
                "sync.worker-stuck",
                due === "reachable"
                  ? "encrypted worker stayed disconnected while Facebook answered; reloading"
                  : "encrypted worker stayed disconnected for 10 minutes; reloading",
              );
            }
            options.reload();
          }
        } else if (result === "busy") {
          // Waiting for Messenger or a protection change is not a repair
          // attempt. Keep checking readiness, but expose a stuck startup.
          budget.cancel();
          busySince ??= now();
          if (now() - busySince >= SILENT_RECOVERY_TIMEOUT_MS) showFailure(true);
        } else {
          busySince = undefined;
          if (result === "started") {
            showFailure(false);
            diag(
              "sync.worker-recovery",
              `started Messenger worker recovery without navigation via=${workerRecovery.previousPhase}`,
            );
          }
        }
        if (result === "unsupported" && !options.isHealthy()) {
          budget.giveUp();
          showFailure(true);
          diag(
            "sync.worker-recovery-unavailable",
            "no compatible worker recovery; preserving the page",
          );
        }
        if (result === "failed") {
          diag(
            "sync.worker-recovery-failed",
            "worker recovery attempt failed; retrying with backoff",
          );
        }
        if (result === "inspection-timeout") {
          diag(
            "sync.worker-inspection-timeout",
            "worker inspection timed out before mutation; retrying with backoff",
          );
        }
        // A started callback is not proof of sync. The regular probes must
        // establish health; otherwise this attempt expires and backs off.
        options.check();
      })
      .catch(() => {
        nativeClearTimeout(timeout);
        restartRunningDeadline = undefined;
        running = false;
        runningTimedOut = false;
        if (launchEpoch !== scopeEpoch) return;
        budget.giveUp();
        showFailure(true);
        diag("sync.worker-recovery-failed", "worker recovery failed; preserving the page");
      });
  };
  window.addEventListener(SILENT_RECOVERY_RETRY_EVENT, () => {
    if (running || options.blocked(true)) return;
    budget.reset();
    manualRequested = true;
    showFailure(false);
    tick();
  });
  return {
    tick,
    resetSettle,
  };
}
