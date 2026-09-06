import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// GitHub runners provide stable Chrome via CHROME_BIN alongside a Chromium
// snapshot. Prefer the configured browser over that development snapshot.
const chromium =
  (Bun.env.CHROME_BIN && Bun.which(Bun.env.CHROME_BIN)) ||
  Bun.which("google-chrome") ||
  Bun.which("chromium");

// Real DOM/CSS fixtures when Chromium is installed. Pure classification tests
// still run on hosts without a browser. No Messenger session or network needed.
test.skipIf(!chromium).each([480, 1000, 1600])(
  "media viewer DOM and CSS fixtures at %ipx",
  async (width) => {
    const directory = await mkdtemp(join(tmpdir(), "carrier-viewer-test-"));
    try {
      const entry = fileURLToPath(new URL("../features/viewer-controls.ts", import.meta.url));
      const bundle = await build({
        stdin: {
          contents: `import { initViewerControls } from ${JSON.stringify(entry)}; initViewerControls();`,
          resolveDir: import.meta.dir,
        },
        bundle: true,
        write: false,
      });
      const css = await readFile(
        new URL("../../../../src-tauri/inject/messenger.css", import.meta.url),
        "utf8",
      );
      const html = `<!doctype html><html><head><style>${css}</style><style>
        html,body{margin:0;height:100%} .viewer{position:fixed;inset:0}
        .media{position:absolute;top:20%;left:20%;width:60%;height:60%}
        .actions{position:absolute;top:-16px;right:20px;display:flex}
        a,button{display:inline-block;width:40px;height:40px}
        [hidden],.off{display:none!important}
        </style></head><body><div role="banner" style="position:fixed;top:-16px;left:0"><button>Close</button></div>
        <main id="fixtures"></main><pre id="result">RUNNING</pre><script>
        // --virtual-time-budget advances timers, but not animation frames.
        window.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 16);
        ${bundle.outputFiles[0]!.text}
        (${runFixtures.toString()})();</script></body></html>`;
      const file = join(directory, "index.html");
      await writeFile(file, html);
      const process = Bun.spawn(
        [
          chromium!,
          "--headless",
          "--disable-gpu",
          "--no-sandbox",
          "--no-first-run",
          `--user-data-dir=${join(directory, "profile")}`,
          `--window-size=${width},900`,
          "--virtual-time-budget=15000",
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

async function runFixtures() {
  const host = document.getElementById("fixtures")!;
  const result = document.getElementById("result")!;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  const marked = (element: Element) => element.hasAttribute("data-carrier-media-viewer");
  const header = () =>
    getComputedStyle(document.documentElement).getPropertyValue("--header-height").trim();
  const assert = (name: string, condition: boolean) => {
    if (!condition) throw new Error(name);
  };
  const make = (extra = "", video = false) => {
    const dialog = document.createElement("div");
    dialog.className = "viewer";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", "Synthetic fixture");
    dialog.innerHTML = `${video ? '<video class="media" controls></video>' : '<img class="media">'}
      <div class="actions"><a download href="#">Save</a><button>Share</button></div>${extra}`;
    host.append(dialog);
    return dialog;
  };
  try {
    for (const [name, width, height] of [
      ["emoji", 0.4, 0.4],
      ["sticker", 0.5, 0.5],
      ["GIF", 0.6, 0.6],
      ["reaction", 0.5, 0.15],
      ["people", 0.5, 0.8],
      ["info", 0.3, 1],
    ] as const) {
      const dialog = make();
      dialog.style.cssText = `position:fixed;inset:auto;right:0;bottom:0;width:${innerWidth * width}px;height:${innerHeight * height}px`;
      await settle();
      assert(name, !marked(dialog) && header() === "0px");
      dialog.remove();
    }
    const main = make('<div role="navigation"></div>');
    const nested = make();
    main.append(nested);
    await settle();
    assert("viewer inside main Messenger dialog", marked(nested) && !marked(main));
    main.remove();
    for (const [name, width, height, accepted] of [
      ["tall screenshot", 0.02, 0.6, true],
      ["wide panorama", 0.6, 0.02, true],
      ["thumbnail", 0.1, 0.1, false],
    ] as const) {
      const viewer = make();
      const media = viewer.querySelector<HTMLElement>(".media")!;
      media.style.width = `${width * 100}%`;
      media.style.height = `${height * 100}%`;
      await settle();
      assert(name, marked(viewer) === accepted && header() === (accepted ? "56px" : "0px"));
      viewer.remove();
    }
    let dialog = make();
    await settle();
    assert("image viewer", marked(dialog) && header() === "56px");
    assert("safe control inset", dialog.querySelector("a")!.getBoundingClientRect().top >= 7.9);
    const picker = make();
    picker.style.cssText = "position:fixed;width:30vw;height:30vh;inset:auto;bottom:0;right:0";
    dialog.prepend(picker);
    await settle();
    assert(
      "nested picker",
      !marked(picker) && !picker.querySelector("[data-carrier-media-actions]") && marked(dialog),
    );
    picker.remove();
    for (const [attribute, value] of [
      ["hidden", ""],
      ["aria-hidden", "true"],
      ["inert", ""],
      ["class", "viewer off"],
      ["role", "region"],
    ]) {
      dialog.setAttribute(attribute!, value!);
      await settle();
      assert(
        `hide via ${attribute}`,
        !marked(dialog) &&
          header() === "0px" &&
          !dialog.querySelector("[data-carrier-media-actions]"),
      );
      dialog.removeAttribute(attribute!);
      dialog.className = "viewer";
      dialog.setAttribute("role", "dialog");
      await settle();
      assert(`restore after ${attribute}`, marked(dialog));
    }
    const old = dialog;
    old.remove();
    dialog = make("", true);
    dialog.querySelector("a")!.remove();
    await settle();
    assert(
      "replacement video with native controls",
      marked(dialog) && !marked(old) && !old.querySelector("[data-carrier-media-actions]"),
    );
    dialog.remove();
    await settle();
    assert(
      "closed viewer",
      header() === "0px" &&
        getComputedStyle(document.querySelector('[role="banner"]')!).display === "none",
    );
    for (const extra of ['<div contenteditable="true"></div>', ""]) {
      dialog = make(extra);
      if (!extra) dialog.setAttribute("data-carrier-shortcuts-overlay", "");
      await settle();
      assert("composer/Carrier surface", !marked(dialog));
      dialog.remove();
    }
    const ancestor = document.createElement("section");
    host.append(ancestor);
    dialog = make();
    ancestor.append(dialog);
    ancestor.setAttribute("aria-hidden", "true");
    await settle();
    assert("hidden ancestor", !marked(dialog));
    ancestor.removeAttribute("aria-hidden");
    await settle();
    assert("visible ancestor", marked(dialog));
    ancestor.remove();
    for (const theme of ["__fb-light-mode", "__fb-dark-mode"]) {
      document.documentElement.className = theme;
      for (const mode of ["zoom", "transform"])
        for (const scale of [0.3, 0.8, 1, 1.5, 2]) {
          document.documentElement.style.zoom = "";
          document.body.style.cssText = "margin:0";
          if (mode === "zoom") document.documentElement.style.zoom = String(scale);
          else
            document.body.style.cssText = `margin:0;transform:scale(${scale});transform-origin:top left;width:${100 / scale}%;height:${100 / scale}%`;
          dialog = make();
          window.dispatchEvent(new Event("resize"));
          await settle();
          assert(`${theme} ${mode} ${scale}`, marked(dialog) && header() === "56px");
          dialog.remove();
          await settle();
        }
    }
    result.textContent = "PASS";
  } catch (error) {
    result.textContent = String(error);
  }
}
