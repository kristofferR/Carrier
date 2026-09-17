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
  "reads the link card label without unrelated or hidden message text",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "carrier-link-card-test-"));
    try {
      const entry = fileURLToPath(new URL("./notification-links.ts", import.meta.url));
      const bundle = await build({
        stdin: {
          contents: `import { notificationLinkCards, notificationLinkBody } from ${JSON.stringify(entry)};
          const root = document.getElementById('messages');
          const cards = notificationLinkCards(root);
          document.getElementById('result').textContent = JSON.stringify({
            cards,
            body: notificationLinkBody('https://youtu.be/_TP-ZzKbXJk', cards),
          });`,
          resolveDir: import.meta.dir,
        },
        bundle: true,
        write: false,
      });
      const file = join(directory, "index.html");
      await writeFile(
        file,
        `<!doctype html><html><body>
      <div role="article"><a href="https://youtu.be/_TP-ZzKbXJk">Outside the conversation</a></div>
      <div id="messages" role="log">
        <div role="article">
          <h3>Sender name</h3><div>Unrelated message text</div>
          <a href="https://youtube.com/watch?v=_TP-ZzKbXJk">https://youtube.com/watch?v=_TP-ZzKbXJk</a>
          <a href="https://l.facebook.com/l.php?u=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3D_TP-ZzKbXJk">
            <img alt="An unrelated image description">
            <span aria-hidden="true">Hidden content</span>
            <span><span>Japanese toilet experience 1</span></span>
            <span>www.youtube.com</span>
          </a>
          <a aria-hidden="true" href="https://youtu.be/_TP-ZzKbXJk"><span>Hidden card</span></a>
        </div>
      </div>
      <pre id="result"></pre><script>${bundle.outputFiles[0]!.text}</script></body></html>`,
      );
      const process = Bun.spawn(
        [
          chromium!,
          "--headless",
          "--disable-gpu",
          "--no-sandbox",
          "--no-first-run",
          `--user-data-dir=${join(directory, "profile")}`,
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
      const result = JSON.parse(output.match(/<pre id="result">([^<]+)/)?.[1] || "null");
      expect(result.cards).toHaveLength(1);
      expect(result.cards[0].title).toBe("Japanese toilet experience 1");
      expect(result.body).toBe("Sent a YouTube link: Japanese toilet experience 1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
