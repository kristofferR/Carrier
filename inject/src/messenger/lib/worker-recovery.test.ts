import { beforeAll, describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import {
  createFacebookModuleDefineInterceptor,
  type FacebookModuleDefine,
} from "./facebook-modules";
import {
  FacebookWorkerRecovery,
  hasSoleMessengerWindow,
  SilentRecoveryBudget,
} from "./worker-recovery";

function fixture(
  canRestartSharedWorker: () => Promise<boolean> = async () => true,
  Recovery = FacebookWorkerRecovery,
) {
  let account: string | undefined = "account-a";
  let currentId: string | null = null;
  let inProgress = false;
  let settled = true;
  let status = "shared_not_exists";
  let resets = 0;
  const rejected: unknown[] = [];
  const watchdogCalls: unknown[][] = [];
  const terminationCalls: string[] = [];
  const sharedShutdownCalls: unknown[][] = [];
  const setupCalls: { receiver: unknown; args: unknown[] }[] = [];
  let setupResult: unknown = Promise.resolve();
  let bridgePromise: Promise<unknown> | null = Promise.resolve();
  let termination: () => Promise<boolean> = async () => {
    settled = false;
    return true;
  };
  const setup = {
    getOrSetupWorker(this: unknown, ...args: unknown[]) {
      setupCalls.push({ receiver: this, args });
      return setupResult;
    },
  };
  const modules: Record<string, unknown> = {
    MAWWaitForBackendSetup: {
      isBackendSetupSettled: () => settled,
      isBackendSetupInProgress: () => inProgress,
      getCurrentWorkerID: () => currentId,
      resetBackendSetup: () => {
        resets++;
      },
      rejectBackendSetup: (error: unknown) => rejected.push(error),
    },
    MAWWebWorkerSingleton: { getWorkerHealthStatus: async () => ({ tag: status }) },
    MAWSetupWorker: {
      waitForWorkerSetup: () => bridgePromise,
      terminateDedicatedWorker: async (reason: string) => {
        terminationCalls.push(reason);
        const stopped = await termination();
        if (stopped) bridgePromise = null;
        return stopped;
      },
      killSharedWorker: async (...args: unknown[]) => {
        sharedShutdownCalls.push(args);
      },
    },
    MAWWorkerWatchdogRecovery: {
      getWorkerRecoveryForWatchdog:
        () =>
        (...args: unknown[]) =>
          watchdogCalls.push(args),
    },
  };
  const recovery = new Recovery(
    (name) => modules[name],
    () => account,
    canRestartSharedWorker,
  );
  recovery.observeSetupExports(setup);
  const args = [{ opaque: true }, () => {}, () => {}, () => {}, "mawInit", () => {}, undefined];
  return {
    recovery,
    setup,
    args,
    modules,
    setupCalls,
    watchdogCalls,
    terminationCalls,
    sharedShutdownCalls,
    rejected,
    get resets() {
      return resets;
    },
    set account(value: string | undefined) {
      account = value;
    },
    set currentId(value: string | null) {
      currentId = value;
    },
    set inProgress(value: boolean) {
      inProgress = value;
    },
    set settled(value: boolean) {
      settled = value;
    },
    set status(value: string) {
      status = value;
    },
    set setupResult(value: unknown) {
      setupResult = value;
    },
    set termination(value: () => Promise<boolean>) {
      termination = value;
    },
    set bridgePromise(value: Promise<unknown> | null) {
      bridgePromise = value;
    },
  };
}

let recoverySource: string;
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `import { FacebookWorkerRecovery } from "./worker-recovery";
        globalThis.Recovery = FacebookWorkerRecovery;`,
      resolveDir: import.meta.dir,
    },
    bundle: true,
    write: false,
  });
  recoverySource = bundle.outputFiles[0]!.text;
});

function deadlineFixture(canRestartSharedWorker?: () => Promise<boolean>) {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const context = {
    Recovery: FacebookWorkerRecovery,
    performance: { now: () => now },
    setTimeout: (run: () => void, delay: number) => {
      const id = ++nextId;
      timers.set(id, { at: now + delay, run });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  };
  runInNewContext(recoverySource, context);
  return {
    f: fixture(canRestartSharedWorker, context.Recovery),
    timers,
    advance: (ms: number, runTimers = true) => {
      now += ms;
      if (!runTimers) return;
      for (const [id, timer] of timers) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.run();
      }
    },
  };
}

