import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const chromium =
  (Bun.env.CHROME_BIN && Bun.which(Bun.env.CHROME_BIN)) ||
  Bun.which("google-chrome") ||
  Bun.which("chromium");

test.skipIf(!chromium)(
  "silent recovery preserves the DOM, protects drafts and holds, and verifies worker health",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "carrier-silent-recovery-test-"));
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      const bundle = await build({
        stdin: {
          contents: `import { initAutoRefresh } from "../features/auto-refresh"; import { initSyncHealth } from "../features/sync-health"; import { workerRecovery } from "../features/worker-recovery"; (${runFixtures.toString()})(initAutoRefresh, initSyncHealth, workerRecovery);`,
          resolveDir: import.meta.dir,
        },
        bundle: true,
        write: false,
      });
      const file = join(directory, "index.html");
      await writeFile(
        file,
        `<!doctype html><html><body><pre id="result">RUNNING</pre><script>${bundle.outputFiles[0]!.text}</script></body></html>`,
      );
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(Bun.file(file), { headers: { "Content-Type": "text/html" } }),
      });
      const process = Bun.spawn(
        [
          chromium!,
          "--headless",
          "--disable-gpu",
          "--no-sandbox",
          "--no-first-run",
          `--user-data-dir=${join(directory, "profile")}`,
          "--window-size=480,900",
          "--virtual-time-budget=5000",
          "--dump-dom",
          `${server.url}messages`,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" },
      );
      const [output, errors, exit] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      expect(exit, errors).toBe(0);
      expect(output.match(/<pre id="result">([^<]+)/)?.[1]).toBe("PASS");
    } finally {
      server?.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

async function runFixtures(
  initRecovery: () => void,
  initHealth: () => void,
  adapter: { observeSetupExports: (value: unknown) => void },
) {
  const result = document.getElementById("result")!;
  const assert = (name: string, condition: boolean) => {
    if (!condition) throw new Error(name);
  };
  const root = document.documentElement;
  const origin = performance.timeOrigin;
  const composer = document.createElement("div");
  composer.contentEditable = "true";
  composer.textContent = "Keep my draft";
  document.body.appendChild(composer);
  let now = Date.now();
  Date.now = () => now;
  performance.now = () => now - origin;
  let nextId = 1;
  const timers = new Map<number, { run: () => void; due: number }>();
  const intervals: Array<() => void> = [];
  window.setTimeout = ((run: () => void, delay = 0) => {
    const id = nextId++;
    timers.set(id, { run, due: now + delay });
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = (id) => {
    if (typeof id === "number") timers.delete(id);
  };
  window.setInterval = ((run: () => void) => {
    intervals.push(run);
    return nextId++;
  }) as typeof window.setInterval;
  const tick = async (ms = 5000) => {
    now += ms;
    for (const run of intervals) run();
    for (const [id, timer] of [...timers]) {
      if (timer.due <= now) {
        timers.delete(id);
        timer.run();
      }
    }
    for (let i = 0; i < 24; i++) await Promise.resolve();
  };
  let connected = false;
  let successful = false;
  let inProgress = false;
  let recoveries = 0;
  let backendResets = 0;
  let supported = true;
  let online = true;
  let workerId = "worker";
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
  const connectionListeners = new Set<(value: unknown) => void>();
  const reports: string[] = [];
  const setup = {
    getOrSetupWorker(..._args: unknown[]) {
      recoveries++;
      successful = true;
      connected = true;
      return Promise.resolve();
    },
  };
  const modules: Record<string, unknown> = {
    WACommsConnectionState: {
      WACommsConnectionState: {
        isConnected: () => connected,
        onSet: (listener: (value: unknown) => void) => {
          connectionListeners.add(listener);
          return () => connectionListeners.delete(listener);
        },
      },
    },
    MAWWaitForBackendSetup: {
      isBackendSetupSettled: () => true,
      isBackendSetupSuccessful: () => successful,
      isBackendSetupInProgress: () => inProgress,
      getCurrentWorkerID: () => (successful ? workerId : null),
      resetBackendSetup: () => {
        backendResets++;
      },
      rejectBackendSetup: () => {},
    },
    MAWWebWorkerSingleton: {
      getWorkerHealthStatus: async () => ({ tag: supported ? "shared_not_exists" : "unknown" }),
    },
    MAWBridgeSendAndReceive: {
      sendAndReceive: async (_namespace: string, route: string) => {
        if (!successful) throw new Error("backend failed");
        if (route === "resendWorkerStateManagerValuesToMainThread") {
          for (const listener of connectionListeners) listener(connected);
        }
      },
    },
  };
  Object.assign(window, {
    require: (name: string) => modules[name],
    __CARRIER_SETTINGS__: { hold_failures: true },
    __CARRIER_HEARTBEAT_ID__: 1,
    __TAURI_INTERNALS__: {
      invoke: async (
        _command: string,
        args: { event?: string; payload?: { realtime?: string } },
      ) => {
        if (args?.payload?.realtime) reports.push(args.payload.realtime);
      },
    },
  });
  // biome-ignore lint/suspicious/noDocumentCookie: synthetic account scope for the fixture.
  document.cookie = "c_user=123; path=/";
  try {
    adapter.observeSetupExports(setup);
    await setup.getOrSetupWorker(
      {},
      () => {},
      () => {},
      () => {},
      "mawInit",
      () => {},
    );
    recoveries = 0;
    connected = successful = false;
    initHealth();
    initRecovery();
    for (let i = 0; i < 30; i++) await tick();
    assert("hold leaves failed backend untouched", recoveries === 0);
    window.__CARRIER_SETTINGS__ = { hold_failures: false };
    for (let i = 0; i < 8; i++) await tick();
    assert(
      "draft prevents worker mutation",
      recoveries === 0 && composer.textContent === "Keep my draft",
    );
    composer.textContent = "";
    inProgress = true;
    for (let i = 0; i < 40; i++) await tick();
    assert("waiting for Messenger never starts a competing bootstrap", recoveries === 0);
    inProgress = false;
    await tick(60_000);
    assert("non-macOS timer gap renews probe grace before worker mutation", recoveries === 0);
    await tick(10_000);
    assert("resumed page receives the full settle window", recoveries === 0);
    for (let i = 0; i < 5; i++) await tick();
    assert("failed bootstrap recovered once", recoveries === 1 && backendResets === 1);
    assert("health verified", connected && reports.at(-1) === "ok");
    assert("native realtime reload suppressed during recovery", reports.includes("managed"));
    assert(
      "document and composer retained",
      root === document.documentElement &&
        composer.isConnected &&
        performance.timeOrigin === origin,
    );
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
    window.__carrierOnNotification?.();
    window.dispatchEvent(
      new CustomEvent("carrier:power-state", {
        detail: {
          sleeping: false,
          resume_generation: 2,
          last_resume_at_ms: performance.timeOrigin + 1,
        },
      }),
    );
    for (let i = 0; i < 200; i++) await tick();
    assert(
      "healthy lifecycle events do not mutate the worker",
      recoveries === 1 && performance.timeOrigin === origin,
    );
    connected = successful = false;
    supported = false;
    for (let i = 0; i < 10; i++) await tick();
    const banner = document.getElementById("carrier-sync-banner");
    assert(
      "unsupported recovery offers reconnect and reload",
      !!banner &&
        [...banner.querySelectorAll("button")].map((b) => b.textContent).join(",") ===
          "Reconnect,Reload",
    );
    assert("failed recovery leaves page in place", performance.timeOrigin === origin);
    supported = true;
    window.__CARRIER_SETTINGS__ = { hold_failures: true };
    window.dispatchEvent(new Event("carrier:sync-recovery-retry"));
    for (let i = 0; i < 5; i++) await tick();
    assert("explicit reconnect works while automatic recovery is held", recoveries === 2);
    assert("explicit reconnect verifies health", connected && reports.at(-1) === "ok");
    window.__CARRIER_SETTINGS__ = { hold_failures: false };
    connected = successful = false;
    supported = false;
    for (let i = 0; i < 12; i++) await tick();
    assert("unsupported recovery exhausts this episode", recoveries === 2);
    online = false;
    window.dispatchEvent(new Event("offline"));
    supported = true;
    await tick();
    online = true;
    window.dispatchEvent(new Event("online"));
    for (let i = 0; i < 2; i++) await tick();
    assert("restored network gives Messenger time to reconnect", recoveries === 2);
    for (let i = 0; i < 4; i++) await tick();
    assert("one extra worker repair follows real network restoration", recoveries === 3);
    assert("restoration keeps the same document", performance.timeOrigin === origin);
    window.__CARRIER_SETTINGS__ = { hold_failures: true };
    modules.MAWBridgeSendAndReceive = {
      sendAndReceive: async (_namespace: string, route: string) => {
        if (route === "resendWorkerStateManagerValuesToMainThread") {
          throw new Error("resendWorkerStateManagerValuesToMainThread is not defined for backend");
        }
      },
    };
    for (let i = 0; i < 20; i++) await tick();
    assert(
      "heartbeat-only fallback does not certify encrypted transport",
      reports.at(-1) === "managed",
    );
    assert("hold prevents mutation while transport proof is unavailable", recoveries === 3);
    // Replenish the episode, then age every health source while recovery is held.
    workerId = "healthy-replacement";
    modules.MAWBridgeSendAndReceive = {
      sendAndReceive: async () => {
        for (const listener of connectionListeners) listener(true);
      },
    };
    for (let i = 0; i < 15; i++) await tick();
    assert("fresh replacement replenishes the episode", reports.at(-1) === "ok");
    modules.MAWBridgeSendAndReceive = { sendAndReceive: async () => {} };
    for (let i = 0; i < 16; i++) await tick();
    let bridgeRepairs = 0;
    modules.MAWWorkerWatchdogRecovery = {
      getWorkerRecoveryForWatchdog: () => () => bridgeRepairs++,
    };
    workerId = "unverified-replacement";
    window.__CARRIER_SETTINGS__ = { hold_failures: false };
    await tick();
    assert(
      "replacement does not inherit the expired global-health settle window",
      bridgeRepairs === 0,
    );
    await tick();
    await tick();
    assert("replacement receives fresh probe grace", bridgeRepairs === 0);
    for (let i = 0; i < 4; i++) await tick();
    assert("a replacement that remains unverified can still recover", bridgeRepairs === 1);
    result.textContent = "PASS";
  } catch (error) {
    result.textContent = `FAIL: ${String(error)}`;
  }
}
