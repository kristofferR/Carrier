import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import type { findOptionalCookieDeclineButton } from "../features/cookie-consent";
import type { initForceTheme } from "../features/force-theme";
import type { initLoginTidy } from "../features/login-tidy";

const chromium = Bun.which("google-chrome") || Bun.which("chromium");

test.skipIf(!chromium)(
  "login preserves scrolling, themes, required auth UI, and post-login navigation",
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "chatpane-login-layout-"));
    const bundle = await build({
      stdin: {
        contents: `
          import { findOptionalCookieDeclineButton } from "../features/cookie-consent";
          import { initForceTheme } from "../features/force-theme";
          import { initLoginTidy } from "../features/login-tidy";
          const testLocation = globalThis.__chatpaneTestLocation = {
            hostname: "www.facebook.com", pathname: "/login.php",
            href: "https://www.facebook.com/login.php", replace() {}
          };
          (${runFixture.toString()})(findOptionalCookieDeclineButton, initLoginTidy, initForceTheme, testLocation);
        `,
        resolveDir: import.meta.dir,
      },
      bundle: true,
      write: false,
      define: {
        location: "globalThis.__chatpaneTestLocation",
      },
    });
    const css = await readFile(
      new URL("../../../../src-tauri/inject/messenger.css", import.meta.url),
      "utf8",
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          `<!doctype html><html id="facebook" class="__fb-light-mode"><head><style>${css}</style>
            <style>
              html,body { margin:0; height:100% }
              .login-shell { height:100vh; max-height:100vh; overflow-y:scroll }
              .login-palette { --primary-text:#111112; --placeholder-text:#686a6e; --surface-background:white; --input-background:white }
              .login-palette section { min-height:110vh; background:var(--surface-background) }
              .login-palette section > div { min-height:110vh }
              .login-palette h2, .login-palette input { color:var(--primary-text) }
              .login-palette input { background:var(--input-background) }
              .login-palette label { color:var(--placeholder-text) }
            </style></head><body><script>${bundle.outputFiles[0]!.text}</script></body></html>`,
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
  initTheme: typeof initForceTheme,
  testLocation: Pick<Location, "hostname" | "pathname" | "href" | "replace">,
) {
  try {
    // Chromium's virtual-time budget advances timers, but not animation frames.
    window.requestAnimationFrame = (callback) =>
      window.setTimeout(() => callback(performance.now()), 16);
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
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const decline = findDecline();
    if (decline?.id !== "decline")
      throw new Error(
        `Selected a clipped or duplicate control: ${decline?.id || decline?.textContent || "null"}`,
      );
    const cover = document.createElement("div");
    cover.style.cssText = "position:fixed;inset:0;z-index:999;background:white";
    document.body.append(cover);
    if (findDecline() !== null) throw new Error("Selected a covered control");
    document.body.innerHTML = `
      <main class="login-shell login-palette" style="width:100%">
        <section style="width:400px"><div><h2>Log into Facebook</h2><form><div style="min-height:120vh"><div id="legacy-band" style="background:white">Login</div>
          <label>Email<input name="email"></label><input name="pass" type="password">
          <button>Log in</button>
          <svg><path id="wordmark" fill="#1C2B33" d="M0 0h10v10z"></path><path id="symbol" fill="#0180FA" d="M10 10h10v10z"></path></svg>
        </div></form></div></section>
        <footer><div><div><hr></div><ul class="localeSelectorList"><li><a href="#">English (US)</a></li><li><a href="#">Norsk (bokmål)</a></li></ul></div></footer>
      </main>`;
    let retirements = 0;
    window.MutationObserver = class extends MutationObserver {
      override disconnect() {
        retirements++;
        super.disconnect();
      }
    };
    window.__CHATPANE_SETTINGS__ = { theme: "dark" };
    initTheme(); // Production order: the forced root class already exists.
    initTidy();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const languageRoot = document.querySelector("[data-chatpane-login-languages]");
    if (!languageRoot) throw new Error("Language strip missing");
    if (document.body.hasAttribute("data-chatpane-login-footer-keep"))
      throw new Error("Footer styling reached the page body");
    for (const wrapper of document.querySelectorAll("[data-chatpane-login-footer-keep]")) {
      if (!wrapper.closest("[data-chatpane-login-footer]") || !wrapper.contains(languageRoot))
        throw new Error("Footer styling escaped the language branch");
    }
    const html = document.documentElement;
    const assert = (name: string, condition: boolean) => {
      if (!condition) throw new Error(name);
    };
    assert(
      "Decorative footer divider removed",
      document.querySelector("hr")!.getBoundingClientRect().height === 0,
    );
    const color = (selector: string) => getComputedStyle(document.querySelector(selector)!).color;
    const checkLanguageSpacing = () => {
      const form = document.querySelector("[data-chatpane-login-form]")!;
      const gap = languageRoot.getBoundingClientRect().top - form.getBoundingClientRect().bottom;
      assert("Language selector follows the form without a large gap", gap >= 16 && gap <= 48);
      assert(
        "Language selector scrolls with the page",
        getComputedStyle(languageRoot).position === "static",
      );
    };
    const checkScroll = () => {
      for (const element of document.querySelectorAll<HTMLElement>("body, body *")) {
        const style = getComputedStyle(element);
        assert(
          `Nested login scrollport: ${element.tagName}`,
          !/auto|scroll/.test(style.overflowY) || element.scrollHeight <= element.clientHeight,
        );
      }
      assert("Document allows scrolling", getComputedStyle(html).overflowY === "auto");
      window.scrollTo(0, 100);
      assert("Tall login content remains reachable", window.scrollY > 0);
      window.scrollTo(0, 0);
    };
    assert(
      "Forced dark is applied after force-theme",
      html.hasAttribute("data-chatpane-login-dark"),
    );
    assert("Nested light text palette replaced", color("h2") === "rgb(243, 244, 245)");
    assert("Input text follows dark palette", color('input[name="email"]') === color("h2"));
    assert("Field labels follow dark palette", color("label") === "rgb(161, 164, 168)");
    assert(
      "Dark input surface",
      getComputedStyle(document.querySelector("input")!).backgroundColor === "rgb(36, 37, 38)",
    );
    assert(
      "Wordmark readable",
      getComputedStyle(document.querySelector("#wordmark")!).fill === color("h2"),
    );
    assert(
      "Logo symbol preserved",
      getComputedStyle(document.querySelector("#symbol")!).fill === "rgb(1, 128, 250)",
    );
    assert(
      "Legacy literal-white band cleared",
      getComputedStyle(document.querySelector("#legacy-band")!).backgroundColor ===
        "rgba(0, 0, 0, 0)",
    );
    checkScroll();
    checkLanguageSpacing();
    const content = document.querySelector<HTMLElement>("form > div")!;
    content.style.minHeight = "0";
    checkLanguageSpacing(); // A short form must not push languages to the window bottom.
    content.style.minHeight = "120vh";
    const theme = async (value: "light" | "dark" | "system") => {
      window.__CHATPANE_SETTINGS__ = { theme: value };
      window.dispatchEvent(new Event("chatpane:settings"));
      await new Promise((resolve) => setTimeout(resolve, 40));
    };
    await theme("light");
    assert("Light palette restored", color("h2") === "rgb(17, 17, 18)");
    assert("Light marker removed", !html.hasAttribute("data-chatpane-login-dark"));
    assert(
      "Literal-white band restored in light mode",
      getComputedStyle(document.querySelector("#legacy-band")!).backgroundColor ===
        "rgb(255, 255, 255)",
    );
    checkScroll();
    await theme("system");
    assert(
      "System theme followed",
      html.hasAttribute("data-chatpane-login-dark") ===
        matchMedia("(prefers-color-scheme: dark)").matches,
    );
    await theme("dark");
    // Saved-account and PIN/E2EE screens must keep their own layout and theme.
    const login = document.body.innerHTML;
    for (const content of [
      '<main><button>Saved account</button><a href="/login/">Use another account</a></main>',
      '<main><form><h2>Restore your chats</h2><input type="password" inputmode="numeric"><button>Restore</button></form></main>',
    ]) {
      document.body.innerHTML = content;
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert("Non-login layout preserved", !html.hasAttribute("data-chatpane-login"));
      assert("Login palette cleaned up", !html.hasAttribute("data-chatpane-login-dark"));
      assert(
        "Required controls visible",
        document.querySelector("button")!.getBoundingClientRect().height > 0,
      );
    }
    document.body.innerHTML = login;
    await new Promise((resolve) => setTimeout(resolve, 40));
    const redirects: string[] = [];
    testLocation.replace = (url) => redirects.push(String(url));
    const checkNavigation = async (path: string, expected: number) => {
      testLocation.pathname = path;
      window.dispatchEvent(new Event("chatpane:settings"));
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
    if (retirements !== 0) throw new Error("Retired while required form was pending");
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
    const priorRetirements = Number(retirements);
    initTidy();
    await checkNavigation("/", 1);
    if (redirects[0] !== "https://www.facebook.com/messages")
      throw new Error("Post-login redirect missed Messenger");
    if (Number(retirements) !== priorRetirements + 1)
      throw new Error("Observer survived completed recovery");
    initTidy();
    await checkNavigation("/home.php", 1); // A bounce back must not loop.
    if (Number(retirements) !== priorRetirements + 2)
      throw new Error("Observer survived redirect guard");
    const beforeMessengerRecovery = Number(retirements);
    initTidy();
    await checkNavigation("/messages", 1);
    if (Number(retirements) !== beforeMessengerRecovery)
      throw new Error("Observer retired before Messenger rendered");
    await checkNavigation("/", 1); // A client-side bounce before Messenger renders must not loop.
    document.body.innerHTML = '<nav role="navigation"><div role="grid"></div></nav>';
    await checkNavigation("/messages/t/123", 1); // A rendered Messenger chat list rearms recovery.
    if (Number(retirements) !== beforeMessengerRecovery + 1)
      throw new Error("Observer survived rendered Messenger");
    document.body.innerHTML = '<div data-pagelet="FeedUnit_0"></div>';
    await checkNavigation("/home.php", 2);
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("Storage unavailable");
    };
    initTidy();
    await checkNavigation("/home.php", 2);
    Storage.prototype.getItem = getItem;
    if (Number(retirements) !== priorRetirements + 4)
      throw new Error("Observer survived unavailable storage");
    for (const requiredUi of [
      '<div role="dialog">Terms</div>',
      '<div aria-modal="true">Consent</div>',
      "<form>Required confirmation</form>",
    ]) {
      document.body.innerHTML = `<div role="feed"></div>${requiredUi}`;
      const beforeRedirects = redirects.length;
      const beforeRetirements = Number(retirements);
      initTidy();
      await checkNavigation("/home.php", beforeRedirects);
      if (Number(retirements) !== beforeRetirements)
        throw new Error("Retired on guarded post-login UI");
      document.body.lastElementChild!.remove();
      // Only the mutation observer can recover after required UI disappears.
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (redirects.length !== beforeRedirects + 1)
        throw new Error("Did not recover after guarded post-login UI");
      await checkNavigation("/home.php", beforeRedirects + 1);
    }
    // biome-ignore lint/suspicious/noDocumentCookie: exercise logout using WebKit's cookie API.
    document.cookie = "c_user=; Max-Age=0; path=/";
    await checkNavigation("/", 5);
    document.documentElement.dataset.testResult = "PASS";
  } catch (error) {
    document.documentElement.dataset.testResult = String(error);
  }
}
