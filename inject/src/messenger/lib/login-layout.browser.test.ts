import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import type { findOptionalCookieDeclineButton } from "../features/cookie-consent";
import type { initLoginTidy } from "../features/login-tidy";

const chromium = Bun.which("google-chrome") || Bun.which("chromium");

test.skipIf(!chromium)(
  "login handles clipped consent controls, footer layout, and post-login navigation",
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "carrier-login-layout-"));
    const bundle = await build({
      stdin: {
        contents: `
          import { findOptionalCookieDeclineButton } from "../features/cookie-consent";
          import { initLoginTidy } from "../features/login-tidy";
          const testLocation = globalThis.__carrierTestLocation = {
            hostname: "www.facebook.com", pathname: "/login.php",
            href: "https://www.facebook.com/login.php", replace() {}
          };
          (${runFixture.toString()})(findOptionalCookieDeclineButton, initLoginTidy, testLocation);
        `,
        resolveDir: import.meta.dir,
      },
      bundle: true,
      write: false,
      define: {
        location: "globalThis.__carrierTestLocation",
      },
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          `<!doctype html><html><body><script>${bundle.outputFiles[0]!.text}</script></body></html>`,
          {
            headers: { "content-type": "text/html" },
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
          `--user-data-dir=${profile}`,
          "--virtual-time-budget=3000",
          "--dump-dom",
          new URL("/login.php", server.url).href,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
      );
      const [output, errors, exit] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      expect(exit, errors).toBe(0);
      expect(output.match(/data-test-result="([^"]+)"/)?.[1]).toBe("PASS");
    } finally {
      await server.stop(true);
      await rm(profile, { recursive: true, force: true });
    }
  },
  60_000,
);

async function runFixture(
  findDecline: typeof findOptionalCookieDeclineButton,
  initTidy: typeof initLoginTidy,
  testLocation: Pick<Location, "hostname" | "pathname" | "href" | "replace">,
) {
  try {
    document.body.innerHTML = `
      <div style="position:fixed;left:10px;top:10px;width:500px;height:240px;overflow:hidden" role="dialog">
        <a href="https://www.facebook.com/privacy/policies/cookies/">Cookie policy</a>
        <div style="position:absolute;top:170px;display:flex;gap:10px">
          <div role="button" style="background:#ddd;width:180px;height:40px"><div id="decline" role="button" style="width:180px;height:40px">Decline optional cookies</div></div>
          <div role="button" style="background:#0866ff;width:180px;height:40px"><div role="button" style="width:180px;height:40px">Allow all cookies</div></div>
        </div>
        <div style="position:absolute;top:350px;display:flex;gap:10px">
          <button style="background:#ddd;width:180px;height:40px">Information</button>
          <button style="background:#0866ff;width:180px;height:40px">More information</button>
        </div>
      </div>`;
    if (findDecline()?.id !== "decline") throw new Error("Selected a clipped or duplicate control");
    const cover = document.createElement("div");
    cover.style.cssText = "position:fixed;inset:0;z-index:999;background:white";
    document.body.append(cover);
    if (findDecline() !== null) throw new Error("Selected a covered control");
    document.body.innerHTML = `
      <main style="width:100%">
        <section style="width:400px"><form><input name="email"><input name="pass" type="password"></form></section>
        <footer><div><ul class="localeSelectorList"><li><a href="#">English (US)</a></li><li><a href="#">Norsk (bokmål)</a></li></ul></div></footer>
      </main>`;
    window.requestAnimationFrame = (callback) =>
      window.setTimeout(() => callback(performance.now()), 16);
    initTidy();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const languageRoot = document.querySelector("[data-carrier-login-languages]");
    if (!languageRoot) throw new Error("Language strip missing");
    if (document.body.hasAttribute("data-carrier-login-footer-keep"))
      throw new Error("Footer styling reached the page body");
    for (const wrapper of document.querySelectorAll("[data-carrier-login-footer-keep]")) {
      if (!wrapper.closest("[data-carrier-login-footer]") || !wrapper.contains(languageRoot))
        throw new Error("Footer styling escaped the language branch");
    }
    const redirects: string[] = [];
    testLocation.replace = (url) => redirects.push(String(url));
    const checkNavigation = async (path: string, expected: number) => {
      testLocation.pathname = path;
      window.dispatchEvent(new Event("carrier:settings"));
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (redirects.length !== expected)
        throw new Error(`Unexpected redirect count on ${path}: ${redirects.length}`);
    };
    await checkNavigation("/", 0); // Logged-out home is the login form.
    // biome-ignore lint/suspicious/noDocumentCookie: exercise the cookie API used by WebKit.
    document.cookie = "c_user=fixture; path=/";
    await checkNavigation("/", 0); // A stale auth cookie must not bypass the form.
    document.body.replaceChildren();
    await checkNavigation("/", 0); // A signed-in landing page alone is insufficient.
    document.body.innerHTML = '<div role="feed"></div><div role="dialog">Terms or ad consent</div>';
    await checkNavigation("/", 0); // Even with the feed behind it, preserve a required dialog.
    document.querySelector('[role="dialog"]')!.remove();
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    await checkNavigation("/", 0);
    modal.remove();
    const securityForm = document.createElement("form");
    document.body.append(securityForm);
    await checkNavigation("/", 0);
    securityForm.remove();
    testLocation.pathname = "/checkpoint/";
    for (const path of [
      "/checkpoint/",
      "/two_factor/",
      "/recover/",
      "/login.php",
      "/auth_platform/",
    ])
      await checkNavigation(path, 0);
    testLocation.hostname = "facebook.com.example.org";
    await checkNavigation("/", 0);
    testLocation.hostname = "www.facebook.com";
    await checkNavigation("/", 1);
    if (redirects[0] !== "https://www.facebook.com/messages")
      throw new Error("Post-login redirect missed Messenger");
    await checkNavigation("/home.php", 1); // A bounce back must not loop.
    await checkNavigation("/messages", 1);
    await checkNavigation("/", 1); // A client-side bounce before Messenger renders must not loop.
    document.body.innerHTML = '<nav role="navigation"><div role="grid"></div></nav>';
    await checkNavigation("/messages/t/123", 1); // A rendered Messenger chat list rearms recovery.
    document.body.innerHTML = '<div data-pagelet="FeedUnit_0"></div>';
    await checkNavigation("/home.php", 2);
    // biome-ignore lint/suspicious/noDocumentCookie: exercise logout using WebKit's cookie API.
    document.cookie = "c_user=; Max-Age=0; path=/";
    await checkNavigation("/", 2);
    document.documentElement.dataset.testResult = "PASS";
  } catch (error) {
    document.documentElement.dataset.testResult = String(error);
  }
}
