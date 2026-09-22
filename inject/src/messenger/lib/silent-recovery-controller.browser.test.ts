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
  "recovery episodes respect account, wake, retry, and timeout boundaries",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "carrier-recovery-controller-test-"));
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      const bundle = await build({
        stdin: {
          contents: `import { createSilentRecovery } from "../features/silent-recovery"; import { workerRecovery } from "../features/worker-recovery"; import { SILENT_RECOVERY_EVENT } from "./worker-recovery"; (${runFixtures.toString()})(createSilentRecovery, workerRecovery, SILENT_RECOVERY_EVENT);`,
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
  createRecovery: (options: {
    blocked: (manual: boolean) => boolean;
    needsRecovery: () => boolean;
    isHealthy: () => boolean;
    check: () => void;
  }) => { tick: () => void; resetSettle: () => void },
  adapter: { recover: (allowed?: () => boolean) => Promise<string> },
  failureEvent: string,
) {
  const result = document.getElementById("result")!;
  const assert = (name: string, condition: boolean) => {
    if (!condition) throw new Error(name);
  };
  let now = performance.timeOrigin + 1_000;
  Date.now = () => now;
  performance.now = () => now - performance.timeOrigin;
  let nextId = 1;
  const timers = new Map<number, { due: number; run: () => void }>();
  window.setTimeout = ((run: () => void, delay = 0) => {
    const id = nextId++;
    timers.set(id, { due: now + delay, run });
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = (id) => {
    if (typeof id === "number") timers.delete(id);
  };
  const flush = async () => {
    for (let i = 0; i < 24; i++) await Promise.resolve();
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
  const make = (state: { needed: boolean; healthy: boolean }) =>
    createRecovery({
      blocked: () => false,
      needsRecovery: () => state.needed,
      isHealthy: () => state.healthy,
      check: () => {},
    });
  const originalRecover = adapter.recover;
  let calls = 0;
  adapter.recover = async () => {
    calls++;
    return "unsupported";
  };
  // biome-ignore lint/suspicious/noDocumentCookie: synthetic account scope for the fixture.
  document.cookie = "c_user=123; path=/";
  try {
    const accountState = { needed: true, healthy: false };
    const accountRecovery = make(accountState);
    accountRecovery.tick();
    await advance(15_000);
    accountRecovery.tick();
    await flush();
    accountRecovery.tick();
    assert("first account exhausted its budget", calls === 1);
    // biome-ignore lint/suspicious/noDocumentCookie: synthetic account switch.
    document.cookie = "c_user=456; path=/";
    accountRecovery.tick();
    await advance(14_999);
    accountRecovery.tick();
    assert("new account receives a fresh settle delay", calls === 1);
    await advance(1);
    accountRecovery.tick();
    await flush();
    assert("new account gets its own attempt", calls === 2);

    adapter.recover = async () => {
      calls++;
      return "started";
    };
    const wakeState = { needed: true, healthy: false };
    const wakeRecovery = make(wakeState);
    wakeRecovery.tick();
    await advance(30_000);
    wakeRecovery.resetSettle();
    wakeRecovery.tick();
    assert("wake does not use a pre-sleep stale timestamp", calls === 2);
    await advance(15_000);
    wakeRecovery.tick();
    await flush();
    assert("wake can recover after fresh probe grace", calls === 3);

    adapter.recover = async () => {
      calls++;
      return "failed";
    };
    const retryState = { needed: true, healthy: false };
    const retryRecovery = make(retryState);
    retryRecovery.tick();
    await advance(15_000);
    retryRecovery.tick();
    await flush();
    assert("transient failure spends one attempt", calls === 4);
    await advance(30_000);
    retryRecovery.tick();
    await advance(14_999);
    retryRecovery.tick();
    assert("transient failure preserves backoff", calls === 4);
    await advance(1);
    retryRecovery.tick();
    await flush();
    assert("transient failure permits another attempt", calls === 5);

    adapter.recover = () => {
      calls++;
      return new Promise(() => {});
    };
    const hungState = { needed: true, healthy: false };
    const hungRecovery = make(hungState);
    let surfaced = false;
    window.addEventListener(failureEvent, (event) => {
      if ((event as CustomEvent<boolean>).detail === true) surfaced = true;
    });
    hungRecovery.tick();
    await advance(15_000);
    hungRecovery.tick();
    assert("hung setup starts once", calls === 6);
    hungState.healthy = true;
    hungState.needed = false;
    await advance(30_000);
    hungRecovery.tick();
    hungState.healthy = false;
    hungState.needed = true;
    hungRecovery.tick();
    await advance(15_000);
    hungRecovery.tick();
    assert("later failure surfaces while old setup remains single-flight", surfaced && calls === 6);
    result.textContent = "PASS";
  } catch (error) {
    result.textContent = `FAIL: ${String(error)}`;
  } finally {
    adapter.recover = originalRecover;
  }
}
