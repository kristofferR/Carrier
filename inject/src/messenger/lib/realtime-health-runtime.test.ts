import { beforeAll, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import type { monitorRealtimeHealth } from "../features/realtime-health";
import {
  REALTIME_CONNECT_GRACE_MS,
  REALTIME_NEVER_CONNECTED_MS,
  RealtimeRecoveryTracker,
} from "./realtime-health";

let source: string;
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `import { monitorRealtimeHealth } from "../features/realtime-health";
        globalThis.monitor = monitorRealtimeHealth;`,
      resolveDir: import.meta.dir,
    },
    bundle: true,
    write: false,
  });
  source = bundle.outputFiles[0]!.text;
});

test("successful worker probes cannot cancel recovery for a disconnected encrypted transport", async () => {
  let now = 100_000;
  let connected: unknown = true;
  let probes = 0;
  let moduleAvailable = true;
  let setupFailed = false;
  let setupReady = false;
  let setupInProgress = false;
  let setupModuleAvailable = true;
  let bridgeAvailable = true;
  const storage = new Map<string, string>();
  const createMonitor = (account = "123") => {
    const tracker = new RealtimeRecoveryTracker(now);
    class Socket extends EventTarget {}
    const listeners = new Set<(value: unknown) => void>();
    const connection = {
      isConnected: () => connected,
      onSet: (listener: (value: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const window = {
      WebSocket: Socket,
      require(name: string) {
        if (name === "MAWWaitForBackendSetup") {
          if (!setupModuleAvailable) return undefined;
          return {
            isBackendSetupSettled: () => setupFailed || setupReady,
            isBackendSetupSuccessful: () => !setupFailed,
            isBackendSetupInProgress: () => setupInProgress,
            getCurrentWorkerID: () => "worker",
          };
        }
        if (name === "WACommsConnectionState") {
          if (!moduleAvailable) throw new Error("module unavailable");
          return { WACommsConnectionState: connection };
        }
        if (name === "MAWBridgeSendAndReceive") {
          if (!bridgeAvailable) return null;
          return {
            sendAndReceive: async (_namespace: string, route: string) => {
              probes += 1;
              if (route === "resendWorkerStateManagerValuesToMainThread") {
                for (const listener of listeners) listener(connected);
              }
              return true;
            },
          };
        }
        throw new Error("unexpected module");
      },
    };
    const context: { monitor?: typeof monitorRealtimeHealth } = {};
    runInNewContext(source, {
      window,
      document: { cookie: `c_user=${account}` },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      location: { href: "https://www.facebook.com/messages/" },
      URL,
      Date: { now: () => now },
      performance: { now: () => now },
      setTimeout,
      clearTimeout,
      globalThis: context,
    });
    const monitor = context.monitor!({
      onHealthy: (source) => tracker.healthy(source, now),
      onStale: (source) => tracker.stale(source),
      onUnknown: (source) => tracker.withdraw(source),
    });
    const socket = Reflect.construct(window.WebSocket, [
      "wss://edge-chat.facebook.com/chat",
    ]) as Socket;
    socket.dispatchEvent(new Event("open"));
    return {
      tracker,
      isVerifiedHealthy: monitor.isVerifiedHealthy,
      check: async () => {
        socket.dispatchEvent(new Event("message"));
        monitor.check();
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    };
  };
  let { tracker, check } = createMonitor();
  await check();
  expect(tracker.status(now)).toBe("ok");
  connected = false;
  await check();
  now += REALTIME_CONNECT_GRACE_MS - 1;
  await check();
  expect(tracker.needsRecovery(now)).toBe(false);
  now += 1;
  await check();
  expect(probes).toBe(4);
  expect(tracker.status(now)).toBe("stale");
  connected = true;
  await check();
  expect(tracker.status(now)).toBe("ok");
  connected = false;
  await check();
  now += REALTIME_CONNECT_GRACE_MS;
  await check();
  expect(tracker.status(now)).toBe("stale");
  // Missing or changed APIs cannot clear a confirmed encrypted disconnect.
  moduleAvailable = false;
  await check();
  expect(tracker.status(now)).toBe("stale");
  moduleAvailable = true;
  connected = "false";
  now += REALTIME_CONNECT_GRACE_MS;
  await check();
  expect(tracker.status(now)).toBe("stale");
  connected = true;
  await check();
  expect(tracker.status(now)).toBe("ok");
  // A recovery reload must not forget that encrypted sync is expected.
  connected = false;
  ({ tracker, check } = createMonitor());
  await check();
  now += REALTIME_NEVER_CONNECTED_MS - 1;
  await check();
  expect(tracker.needsRecovery(now)).toBe(false);
  now += 1;
  await check();
  expect(tracker.status(now)).toBe("stale");
  ({ tracker, check } = createMonitor());
  await check();
  now += REALTIME_NEVER_CONNECTED_MS;
  await check();
  expect(tracker.status(now)).toBe("stale");
  // Connection history must not arm an uninitialized worker in another account.
  ({ tracker, check } = createMonitor("456"));
  await check();
  now += REALTIME_NEVER_CONNECTED_MS;
  await check();
  expect(tracker.status(now)).toBe("ok");
  // An explicit failed bootstrap is authoritative even without connection
  // history; unrelated MQTT traffic must not hide this first-start failure.
  setupFailed = true;
  await check();
  expect(tracker.status(now)).toBe("stale");
  // A successful first bootstrap is not proof its encrypted socket opened.
  setupFailed = false;
  setupReady = true;
  const fresh = createMonitor("789");
  await fresh.check();
  expect(fresh.isVerifiedHealthy()).toBe(false);
  now += REALTIME_NEVER_CONNECTED_MS;
  await fresh.check();
  expect(fresh.tracker.status(now)).toBe("stale");
  connected = true;
  await fresh.check();
  expect(fresh.isVerifiedHealthy()).toBe(true);
  now += REALTIME_CONNECT_GRACE_MS;
  expect(fresh.isVerifiedHealthy()).toBe(false);
  await fresh.check();
  expect(fresh.isVerifiedHealthy()).toBe(true);
  // A missing private API can fall back for observation, but must not refill
  // a recovery budget as if the encrypted connection had been verified.
  moduleAvailable = false;
  await fresh.check();
  expect(fresh.isVerifiedHealthy()).toBe(false);
  moduleAvailable = true;
  connected = false;
  await fresh.check();
  expect(fresh.isVerifiedHealthy()).toBe(false);

  // An actual bootstrap has a deadline independent of both page traffic and
  // whether the worker has published its bridge/connection-state modules yet.
  setupReady = false;
  setupInProgress = true;
  for (const missingApis of [false, true]) {
    bridgeAvailable = moduleAvailable = !missingApis;
    const starting = createMonitor(missingApis ? "1001" : "1000");
    await starting.check();
    now += REALTIME_NEVER_CONNECTED_MS - 1;
    await starting.check();
    expect(starting.tracker.status(now)).toBe("ok");
    now += 1;
    await starting.check();
    expect(starting.tracker.status(now)).toBe("stale");
    expect(starting.isVerifiedHealthy()).toBe(false);
  }
  for (const missingSetupModule of [false, true]) {
    setupReady = false;
    setupInProgress = setupModuleAvailable = true;
    const starting = createMonitor(missingSetupModule ? "1003" : "1002");
    await starting.check();
    now += 45_000;
    setupModuleAvailable = !missingSetupModule;
    setupInProgress = false;
    await starting.check();
    now += 44_999;
    await starting.check();
    expect(starting.tracker.status(now)).toBe("ok");
    now += 1;
    await starting.check();
    expect(starting.tracker.status(now)).toBe("stale");
    setupModuleAvailable = setupInProgress = true;
    await starting.check();
    expect(starting.tracker.status(now)).toBe("stale");
    setupReady = true;
    setupInProgress = false;
    await starting.check();
    expect(starting.tracker.status(now)).toBe("ok");
  }
});

function stateProbeFixture() {
  let now = 0;
  let account = "123";
  let id = "worker-1";
  let cached: unknown = true;
  let mode: "normal" | "drop" | "after-reply" | "missing" | "pending" = "normal";
  let nextTimer = 0;
  let complete: ((value?: unknown) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const timers = new Map<number, { due: number; run: () => void }>();
  const listeners = new Set<(value: unknown) => void>();
  const requests: string[] = [];
  let identityChanges = 0;
  const tracker = new RealtimeRecoveryTracker(now);
  const schedule = (run: () => void, delay: number) => {
    const timer = ++nextTimer;
    timers.set(timer, { due: now + delay, run });
    return timer;
  };
  const deliver = (value: unknown) => {
    cached = value;
    for (const listener of listeners) listener(value);
  };
  const connection = {
    isConnected: () => cached,
    onSet: (listener: (value: unknown) => void) => {
      listener(cached);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const modules: Record<string, unknown> = {
    WACommsConnectionState: { WACommsConnectionState: connection },
    MAWWaitForBackendSetup: {
      isBackendSetupSettled: () => true,
      isBackendSetupSuccessful: () => true,
      getCurrentWorkerID: () => id,
    },
    MAWBridgeSendAndReceive: {
      sendAndReceive: async (_namespace: string, route: string) => {
        requests.push(route);
        if (route === "getWorkerHeartbeat") return true;
        if (mode === "normal") deliver(cached);
        else if (mode === "after-reply") schedule(() => deliver(cached), 1);
        else if (mode === "missing") {
          throw new Error("resendWorkerStateManagerValuesToMainThread is not defined for backend");
        } else if (mode === "pending") {
          return new Promise((resolve, fail) => {
            complete = resolve;
            reject = fail;
          });
        }
      },
    },
  };
  const context: { monitor?: typeof monitorRealtimeHealth } = {};
  runInNewContext(source, {
    window: { WebSocket: class extends EventTarget {}, require: (name: string) => modules[name] },
    document: {
      get cookie() {
        return `c_user=${account}`;
      },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { href: "https://www.facebook.com/messages/" },
    Date: { now: () => now },
    performance: { now: () => now },
    setTimeout: schedule,
    clearTimeout: (timer: number) => timers.delete(timer),
    URL,
    globalThis: context,
  });
  const monitor = context.monitor!({
    onHealthy: (source) => tracker.healthy(source, now),
    onStale: (source) => tracker.stale(source),
    onUnknown: (source) => tracker.withdraw(source),
    onWorkerChanged: () => identityChanges++,
  });
  const flush = async () => {
    for (let i = 0; i < 24; i++) await Promise.resolve();
  };
  return {
    get identityChanges() {
      return identityChanges;
    },
    requests,
    listeners,
    tracker,
    monitor,
    deliver,
    flush,
    setMode: (value: typeof mode) => {
      mode = value;
    },
    changeAccount: () => {
      account = "456";
    },
    changeWorker: () => {
      id = "worker-2";
    },
    changeState: () => {
      modules.WACommsConnectionState = { WACommsConnectionState: { ...connection } };
    },
    complete: () => complete?.(),
    reject: (error: unknown) => reject?.(error),
    probe: async () => {
      tracker.healthy("socket", now);
      monitor.check();
      await flush();
    },
    advance: async (ms: number) => {
      now += ms;
      for (const [timer, task] of [...timers]) {
        if (task.due <= now) {
          timers.delete(timer);
          task.run();
        }
      }
      await flush();
    },
  };
}

test("RPC replies and a cached connected value cannot hide missing state delivery", async () => {
  const fixture = stateProbeFixture();
  fixture.setMode("drop");
  for (let attempt = 0; attempt < 3; attempt++) {
    await fixture.probe();
    await fixture.probe();
    expect(fixture.requests.length).toBe(attempt + 1);
    expect(fixture.monitor.isVerifiedHealthy()).toBe(false);
    await fixture.advance(8000);
    expect(fixture.listeners.size).toBe(0);
  }
  expect(fixture.tracker.needsRecovery(24_000)).toBe(true);
  fixture.setMode("normal");
  await fixture.probe();
  expect(fixture.monitor.isVerifiedHealthy()).toBe(true);
  expect(fixture.tracker.needsRecovery(24_000)).toBe(false);
  expect(fixture.listeners.size).toBe(0);
});

test("state delivery may arrive after the RPC response", async () => {
  const fixture = stateProbeFixture();
  fixture.setMode("after-reply");
  await fixture.probe();
  expect(fixture.monitor.isVerifiedHealthy()).toBe(false);
  expect(fixture.listeners.size).toBe(1);
  await fixture.advance(1);
  expect(fixture.monitor.isVerifiedHealthy()).toBe(true);
  expect(fixture.listeners.size).toBe(0);
});

for (const boundary of ["changeAccount", "changeWorker", "changeState"] as const) {
  for (const pending of [false, true]) {
    test(`${boundary} withdraws the old failed-probe verdict synchronously (pending=${pending})`, async () => {
      const fixture = stateProbeFixture();
      fixture.setMode("drop");
      for (let attempt = 0; attempt < 3; attempt++) {
        await fixture.probe();
        await fixture.advance(8000);
      }
      expect(fixture.tracker.needsRecovery(24_000)).toBe(true);
      if (pending) await fixture.probe();
      fixture[boundary]();
      fixture.monitor.check();
      // auto-refresh calls the recovery controller immediately after check(),
      // before any replacement probe or the old pending probe can settle.
      expect(fixture.tracker.needsRecovery(24_000)).toBe(false);
      expect(fixture.monitor.isVerifiedHealthy()).toBe(false);
      expect(fixture.identityChanges).toBe(1);
      await fixture.advance(8000);
      expect(fixture.tracker.needsRecovery(32_000)).toBe(false);
    });
  }
}

test("a worker without the state route falls back without certifying encrypted health", async () => {
  const fixture = stateProbeFixture();
  fixture.setMode("missing");
  await fixture.probe();
  await fixture.probe();
  expect(fixture.requests).toEqual([
    "resendWorkerStateManagerValuesToMainThread",
    "getWorkerHeartbeat",
    "getWorkerHeartbeat",
  ]);
  expect(fixture.monitor.isVerifiedHealthy()).toBe(false);
  expect(fixture.tracker.needsRecovery(0)).toBe(false);
  expect(fixture.listeners.size).toBe(0);
  // A replacement worker may implement a route missing from the old version.
  fixture.changeWorker();
  fixture.setMode("normal");
  await fixture.probe();
  expect(fixture.requests.at(-1)).toBe("resendWorkerStateManagerValuesToMainThread");
  expect(fixture.monitor.isVerifiedHealthy()).toBe(true);
});

for (const boundary of ["changeAccount", "changeWorker"] as const) {
  test(`a reply cannot verify recovery after ${boundary}`, async () => {
    const fixture = stateProbeFixture();
    fixture.setMode("pending");
    await fixture.probe();
    fixture.deliver(true);
    fixture[boundary]();
    fixture.complete();
    await fixture.flush();
    expect(fixture.monitor.isVerifiedHealthy()).toBe(false);
    expect(fixture.listeners.size).toBe(0);
  });
}

test("a late missing-route error cannot launch another request after timeout", async () => {
  const fixture = stateProbeFixture();
  fixture.setMode("pending");
  await fixture.probe();
  await fixture.advance(8000);
  fixture.reject(
    new Error("resendWorkerStateManagerValuesToMainThread is not defined for backend"),
  );
  fixture.deliver(true);
  await fixture.flush();
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.monitor.isVerifiedHealthy()).toBe(false);
  expect(fixture.listeners.size).toBe(0);
});

test("a delayed RPC reply cannot extend the age of an earlier state notification", async () => {
  const fixture = stateProbeFixture();
  fixture.setMode("pending");
  await fixture.probe();
  fixture.deliver(true);
  await fixture.advance(7000);
  fixture.complete();
  await fixture.flush();
  expect(fixture.monitor.isVerifiedHealthy()).toBe(true);
  await fixture.advance(8000);
  expect(fixture.monitor.isVerifiedHealthy()).toBe(false);
});

test("only fresh encrypted state or a new worker clears a confirmed disconnect", async () => {
  const fixture = stateProbeFixture();
  await fixture.probe();
  fixture.deliver(false);
  await fixture.probe();
  await fixture.advance(15_000);
  await fixture.probe();
  expect(fixture.tracker.needsRecovery(15_000)).toBe(true);
  fixture.setMode("missing");
  fixture.deliver(true);
  await fixture.probe();
  expect(fixture.tracker.needsRecovery(15_000)).toBe(true);
  expect(fixture.monitor.isVerifiedHealthy()).toBe(false);
  fixture.changeWorker();
  await fixture.probe();
  expect(fixture.tracker.needsRecovery(15_000)).toBe(false);
  expect(fixture.monitor.isVerifiedHealthy()).toBe(false);
  await fixture.advance(90_000);
  await fixture.probe();
  expect(fixture.tracker.needsRecovery(105_000)).toBe(true);
  fixture.setMode("normal");
  fixture.changeAccount();
  await fixture.probe();
  expect(fixture.monitor.isVerifiedHealthy()).toBe(true);
});
