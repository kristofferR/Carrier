import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import type { initSettingsButton } from "../features/settings-button";
import type { initViewerControls } from "../features/viewer-controls";
import type { connectedRoots } from "./dom-roots";

const chromium =
  (Bun.env.CHROME_BIN && Bun.which(Bun.env.CHROME_BIN)) ||
  Bun.which("google-chrome") ||
  Bun.which("chromium");

test.skipIf(!chromium)(
  "chat churn avoids document sweeps while header and dialog replacements still work",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "carrier-dom-performance-"));
    try {
      const bundle = await build({
        stdin: {
          contents: `
            import { initSettingsButton } from "../features/settings-button";
            import { initViewerControls } from "../features/viewer-controls";
            import { connectedRoots } from "./dom-roots";
            (${runFixtures.toString()})(initSettingsButton, initViewerControls, connectedRoots);
          `,
          resolveDir: import.meta.dir,
        },
        bundle: true,
        write: false,
      });
      const file = join(directory, "index.html");
      await writeFile(
        file,
        `<!doctype html><html><body><main id="chat"></main><pre id="result">RUNNING</pre>
          <script>
          window.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 16);
          ${bundle.outputFiles[0]!.text}
          </script></body></html>`,
      );
      // Serve under /messages so the Settings button follows its real route guard.
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(Bun.file(file)),
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
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

async function runFixtures(
  settings: typeof initSettingsButton,
  viewerControls: typeof initViewerControls,
  roots: typeof connectedRoots,
) {
  const result = document.getElementById("result")!;
  const chat = document.getElementById("chat")!;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  const assert = (name: string, condition: boolean) => {
    if (!condition) throw new Error(name);
  };
  const header = () => {
    const element = document.createElement("header");
    element.innerHTML = `<div><button style="width:40px;height:40px"><svg><path d="M2.25 10a1.75 1.75 0 1 1 3.5 0"></path></svg></button></div><div>Compose</div>`;
    document.body.prepend(element);
    return element;
  };
  const gear = () => document.querySelector("[data-carrier-settings-button]");
  const marked = (element: Element) => element.hasAttribute("data-carrier-media-viewer");
  try {
    let currentHeader = header();
    settings();
    viewerControls();
    await settle();
    assert("initial settings placement", !!gear() && currentHeader.contains(gear()));

    let documentSweeps = 0;
    const query = document.querySelectorAll.bind(document);
    Object.defineProperty(document, "querySelectorAll", {
      value: (selector: string) => {
        documentSweeps += 1;
        return query(selector);
      },
    });
    for (let index = 0; index < 20; index += 1) {
      chat.innerHTML = `<article><span>Message ${index}</span><img></article>`;
      chat.style.opacity = index % 2 ? "1" : "0.9";
      chat.querySelector("img")!.dispatchEvent(new Event("load"));
      await settle();
    }
    assert(`unrelated chat updates caused ${documentSweeps} document sweeps`, documentSweeps === 0);

    const oldGear = gear();
    currentHeader.remove();
    currentHeader = header();
    await settle();
    assert("header replacement", gear() !== oldGear && currentHeader.contains(gear()));
    const slot = gear()!.parentElement!;
    currentHeader.append(slot);
    await settle();
    assert("displaced gear repaired", currentHeader.firstElementChild === slot);
    const hiddenHeader = currentHeader;
    hiddenHeader.hidden = true;
    currentHeader = header();
    await settle();
    assert("hidden header replaced without detaching", currentHeader.contains(gear()));
    hiddenHeader.remove();
    const replacementHeader = header();
    replacementHeader.querySelector("path")!.setAttribute("d", "M0 0");
    await settle();
    currentHeader
      .querySelector("button:not([data-carrier-settings-button]) path")!
      .setAttribute("d", "M0 0");
    replacementHeader.querySelector("path")!.setAttribute("d", "M2.25 10a1.75 1.75 0 1 1 3.5 0");
    await settle();
    assert("recycled overflow icon", replacementHeader.contains(gear()));
    currentHeader.remove();
    currentHeader = replacementHeader;

    const wrapper = document.createElement("section");
    const dialog = document.createElement("div");
    dialog.style.cssText = "position:fixed;inset:0";
    dialog.innerHTML = '<video controls style="width:80vw;height:80vh"></video>';
    wrapper.append(dialog);
    chat.append(wrapper);
    await settle();
    dialog.setAttribute("role", "dialog");
    await settle();
    assert("role added after insertion", marked(dialog));
    wrapper.hidden = true;
    await settle();
    assert("ancestor hidden", !marked(dialog));
    wrapper.hidden = false;
    await settle();
    assert("ancestor restored", marked(dialog));
    dialog.querySelector("video")!.remove();
    await settle();
    assert("media removed", !marked(dialog));
    dialog.innerHTML = '<video controls style="width:80vw;height:80vh"></video>';
    await settle();
    assert("media inserted", marked(dialog));
    wrapper.remove();
    await settle();
    assert("detached dialog cleaned up", !marked(dialog));
    chat.append(wrapper);
    await settle();
    assert("nested dialog discovered on reinsertion", marked(dialog));
    wrapper.style.cssText = "position:absolute;top:0;left:0";
    dialog.style.cssText = "width:100vw;height:100vh";
    await settle();
    assert("dialog in a positioned ancestor", marked(dialog));
    const spacer = document.createElement("div");
    spacer.style.height = "60vh";
    wrapper.prepend(spacer);
    await settle();
    assert("sibling insertion repositions dialog without resizing", !marked(dialog));
    spacer.remove();
    await settle();
    assert("sibling removal restores dialog position", marked(dialog));

    const nested = dialog.querySelector("video")!;
    const detached = document.createElement("div");
    const batch = roots(new Set([nested, detached, dialog, wrapper, currentHeader]));
    assert("nested and detached roots excluded", batch.length === 2);
    assert("independent trees retained", batch.includes(wrapper) && batch.includes(currentHeader));
    currentHeader.append(nested);
    const moved = roots(new Set([dialog, nested]));
    assert("moved descendant scanned at its current location", moved.length === 2);
    result.textContent = "PASS";
  } catch (error) {
    result.textContent = String(error);
  }
}
