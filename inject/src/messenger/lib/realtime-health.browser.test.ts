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
  "unconnected worker probes and replacement identities in a real DOM",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "carrier-worker-health-test-"));
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      const bundle = await build({
        stdin: {
          contents: `import { monitorRealtimeHealth } from "../features/realtime-health"; import { RealtimeRecoveryTracker, REALTIME_NEVER_CONNECTED_MS } from "./realtime-health"; (${runFixtures.toString()})(monitorRealtimeHealth, RealtimeRecoveryTracker, REALTIME_NEVER_CONNECTED_MS);`,
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
);

async function runFixtures(
  monitorHealth: (callbacks: {
    onHealthy: (source: string) => void;
    onStale: (source: string) => void;
    onUnknown: (source: string) => void;
  }) => { check: () => void },
  Tracker: new (
    startedAt: number,
  ) => {
    healthy: (source: "worker") => void;
    stale: (source: "worker") => void;
    withdraw: (source: "worker") => void;
    status: (now: number) => string;
  },
  neverConnectedMs: number,
) {
  const result = document.getElementById("result")!;
  const assert = (name: string, condition: boolean) => {
    if (!condition) throw new Error(name);
  };
  const listeners = new Set<(value: unknown) => void>();
  let wallNow = Date.now();
  Date.now = () => wallNow;
  let id = "worker-a";
  let fail = false;
  let connected: boolean | undefined = false;
  const state = {
    isConnected: () => connected,
    onSet: (listener: (value: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  let currentState = state;
  const modules: Record<string, unknown> = {
    WACommsConnectionState: {
      get WACommsConnectionState() {
        return currentState;
      },
    },
    MAWWaitForBackendSetup: {
      isBackendSetupSettled: () => false,
      isBackendSetupSuccessful: () => false,
      getCurrentWorkerID: () => id,
    },
    MAWBridgeSendAndReceive: {
      sendAndReceive: async (_namespace: string, route: string) => {
        if (fail) throw new Error("temporary probe failure");
        if (route === "resendWorkerStateManagerValuesToMainThread") {
          for (const listener of listeners) listener(connected);
        }
      },
    },
  };
  Object.assign(window, { require: (name: string) => modules[name] });
  // biome-ignore lint/suspicious/noDocumentCookie: synthetic account scope for the fixture.
  document.cookie = "c_user=123; path=/";
  const tracker = new Tracker(0);
  let staleReports = 0;
  let connectionStales = 0;
  const monitor = monitorHealth({
    onHealthy: (source) => {
      if (source === "worker") tracker.healthy(source);
    },
    onStale: (source) => {
      if (source === "worker") {
        staleReports++;
        tracker.stale(source);
      }
      if (source === "worker-connection") connectionStales++;
    },
    onUnknown: (source) => {
      if (source === "worker") tracker.withdraw(source);
    },
  });
  const check = async () => {
    monitor.check();
    for (let i = 0; i < 24; i++) await Promise.resolve();
  };
  try {
    await check();
    assert("fresh disconnected state is not health", tracker.status(neverConnectedMs) === "never");
    fail = true;
    await check();
    await check();
    assert("two failures do not mark worker stale", staleReports === 0);
    id = "worker-b";
    currentState = { ...state };
    await check();
    assert("first failure on replacement worker starts a new streak", staleReports === 0);
    await check();
    await check();
    assert("replacement worker needs its own three failures", staleReports === 1);
    fail = false;
    id = "worker-a";
    connected = true;
    currentState = { ...state };
    await check();
    // biome-ignore lint/suspicious/noDocumentCookie: synthetic account switch.
    document.cookie = "c_user=456; path=/";
    id = "worker-b";
    connected = false;
    currentState = { ...state };
    await check();
    wallNow += 15_000;
    await check();
    assert("new account does not inherit a connected worker", connectionStales === 0);
    result.textContent = "PASS";
  } catch (error) {
    result.textContent = `FAIL: ${String(error)}`;
  }
}
