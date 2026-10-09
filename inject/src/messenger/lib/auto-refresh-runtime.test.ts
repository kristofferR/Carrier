import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

test("native heartbeats keep hidden-worker verification fresh without page interval ticks", async () => {
  const bundle = await build({
    stdin: {
      contents: `import { initAutoRefresh } from "../features/auto-refresh";
        globalThis.init = initAutoRefresh;`,
      resolveDir: import.meta.dir,
    },
    bundle: true,
    write: false,
  });
  let now = 0;
  let deliverState = true;
  let requests = 0;
  let intervalRegistrations = 0;
  let nextTimer = 0;
  const timers = new Map<number, { due: number; run: () => void }>();
  const reports: string[] = [];
  const listeners = new Set<(connected: boolean) => void>();
  const schedule = (run: () => void, delay: number) => {
    const id = ++nextTimer;
    timers.set(id, { due: now + delay, run });
    return id;
  };
  const cancel = (id: number) => timers.delete(id);
  const modules: Record<string, unknown> = {
    WACommsConnectionState: {
      WACommsConnectionState: {
        isConnected: () => true,
        onSet: (listener: (connected: boolean) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
    MAWWaitForBackendSetup: {
      isBackendSetupSettled: () => true,
      isBackendSetupSuccessful: () => true,
      getCurrentWorkerID: () => "worker-1",
    },
    MAWBridgeSendAndReceive: {
      sendAndReceive: async () => {
        requests++;
        if (deliverState) for (const listener of listeners) listener(true);
      },
    },
  };
  const window = Object.assign(new EventTarget(), {
    WebSocket: class extends EventTarget {},
    __CARRIER_HEARTBEAT_ID__: 42,
    __carrierHeartbeat: undefined as ((id: number) => void) | undefined,
    __TAURI_INTERNALS__: {
      invoke: async (_cmd: string, args?: { event?: string; payload?: { realtime?: string } }) => {
        if (args?.event === "carrier:webview-heartbeat") reports.push(args.payload!.realtime!);
      },
    },
    require: (name: string) => modules[name],
    setTimeout: schedule,
    clearTimeout: cancel,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  });
  const context: { init?: () => void } = {};
  runInNewContext(bundle.outputFiles[0]!.text, {
    window,
    document: Object.assign(new EventTarget(), {
      cookie: "c_user=123",
      hidden: true,
      readyState: "complete",
      hasFocus: () => false,
      getElementById: () => null,
      querySelectorAll: () => [],
      getElementsByTagName: () => [],
    }),
    navigator: { onLine: true, platform: "Linux", userAgent: "" },
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { pathname: "/messages/", href: "https://www.facebook.com/messages/" },
    performance: { timeOrigin: 0, now: () => now },
    Date: { now: () => now },
    HTMLImageElement: class {},
    URL,
    setTimeout: schedule,
    clearTimeout: cancel,
    setInterval: () => intervalRegistrations++,
    globalThis: context,
  });
  context.init!();
  const flush = async () => {
    for (let i = 0; i < 24; i++) await Promise.resolve();
  };
  const heartbeat = async (id = 42) => {
    window.__carrierHeartbeat!(id);
    await flush();
  };
  const advance = async (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.due <= now) {
        timers.delete(id);
        timer.run();
      }
    }
    await flush();
  };
  await heartbeat(41);
  expect(requests).toBe(0);
  await heartbeat();
  expect(requests).toBe(1);
  // Only native pings run: a full minute of health must survive hidden-page
  // interval suspension without accepting a cached connected boolean.
  for (let i = 0; i < 13; i++) {
    await advance(5_000);
    await heartbeat();
    expect(reports.at(-1)).toBe("ok");
  }
  expect(intervalRegistrations).toBe(1);
  deliverState = false;
  await advance(5_000);
  await heartbeat();
  await advance(15_000);
  await heartbeat();
  expect(reports.at(-1)).toBe("pending");
});
