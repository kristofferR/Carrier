import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { Settings, SettingsChange } from "./native-types";

const chromium =
  (Bun.env.CHROME_BIN && Bun.which(Bun.env.CHROME_BIN)) ||
  Bun.which("google-chrome") ||
  Bun.which("chromium");

test.skipIf(!chromium).each(["MacIntel", "Win32", "Linux x86_64"])(
  "Settings renders and queues typed edits on %s",
  async (platform) => {
    const directory = await mkdtemp(join(tmpdir(), "chatpane-settings-"));
    try {
      const bundles = await Promise.all(
        ["early", "index"].map((name) =>
          build({
            entryPoints: [join(import.meta.dir, `${name}.ts`)],
            bundle: true,
            write: false,
          }),
        ),
      );
      let html = await Bun.file(new URL("../../../dist/settings.html", import.meta.url)).text();
      html = html.replace(
        '<script src="settings-early.js"></script>',
        `<script>(${installBridge.toString()})(${JSON.stringify(platform)}, ${JSON.stringify(globalThis.__CHATPANE_I18N__)});</script>
        <script>${bundles[0]!.outputFiles[0]!.text}</script>`,
      );
      html = html.replace(
        '<script src="settings.js"></script>',
        `<pre id="result">RUNNING</pre><script>${bundles[1]!.outputFiles[0]!.text}</script>
        <script>(${exerciseSettings.toString()})();</script>`,
      );
      const file = join(directory, "settings.html");
      await writeFile(file, html);
      const child = Bun.spawn(
        [
          chromium!,
          "--headless",
          "--disable-gpu",
          "--no-sandbox",
          "--no-first-run",
          `--user-data-dir=${join(directory, "profile")}`,
          "--virtual-time-budget=10000",
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

interface Fixture {
  current: Partial<Settings>;
  changes: SettingsChange[];
  calls: string[];
  failNext: boolean;
  /** Lets native replies through, once the first frame has been checked. */
  release: () => void;
}

declare global {
  interface Window {
    settingsFixture: Fixture;
  }
}

function installBridge(platform: string, strings: typeof globalThis.__CHATPANE_I18N__) {
  Object.defineProperty(navigator, "platform", { value: platform });
  // The OS's injected data arrives before either Settings bundle.
  globalThis.__CHATPANE_I18N__ = strings;
  window.__CHATPANE_TITLE_BAR__ = {
    inset: 28,
    controls: platform === "MacIntel" ? null : platform === "Win32" ? "windows" : "linux",
    minimize: false,
    maximize: false,
    maximized: false,
  };
  let release = () => {};
  const replies = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture: Fixture = {
    current: { theme: "system", app_icon: "color-light", hide_names_avatars: true },
    changes: [],
    calls: [],
    failNext: false,
    release,
  };
  window.settingsFixture = fixture;
  window.__CHATPANE_SETTINGS_BOOT__ = {
    settings: structuredClone(fixture.current) as Settings,
    capabilities: {
      snap: false,
      autostart: true,
      automaticUpdateChecks: true,
      multiInstance: true,
      debug: false,
    },
    version: "3.1.0",
    install_mode: { kind: "built-in", buttonLabel: null, instructions: null },
    discovered_update: null,
  };
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      fixture.calls.push(command);
      await replies;
      switch (command) {
        case "get_settings":
          return structuredClone(fixture.current);
        case "autostart_status":
          return "off";
        case "update_install_mode":
          return { kind: "built-in" };
        case "messenger_account":
          return { activeStatus: true, sounds: false, dndUntil: 0, readReceipts: true };
        case "messenger_profile":
          return { name: "Ada Lovelace", picture: "data:image/png;base64,iVBORw0KGgo=" };
        case "list_themes":
          return [{ id: "default", name: "Default", builtIn: true }];
        case "notification_sounds":
        case "list_fonts":
          return [];
        case "reset_settings":
          fixture.current = {};
          return {};
        case "update_setting": {
          const change = args?.change as SettingsChange;
          fixture.changes.push(change);
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (fixture.failNext) {
            fixture.failNext = false;
            throw new Error("fixture save failed");
          }
          if (change.key === "app_icon_dark_mode") {
            fixture.current.app_icon_dark = change.value
              ? fixture.current.app_icon?.replace("-light", "-dark")
              : "";
          } else Object.assign(fixture.current, { [change.key]: change.value });
          return structuredClone(fixture.current);
        }
        default:
          return null;
      }
    },
  };
}

async function exerciseSettings() {
  const result = document.getElementById("result")!;
  const fixture = window.settingsFixture;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
  const assert = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
  };
  const tab = (name: string) => document.getElementById(`tab-${name}`)!.click();
  const toggle = (label: string) => {
    const row = [...document.querySelectorAll("label.row")].find(
      (row) => row.querySelector(".label")?.textContent === label,
    );
    const input = row?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!input) throw new Error(`Missing setting: ${label}`);
    input.click();
  };
  try {
    // The first frame comes from the boot data, before any native reply.
    assert(document.getElementById("rows")!.children.length > 0, "first frame is complete");
    assert(document.getElementById("version")!.textContent!.includes("3.1.0"), "version");
    assert(!(document.getElementById("check") as HTMLButtonElement).disabled, "update button");
    fixture.release();
    await settle();
    assert(document.title === "Chatpane Settings", "early localization");
    assert(document.querySelectorAll('[role="tab"]').length === 7, "all tabs render");
    for (const name of ["appearance", "tray", "notifications", "privacy", "account", "advanced"]) {
      tab(name);
      await settle();
      assert(
        document.getElementById(`tab-${name}`)?.getAttribute("aria-selected") === "true",
        name,
      );
      assert(document.getElementById("rows")!.children.length > 0, `${name} has controls`);
    }
    // Account opens with the signed-in account, and Log Out asks native to confirm.
    tab("account");
    await settle();
    const profile = document.querySelector(".profile")!;
    assert(profile.querySelector(".name")?.textContent === "Ada Lovelace", "profile name");
    assert(
      profile.querySelector<HTMLImageElement>("img.avatar")?.src.startsWith("data:image/png"),
      "profile picture",
    );
    fixture.calls.length = 0;
    profile.querySelector("button")!.click();
    await settle();
    assert(fixture.calls.join() === "log_out", "Log Out asks native");

    const platform = navigator.platform;
    assert(
      Boolean(document.getElementById("window-controls")) === (platform !== "MacIntel"),
      "native window control placement",
    );

    // A menu change after the page read its snapshot must survive an unrelated edit.
    fixture.current.always_on_top = true;
    tab("general");
    fixture.calls.length = 0;
    toggle("Spell check");
    await settle();
    assert(
      fixture.current.always_on_top && fixture.current.spellcheck,
      "preserves the latest native state",
    );
    assert(fixture.calls.join() === "update_setting", "one atomic command, no snapshot read/write");

    // Saving errors remain visible, and the queue still accepts later edits.
    fixture.failNext = true;
    toggle("Spell check");
    await settle();
    assert(document.getElementById("status")!.textContent === "fixture save failed", "save error");
    toggle("Spell check");
    await settle();
    assert(fixture.current.spellcheck === false, "save queue recovers after rejection");

    tab("appearance");
    const zoomRow = [...document.querySelectorAll("label.row")].find(
      (row) => row.querySelector(".label")?.textContent === "Page zoom",
    );
    const zoom = zoomRow!.querySelector("select")!;
    zoom.value = "120";
    zoom.dispatchEvent(new Event("change"));
    await settle();
    assert(fixture.current.zoom === 120, "numeric settings keep numeric wire values");

    tab("notifications");
    const sound = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Notification sound"]',
    )!;
    sound.value = JSON.stringify("off");
    sound.dispatchEvent(new Event("change"));
    await settle();
    assert(
      fixture.current.notification_sound_choice === "off",
      "sound selection keeps its wire variant",
    );

    tab("appearance");
    fixture.current.app_icon = "mono-light";
    document.querySelector<HTMLInputElement>(".icon-switch input")!.click();
    await settle();
    assert(fixture.changes.at(-1)?.key === "app_icon_dark_mode", "native icon derivation request");
    assert(fixture.current.app_icon_dark === "mono-dark", "derives from latest native icon");

    // A reset clicked after an edit must execute after that queued edit.
    tab("general");
    fixture.calls.length = 0;
    toggle("Spell check");
    document.getElementById("reset")!.click();
    await settle();
    assert(fixture.calls.join() === "update_setting,reset_settings", "reset preserves user order");
    assert(Object.keys(fixture.current).length === 0, "reset is the final saved state");
    result.textContent = "PASS";
  } catch (error) {
    result.textContent = String(error);
  }
}