describe("recovery inspection deadlines", () => {
  function stalledSetup(canRestartSharedWorker?: () => Promise<boolean>) {
    const value = deadlineFixture(canRestartSharedWorker);
    const { f } = value;
    f.setup.getOrSetupWorker(...f.args);
    f.modules.WACommsConnectionState = {
      WACommsConnectionState: {
        connected: false,
        isConnected() {
          return this.connected;
        },
      },
    };
    f.currentId = "shared-worker";
    f.status = "shared_exists_and_connected";
    f.inProgress = true;
    f.settled = false;
    f.bridgePromise = Promise.resolve({ close() {} });
    return value;
  }

  function stalledDedicated() {
    const value = stalledSetup(async () => false);
    const { f } = value;
    f.currentId = "dedicated";
    f.status = "dedicated_exists";
    const calls: unknown[][] = [];
    const lifecycle = {
      setOnCloseForWorkerInstance(_callback: unknown) {},
    };
    const callback = (reason: unknown, id: unknown, type: unknown) => {
      calls.push([reason, id, type]);
    };
    f.recovery.observeLifecycleExports(lifecycle);
    lifecycle.setOnCloseForWorkerInstance(callback);
    return { ...value, lifecycle, callback, calls };
  }

  test("pending dedicated setup restarts through its registered native lifecycle once", async () => {
    const { f, advance, calls } = stalledDedicated();
    advance(89_999);
    expect(await f.recovery.recover(() => true, true)).toBe("busy");
    advance(1);
    expect(await f.recovery.recover(() => true, true)).toBe("started");
    expect(calls).toEqual([["carrier-sync-recovery", "dedicated", "carrier_recovery"]]);
    expect(f.terminationCalls).toHaveLength(0);
    expect(f.sharedShutdownCalls).toHaveLength(0);
    expect(f.setupCalls).toHaveLength(1);
    expect(f.resets).toBe(0);
    expect(await f.recovery.recover(() => true, true)).toBe("busy");
    expect(calls).toHaveLength(1);
  });

  test("native lifecycle registration starts a fresh pending-setup grace period", async () => {
    const { f, advance, lifecycle, callback, calls } = stalledDedicated();
    advance(90_000);
    lifecycle.setOnCloseForWorkerInstance(callback);
    expect(await f.recovery.recover(() => true, true)).toBe("busy");
    advance(90_000);
    expect(await f.recovery.recover(() => true, true)).toBe("started");
    expect(calls).toHaveLength(1);
  });

  for (const change of [
    "callback",
    "account",
    "bridge",
    "connected",
    "settled",
    "allowed",
  ] as const) {
    test(`a ${change} change while awaiting the dedicated bridge prevents restart`, async () => {
      const { f, advance, lifecycle, callback, calls } = stalledDedicated();
      const bridge = Promise.withResolvers<unknown>();
      f.bridgePromise = bridge.promise;
      advance(90_000);
      let allowed = true;
      const attempt = f.recovery.recover(() => allowed, true);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      if (change === "callback") lifecycle.setOnCloseForWorkerInstance(callback);
      else if (change === "account") f.account = "another-account";
      else if (change === "bridge") f.bridgePromise = Promise.resolve({ close() {} });
      else if (change === "connected") {
        const module = f.modules.WACommsConnectionState as {
          WACommsConnectionState: { connected: boolean };
        };
        module.WACommsConnectionState.connected = true;
      } else if (change === "settled") f.settled = true;
      else allowed = false;
      bridge.resolve({ close() {} });
      expect(await attempt).toBe("busy");
      expect(calls).toHaveLength(0);
    });
  }

  test("an overdue dedicated bridge cannot invoke the captured lifecycle", async () => {
    const { f, advance, calls } = stalledDedicated();
    const bridge = Promise.withResolvers<unknown>();
    f.bridgePromise = bridge.promise;
    advance(90_000);
    const attempt = f.recovery.recover(() => true, true);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    advance(8_000);
    expect(await attempt).toBe("inspection-timeout");
    bridge.resolve({ close() {} });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(calls).toHaveLength(0);
    expect(await f.recovery.recover(() => true, true)).toBe("started");
  });

  test("unknown lifecycle callback shapes disable pending dedicated recovery", async () => {
    const { f, advance, lifecycle, calls } = stalledDedicated();
    lifecycle.setOnCloseForWorkerInstance(() => {});
    advance(90_000);
    expect(await f.recovery.recover(() => true, true)).toBe("busy");
    expect(calls).toHaveLength(0);
  });

  test("only an old disconnected startup with a ready bridge can use shared shutdown", async () => {
    const { f, advance } = stalledSetup();
    advance(89_999);
    expect(await f.recovery.recover(() => true, true)).toBe("busy");
    advance(1);
    expect(await f.recovery.recover()).toBe("busy");
    expect(await f.recovery.recover(() => true, true)).toBe("started");
    expect(f.sharedShutdownCalls).toHaveLength(1);
    expect(f.setupCalls).toHaveLength(1);
    expect(f.resets).toBe(0);
    expect(f.watchdogCalls).toHaveLength(0);
    expect(await f.recovery.recover(() => true, true)).toBe("busy");
    expect(f.sharedShutdownCalls).toHaveLength(1);
  });

  test("a pending page bridge cannot restart the worker or consume the shutdown allowance", async () => {
    const { f, advance } = stalledSetup();
    const bridge = Promise.withResolvers<unknown>();
    f.bridgePromise = bridge.promise;
    advance(90_000);
    const attempt = f.recovery.recover(() => true, true);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    advance(8_000);
    expect(await attempt).toBe("inspection-timeout");
    bridge.resolve({ close() {} });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(f.sharedShutdownCalls).toHaveLength(0);
    expect(await f.recovery.recover(() => true, true)).toBe("started");
    expect(f.sharedShutdownCalls).toHaveLength(1);
  });

  test("pending startup is left alone when shared ownership cannot be established", async () => {
    const { f, advance } = stalledSetup(async () => false);
    advance(90_000);
    expect(await f.recovery.recover(() => true, true)).toBe("busy");
    expect(f.sharedShutdownCalls).toHaveLength(0);
    expect(f.watchdogCalls).toHaveLength(0);
  });

  for (const change of ["connected", "state", "account", "bridge", "settled"] as const) {
    test(`a ${change} change during inventory prevents pending-startup shutdown`, async () => {
      const { f, advance } = stalledSetup(async () => {
        if (change === "connected") {
          const module = f.modules.WACommsConnectionState as {
            WACommsConnectionState: { connected: boolean };
          };
          module.WACommsConnectionState.connected = true;
        } else if (change === "state") {
          f.modules.WACommsConnectionState = {
            WACommsConnectionState: { isConnected: () => false },
          };
        } else if (change === "account") f.account = "another-account";
        else if (change === "bridge") f.bridgePromise = Promise.resolve({ close() {} });
        else f.settled = true;
        return true;
      });
      advance(90_000);
      expect(await f.recovery.recover(() => true, true)).toBe("busy");
      expect(f.sharedShutdownCalls).toHaveLength(0);
      expect(f.watchdogCalls).toHaveLength(0);
    });
  }

  test("a hung status query expires; its late result cannot mutate a later attempt", async () => {
    const { f, advance, timers } = deadlineFixture();
    f.currentId = "worker";
    const pending = Promise.withResolvers<unknown>();
    f.modules.MAWWebWorkerSingleton = { getWorkerHealthStatus: () => pending.promise };
    const attempt = f.recovery.recover();
    advance(8_000);
    expect(await attempt).toBe("inspection-timeout");
    expect(timers.size).toBe(0);
    f.modules.MAWWebWorkerSingleton = {
      getWorkerHealthStatus: async () => ({ tag: "shared_exists_and_connected" }),
    };
    expect(await f.recovery.recover()).toBe("started");
    pending.resolve({ tag: "shared_exists_and_connected" });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.watchdogCalls).toHaveLength(1);
    expect(timers.size).toBe(0);
  });

  test("late native inventory cannot shut down the shared worker or reattach a bridge", async () => {
    const inventory = Promise.withResolvers<boolean>();
    const { f, advance } = deadlineFixture(() => inventory.promise);
    f.setup.getOrSetupWorker(...f.args);
    f.currentId = "worker";
    f.status = "shared_exists_and_connected";
    expect(await f.recovery.recover()).toBe("started");
    const attempt = f.recovery.recover(() => true, true);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    advance(8_000);
    expect(await attempt).toBe("inspection-timeout");
    inventory.resolve(true);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(f.sharedShutdownCalls).toHaveLength(0);
    expect(f.watchdogCalls).toHaveLength(1);
    expect(await f.recovery.recover(() => true, true)).toBe("started");
    expect(f.sharedShutdownCalls).toHaveLength(1);
  });

  test("overdue responses are rejected even before the timeout task runs after suspension", async () => {
    const { f, advance, timers } = deadlineFixture();
    f.currentId = "worker";
    const pending = Promise.withResolvers<unknown>();
    f.modules.MAWWebWorkerSingleton = { getWorkerHealthStatus: () => pending.promise };
    const attempt = f.recovery.recover();
    advance(60_000, false);
    pending.resolve({ tag: "shared_exists_and_connected" });
    expect(await attempt).toBe("inspection-timeout");
    expect(f.watchdogCalls).toHaveLength(0);
    expect(timers.size).toBe(0);
  });

  for (const stage of ["setup", "termination"] as const) {
    test(`a pending ${stage} still prevents a competing initialization`, async () => {
      const { f, advance, timers } = deadlineFixture();
      f.setup.getOrSetupWorker(...f.args);
      const pending = Promise.withResolvers<boolean>();
      if (stage === "setup") f.setupResult = pending.promise;
      else {
        f.currentId = "dedicated";
        f.status = "dedicated_exists";
        f.termination = () => pending.promise;
      }
      const attempt = f.recovery.recover();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      advance(3_600_000);
      expect(await f.recovery.recover()).toBe("busy");
      expect(timers.size).toBe(0);
      if (stage === "termination") f.settled = false;
      pending.resolve(true);
      expect(await attempt).toBe("started");
      expect(f.setupCalls).toHaveLength(2);
    });
  }
});

