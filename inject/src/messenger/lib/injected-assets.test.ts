import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import english from "../../../../src-tauri/locales/en.json";

const repoUrl = (path: string) => new URL(`../../../../${path}`, import.meta.url);
const repoAsset = (path: string) => Bun.file(repoUrl(path)).text();

describe("hand-maintained injected assets", () => {
  test("the MCP bridge contains no raw NUL bytes", async () => {
    const source = await repoAsset("src-tauri/inject/mcp-bridge.js");

    expect(source).not.toContain("\0");
    expect(source).toContain('listen("execute-js"');
    expect(source).toContain('listen("get-page-state"');
    expect(source).toContain('listen("get-page-map"');
  });

  test("the MCP page map bounds untrusted DOM traversal and output", async () => {
    const source = await repoAsset("src-tauri/inject/mcp-bridge.js");

    expect(source).toContain("Number.isFinite(p.maxDepth)");
    expect(source).toContain("MAX_VISITED_NODES");
    expect(source).toContain("MAX_ELEMENTS");
    expect(source).toContain("MAX_OUTPUT_CHARS");
    expect(source).toContain("if (!visibleNow) return");
    expect(source).toContain("truncated: exhausted");
    expect(source).toContain("var contentSource = roots");
    expect(source).toContain("return mapVisible(root)");
    expect(source).not.toContain("return root.innerText || root.textContent");
    expect(source).toContain(
      "if (!scopes.length && document.documentElement) roots.push(document.documentElement)",
    );
    expect(source).not.toContain('((document.body && document.body.innerText) || "")');
  });

  test("release capabilities cannot listen for app events", async () => {
    const release = JSON.parse(await repoAsset("src-tauri/capabilities/default.json")) as {
      permissions: unknown[];
    };
    const development = JSON.parse(await repoAsset("src-tauri/dev-capabilities/mcp.json")) as {
      permissions: unknown[];
    };

    expect(release.permissions).not.toContain("core:event:allow-listen");
    expect(development.permissions).toContain("core:event:allow-listen");
  });

  test("only Facebook and Messenger pages can reach Chatpane, not user-content hosts", async () => {
    const release = JSON.parse(await repoAsset("src-tauri/capabilities/default.json")) as {
      remote: { urls: string[] };
    };

    for (const url of release.remote.urls) {
      expect(new URL(url).hostname).toMatch(/^(\*\.)?(facebook|messenger)\.com$/);
    }
  });

  test("the connectivity screen keeps an explicit webview fallback", async () => {
    const splash = await repoAsset("dist/index.html");

    expect(splash).toContain('id="open-anyway"');
    expect(splash).toContain('invoke("open_messenger_anyway")');
    expect(splash).toContain('invoke("connect_messenger", { retryStartupTransients })');
    expect(splash).toContain('retry.addEventListener("click", () => connect(false))');
    expect(splash).toContain("connect(true)");
    expect(splash).toContain('["blocked", "unreachable", "error"]');
  });

  test("Windows tray options remain platform-gated and keep a tray escape hatch", async () => {
    const settings = await repoAsset("dist/settings.html");

    expect(settings).toContain("const IS_WINDOWS = /Win/");
    expect(settings).toContain('"hide_on_minimize"');
    expect(settings).toContain('"hide_on_focus_loss"');
    expect(settings).toContain('"hide_taskbar_icon"');
    expect(settings).toContain('key === "show_tray" && trayRequired');
  });

  test("the symbolic tray setting is offered on macOS, Linux, and Windows", async () => {
    const settings = await repoAsset("dist/settings.html");

    expect(settings).toContain("const IS_LINUX = !IS_MAC && !IS_WINDOWS");
    expect(settings).toContain('...(IS_MAC || IS_LINUX || IS_WINDOWS ? ["tray_icon_style"] : [])');
    expect(settings).toContain('["symbolic", t("settings.tray.tray_icon_style.symbolic")]');
    expect(english["settings.tray.tray_icon_style.symbolic"]).toBe("Monochrome");
  });

  test("notification polish is configurable, with a taskbar flash on Windows", async () => {
    const settings = await repoAsset("dist/settings.html");

    // Conversation grouping stays macOS-only (Windows groups inherently);
    // clear-on-view and the attention setting cover Windows too.
    expect(settings).toContain('...(IS_MAC ? ["group_notifications_by_conversation"] : [])');
    expect(settings).toContain(
      '...(IS_MAC || IS_WINDOWS ? ["clear_notifications_on_view", "attention_on_message"] : [])',
    );
    expect(settings).toContain('label: t("settings.notifications.attention.label_windows")');
    expect(english["settings.notifications.attention.label_windows"]).toBe("Flash Taskbar Icon");
  });

  test("downloads can save automatically or ask for a location", async () => {
    const settings = await repoAsset("dist/settings.html");

    expect(settings).toContain('"download_behavior", "downloads"');
    expect(settings).toContain('["downloads", t("settings.general.download_behavior.downloads")]');
    expect(settings).toContain('["ask", t("settings.general.download_behavior.ask")]');
    expect(english["settings.general.download_behavior.ask"]).toBe("Ask every time");
    expect(settings).toContain('"focus_composer_on_return", "download_behavior"');
    expect(settings).toContain("download_behavior: downloadBehaviorRow");
  });

  test("custom CSS is presented as best-effort and reloadable", async () => {
    const settings = await repoAsset("dist/settings.html");

    expect(settings).toContain('invoke("open_custom_css")');
    expect(settings).toContain('t("settings.advanced.custom_css.opened")');
    expect(english["settings.advanced.custom_css.opened"]).toBe(
      "Save custom.css, then reload {app} to apply it.",
    );
    expect(english["settings.advanced.custom_css.hint"]).toContain(
      "missing or invalid CSS is safely ignored",
    );
  });

  test("privacy settings share their own tab", async () => {
    const settings = await repoAsset("dist/settings.html");

    expect(settings).toContain(
      'fields: ["block_typing_indicator", "hide_names", "hide_avatars", "block_telemetry", "strip_link_tracking"]',
    );
  });

  test("Facebook link cleanup is a default-on setting beside telemetry blocking", async () => {
    const settings = await repoAsset("dist/settings.html");

    expect(settings).toContain(
      '["strip_link_tracking", t("settings.privacy.strip_link_tracking.label")',
    );
    expect(english["settings.privacy.strip_link_tracking.label"]).toBe(
      "Remove Facebook link tracking",
    );
    expect(settings).toContain('"block_telemetry", "strip_link_tracking"');
  });

  test("media viewer controls use a measured safe top inset", async () => {
    const css = await repoAsset("src-tauri/inject/messenger.css");

    expect(css).toContain("data-chatpane-media-controls");
    expect(css).toContain("data-chatpane-media-actions");
    expect(css).toContain("translate: 0 var(--chatpane-media-controls-offset");
  });

  test("macOS downloads declare a Files & Folders permission purpose", async () => {
    const info = await repoAsset("src-tauri/Info.plist");

    expect(info).toContain("<key>NSDownloadsFolderUsageDescription</key>");
    expect(info).toContain("Chatpane saves photos, videos, and files");
  });

  test("release builds bundle the pre-signed macOS share extension", async () => {
    const release = JSON.parse(await repoAsset("src-tauri/tauri.conf.release.json")) as {
      build: { beforeBundleCommand: string };
      bundle: {
        createUpdaterArtifacts: boolean;
        macOS: { files: Record<string, string> };
      };
    };
    const [buildEntrypoint, buildScript] = await Promise.all([
      repoAsset("share-extension/macos/build.ts"),
      repoAsset("share-extension/macos/build.sh"),
    ]);
    const packageJson = JSON.parse(await repoAsset("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(release.build.beforeBundleCommand).toBe("bun run build:share-extension");
    expect(packageJson.scripts["build:share-extension"]).toBe("bun share-extension/macos/build.ts");
    expect(release.bundle.macOS.files["PlugIns/Chatpane Share.appex"]).toBe(
      "target/share-extension/Chatpane Share.appex",
    );
    expect(release.bundle.createUpdaterArtifacts).toBe(true);
    expect(buildEntrypoint).toContain('if (process.platform !== "darwin")');
    expect(buildEntrypoint).toContain("process.env.APPLE_SIGNING_IDENTITY?.trim()");
    expect(buildEntrypoint).not.toContain('|| "-"');
    expect(buildScript).toContain('codesign --force --options runtime "$TIMESTAMP_OPTION"');
    expect(buildScript).toContain('--entitlements "$SCRIPT_DIR/entitlements.plist"');
    expect(buildScript).toContain('--sign "$IDENTITY"');
  });

  test("the share extension build rejects multiline bundle versions", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "chatpane-share-version-"));
    try {
      const result = Bun.spawnSync([
        "sh",
        fileURLToPath(repoUrl("share-extension/macos/build.sh")),
        outputDir,
        "arm64",
        "-",
        "1.2.3\nextra",
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(result.stderr)).toContain("invalid bundle version");
    } finally {
      await rm(outputDir, { force: true, recursive: true });
    }
  });

  test("Settings loads the generated update consent controller", async () => {
    const [settings, controller] = await Promise.all([
      repoAsset("dist/settings.html"),
      repoAsset("dist/settings-update.js"),
    ]);

    expect(settings).toContain('<button class="action" id="check" type="button" disabled>');
    expect(settings).toContain('<script src="settings-update.js"></script>');
    expect(controller).toContain("GENERATED FILE — DO NOT EDIT");
    expect(controller).toContain("UpdateConsentController");
  });

  test("every landing locale exposes signed checks and audited consent copy", async () => {
    const landing = await repoAsset("docs/index.html");
    const payload = landing.match(/var I18N = \/\*__I18N_LOCALES__\*\/ (\{.*\});\r?\n/)?.[1];
    expect(payload).toBeTruthy();

    // English ships inline; every other language loads from docs/i18n/<lang>.json.
    type Locale = { t: Record<string, string> };
    const locales = JSON.parse(payload || "{}") as Record<string, Locale>;
    expect(Object.keys(locales)).toEqual(["en"]);
    const files = (await readdir(fileURLToPath(repoUrl("docs/i18n"))))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();
    for (const lang of files) {
      locales[lang] = JSON.parse(await repoAsset(`docs/i18n/${lang}.json`)) as Locale;
    }
    expect(Object.keys(locales)).toEqual([
      "en",
      "ar",
      "bn",
      "cs",
      "da",
      "de",
      "el",
      "es",
      "fil",
      "fr",
      "hi",
      "hu",
      "id",
      "it",
      "km",
      "lo",
      "my",
      "nb",
      "ne",
      "pl",
      "pt-BR",
      "ro",
      "si",
      "sv",
      "th",
      "tr",
      "uk",
      "ur",
      "vi",
      "zh-CN",
    ]);

    const staleQuietHours = [
      "Set quiet hours",
      "ساعات هدوء",
      "horas de silencio",
      "quiet hours",
      "heures de silence",
      "stille timer",
      "ciszę na wieczór",
      "horário de silêncio",
      "ช่วงเวลาห้ามรบกวน",
      "giờ yên tĩnh",
    ];
    const conditionalUpdatePhrases: Record<string, string> = {
      en: "Automatic Update Checks is enabled",
      ar: "تفعيل البحث التلقائي عن التحديثات",
      es: "búsqueda automática de actualizaciones",
      fil: "naka-enable ang Awtomatikong Pag-check ng Update",
      fr: "recherche automatique de mises à jour est activée",
      nb: "automatiske oppdateringssjekker er slått på",
      pl: "automatyczne sprawdzanie aktualizacji jest włączone",
      "pt-BR": "verificação automática de atualizações está ativada",
      th: "เปิดการตรวจหาอัปเดตอัตโนมัติ",
      vi: "bật Tự động kiểm tra cập nhật",
    };
    const signedCheckPayload = landing.match(
      /var I18N_SIGNED_UPDATE_CHECKS = (\{[\s\S]*?\});/,
    )?.[1];
    expect(signedCheckPayload).toBeTruthy();
    const signedCheckPhrases = JSON.parse(signedCheckPayload || "{}") as Record<string, string>;
    expect(Object.keys(signedCheckPhrases)).toEqual(Object.keys(locales));
    expect(landing).toContain("I18N[locale].t['dl.trust'] =");
    for (const [locale, { t }] of Object.entries(locales)) {
      const updateAnswer = t["faq.a10"] || "";
      const trustAnswer = t["faq.a4"] || "";
      const repairAnswer = t["faq.a7"] || "";
      const notificationCopy = t["feat.2.body"] || "";
      const conditionalPhrase = conditionalUpdatePhrases[locale];
      expect(signedCheckPhrases[locale]).toBeTruthy();
      if (locale !== "en") {
        // The prerendered page (scripts/site/build.ts) must carry the phrase.
        const page = await repoAsset(`docs/${locale}/index.html`);
        expect(page).toMatch(
          new RegExp(`data-i18n="dl\\.trust"[^>]*>[^<]* · ${signedCheckPhrases[locale]}</p>`),
        );
      }
      if (!conditionalPhrase) continue;

      expect(updateAnswer).toContain("GitHub");
      expect(updateAnswer).toContain("Windows");
      expect(updateAnswer).toContain("SmartScreen");
      expect(updateAnswer).toContain(conditionalPhrase);
      expect(repairAnswer).toContain(conditionalPhrase);
      expect(trustAnswer).toContain("SmartScreen");
      expect(repairAnswer).toMatch(/https:\/\/github\.com\/kristofferR\/\w+\/issues/);
      expect(staleQuietHours.some((phrase) => notificationCopy.includes(phrase))).toBe(false);
    }
  });
});
