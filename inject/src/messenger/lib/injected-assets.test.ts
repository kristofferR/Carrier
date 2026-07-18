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
});
