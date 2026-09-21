import { createHash } from "node:crypto";
import { basename } from "node:path";
import { buildInfo } from "./policy";

const [executable, ...files] = process.argv.slice(2);
if (!executable || !files.length) throw new Error("Usage: manifest.ts executable artifacts...");
const probe = Bun.spawnSync([executable, "--build-info"]);
if (probe.exitCode !== 0) throw new Error("Build identity probe failed");
const build = buildInfo(JSON.parse(probe.stdout.toString()));
if (build.revision !== process.env.CARRIER_BUILD_REVISION)
  throw new Error("Build commit differs from workflow commit");
const hashes: Record<string, string> = {};
for (const path of files) {
  if (basename(path) !== path) throw new Error("Artifact filenames must be basenames");
  hashes[path] = createHash("sha256")
    .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
    .digest("hex");
}
await Bun.write("build.json", JSON.stringify({ ...build, files: hashes }, null, 2));
