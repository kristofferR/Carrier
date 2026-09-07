import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const chromium =
  (Bun.env.CHROME_BIN && Bun.which(Bun.env.CHROME_BIN)) ||
  Bun.which("google-chrome") ||
  Bun.which("chromium");

test.skipIf(!chromium)(
  "rate-limit cooldown, banner and protected automatic retry in a real DOM",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "carrier-rate-limit-test-"));
    let server: ReturnType<typeof Bun.serve> | undefined;
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
    const syncAlerts: string[] = [];
    Object.assign(window, {
      __CARRIER_HEARTBEAT_ID__: 42,
      __TAURI_INTERNALS__: {
        invoke: async (_command: string, args: { event?: string; payload?: { kind?: string } }) => {
          if (args?.event === "carrier:sync-alert" && args.payload?.kind)
            syncAlerts.push(args.payload.kind);
        },
      },
    });
    initRecovery();
    // Only fixture responses: never contact Facebook or exercise a live limit.
    Object.defineProperty(window, "fetch", {
      value: async () => new Response("{}", { status: 200 }),
      configurable: true,
      writable: true,
    });
    XMLHttpRequest.prototype.open = () => {};
    XMLHttpRequest.prototype.send = function () {
      Object.defineProperty(this, "status", { value: 200, configurable: true });
      this.dispatchEvent(new Event("loadend"));
    };
    initHealth();
    assert(
      "rate limiting raises a native alert for buried windows",
      syncAlerts.includes("rate-limited"),
    );
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
    await fetch("https://www.facebook.com/api/graphql");
    now += 10_000;
    tick();
    assert("successful fetch clears expired rate-limit warning", !banner());
    assert(
      "recovery removes the persisted episode",
      localStorage.getItem("carrier-rate-limit") === null,
    );
    report("graphql-1675004");
    assert("a distinct episode starts at the base backoff", remaining() === 15 * 60_000);
    await fetch("https://www.facebook.com/api/graphql");
    tick();
    assert("successful traffic does not hide an active cooldown", !!banner());
    now += remaining() + 1;
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "https://www.facebook.com/api/graphql");
    xhr.send();
    now += 10_000;
    tick();
    assert("successful XHR clears expired rate-limit warning", !banner());
    const probeRequests: boolean[] = [];
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: async (
          _command: string,
          args: { event?: string; payload?: { rate_limit_retry?: boolean } },
        ) => {
          if (args?.event === "carrier:webview-heartbeat" && args.payload?.rate_limit_retry)
            probeRequests.push(true);
        },
      },
    });
    report("graphql-1675004");
    now += remaining() + 1;
    await fetch("https://www.facebook.com/api/graphql");
    report("graphql-1675004"); // Facebook normalizes an HTTP-200 GraphQL error.
    now += 10_000;
    tick();
    assert(
      "HTTP-200 rate errors retain escalating backoff",
      JSON.parse(localStorage.getItem("carrier-rate-limit")!).attempts === 2,
    );
    now += remaining() + 1;
    draft.textContent = "";
    tick();
    runTimer(1000);
    assert("automatic retry requests native coordination", probeRequests.length === 1);
    window.__carrierRateLimitRetry?.(42, Date.now() - 1);
    assert(
      "stale grants leave the request queued",
      [...timers.values()].some((t) => t.delay === 8000),
    );
    draft.textContent = "new draft";
    window.__carrierRateLimitRetry?.(42, Date.now() + 5000);
    assert(
      "grant rechecks draft protection",
      [...timers.values()].some((t) => t.delay === 8000),
    );
    result.textContent = "PASS";
  } catch (error) {
    result.textContent = `FAIL: ${String(error)}`;
  }
}
