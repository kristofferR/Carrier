import { describe, expect, test } from "bun:test";

const repoAsset = (path: string) =>
  Bun.file(new URL(`../../../../${path}`, import.meta.url)).text();

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

  test("the connectivity screen keeps an explicit webview fallback", async () => {
    const splash = await repoAsset("dist/index.html");

    expect(splash).toContain('id="open-anyway"');
    expect(splash).toContain('invoke("open_messenger_anyway")');
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

  test("custom CSS is presented as best-effort and reloadable", async () => {
    const settings = await repoAsset("dist/settings.html");

    expect(settings).toContain('invoke("open_custom_css")');
    expect(settings).toContain("Save custom.css, then reload Carrier to apply it.");
    expect(settings).toContain("missing or invalid CSS is safely ignored");
  });

  test("every landing locale describes update consent and current notification controls", async () => {
    const landing = await repoAsset("docs/index.html");
    const payload = landing.match(/var I18N = \/\*__I18N_LOCALES__\*\/ (\{.*\});\r?\n/)?.[1];
    expect(payload).toBeTruthy();

    const locales = JSON.parse(payload || "{}") as Record<string, { t: Record<string, string> }>;
    expect(Object.keys(locales)).toEqual([
      "en",
      "ar",
      "es",
      "fil",
      "fr",
      "nb",
      "pl",
      "pt-BR",
      "th",
      "vi",
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
    const conditionalUpdatePhrases: Record<string, [string, string]> = {
      en: ["Automatic Update Checks is enabled", "Optional"],
      ar: ["تفعيل البحث التلقائي عن التحديثات", "اختياري"],
      es: ["búsqueda automática de actualizaciones", "opcional"],
      fil: ["naka-enable ang awtomatikong pag-check ng update", "Opsyonal"],
      fr: ["recherche automatique de mises à jour est activée", "facultative"],
      nb: ["automatiske oppdateringssjekker er slått på", "Valgfri"],
      pl: ["automatyczne sprawdzanie aktualizacji jest włączone", "Opcjonalnie"],
      "pt-BR": ["verificação automática de atualizações está ativada", "opcional"],
      th: ["เปิดการตรวจหาอัปเดตอัตโนมัติ", "เลือกเปิด"],
      vi: ["bật kiểm tra cập nhật tự động", "Tùy chọn"],
    };
    for (const [locale, { t }] of Object.entries(locales)) {
      const updateAnswer = t["faq.a10"] || "";
      const trustAnswer = t["faq.a4"] || "";
      const repairAnswer = t["faq.a7"] || "";
      const notificationCopy = t["feat.2.body"] || "";
      const updatePill = t["feat.pill2"] || "";
      const [conditionalPhrase, optionalPhrase] = conditionalUpdatePhrases[locale]!;
      expect(updateAnswer).toContain("GitHub");
      expect(updateAnswer).toContain("Windows");
      expect(updateAnswer).toContain("SmartScreen");
      expect(updateAnswer).toContain(conditionalPhrase);
      expect(repairAnswer).toContain(conditionalPhrase);
      expect(updatePill).toContain(optionalPhrase);
      expect(trustAnswer).toContain("SmartScreen");
      expect(repairAnswer).toContain("https://github.com/kristofferR/Carrier/issues");
      expect(staleQuietHours.some((phrase) => notificationCopy.includes(phrase))).toBe(false);
    }
  });
});
