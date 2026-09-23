import { REALTIME_NEVER_CONNECTED_MS } from "./realtime-health";

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

export type WorkerRecoveryResult =
  | "started"
  | "busy"
  | "unsupported"
  | "failed"
  | "inspection-timeout";

const INSPECTION_TIMEOUT_MS = 8_000;
const nativeSetTimeout = setTimeout.bind(globalThis);
const nativeClearTimeout = clearTimeout.bind(globalThis);
const nativeNow = performance.now.bind(performance);
class InspectionTimeout extends Error {}

type RecoveryPhase =
  | "idle"
  | "worker-status"
  | "bridge-readiness"
  | "window-inventory"
  | "shared-shutdown"
  | "dedicated-termination"
  | "setup"
  | "bridge-repair";

/** Only read-only queries may be abandoned; setup/termination must stay single-flight. */
async function inspect(read: () => unknown): Promise<unknown> {
  const startedAt = nativeNow();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = nativeSetTimeout(() => reject(new InspectionTimeout()), INSPECTION_TIMEOUT_MS);
      }),
    ]);
    // After suspension a promise can run before the overdue timeout task.
    if (nativeNow() - startedAt >= INSPECTION_TIMEOUT_MS) throw new InspectionTimeout();
    return result;
  } finally {
    nativeClearTimeout(timer);
  }
}

/** Treat unknown native windows as possible Messenger clients. */
export function hasSoleMessengerWindow(value: unknown): boolean {
  if (!Array.isArray(value) || value.some((label) => typeof label !== "string")) return false;
  const messenger = value.filter((label) => label === "main" || /^win-\d+$/.test(label));
  return (
    messenger.length === 1 &&
    value.every((label) => label === "settings" || messenger.includes(label))
  );
}

/** Retain Messenger's own setup closure, never copy or serialize its key material. */
export class FacebookWorkerRecovery {
  private replay: (() => unknown) | undefined;
  private scope: string | undefined;
  private setupStartedAt: number | undefined;
  private recovering = false;
  private readonly wrapped = new WeakSet<object>();
  private sharedBridgeRepair: { scope: string; id: string } | undefined;
  private lifecycleRestartUsedScope: string | undefined;
  private lifecycle: { callback: Method; scope: string | undefined } | undefined;
  private pausedDedicatedSetup:
    | { scope: string; replay: () => unknown; state: unknown; setup: unknown }
    | undefined;
  private currentPhase: RecoveryPhase = "idle";

  get phase(): RecoveryPhase {
    return this.currentPhase;
  }

  constructor(
    private readonly load: ModuleLoader,
    private readonly accountScope: () => string | undefined,
    private readonly canRestartSharedWorker: () => Promise<boolean> = async () => false,
  ) {}

  observeLifecycleExports(value: unknown): void {
    const exports = record(value);
    const register = method(exports, "setOnCloseForWorkerInstance");
    if (!exports || !register || this.wrapped.has(register)) return;
    const owner = this;
    const wrapped = new Proxy(register, {
      apply(target, receiver, args: unknown[]) {
        const result = Reflect.apply(target, receiver, args);
        try {
          const callback = args[0];
          owner.pausedDedicatedSetup = undefined;
          owner.lifecycle =
            result === undefined &&
            args.length === 1 &&
            typeof callback === "function" &&
            callback.length === 3
              ? { callback: callback as Method, scope: owner.accountScope() }
              : undefined;
          owner.setupStartedAt = nativeNow();
        } catch (_) {
          owner.lifecycle = undefined;
        }
        return result;
      },
    });
    try {
      exports.setOnCloseForWorkerInstance = wrapped;
      this.wrapped.add(wrapped);
    } catch (_) {}
  }

