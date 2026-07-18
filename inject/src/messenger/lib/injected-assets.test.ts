import { describe, expect, test } from "bun:test";

const repoAsset = (path: string) =>
  Bun.file(new URL(`../../../../${path}`, import.meta.url)).text();

describe("hand-maintained injected assets", () => {
  test("the MCP bridge contains no raw NUL bytes", async () => {
    const source = await repoAsset("src-tauri/inject/mcp-bridge.js");

    expect(source).not.toContain("\0");
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
});
