export const repo = "kristofferR/Carrier";
export const revisionPattern = /^[0-9a-f]{40}$/;
export interface BuildInfo {
  version: string;
  revision: string;
  debug: true;
  diagnostics: true;
  mcp: true;
  platform: "linux" | "macos";
  arch: "x86_64" | "aarch64";
}
export function buildInfo(value: unknown): BuildInfo {
  if (
    !value ||
    typeof value !== "object" ||
    !("debug" in value) ||
    value.debug !== true ||
    !("diagnostics" in value) ||
    value.diagnostics !== true ||
    !("mcp" in value) ||
    value.mcp !== true ||
    !("revision" in value) ||
    typeof value.revision !== "string" ||
    !revisionPattern.test(value.revision) ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(value.version) ||
    !("platform" in value) ||
    (value.platform !== "linux" && value.platform !== "macos") ||
    !("arch" in value) ||
    (value.arch !== "x86_64" && value.arch !== "aarch64")
  ) {
    throw new Error("Refusing a build without verified debug, MCP, DevTools, and commit identity");
  }
  return {
    version: value.version,
    revision: value.revision,
    debug: true,
    diagnostics: true,
    mcp: true,
    platform: value.platform,
    arch: value.arch,
  };
}
export function matchesBuild(actual: unknown, expected: BuildInfo) {
  const info = buildInfo(actual);
  if (
    Object.keys(expected).some(
      (key) => info[key as keyof BuildInfo] !== expected[key as keyof BuildInfo],
    )
  ) {
    throw new Error("Executable identity does not match the requested debug build");
  }
}

export function debugDraft(value: unknown): { tag: string; revision: string } | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("draft" in value) ||
    value.draft !== true ||
    !("tag_name" in value) ||
    typeof value.tag_name !== "string" ||
    !("body" in value) ||
    typeof value.body !== "string"
  )
    return null;
  const tag = /^debug-v\d+\.\d+\.\d+-([0-9a-f]{12})$/.exec(value.tag_name);
  const body = /^Carrier debug ready\nCommit: ([0-9a-f]{40})$/.exec(value.body);
  if (!tag || !body || !body[1]!.startsWith(tag[1]!)) return null;
  return { tag: value.tag_name, revision: body[1]! };
}
