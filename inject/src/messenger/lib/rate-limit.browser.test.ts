import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const chromium =
  (Bun.env.CHROME_BIN && Bun.which(Bun.env.CHROME_BIN)) ||
  Bun.which("google-chrome") ||
  Bun.which("chromium");

test.skipIf(!chromium)(
  "rate-limit cooldown, banner and protected automatic retry in a real DOM",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "carrier-rate-limit-test-"));
    try {
      const entry = fileURLToPath(new URL("../features/rate-limit.ts", import.meta.url));
      const bundle = await build({
        stdin: {
          contents: `import { initRateLimit, reportRateLimit, rateLimitRemainingMs, retryRateLimitNow } from ${JSON.stringify(entry)}; import { initAutoRefresh } from ${JSON.stringify(fileURLToPath(new URL("../features/auto-refresh.ts", import.meta.url)))}; import { initSyncHealth } from ${JSON.stringify(fileURLToPath(new URL("../features/sync-health.ts", import.meta.url)))}; import { initUnreadBadge } from ${JSON.stringify(fileURLToPath(new URL("../features/unread-badge.ts", import.meta.url)))}; (${runFixtures.toString()})(initRateLimit, reportRateLimit, rateLimitRemainingMs, initAutoRefresh, initSyncHealth, retryRateLimitNow, initUnreadBadge);`,
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
          pathToFileURL(file).href,
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
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

async function runFixtures(
  init: () => void,
  report: (source: "graphql-1675004", retryMs?: number) => void,
  remaining: () => number,
  initRecovery: () => void,
  initHealth: () => void,
  retryNow: () => void,
  initBadge: () => void,
) {
  const result = document.getElementById("result")!;
  const assert = (name: string, condition: boolean) => {
    if (!condition) throw new Error(name);
  };
  let now = Date.now();
  Date.now = () => now;
  let nextId = 1;
  const timers = new Map<number, { run: () => void; delay: number }>();
  const intervals: Array<{ run: () => void; delay: number }> = [];
  window.setTimeout = ((run: () => void, delay = 0) => {
    const id = nextId++;
    timers.set(id, { run, delay });
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = (id) => {
    if (typeof id === "number") timers.delete(id);
  };
  window.setInterval = ((run: () => void, delay = 0) => {
    intervals.push({ run, delay });
    return nextId++;
  }) as typeof window.setInterval;
  const tick = () => {
    for (const interval of intervals) interval.run();
  };
  const runTimer = (delay: number) => {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    assert(`timer ${delay} exists`, !!entry);
    timers.delete(entry![0]);
    entry![1].run();
  };
  try {
    localStorage.removeItem("carrier-rate-limit");
    init();
    report("graphql-1675004", 120_000);
    initRecovery();
    initHealth();
    const banner = () => document.getElementById("carrier-sync-banner");
    assert("visible countdown", banner()?.textContent?.includes("2 min") === true);
    const rect = banner()!.getBoundingClientRect();
    assert("fits narrow viewport", rect.left >= 0 && rect.right <= innerWidth);
    now += 60_000;
    tick();
    assert("cooldown prevents recovery", ![...timers.values()].some((t) => t.delay === 1000));
    assert("countdown updates", banner()?.textContent?.includes("1 min") === true);
    report("graphql-1675004");
    assert("burst does not postpone retry", remaining() === 60_000);
    const draft = document.createElement("div");
    draft.contentEditable = "true";
    draft.textContent = "unsent fixture";
    document.body.appendChild(draft);
    now += 60_001;
    tick();
    runTimer(1000);
    assert("draft retained", draft.textContent === "unsent fixture");
    assert(
      "draft defers automatic retry",
      [...timers.values()].some((t) => t.delay === 8000),
    );
    assert(
      "expired cooldown is not advertised as recovered",
      banner()?.textContent?.includes("cooldown ended") === true,
    );
    report("graphql-1675004");
    assert("rejection backs off", remaining() === 30 * 60_000);
    assert("rejection cancels pending reload", ![...timers.values()].some((t) => t.delay === 8000));
    assert(
      "persisted backoff",
      JSON.parse(localStorage.getItem("carrier-rate-limit")!).attempts === 2,
    );
    const button = banner()!.querySelector("button")!;
    assert(
      "persistent manual retry available",
      button.textContent === "Try again" && !button.disabled,
    );
    button.click();
    assert("synthetic clicks cannot bypass backoff", remaining() > 0);
    const automaticDeadline = localStorage.getItem("carrier-rate-limit");
    retryNow();
    assert("manual attempt leaves cooldown intact", remaining() === 30 * 60_000);
    runTimer(1000);
    assert(
      "manual retry still protects draft",
      [...timers.values()].some((t) => t.delay === 8000),
    );
    report("graphql-1675004");
    assert(
      "manual rejection does not change backoff",
      localStorage.getItem("carrier-rate-limit") === automaticDeadline,
    );
    assert("acknowledged manual retry disables button", button.disabled);
    window.dispatchEvent(
      new CustomEvent("carrier:power-state", { detail: { sleeping: true, resume_generation: 0 } }),
    );
    assert("cancelled manual retry re-enables button", !button.disabled);
    window.dispatchEvent(
      new CustomEvent("carrier:power-state", { detail: { sleeping: false, resume_generation: 1 } }),
    );
    banner()!.remove();
    tick();
    assert("removed banner is restored during cooldown", !!banner()?.querySelector("button"));
    const badgeCalls: Array<{ command: string; value: unknown }> = [];
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { value?: unknown }) => {
          badgeCalls.push({ command, value: args?.value });
        },
      },
    });
    document.title = "(7) Messenger";
    initBadge();
    const badge = () =>
      badgeCalls.filter((call) => call.command === "plugin:window|set_badge_label").at(-1)?.value;
    assert("macOS Dock shows ERR during cooldown", badge() === "ERR");
    now += remaining() + 1;
    tick();
    assert("macOS Dock restores unread count after cooldown", badge() === "7");
    assert(
      "macOS uses one badge setter to avoid count/error races",
      !badgeCalls.some((call) => call.command === "plugin:window|set_badge_count"),
    );
    result.textContent = "PASS";
  } catch (error) {
    result.textContent = `FAIL: ${String(error)}`;
  }
}
