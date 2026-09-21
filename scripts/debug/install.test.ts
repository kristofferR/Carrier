import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInfo } from "./policy";

// Uses a real compiled diagnostics binary, isolated HOME, and fake GitHub/process
// discovery. Exercises the real archives, hashes, native locks, and file swaps.
const executable = process.env.CARRIER_TEST_BINARY;
test.skipIf(!executable || process.platform !== "linux")(
  "debug installer stages while running, rolls back failed replacement, and rejects tampering",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "carrier-debug-install-test-"));
    try {
      const home = join(directory, "home");
      const commands = join(directory, "commands");
      const artifacts = join(directory, "artifacts");
      await Promise.all(
        [home, commands, artifacts].map((path) => mkdir(path, { recursive: true })),
      );
      const probe = Bun.spawnSync([executable!, "--build-info"]);
      expect(probe.exitCode).toBe(0);
      const info = buildInfo(JSON.parse(probe.stdout.toString()));
      const tar = Bun.spawnSync([
        "tar",
        "-czf",
        join(artifacts, "Carrier-debug-linux.tar.gz"),
        "-C",
        join(executable!, ".."),
        "carrier",
      ]);
      expect(tar.exitCode).toBe(0);
      for (const file of ["update.ts", "policy.ts"])
        await copyFile(join(import.meta.dir, file), join(artifacts, file));
      const hashes: Record<string, string> = {};
      for (const file of await readdir(artifacts))
        hashes[file] = createHash("sha256")
          .update(await readFile(join(artifacts, file)))
          .digest("hex");
      await writeFile(join(artifacts, "build.json"), JSON.stringify({ ...info, files: hashes }));
      const olderRevision = "0".repeat(40);
      const attestationLog = join(directory, "attestations");
      const stub = `#!${process.execPath}
import { appendFile, copyFile, readdir } from "node:fs/promises";
import { join } from "node:path";
const a = process.argv.slice(2);
if (a[0] === "api") {
  const path = a[1];
  let response;
  if (path.includes("releases?")) response = [
    {draft:true,tag_name:"debug-v${info.version}-${olderRevision.slice(0, 12)}",body:"Carrier debug ready\\nCommit: ${olderRevision}"},
    {draft:true,tag_name:"debug-v${info.version}-${info.revision.slice(0, 12)}",body:"Carrier debug ready\\nCommit: ${info.revision}"},
  ];
  else if (path.endsWith("compare/${olderRevision}...main")) response = {status:"ahead",ahead_by:2};
  else if (path.endsWith("compare/${info.revision}...main")) response = {status:"ahead",ahead_by:1};
  else if (path.endsWith("compare/${info.revision}...${olderRevision}")) response = {status:"behind"};
  else if (path.includes("compare/")) response = {status:"ahead",ahead_by:1};
  else response = {workflow_runs:[{id:1,head_sha:${JSON.stringify(info.revision)}}]};
  console.log(JSON.stringify(response));
} else if (a[0] === "attestation" && a[1] === "verify") {
  await appendFile(${JSON.stringify(attestationLog)}, a.slice(2).join("\\t") + "\\n");
} else {
  const dir = a[a.indexOf("--dir")+1];
  for (const name of await readdir(${JSON.stringify(artifacts)})) await copyFile(join(${JSON.stringify(artifacts)},name),join(dir,name === "build.json" ? "build-linux-x86_64.json" : name));
}
`;
      await writeFile(join(commands, "gh"), stub);
      await chmod(join(commands, "gh"), 0o755);
      const running = async (active: boolean) => {
        await writeFile(join(commands, "pgrep"), `#!/bin/sh\n${active ? "echo 1" : "exit 1"}\n`);
        await chmod(join(commands, "pgrep"), 0o755);
      };
      const root = join(home, ".local/share/carrier-debug");
      const target = join(home, ".local/bin/carrier");
      const env = { ...process.env, HOME: home, PATH: `${commands}:${process.env.PATH}` };
      const run = async () => {
        const p = Bun.spawn([process.execPath, join(import.meta.dir, "update.ts"), "--check"], {
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, error, code] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
          p.exited,
        ]);
        return { code, output: `${out}\n${error}` };
      };
      await running(true);
      const staged = await run();
      expect(staged.code, staged.output).toBe(0);
      expect(await Bun.file(join(root, "pending.json")).exists()).toBe(true);
      expect(await Bun.file(target).exists()).toBe(false);
      const attestations = await readFile(attestationLog, "utf8");
      expect(attestations).toContain("Carrier-debug-linux.tar.gz");
      expect(attestations).toContain("build.json");
      expect(attestations).toContain(`--source-digest\t${info.revision}`);
      expect(attestations).toContain(
        "--signer-workflow\tkristofferR/Carrier/.github/workflows/debug.yml",
      );
      // Final verification fails after swapping. The original file must return.
      await running(false);
      await mkdir(join(home, ".local/bin"), { recursive: true });
      await writeFile(target, "previous-install");
      const readelf = Bun.which("readelf")!;
      await writeFile(
        join(commands, "readelf"),
        `#!/bin/sh\nif [ "$2" = '${target}' ]; then exit 1; fi\nexec '${readelf}' "$@"\n`,
      );
      await chmod(join(commands, "readelf"), 0o755);
      const failed = await run();
      expect(failed.code).toBe(1);
      expect(await readFile(target, "utf8")).toBe("previous-install");
      expect(await Bun.file(join(root, "installed.json")).exists()).toBe(false);
      expect(await readdir(join(root, "backups"))).toEqual([]);
      expect(
        (await readdir(join(home, ".local/bin"))).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
      await rm(join(commands, "readelf"));
      const installed = await run();
      expect(installed.code, installed.output).toBe(0);
      expect(buildInfo(await Bun.file(join(root, "installed.json")).json())).toEqual(info);
      const repeated = await run();
      expect(repeated.code, repeated.output).toBe(0);
      // A release/manual overwrite must never be executed even for its CLI probe.
      await rm(target);
      await writeFile(target, `#!/bin/sh\ntouch '${join(home, "unexpected-execution")}'\n`);
      await chmod(target, 0o755);
      const tampered = await run();
      expect(tampered.code).toBe(1);
      expect(tampered.output).toContain("replaced outside the debug updater");
      expect(await Bun.file(join(home, "unexpected-execution")).exists()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  180_000,
);
