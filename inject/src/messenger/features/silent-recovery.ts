import { diag } from "../bridge";
import { REALTIME_UNOBSERVED_SETTLE_MS } from "../lib/realtime-health";
import {
  SILENT_RECOVERY_EVENT,
  SILENT_RECOVERY_RETRY_EVENT,
  SILENT_RECOVERY_TIMEOUT_MS,
  SilentRecoveryBudget,
} from "../lib/worker-recovery";
import { workerRecovery } from "./worker-recovery";

/** A responsive document owns transport recovery; it never reloads itself. */
export function createSilentRecovery(options: {
  blocked: (manual: boolean) => boolean;
  needsRecovery: () => boolean;
  isHealthy: () => boolean;
  check: () => void;
}) {
  const budget = new SilentRecoveryBudget();
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const now = performance.now.bind(performance);
  let running = false;
  let failed = false;
  let manualRequested = false;
  let unhealthySince: number | undefined;
  let busySince: number | undefined;
  const showFailure = (value: boolean) => {
    if (failed === value) return;
    failed = value;
    window.dispatchEvent(new CustomEvent(SILENT_RECOVERY_EVENT, { detail: value }));
  };
  const tick = () => {
    const needed = options.needsRecovery();
    budget.observe(options.isHealthy(), now());
    if (!needed) {
      manualRequested = false;
      unhealthySince = undefined;
      busySince = undefined;
      showFailure(false);
      return;
    }
    // On wake the old health sample is stale while a fresh heartbeat is still
    // in flight. Give that probe its full deadline before touching the worker.
    unhealthySince ??= now();
    if (now() - unhealthySince < REALTIME_UNOBSERVED_SETTLE_MS) return;
    if (budget.exhausted) showFailure(true);
    if (running || options.blocked(manualRequested) || !budget.start(now())) return;
    const manual = manualRequested;
    manualRequested = false;
    running = true;
    // A timeout cannot cancel Messenger's initialization. Keep running latched
    // until the actual promise settles, so no second bootstrap can race it.
    const timeout = nativeSetTimeout(() => {
      if (options.isHealthy()) return;
      budget.giveUp();
      showFailure(true);
      diag("sync.worker-recovery-timeout", "worker recovery did not settle; preserving the page");
    }, SILENT_RECOVERY_TIMEOUT_MS);
    void workerRecovery
      .recover(() => !options.blocked(manual) && options.needsRecovery())
      .then((result) => {
        nativeClearTimeout(timeout);
        running = false;
        if (result === "busy") {
          // Waiting for Messenger or a protection change is not a repair
          // attempt. Keep checking readiness, but expose a stuck startup.
          budget.cancel();
          busySince ??= now();
          if (now() - busySince >= SILENT_RECOVERY_TIMEOUT_MS) showFailure(true);
        } else {
          busySince = undefined;
          if (result === "started") {
            showFailure(false);
            diag("sync.worker-recovery", "started Messenger worker recovery without navigation");
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
        // A started callback is not proof of sync. The regular probes must
        // establish health; otherwise this attempt expires and backs off.
        options.check();
      })
      .catch(() => {
        nativeClearTimeout(timeout);
        running = false;
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
  return { tick };
}
