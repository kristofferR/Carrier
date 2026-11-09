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
  "only turning Stop Media Autoplay on pauses media already playing",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatpane-media-autoplay-"));
    try {
      const bundle = await build({
        stdin: {
          contents: `
            import { initMediaAutoplay } from "../features/media-autoplay";
            (${runFixture.toString()})(initMediaAutoplay);
          `,
          resolveDir: import.meta.dir,
        },
        bundle: true,
        write: false,
      });
      const file = join(directory, "media.html");
      await writeFile(
        file,
        `<!doctype html><html><body><pre id="result">RUNNING</pre>
        <script>${bundle.outputFiles[0]!.text}</script></body></html>`,
      );
      const child = Bun.spawn(
        [
          chromium!,
          "--headless",
          "--disable-gpu",
          "--no-sandbox",
          "--no-first-run",
          `--user-data-dir=${join(directory, "profile")}`,
          "--virtual-time-budget=5000",
          "--dump-dom",
          pathToFileURL(file).href,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" },
      );
      const [output, errors, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exit, errors).toBe(0);
      expect(output.match(/<pre id="result">([^<]+)/)?.[1], errors).toBe("PASS");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

function runFixture(initMediaAutoplay: () => void) {
  const result = document.getElementById("result")!;
  try {
    const settings = (stop_media_autoplay: boolean) => {
      window.__CHATPANE_SETTINGS__ = { stop_media_autoplay, spellcheck: true };
      window.dispatchEvent(new Event("chatpane:settings"));
    };
    // A video the user started, already playing.
    const video = document.createElement("video");
    let pauses = 0;
    Object.defineProperty(video, "paused", { get: () => false });
    video.pause = () => {
      pauses++;
    };
    document.body.append(video);

    window.__CHATPANE_SETTINGS__ = { stop_media_autoplay: false };
    initMediaAutoplay();
    settings(true);
    if (pauses !== 1) throw new Error(`turning it on paused ${pauses}`);
    settings(true);
    if (pauses !== 1) throw new Error("an unrelated change paused playing media");
    result.textContent = "PASS";
  } catch (error) {
    result.textContent = String(error);
  }
}
