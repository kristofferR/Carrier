import { join } from "node:path";

if (process.platform !== "darwin") {
  console.log("Carrier Share: skipped on non-macOS target");
  process.exit(0);
}

const repoRoot = join(import.meta.dir, "..", "..");
const targetArch = process.env.TAURI_ENV_ARCH || process.arch;
const arch =
  targetArch === "aarch64" || targetArch === "arm64"
    ? "arm64"
    : targetArch === "x86_64" || targetArch === "x64"
      ? "x86_64"
      : null;
if (!arch) throw new Error(`Unsupported macOS architecture: ${targetArch}`);

const tauriConfig = (await Bun.file(join(repoRoot, "src-tauri", "tauri.conf.json")).json()) as {
  version?: unknown;
};
if (typeof tauriConfig.version !== "string" || !/^\d+\.\d+\.\d+$/.test(tauriConfig.version)) {
  throw new Error("tauri.conf.json must contain a three-part numeric version");
}

const outputDir = join(repoRoot, "src-tauri", "target", "share-extension");
const identity = process.env.APPLE_SIGNING_IDENTITY?.trim();
if (!identity) {
  throw new Error(
    'APPLE_SIGNING_IDENTITY is required for macOS release builds (use "-" for an explicit ad-hoc build)',
  );
}
const result = Bun.spawnSync(
  ["sh", join(import.meta.dir, "build.sh"), outputDir, arch, identity, tauriConfig.version],
  { cwd: repoRoot, stdout: "inherit", stderr: "inherit" },
);
if (result.exitCode !== 0) {
  throw new Error(`Carrier Share build failed with exit code ${result.exitCode ?? "unknown"}`);
}
