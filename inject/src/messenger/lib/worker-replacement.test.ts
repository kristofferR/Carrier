import { describe, expect, test } from "bun:test";
import { DedicatedWorkerReplacement } from "./worker-replacement";

/** Mirrors MAWWebWorkerSingleton: one creation promise per worker. */
function fixture(workerID = "dedicated") {
  let successful = false;
  let creation: Promise<unknown> | null = null;
  let failNext = false;
  const singleton = {
    createWorkerIfNone(_reason: string) {
      if (creation) return creation;
      const failing = failNext;
      failNext = false;
      creation = failing
        ? Promise.reject(new Error("worker creation failed"))
        : Promise.resolve({ worker: {}, workerID });
      creation.catch(() => {
        creation = null;
      });
      return creation;
    },
    resetWorkerCreation() {
      creation = null;
    },
  };
  const detector = new DedicatedWorkerReplacement((name) =>
    name === "MAWWaitForBackendSetup" ? { isBackendSetupSuccessful: () => successful } : undefined,
  );
  detector.observeLifecycleExports(singleton);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    detector,
    singleton,
    settle,
    setSuccessful: (value: boolean) => {
      successful = value;
    },
    failNextCreation: () => {
      failNext = true;
    },
  };
}

describe("DedicatedWorkerReplacement", () => {
  test("flags a dedicated worker created after the first one served the page", async () => {
    const { detector, singleton, settle, setSuccessful } = fixture();
    await singleton.createWorkerIfNone("mawInit");
    setSuccessful(true);
    expect(detector.replaced()).toBe(false);

    singleton.resetWorkerCreation();
    setSuccessful(false);
    await singleton.createWorkerIfNone("bridgeRecovery");
    await settle();
    expect(detector.replaced()).toBe(true);
  });

  test("ignores callers reusing the current worker", async () => {
    const { detector, singleton, settle, setSuccessful } = fixture();
    const first = singleton.createWorkerIfNone("mawInit");
    setSuccessful(true);
    detector.replaced();
    expect(singleton.createWorkerIfNone("setup-worker")).toBe(first);
    await settle();
    expect(detector.replaced()).toBe(false);
  });

  test("ignores startup retries before any worker served the page", async () => {
    const { detector, singleton, settle, setSuccessful } = fixture();
    await singleton.createWorkerIfNone("mawInit");
    detector.replaced();
    singleton.resetWorkerCreation();
    await singleton.createWorkerIfNone("backendSetupFailure");
    setSuccessful(true);
    await settle();
    expect(detector.replaced()).toBe(false);
  });

  test("leaves Messenger's in-place shared worker restarts alone", async () => {
    const { detector, singleton, settle, setSuccessful } = fixture("shared-worker-id");
    await singleton.createWorkerIfNone("mawInit");
    setSuccessful(true);
    detector.replaced();
    singleton.resetWorkerCreation();
    await singleton.createWorkerIfNone("workerTerminated");
    await settle();
    expect(detector.replaced()).toBe(false);
  });

  test("still flags the replacement after a failed creation attempt", async () => {
    const { detector, singleton, settle, setSuccessful, failNextCreation } = fixture();
    await singleton.createWorkerIfNone("mawInit");
    setSuccessful(true);
    detector.replaced();
    singleton.resetWorkerCreation();
    setSuccessful(false);
    failNextCreation();
    await singleton.createWorkerIfNone("bridgeRecovery").catch(() => {});
    await settle();
    expect(detector.replaced()).toBe(false);

    await singleton.createWorkerIfNone("bridgeRecovery");
    await settle();
    expect(detector.replaced()).toBe(true);
  });
});
