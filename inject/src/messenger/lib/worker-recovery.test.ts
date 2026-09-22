import { describe, expect, test } from "bun:test";
import {
  createFacebookModuleDefineInterceptor,
  type FacebookModuleDefine,
} from "./facebook-modules";
import { FacebookWorkerRecovery, SilentRecoveryBudget } from "./worker-recovery";

function fixture() {
  let account: string | undefined = "account-a";
  let currentId: string | null = null;
  let inProgress = false;
  let settled = true;
  let status = "shared_not_exists";
  let resets = 0;
  const rejected: unknown[] = [];
  const watchdogCalls: unknown[][] = [];
  const terminationCalls: string[] = [];
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
    },
    MAWWorkerWatchdogRecovery: {
      getWorkerRecoveryForWatchdog:
        () =>
        (...args: unknown[]) =>
          watchdogCalls.push(args),
    },
  };
  const recovery = new FacebookWorkerRecovery(
    (name) => modules[name],
    () => account,
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

describe("Messenger worker recovery", () => {
  test("intercepts the real factory ABI without inspecting dependency exports", () => {
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
      (value) => observed.push(value),
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
    intercept("MAWSetupWorker", [], original);
    expect(factory?.length).toBe(original.length);
    const output = {};
    factory?.({}, {}, {}, {}, dependency, { exports: output }, output);
    expect(observed).toContain(output);
    expect(observed).not.toContain(dependency);
  });

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