describe("Messenger worker recovery", () => {
  test("requires an unambiguous sole Messenger window for shared shutdown", () => {
    expect(hasSoleMessengerWindow(["main"])).toBe(true);
    expect(hasSoleMessengerWindow(["main", "settings"])).toBe(true);
    expect(hasSoleMessengerWindow(["win-2", "settings"])).toBe(true);
    expect(hasSoleMessengerWindow(["main", "win-2"])).toBe(false);
    expect(hasSoleMessengerWindow(["main", "unknown"])).toBe(false);
    expect(hasSoleMessengerWindow(["settings"])).toBe(false);
    expect(hasSoleMessengerWindow(undefined)).toBe(false);
  });

  for (const moduleName of ["MAWSetupWorker", "MAWWebWorkerSingleton"]) {
    test(`intercepts ${moduleName} without inspecting dependency exports`, () => {
      let factory: ((...args: unknown[]) => unknown) | undefined;
      const define: FacebookModuleDefine = (_name, _deps, value) => {
        factory = value as typeof factory;
      };
      const observed: unknown[] = [];
      const intercept = createFacebookModuleDefineInterceptor(
        define,
        () => false,
        undefined,
        undefined,
        moduleName === "MAWSetupWorker" ? (value) => observed.push(value) : undefined,
        undefined,
        moduleName === "MAWWebWorkerSingleton" ? (value) => observed.push(value) : undefined,
      );
      const dependency = { getOrSetupWorker() {} };
      const exports = { getOrSetupWorker() {} };
      function original(
        _global: unknown,
        _require: unknown,
        _import: unknown,
        _requireDefault: unknown,
        _dependency: unknown,
        _module: unknown,
        output: unknown,
      ) {
        Object.assign(output as object, exports);
      }
      intercept(moduleName, [], original);
      expect(factory?.length).toBe(original.length);
      const output = {};
      factory?.({}, {}, {}, {}, dependency, { exports: output }, output);
      expect(observed).toContain(output);
      expect(observed).not.toContain(dependency);
    });
  }

  test("retries a failed bootstrap using exactly the original callbacks and receiver", async () => {
    const f = fixture();
    const result = Promise.resolve("bridge");
    f.setupResult = result;
    expect(f.setup.getOrSetupWorker(...f.args)).toBe(result);
    expect(await f.recovery.recover()).toBe("started");
    expect(f.resets).toBe(1);
    expect(f.setupCalls).toHaveLength(2);
    expect(f.setupCalls[1]?.receiver).toBe(f.setup);
    expect(f.setupCalls[1]?.args).toEqual([
      ...f.args.slice(0, 4),
      "bridgeRecovery",
      ...f.args.slice(5),
    ]);
    expect(f.setupCalls[1]?.args[0]).toBe(f.args[0]);
    expect(f.args[4]).toBe("mawInit");
    expect(f.watchdogCalls).toHaveLength(0);
  });

  test("uses Messenger's existing callback for a worker that had an identity", async () => {
    const f = fixture();
    f.currentId = "worker";
    expect(await f.recovery.recover()).toBe("started");
    expect(f.watchdogCalls).toEqual([["locks_based_recovery", "worker", "locks_based_recovery"]]);
    expect(f.resets).toBe(0);
    expect(f.setupCalls).toHaveLength(0);
  });

  test("escalates one failed bridge repair through Messenger's own shared-worker lifecycle", async () => {
    const f = fixture();
    f.setup.getOrSetupWorker(...f.args);
    f.currentId = "worker";
    f.status = "shared_exists_and_connected";
    expect(await f.recovery.recover()).toBe("started");
    expect(await f.recovery.recover(() => true, true)).toBe("started");
    expect(f.watchdogCalls).toHaveLength(1);
    expect(f.sharedShutdownCalls).toEqual([[false, "carrier-sync-recovery"]]);
    expect(f.setupCalls).toHaveLength(1);
    expect(f.resets).toBe(0);
    // A shutdown request is not proof that the worker died. Do not broadcast
    // again in the same unhealthy episode, even if its identity has not moved.
    expect(await f.recovery.recover(() => true, true)).toBe("started");
    expect(f.sharedShutdownCalls).toHaveLength(1);
    f.recovery.clearEscalation();
    expect(await f.recovery.recover(() => true, true)).toBe("started");
    expect(f.sharedShutdownCalls).toHaveLength(1);
    expect(await f.recovery.recover(() => true, true)).toBe("started");
    expect(f.sharedShutdownCalls).toHaveLength(2);
  });

  test("never shuts down a shared worker without a prior repair or the current account", async () => {
    const f = fixture();
    f.setup.getOrSetupWorker(...f.args);
    f.currentId = "worker";
    f.status = "shared_exists_and_connected";
    expect(await f.recovery.recover(() => true, true)).toBe("started");
    expect(f.sharedShutdownCalls).toHaveLength(0);
    f.account = "account-b";
    expect(await f.recovery.recover(() => true, true)).toBe("started");
    expect(f.sharedShutdownCalls).toHaveLength(0);
  });

  test("leaves a shared worker alive when another Messenger window exists", async () => {
    const f = fixture(async () => false);
    f.setup.getOrSetupWorker(...f.args);
    f.currentId = "worker";
    f.status = "shared_exists_and_connected";
    expect(await f.recovery.recover()).toBe("started");
    expect(await f.recovery.recover(() => true, true)).toBe("started");
    expect(f.watchdogCalls).toHaveLength(2);
    expect(f.sharedShutdownCalls).toHaveLength(0);
  });

  test("rechecks protection and worker identity after the native window query", async () => {
    const f = fixture(async () => {
      f.bridgePromise = Promise.resolve();
      return true;
    });
    f.setup.getOrSetupWorker(...f.args);
    f.currentId = "worker";
    f.status = "shared_exists_and_connected";
    expect(await f.recovery.recover()).toBe("started");
    expect(await f.recovery.recover(() => true, true)).toBe("busy");
    expect(f.sharedShutdownCalls).toHaveLength(0);
  });

  test("does not shut down if recovery times out while querying native windows", async () => {
    let allowed = true;
    const f = fixture(async () => {
      allowed = false;
      return true;
    });
    f.setup.getOrSetupWorker(...f.args);
    f.currentId = "worker";
    f.status = "shared_exists_and_connected";
    expect(await f.recovery.recover()).toBe("started");
    expect(await f.recovery.recover(() => allowed, true)).toBe("busy");
    expect(f.sharedShutdownCalls).toHaveLength(0);
  });

  test("does not shut down when a shared bridge changes during asynchronous inspection", async () => {
    const f = fixture();
    f.setup.getOrSetupWorker(...f.args);
    f.currentId = "worker";
    f.status = "shared_exists_and_connected";
    expect(await f.recovery.recover()).toBe("started");
    f.modules.MAWWebWorkerSingleton = {
      getWorkerHealthStatus: async () => {
        f.bridgePromise = Promise.resolve();
        return { tag: "shared_exists_and_connected" };
      },
    };
    expect(await f.recovery.recover(() => true, true)).toBe("started");
    expect(f.sharedShutdownCalls).toHaveLength(0);
  });

  test("does not shut down a replacement shared worker after asynchronous inspection", async () => {
    const f = fixture();
    f.setup.getOrSetupWorker(...f.args);
    f.currentId = "worker";
    f.status = "shared_exists_and_connected";
    expect(await f.recovery.recover()).toBe("started");
    f.modules.MAWWebWorkerSingleton = {
      getWorkerHealthStatus: async () => {
        f.currentId = "replacement";
        return { tag: "shared_exists_and_connected" };
      },
    };
    expect(await f.recovery.recover(() => true, true)).toBe("started");
    expect(f.sharedShutdownCalls).toHaveLength(0);
  });

  test("a failed shared-worker shutdown is not broadcast again in the same episode", async () => {
    const f = fixture();
    f.setup.getOrSetupWorker(...f.args);
    f.currentId = "worker";
    f.status = "shared_exists_and_connected";
    expect(await f.recovery.recover()).toBe("started");
    let calls = 0;
    Object.assign(f.modules.MAWSetupWorker as object, {
      killSharedWorker: async () => {
        calls++;
        throw new Error("shutdown request failed");
      },
    });
    expect(await f.recovery.recover(() => true, true)).toBe("failed");
    expect(await f.recovery.recover(() => true, true)).toBe("started");
    expect(calls).toBe(1);
  });

  test("stops and replays a dedicated worker without navigating", async () => {
    const f = fixture();
    f.setup.getOrSetupWorker(...f.args);
    f.currentId = "dedicated";
    f.status = "dedicated_exists";
    expect(await f.recovery.recover()).toBe("started");
    expect(f.terminationCalls).toEqual(["bridgeRecovery"]);
    expect(f.setupCalls).toHaveLength(2);
    expect(f.setupCalls[1]?.args[4]).toBe("bridgeRecovery");
    expect(f.setupCalls[1]?.args[0]).toBe(f.args[0]);
    expect(f.watchdogCalls).toHaveLength(0);
    // Messenger's dedicated termination resets backend setup itself.
    expect(f.resets).toBe(0);
  });

  test("replays a failed dedicated bootstrap when no worker exists", async () => {
    const f = fixture();
    f.setup.getOrSetupWorker(...f.args);
    f.status = "dedicated_not_exists";
    expect(await f.recovery.recover()).toBe("started");
    expect(f.terminationCalls).toHaveLength(0);
    expect(f.resets).toBe(1);
    expect(f.setupCalls).toHaveLength(2);
  });

  test("does not race a dedicated termination or replay after an account switch", async () => {
    const f = fixture();
    f.setup.getOrSetupWorker(...f.args);
    f.currentId = "dedicated";
    f.status = "dedicated_exists";
    let complete: (stopped: boolean) => void = () => {};
    f.termination = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    const pending = f.recovery.recover();
    await Promise.resolve();
    await Promise.resolve();
    expect(await f.recovery.recover()).toBe("busy");
    f.account = "account-b";
    complete(true);
    expect(await pending).toBe("busy");
    expect(f.setupCalls).toHaveLength(1);
  });

  test("does not replay if a dedicated worker could not be stopped", async () => {
    const f = fixture();
    f.setup.getOrSetupWorker(...f.args);
    f.currentId = "dedicated";
    f.status = "dedicated_exists";
    f.termination = async () => false;
    expect(await f.recovery.recover()).toBe("unsupported");
    expect(f.setupCalls).toHaveLength(1);
    expect(f.watchdogCalls).toHaveLength(0);
  });

  test("will not terminate a replacement dedicated worker after asynchronous inspection", async () => {
    const f = fixture();
    f.setup.getOrSetupWorker(...f.args);
    f.currentId = "dedicated";
    f.modules.MAWWebWorkerSingleton = {
      getWorkerHealthStatus: async () => {
        f.bridgePromise = Promise.resolve();
        return { tag: "dedicated_exists" };
      },
    };
    expect(await f.recovery.recover()).toBe("unsupported");
    expect(f.terminationCalls).toHaveLength(0);
    expect(f.setupCalls).toHaveLength(1);
  });

  test("does not replay a new same-account setup seen during worker inspection", async () => {
    const f = fixture();
    f.setup.getOrSetupWorker(...f.args);
    f.modules.MAWWebWorkerSingleton = {
      getWorkerHealthStatus: async () => {
        f.setup.getOrSetupWorker(...f.args);
        return { tag: "shared_not_exists" };
      },
    };
    expect(await f.recovery.recover()).toBe("busy");
    expect(f.resets).toBe(0);
    expect(f.setupCalls).toHaveLength(2);
  });

  test("does not replay if backend reset itself starts another setup", async () => {
    const f = fixture();
    f.setup.getOrSetupWorker(...f.args);
    Object.assign(f.modules.MAWWaitForBackendSetup as object, {
      resetBackendSetup: () => f.setup.getOrSetupWorker(...f.args),
    });
    expect(await f.recovery.recover()).toBe("busy");
    expect(f.setupCalls).toHaveLength(2);
  });

  test("does not replay a new same-account setup after dedicated termination", async () => {
    const f = fixture();
    f.setup.getOrSetupWorker(...f.args);
    f.currentId = "dedicated";
    f.status = "dedicated_exists";
    f.termination = async () => {
      f.setup.getOrSetupWorker(...f.args);
      f.settled = false;
      return true;
    };
    expect(await f.recovery.recover()).toBe("busy");
    expect(f.terminationCalls).toEqual(["bridgeRecovery"]);
    expect(f.setupCalls).toHaveLength(2);
  });

  test("cannot replay another account's bootstrap or an unknown ABI", async () => {
    const f = fixture();
    f.setup.getOrSetupWorker(...f.args);
    f.account = "account-b";
    expect(await f.recovery.recover()).toBe("unsupported");
    const unknown = fixture();
    unknown.setup.getOrSetupWorker({}, "changed-ABI");
    expect(await unknown.recovery.recover()).toBe("unsupported");
    expect(f.resets + unknown.resets).toBe(0);
  });

  test("unavailable account scope never prevents Messenger's original setup", async () => {
    const f = fixture();
    const recovery = new FacebookWorkerRecovery(
      (name) => f.modules[name],
      () => {
        throw new Error("cookie access unavailable");
      },
    );
    recovery.observeSetupExports(f.setup);
    const result = Promise.resolve("original");
    f.setupResult = result;
    expect(f.setup.getOrSetupWorker(...f.args)).toBe(result);
    expect(await recovery.recover()).toBe("unsupported");
    expect(f.resets).toBe(0);
  });

  test("leaves unknown worker kinds and Messenger's ongoing initialization alone", async () => {
    const f = fixture();
    f.setup.getOrSetupWorker(...f.args);
    f.inProgress = true;
    expect(await f.recovery.recover()).toBe("busy");
    f.inProgress = false;
    f.settled = false;
    expect(await f.recovery.recover()).toBe("busy");
    f.settled = true;
    f.status = "dedicated_exists";
    expect(await f.recovery.recover()).toBe("unsupported");
    expect(f.resets).toBe(0);
  });

  test("rechecks draft/call protection after asynchronous worker inspection", async () => {
    const f = fixture();
    f.setup.getOrSetupWorker(...f.args);
    let allowed = true;
    f.modules.MAWWebWorkerSingleton = {
      getWorkerHealthStatus: async () => {
        allowed = false;
        return { tag: "shared_not_exists" };
      },
    };
    expect(await f.recovery.recover(() => allowed)).toBe("busy");
    expect(f.resets).toBe(0);
  });

  test("transient worker inspection failures keep the bounded retry episode", async () => {
    const f = fixture();
    f.setup.getOrSetupWorker(...f.args);
    f.modules.MAWWebWorkerSingleton = {
      getWorkerHealthStatus: async () => {
        throw new Error("temporary lock failure");
      },
    };
    expect(await f.recovery.recover()).toBe("failed");
    expect(f.resets).toBe(0);
  });

  test("serializes recovery and preserves backend rejection if a retry fails", async () => {
    const f = fixture();
    f.setup.getOrSetupWorker(...f.args);
    let reject: (error: unknown) => void = () => {};
    f.setupResult = new Promise((_resolve, fail) => {
      reject = fail;
    });
    const pending = f.recovery.recover();
    expect(await f.recovery.recover()).toBe("busy");
    await Promise.resolve();
    const error = new Error("worker failed");
    reject(error);
    expect(await pending).toBe("started");
    expect(f.rejected).toEqual([error]);
    expect(f.resets).toBe(1);
  });
});

