import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const chromium =
  (Bun.env.CHROME_BIN && Bun.which(Bun.env.CHROME_BIN)) ||
  Bun.which("google-chrome") ||
  Bun.which("chromium");

test.skipIf(!chromium)(
  "title-only conversations do not freeze Dock and tray updates",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "carrier-unread-test-"));
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      const entry = fileURLToPath(new URL("../features/unread-badge.ts", import.meta.url));
      const bundle = await build({
        stdin: {
          contents: `import { initUnreadBadge } from ${JSON.stringify(entry)}; (${runFixtures.toString()})(initUnreadBadge);`,
          resolveDir: import.meta.dir,
        },
        bundle: true,
        write: false,
      });
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () =>
          new Response(
            `<!doctype html><html><body><pre id="result">RUNNING</pre><script>${bundle.outputFiles[0]!.text}</script></body></html>`,
            { headers: { "Content-Type": "text/html" } },
          ),
      });
      const process = Bun.spawn(
        [
          chromium!,
          "--headless",
          "--disable-gpu",
          "--no-sandbox",
          "--no-first-run",
          `--user-data-dir=${join(directory, "profile")}`,
          "--virtual-time-budget=1000",
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

function runFixtures(initBadge: () => void) {
  const result = document.getElementById("result")!;
  const assert = (name: string, condition: boolean) => {
    if (!condition) throw new Error(name);
  };
  let now = 1_000;
  Date.now = () => now;
  const intervals: (() => void)[] = [];
  window.setTimeout = ((_run: () => void, _delay = 0) => 1) as typeof window.setTimeout;
  window.setInterval = ((run: () => void) => {
    intervals.push(run);
    return intervals.length;
  }) as typeof window.setInterval;
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  window.__CARRIER_SETTINGS__ = {
    badge_mode: "conversations",
    unread_badge: true,
    ignore_muted_conversations: true,
  };
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      calls.push({ command, args });
    },
  } as typeof window.__TAURI_INTERNALS__;
  const grid = document.createElement("div");
  grid.setAttribute("role", "grid");
  grid.innerHTML = `<a href="/messages/t/1" style="display:block"><span style="display:block;font-weight:600">Unread chat</span><span style="display:block;font-weight:600">Preview</span></a><a href="/messages/t/2" style="display:block"><span style="display:block;font-weight:400">Empty chat</span><span id="preview" style="display:block;font-weight:400">Preview</span></a>`;
  document.body.append(grid);
  const badge = () =>
    calls.filter((call) => call.command === "plugin:window|set_badge_label").at(-1);
  const tray = () =>
    calls
      .filter(
        (call) => call.command === "plugin:event|emit" && call.args?.event === "carrier:unread",
      )
      .at(-1);
  const tick = (time: number) => {
    now = time;
    for (const run of intervals) run();
  };
  try {
    initBadge();
    assert(
      "initial count reaches Dock and tray",
      badge()?.args?.value === "1" && tray()?.args?.payload === 1,
    );
    for (const span of grid.querySelectorAll<HTMLElement>("span")) span.style.fontWeight = "400";
    document.getElementById("preview")!.remove();
    tick(2_000);
    tick(7_000);
    assert("partial hydration retains the count", badge()?.args?.value === "1");
    tick(22_000);
    assert(
      "settled title-only row clears both badges",
      badge()?.args?.value === null && tray()?.args?.payload === 0,
    );
    grid.querySelector("a")!.innerHTML = "";
    tick(23_000);
    tick(83_000);
    tick(143_000);
    assert(
      "nameless placeholder cannot publish read state",
      calls.filter((call) => call.command === "plugin:window|set_badge_label").length === 2,
    );
    grid.querySelector("a")!.innerHTML =
      `<span style="display:block;font-weight:600">Unread chat</span><span style="display:block;font-weight:600">New preview</span>`;
    tick(144_000);
    tick(149_000);
    tick(164_000);
    assert(
      "a later unread updates both badges",
      badge()?.args?.value === "1" && tray()?.args?.payload === 1,
    );
    result.textContent = "PASS";
  } catch (error) {
    result.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`;
  }
}