  observeSetupExports(value: unknown): void {
    const exports = record(value);
    const setup = method(exports, "getOrSetupWorker");
    if (!exports || !setup || this.wrapped.has(setup)) return;
    const owner = this;
    const wrapped = new Proxy(setup, {
      apply(target, receiver, args: unknown[]) {
        owner.replay = undefined;
        owner.scope = undefined;
        owner.setupStartedAt = undefined;
        owner.pausedDedicatedSetup = undefined;
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
            owner.setupStartedAt = nativeNow();
            owner.replay = () => Reflect.apply(target, receiver, retryArgs);
          } catch (_) {
            owner.scope = undefined;
            owner.setupStartedAt = undefined;
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

  /** A sustained verified connection starts a fresh escalation episode. */
  clearEscalation(): void {
    this.sharedBridgeRepair = undefined;
    this.lifecycleRestartUsedScope = undefined;
  }

  async recover(
    allowed: () => boolean = () => true,
    escalate = false,
  ): Promise<WorkerRecoveryResult> {
    if (this.recovering) return "busy";
    this.recovering = true;
    try {
      if (!allowed()) return "busy";
      let startingScope: string | undefined;
      try {
        startingScope = this.accountScope();
      } catch (_) {
        return "unsupported";
      }
      if (!startingScope) return "unsupported";
      if (this.sharedBridgeRepair?.scope !== startingScope) this.sharedBridgeRepair = undefined;
      if (this.lifecycleRestartUsedScope !== startingScope)
        this.lifecycleRestartUsedScope = undefined;
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
      const pendingSetup = inProgress.call(state) === true || settled.call(state) !== true;
      const paused = this.pausedDedicatedSetup;
      const canResumeDedicated = () => {
        if (!paused || this.pausedDedicatedSetup !== paused) return false;
        const setup = this.load("MAWSetupWorker");
        return (
          paused.scope === startingScope &&
          this.scope === startingScope &&
          paused.replay === this.replay &&
          paused.state === state &&
          paused.setup === setup &&
          currentId.call(state) === "dedicated" &&
          inProgress.call(state) === false &&
          settled.call(state) === false &&
          method(setup, "waitForWorkerSetup")?.call(setup) === null
        );
      };
      const resumingDedicated = canResumeDedicated();
      if (pendingSetup && !resumingDedicated && !escalate) return "busy";
      const currentConnectionState = () =>
        record(this.load("WACommsConnectionState"))?.WACommsConnectionState;
      const connectionState =
        pendingSetup && !resumingDedicated ? currentConnectionState() : undefined;
      const connected = method(connectionState, "isConnected");
      const stillPendingAndDisconnected = () =>
        inProgress.call(state) === true &&
        settled.call(state) === false &&
        currentConnectionState() === connectionState &&
        connected?.call(connectionState) === false;
      const stalledSetup =
        pendingSetup &&
        !resumingDedicated &&
        escalate &&
        !!this.replay &&
        this.scope === startingScope &&
        this.setupStartedAt !== undefined &&
        nativeNow() - this.setupStartedAt >= REALTIME_NEVER_CONNECTED_MS &&
        stillPendingAndDisconnected();
      if (pendingSetup && !resumingDedicated && !stalledSetup) return "busy";
      const initialId = currentId.call(state);
      if (stalledSetup && (typeof initialId !== "string" || initialId.length === 0)) {
        return "busy";
      }
      const setup = initialId ? this.load("MAWSetupWorker") : undefined;
      const bridge = method(setup, "waitForWorkerSetup");
      const initialBridge = bridge?.call(setup);
      // Messenger may start a new setup for the same account while status or
      // termination is pending. Never replay callbacks from another attempt.
      const replay = this.replay;
      const replayScope = this.scope;
      this.currentPhase = "worker-status";
      const status = record(await inspect(() => health.call(singleton)));
      if (
        !allowed() ||
        startingScope !== this.accountScope() ||
        this.replay !== replay ||
        this.scope !== replayScope
      ) {
        return "busy";
      }
      // Unknown worker protocols cannot establish a safe recovery path.
      if (
        !status ||
        ![
          "dedicated_not_exists",
          "dedicated_exists",
          "shared_not_exists",
          "shared_exists_not_connected",
          "shared_exists_and_connected",
        ].includes(String(status.tag))
      ) {
        return "unsupported";
      }
      if (resumingDedicated && paused) {
        if (status.tag !== "dedicated_not_exists" || !canResumeDedicated()) return "busy";
        // Carrier already stopped this exact dedicated worker, but a protection
        // gate deferred setup. Resume only after a fresh no-worker inspection.
        this.pausedDedicatedSetup = undefined;
        this.currentPhase = "setup";
        try {
          await paused.replay();
        } catch (error) {
          reject.call(state, error);
        }
        return "started";
      }
      if (stalledSetup) {
        if (
          !["shared_exists_and_connected", "dedicated_exists"].includes(String(status.tag)) ||
          !stillPendingAndDisconnected()
        ) {
          return "busy";
        }
      } else if (inProgress.call(state) === true || settled.call(state) !== true) return "busy";
      const id = currentId.call(state);
      if (status.tag === "dedicated_exists") {
        if (
          id !== "dedicated" ||
          initialId !== id ||
          !initialBridge ||
          typeof record(initialBridge)?.then !== "function" ||
          bridge?.call(setup) !== initialBridge ||
          !replay ||
          replayScope !== startingScope
        ) {
          return "unsupported";
        }
        if (stalledSetup) {
          const lifecycle = this.lifecycle;
          if (
            !lifecycle ||
            lifecycle.scope !== startingScope ||
            this.lifecycleRestartUsedScope === startingScope
          )
            return "busy";
          this.currentPhase = "bridge-readiness";
          const readyBridge = await inspect(() => initialBridge);
          if (!method(readyBridge, "close")) return "unsupported";
          if (
            !allowed() ||
            startingScope !== this.accountScope() ||
            this.lifecycle !== lifecycle ||
            this.replay !== replay ||
            this.scope !== replayScope ||
            currentId.call(state) !== id ||
            bridge?.call(setup) !== initialBridge ||
            !stillPendingAndDisconnected()
          )
            return "busy";
          // The registered lifecycle closes this page's dedicated Worker and
          // restarts it with Messenger's own closure, including pending setup.
          this.lifecycleRestartUsedScope = startingScope;
          this.currentPhase = "dedicated-termination";
          Reflect.apply(lifecycle.callback, undefined, [
            "carrier-sync-recovery",
            id,
            "carrier_recovery",
          ]);
          return "started";
        }
        const terminate = method(setup, "terminateDedicatedWorker");
        if (!terminate) return "unsupported";
        // Messenger's bridge close calls Worker.terminate() for a dedicated
        // worker. It then resets its own backend/portal/creation state.
        this.currentPhase = "dedicated-termination";
        const stopped = await terminate.call(setup, "bridgeRecovery");
        if (stopped !== true) return "unsupported";
        // Never replay vault material captured for a previous account.
        if (
          startingScope !== this.accountScope() ||
          this.replay !== replay ||
          this.scope !== replayScope
        ) {
          return "busy";
        }
        if (
          bridge?.call(setup) != null ||
          inProgress.call(state) === true ||
          settled.call(state) === true
        ) {
          return "busy";
        }
        if (!allowed()) {
          this.pausedDedicatedSetup = { scope: startingScope, replay, state, setup };
          return "busy";
        }
        try {
          this.currentPhase = "setup";
          await replay();
        } catch (error) {
          reject.call(state, error);
        }
        return "started";
      }
      if (typeof id === "string" && id.length > 0) {
        if (status.tag === "dedicated_not_exists") return "unsupported";
        if (
          escalate &&
          status.tag === "shared_exists_and_connected" &&
          initialId === id &&
          (stalledSetup ||
            (this.sharedBridgeRepair?.scope === startingScope &&
              this.sharedBridgeRepair.id === id)) &&
          this.lifecycleRestartUsedScope !== startingScope &&
          replay &&
          replayScope === startingScope &&
          initialBridge &&
          typeof record(initialBridge)?.then === "function" &&
          bridge?.call(setup) === initialBridge
        ) {
          if (stalledSetup) {
            // The close listener waits for this bridge before restarting.
            // A pending page-bridge setup cannot be rescued through that path.
            this.currentPhase = "bridge-readiness";
            const readyBridge = await inspect(() => initialBridge);
            if (!method(readyBridge, "close")) return "unsupported";
          }
          let soleWindow = false;
          try {
            this.currentPhase = "window-inventory";
            soleWindow = (await inspect(() => this.canRestartSharedWorker())) === true;
          } catch (error) {
            if (error instanceof InspectionTimeout) throw error;
            // An unavailable native window inventory cannot prove ownership.
          }
          if (
            !allowed() ||
            startingScope !== this.accountScope() ||
            currentId.call(state) !== id ||
            this.replay !== replay ||
            this.scope !== replayScope ||
            bridge?.call(setup) !== initialBridge ||
            (stalledSetup
              ? !stillPendingAndDisconnected()
              : inProgress.call(state) === true || settled.call(state) !== true)
          ) {
            return "busy";
          }
          if (soleWindow) {
            const shutdown = method(setup, "killSharedWorker");
            if (!shutdown) return "unsupported";
            // Messenger's own close listener resets and reinitializes the page.
            // Do not replay setup: shutdown is broadcast and its promise does
            // not certify that the old worker has exited.
            this.lifecycleRestartUsedScope = startingScope;
            this.currentPhase = "shared-shutdown";
            await shutdown.call(setup, false, "carrier-sync-recovery");
            return "started";
          }
        }
        if (stalledSetup) return "busy";
        const recovery = this.load("MAWWorkerWatchdogRecovery");
        const callback = method(recovery, "getWorkerRecoveryForWatchdog")?.call(recovery);
        if (typeof callback !== "function") return "unsupported";
        // Reattach this page's bridge using Messenger's existing callback.
        // Status locks prove worker existence, not that its port still works.
        this.currentPhase = "bridge-repair";
        Reflect.apply(callback, undefined, ["locks_based_recovery", id, "locks_based_recovery"]);
        this.sharedBridgeRepair = { scope: startingScope, id };
        return "started";
      }
      if (
        id != null ||
        !["shared_not_exists", "dedicated_not_exists"].includes(String(status.tag)) ||
        !replay ||
        !replayScope ||
        replayScope !== this.accountScope()
      ) {
        return "unsupported";
      }
      try {
        reset.call(state);
        if (
          this.replay !== replay ||
          this.scope !== replayScope ||
          inProgress.call(state) === true ||
          currentId.call(state) != null
        ) {
          return "busy";
        }
        this.currentPhase = "setup";
        await replay();
      } catch (error) {
        // The normal caller does this after a failed setup. Preserve that
        // contract so queued bridge operations reject instead of hanging.
        reject.call(state, error);
      }
      return "started";
    } catch (error) {
      if (error instanceof InspectionTimeout) return "inspection-timeout";
      // Known missing or changed APIs return unsupported above. An operation
      // that exists but throws may recover on a later bounded attempt.
      return "failed";
    } finally {
      this.currentPhase = "idle";
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
  private networkRestorationUsed = false;

  get exhausted(): boolean {
    return this.attempts >= RETRY_DELAYS_MS.length && this.activeUntil === undefined;
  }

  get attemptCount(): number {
    return this.attempts;
  }

  /** Resume with fresh observations, without refunding any attempted repair. */
  restartObservation(now: number): void {
    this.healthySince = undefined;
    if (this.activeUntil !== undefined) this.activeUntil = now + SILENT_RECOVERY_TIMEOUT_MS;
  }

  observe(healthy: boolean, now: number): void {
    if (healthy) {
      if (this.activeUntil !== undefined) this.finish(now);
      this.healthySince ??= now;
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

  /** A real offline-to-online transition earns one more try per unhealthy episode. */
  grantNetworkRestoration(now: number): boolean {
    if (!this.exhausted || this.networkRestorationUsed) return false;
    this.networkRestorationUsed = true;
    this.attempts = RETRY_DELAYS_MS.length - 1;
    this.nextAt = now;
    return true;
  }

  reset(): void {
    this.attempts = 0;
    this.nextAt = 0;
    this.activeUntil = undefined;
    this.healthySince = undefined;
    this.networkRestorationUsed = false;
  }
}
