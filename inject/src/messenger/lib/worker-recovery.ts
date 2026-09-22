type Method = (this: unknown, ...args: unknown[]) => unknown;
type ModuleLoader = (name: string) => unknown;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function method(value: unknown, key: string): Method | undefined {
  const candidate = record(value)?.[key];
  return typeof candidate === "function" ? (candidate as Method) : undefined;
}

export type WorkerRecoveryResult = "started" | "busy" | "unsupported";

/** Retain Messenger's own setup closure, never copy or serialize its key material. */
export class FacebookWorkerRecovery {
  private replay: (() => unknown) | undefined;
  private scope: string | undefined;
  private recovering = false;
  private readonly wrapped = new WeakSet<object>();

  constructor(
    private readonly load: ModuleLoader,
    private readonly accountScope: () => string | undefined,
  ) {}

  observeSetupExports(value: unknown): void {
    const exports = record(value);
    const setup = method(exports, "getOrSetupWorker");
    if (!exports || !setup || this.wrapped.has(setup)) return;
    const owner = this;
    const wrapped = new Proxy(setup, {
      apply(target, receiver, args: unknown[]) {
        // Current MAWSetupWorker ABI: vault, bridge, two lifecycle callbacks,
        // reason, error callback, optional EB state. Unknown shapes fail open.
        if (
          record(args[0]) &&
          [1, 2, 3, 5].every((index) => typeof args[index] === "function") &&
          typeof args[4] === "string"
        ) {
          try {
            const retryArgs = [...args];
            retryArgs[4] = "bridgeRecovery";
            owner.scope = owner.accountScope();
            owner.replay = () => Reflect.apply(target, receiver, retryArgs);
          } catch (_) {
            owner.scope = undefined;
            owner.replay = undefined;
          }
        }
        return Reflect.apply(target, receiver, args);
      },
    });
    try {
      exports.getOrSetupWorker = wrapped;
      this.wrapped.add(wrapped);
    } catch (_) {
      // Frozen or changed exports must never prevent Messenger from booting.
    }
  }

  async recover(allowed: () => boolean = () => true): Promise<WorkerRecoveryResult> {
    if (this.recovering) return "busy";
    this.recovering = true;
    try {
      if (!allowed()) return "busy";
      const startingScope = this.accountScope();
      if (!startingScope) return "unsupported";
      const state = this.load("MAWWaitForBackendSetup");
      const settled = method(state, "isBackendSetupSettled");
      const inProgress = method(state, "isBackendSetupInProgress");
      const currentId = method(state, "getCurrentWorkerID");
      const reset = method(state, "resetBackendSetup");
      const reject = method(state, "rejectBackendSetup");
      const singleton = this.load("MAWWebWorkerSingleton");
      const health = method(singleton, "getWorkerHealthStatus");
      if (!settled || !inProgress || !currentId || !reset || !reject || !health) {
        return "unsupported";
      }
      if (inProgress.call(state) === true || settled.call(state) !== true) return "busy";
      const status = record(await health.call(singleton));
      if (!allowed() || startingScope !== this.accountScope()) return "busy";
      // Never terminate a shared worker: it may serve another window's call.
      if (
        !status ||
        ![
          "shared_not_exists",
          "shared_exists_not_connected",
          "shared_exists_and_connected",
        ].includes(String(status.tag))
      ) {
        return "unsupported";
      }
      if (inProgress.call(state) === true || settled.call(state) !== true) return "busy";
      const id = currentId.call(state);
      if (typeof id === "string" && id.length > 0) {
        const recovery = this.load("MAWWorkerWatchdogRecovery");
        const callback = method(recovery, "getWorkerRecoveryForWatchdog")?.call(recovery);
        if (typeof callback !== "function") return "unsupported";
        // Reattach this page's bridge using Messenger's existing callback.
        // Status locks prove worker existence, not that its port still works.
        Reflect.apply(callback, undefined, ["locks_based_recovery", id, "locks_based_recovery"]);
        return "started";
      }
      if (
        id != null ||
        status.tag !== "shared_not_exists" ||
        !this.replay ||
        !this.scope ||
        this.scope !== this.accountScope()
      ) {
        return "unsupported";
      }
      try {
        reset.call(state);
        await this.replay();
      } catch (error) {
        // The normal caller does this after a failed setup. Preserve that
        // contract so queued bridge operations reject instead of hanging.
        reject.call(state, error);
      }
      return "started";
    } catch (_) {
      return "unsupported";
    } finally {
      this.recovering = false;
    }
  }
}

export const SILENT_RECOVERY_EVENT = "carrier:sync-recovery";
export const SILENT_RECOVERY_RETRY_EVENT = "carrier:sync-recovery-retry";
export const SILENT_RECOVERY_RELOAD_EVENT = "carrier:sync-recovery-reload";
export const SILENT_RECOVERY_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [0, 15_000, 60_000] as const;
const HEALTHY_RESET_MS = 60_000;

/** One finite retry episode; a brief healthy blip cannot refill its budget. */
export class SilentRecoveryBudget {
  private attempts = 0;
  private nextAt = 0;
  private healthySince: number | undefined;
  private activeUntil: number | undefined;

  get exhausted(): boolean {
    return this.attempts >= RETRY_DELAYS_MS.length && this.activeUntil === undefined;
  }

  observe(healthy: boolean, now: number): void {
    if (healthy) {
      this.healthySince ??= now;
      this.activeUntil = undefined;
      if (now - this.healthySince >= HEALTHY_RESET_MS) this.reset();
    } else {
      this.healthySince = undefined;
      if (this.activeUntil !== undefined && now >= this.activeUntil) this.finish(now);
    }
  }

  start(now: number): boolean {
    if (this.activeUntil !== undefined || this.exhausted || now < this.nextAt) return false;
    this.attempts++;
    this.activeUntil = now + SILENT_RECOVERY_TIMEOUT_MS;
    return true;
  }

  finish(now: number): void {
    if (this.activeUntil === undefined) return;
    this.activeUntil = undefined;
    this.nextAt = now + (RETRY_DELAYS_MS[this.attempts] ?? 0);
  }

  cancel(): void {
    if (this.activeUntil === undefined) return;
    this.activeUntil = undefined;
    this.attempts--;
  }

  giveUp(): void {
    this.attempts = RETRY_DELAYS_MS.length;
    this.activeUntil = undefined;
  }

  reset(): void {
    this.attempts = 0;
    this.nextAt = 0;
    this.activeUntil = undefined;
    this.healthySince = undefined;
  }
}
