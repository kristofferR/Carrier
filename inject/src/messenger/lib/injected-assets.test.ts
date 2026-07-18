import { describe, expect, test } from "bun:test";

const repoAsset = (path: string) =>
  Bun.file(new URL(`../../../../${path}`, import.meta.url)).text();

describe("hand-maintained injected assets", () => {
  test("the MCP bridge contains no raw NUL bytes", async () => {
    const source = await repoAsset("src-tauri/inject/mcp-bridge.js");

    expect(source).not.toContain("\0");
  });

  test("release capabilities cannot listen for app events", async () => {
    const release = await repoAsset("src-tauri/capabilities/default.json");
    const development = await repoAsset("src-tauri/dev-capabilities/mcp.json");

    expect(release).not.toContain("core:event:allow-listen");
    expect(development).toContain("core:event:allow-listen");
  });
});
