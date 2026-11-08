import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const chromium =
  (Bun.env.CHROME_BIN && Bun.which(Bun.env.CHROME_BIN)) ||
  Bun.which("google-chrome") ||
  Bun.which("chromium");

test.skipIf(!chromium)(
  "late bubble classes and pane drag termination work in a real DOM",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatpane-pane-gradient-"));
    const bundle = await build({
      stdin: {
        contents: `
          import { initChatGradient } from "../features/chat-gradient";
          import { initPaneResize } from "../features/pane-resize";
          (${runFixtures.toString()})(initChatGradient, initPaneResize);
        `,
        resolveDir: import.meta.dir,
      },
      bundle: true,
      write: false,
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          `<!doctype html><html><body><pre id="result">RUNNING</pre>
          <script>${bundle.outputFiles[0]!.text}</script></body></html>`,
          {
            headers: { "Content-Type": "text/html" },
          },
        ),
    });
    try {
      const process = Bun.spawn(
        [
          chromium!,
          "--headless",
          "--disable-gpu",
          "--no-sandbox",
          "--no-first-run",
          `--user-data-dir=${join(directory, "profile")}`,
          "--virtual-time-budget=10000",
          "--dump-dom",
          new URL("/messages", server.url).href,
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
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

async function runFixtures(gradient: () => void, panes: () => void) {
  const result = document.getElementById("result")!;
  const assert = (name: string, condition: boolean) => {
    if (!condition) throw new Error(name);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1100));
  try {
    const host = document.createElement("div");
    host.innerHTML = `<nav role="navigation" style="width:240px"></nav>
      <main role="main"><div style="display:flex;flex-direction:row;width:1000px">
        <div style="width:700px;--chat-outgoing-message-background-gradient:linear-gradient(red, blue)">
          <div role="log"></div>
        </div><aside style="min-width:300px"></aside>
      </div></main>`;
    document.body.append(host);
    const sheet = document.createElement("style");
    sheet.textContent =
      ".early { background-color:var(--chat-outgoing-message-bubble-background-color) }";
    document.head.append(sheet);
    let saves = 0;
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: async (_command: string, args: { event: string }) => {
          if (args.event === "chatpane:pane-widths") saves++;
        },
      },
    });
    gradient();
    panes();
    await settle();
    const css = document.getElementById("chatpane-chat-gradient")!;
    assert("initial bubble class", css.textContent!.includes(".early"));
    sheet.sheet!.insertRule(
      ".late { background-color:var(--chat-outgoing-message-bubble-background-color) }",
    );
    await settle();
    assert("late bubble class", css.textContent!.includes(".late"));

    const edge = host.querySelector<HTMLElement>('.chatpane-pane-edge[data-pane="list"]')!;
    edge.setPointerCapture = () => {
      throw new DOMException("capture unavailable", "NotFoundError");
    };
    for (const terminal of ["pointerup", "pointercancel", "lostpointercapture"]) {
      const before = saves;
      const pointerId = 7;
      edge.dispatchEvent(new PointerEvent("pointerdown", { pointerId, button: 0, clientX: 240 }));
      edge.dispatchEvent(new PointerEvent("pointermove", { pointerId, clientX: 270 }));
      document.body.dispatchEvent(new PointerEvent("pointerup", { pointerId: 8, bubbles: true }));
      assert("another pointer cannot end drag", edge.classList.contains("dragging"));
      const target = terminal === "lostpointercapture" ? edge : document.body;
      target.dispatchEvent(new PointerEvent(terminal, { pointerId, bubbles: true }));
      assert(
        "drag marker cleared",
        !document.documentElement.hasAttribute("data-chatpane-resizing"),
      );
      assert("edge marker cleared", !edge.classList.contains("dragging"));
      // Messenger's own inline width comes back once the drag's sizing goes.
      assert("original inline width restored", edge.parentElement!.style.width === "240px");
      const saved = saves;
      assert("changed width saved once", saved === before + 1);
      edge.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId }));
      document.body.dispatchEvent(new PointerEvent("pointerup", { pointerId, bubbles: true }));
      assert("duplicate termination does not save twice", saves === saved);
    }
    result.textContent = "PASS";
  } catch (error) {
    result.textContent = `FAIL: ${String(error)}`;
  }
}