describe("silent recovery budget", () => {
  test("resuming observation preserves attempts and gives probes a new window", () => {
    const b = new SilentRecoveryBudget();
    expect(b.start(0)).toBe(true);
    b.restartObservation(100_000);
    b.observe(false, 100_001);
    expect(b.start(100_001)).toBe(false);
    b.observe(false, 130_000);
    expect(b.start(144_999)).toBe(false);
    expect(b.start(145_000)).toBe(true);
    expect(b.attemptCount).toBe(2);
  });
  test("unobserved time across suspend cannot replenish the retry budget", () => {
    const b = new SilentRecoveryBudget();
    b.giveUp();
    b.observe(true, 0);
    b.observe(true, 55_000);
    b.restartObservation(3_600_000);
    b.observe(true, 3_600_000);
    expect(b.exhausted).toBe(true);
    b.observe(true, 3_659_999);
    expect(b.exhausted).toBe(true);
    b.observe(true, 3_660_000);
    expect(b.exhausted).toBe(false);
  });
  test("waiting for Messenger does not spend repair attempts", () => {
    const b = new SilentRecoveryBudget();
    for (let i = 0; i < 10; i++) {
      expect(b.start(i * 5000)).toBe(true);
      b.cancel();
    }
    expect(b.exhausted).toBe(false);
    expect(b.start(50_000)).toBe(true);
    b.giveUp();
    b.cancel();
    expect(b.exhausted).toBe(true);
  });

  test("backs off between three bounded attempts", () => {
    const b = new SilentRecoveryBudget();
    expect(b.start(0)).toBe(true);
    expect(b.start(1)).toBe(false);
    b.observe(false, 30_000);
    expect(b.start(44_999)).toBe(false);
    expect(b.start(45_000)).toBe(true);
    b.observe(false, 75_000);
    expect(b.start(134_999)).toBe(false);
    expect(b.start(135_000)).toBe(true);
    b.observe(false, 165_000);
    expect(b.exhausted).toBe(true);
    expect(b.start(1_000_000)).toBe(false);
  });

  test("requires sustained health to replenish retries", () => {
    const b = new SilentRecoveryBudget();
    b.giveUp();
    b.observe(true, 0);
    b.observe(false, 59_999);
    expect(b.exhausted).toBe(true);
    b.observe(true, 60_000);
    b.observe(true, 120_000);
    expect(b.exhausted).toBe(false);
    expect(b.start(120_001)).toBe(true);
  });

  test("a brief healthy sample ends observation but preserves retry backoff", () => {
    const b = new SilentRecoveryBudget();
    expect(b.start(0)).toBe(true);
    b.observe(true, 5_000);
    b.observe(false, 10_000);
    expect(b.start(19_999)).toBe(false);
    expect(b.start(20_000)).toBe(true);
  });

  test("a network restoration grants one extra attempt until health is sustained", () => {
    const b = new SilentRecoveryBudget();
    expect(b.grantNetworkRestoration(0)).toBe(false);
    b.giveUp();
    expect(b.grantNetworkRestoration(15_000)).toBe(true);
    expect(b.start(15_000)).toBe(true);
    b.observe(false, 45_000);
    expect(b.exhausted).toBe(true);
    expect(b.grantNetworkRestoration(60_000)).toBe(false);
    b.observe(true, 60_000);
    b.observe(false, 119_999);
    expect(b.grantNetworkRestoration(120_000)).toBe(false);
    b.observe(true, 120_000);
    b.observe(true, 180_000);
    b.giveUp();
    expect(b.grantNetworkRestoration(195_000)).toBe(true);
  });
});
