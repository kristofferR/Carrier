import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const chromium =
  (Bun.env.CHROME_BIN && Bun.which(Bun.env.CHROME_BIN)) ||
  Bun.which("google-chrome") ||
  Bun.which("chromium");

test.skipIf(!chromium)(
  "capacity eviction waits for thread kinds and suppresses groups in a reconnect burst",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "carrier-notification-capacity-"));
    try {
      const bundle = await build({
        stdin: {
          contents: `
            import { initNotificationBridge } from "../features/notifications";
            (${runFixture.toString()})(initNotificationBridge);
          `,
          resolveDir: import.meta.dir,
        },
        bundle: true,
        write: false,
      });
      const file = join(directory, "index.html");
      await writeFile(
        file,
        `<!doctype html><html lang="en"><head><title>Messenger</title>
        <style>a, span { display: block; } span { font-weight: 400; }</style></head><body>
        <div role="navigation"><div role="grid"></div></div><pre id="result">RUNNING</pre>
        <script>${bundle.outputFiles[0]!.text}</script></body></html>`,
      );
      const process = Bun.spawn(
        [
          chromium!,
          "--headless",
          "--disable-gpu",
          "--no-sandbox",
          "--no-first-run",
          `--user-data-dir=${join(directory, "profile")}`,
          "--virtual-time-budget=6000",
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
      expect(output.match(/<pre id="result">([^<]+)/)?.[1], output).toBe("PASS");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

async function runFixture(init: () => void) {
  const result = document.getElementById("result")!;
  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const delivered: string[] = [];
  const reads = new Set<string>();
  try {
    window.__CARRIER_SETTINGS__ = { notify_group_chats: false, hide_notification_preview: true };
    window.__TAURI_INTERNALS__ = {
      invoke: async (_cmd: string, args?: Record<string, unknown>) => {
        if (args?.event === "carrier:notify") {
          delivered.push((args.payload as { thread_path: string }).thread_path);
        }
        return true;
      },
    } as unknown as typeof window.__TAURI_INTERNALS__;
    const modules: Record<string, unknown> = {
      LSDatabaseSingleton: {
        LSDatabaseSingleton: Promise.resolve({
          tables: {
            threads: {
              get: async (id: string) => {
                reads.add(id);
                // Keep every kind unresolved during the synchronous overflow.
                await settle(300);
                return { threadType: id === "2" ? 1 : id === "3" ? 9 : 2 };
              },
            },
          },
        }),
      },
      I64: { of_string: (value: string) => value },
      LSMessagingThreadTypeUtil: {
        isGroup: (type: unknown) => type === 2,
        isOneToOne: (type: unknown) => type === 1,
      },
    };
    (window as unknown as { require: (name: string) => unknown }).require = (name) => modules[name];
    const grid = document.querySelector('[role="grid"]')!;
    // The first three arrivals all overflow the 50-row correlation bound:
    // a group, a direct message, and a thread whose kind stays unknown.
    grid.innerHTML = Array.from(
      { length: 53 },
      (_, i) =>
        `<a href="/messages/t/${i + 1}/"><span>Chat ${i + 1}</span><span>Old message</span></a>`,
    ).join("");
    init();
    await settle(100);
    document.title = "(53) Messenger";
    for (const span of grid.querySelectorAll<HTMLElement>("span")) {
      span.style.fontWeight = "700";
      if (span === span.parentElement?.lastElementChild) span.textContent = "New message";
    }
    await settle(200);
    if (reads.size !== 53) throw new Error(`Expected 53 pending kinds, got ${reads.size}`);
    if (delivered.length) throw new Error(`Delivered before kind lookup: ${delivered}`);
    await settle(3500);
    if (delivered.sort().join(",") !== "/t/2/,/t/3/") {
      throw new Error(`Expected only direct and unknown kinds, got ${delivered}`);
    }
    result.textContent = "PASS";
  } catch (error) {
    result.textContent = String(error);
  }
}
