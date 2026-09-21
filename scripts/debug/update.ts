#!/usr/bin/env bun
// Per-user updater. No releases, package managers, process termination, or GUI automation.
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import {
  type BuildInfo,
  buildInfo,
  debugDraft,
  matchesBuild,
  repo,
  revisionPattern,
} from "./policy";

const mac = process.platform === "darwin";
if (!mac && process.platform !== "linux")
  throw new Error("Personal debug installs support macOS and Linux");
const platform = mac ? "macos" : "linux";
const arch =
  process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : "unsupported";
const home = homedir();
const root = join(
  home,
  mac ? "Library/Application Support/CarrierDebug" : ".local/share/carrier-debug",
);
const builds = join(root, "builds");
const target = mac ? "/Applications/Carrier.app" : join(home, ".local/bin/carrier");
const binary = (path: string) => (mac ? join(path, "Contents/MacOS/carrier") : path);
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const automatic = args.includes("--automatic");
const forceCheck = args.includes("--check");
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const swapFile = join(root, "swap.json");

async function command(argv: string[], allowed = [0]) {
  const p = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  });
  const [out, error, status] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (!allowed.includes(status))
    throw new Error(`${argv[0]} failed (${status}): ${error.trim().slice(0, 400)}`);
  return { out, status };
}
async function api(path: string): Promise<unknown> {
  return JSON.parse((await command(["gh", "api", `repos/${repo}/${path}`])).out);
}
async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}
async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  );
}
async function sha256(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
async function atomicJson(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
async function removeBestEffort(path: string, description: string) {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    console.error(
      `Failed to remove ${description}: ${error instanceof Error ? error.message : error}`,
    );
  }
}
async function running() {
  const { out, status } = await command(
    ["pgrep", "-u", String(userInfo().uid), "-x", "carrier"],
    [0, 1],
  );
  if (status !== 0) return false;
  for (const pid of out.trim().split(/\s+/)) {
    const processArgs = (await command(["ps", "-p", pid, "-o", "args="], [0, 1])).out;
    if (
      processArgs &&
      !processArgs.includes(" --debug-install-lock ") &&
      !processArgs.includes(" --debug-update-lock ")
    )
      return true;
  }
  return false;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid response object");
  return value as Record<string, unknown>;
}
interface SwapTransaction {
  revision: string;
  backup: string;
  hadPrevious: boolean;
}
function swapTransaction(value: unknown): SwapTransaction {
  const transaction = object(value);
  if (
    typeof transaction.revision !== "string" ||
    !revisionPattern.test(transaction.revision) ||
    typeof transaction.backup !== "string" ||
    !new RegExp(`^\\d+-${transaction.revision}$`).test(transaction.backup) ||
    typeof transaction.hadPrevious !== "boolean"
  )
    throw new Error("Invalid interrupted install transaction");
  return {
    revision: transaction.revision,
    backup: transaction.backup,
    hadPrevious: transaction.hadPrevious,
  };
}
async function completedSwap(revision: string) {
  try {
    const installed = object(await json(join(root, "installed.json")));
    if (
      buildInfo(installed).revision !== revision ||
      typeof installed.binarySha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(installed.binarySha256)
    )
      return false;
    const digest = createHash("sha256")
      .update(await readFile(binary(target)))
      .digest("hex");
    return digest === installed.binarySha256;
  } catch {
    return false;
  }
}
async function removeMatchingPending(revision: string) {
  const pending = join(root, "pending.json");
  try {
    if (buildInfo(await json(pending)).revision === revision) await rm(pending, { force: true });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
async function updateLockBinary() {
  const installedPath = join(root, "installed.json");
  let expectedHash: string | null = null;
  if (await exists(installedPath)) {
    const installed = object(await json(installedPath));
    buildInfo(installed);
    if (
      typeof installed.binarySha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(installed.binarySha256)
    )
      throw new Error("Invalid installed Carrier identity");
    expectedHash = installed.binarySha256;
  }

  const candidates = [binary(target)];
  const backupRoot = join(root, "backups");
  if (await exists(backupRoot)) {
    for (const entry of await readdir(backupRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(backupRoot, entry.name);
      candidates.push(
        binary(join(directory, mac ? "Carrier.app" : "carrier")),
        binary(join(directory, mac ? "interrupted-new.app" : "interrupted-new")),
      );
    }
  }
  if (expectedHash) {
    for (const candidate of candidates) {
      try {
        if ((await sha256(candidate)) === expectedHash) return candidate;
      } catch {}
    }
    throw new Error(
      "Installed Carrier was replaced outside the debug updater. Refusing to execute it; restore the verified debug backup.",
    );
  }

  // A first install has no installed.json yet. Its already-verified extracted
  // binary is still available even if the canonical path is between renames.
  if (await exists(builds)) {
    for (const entry of await readdir(builds, { withFileTypes: true })) {
      if (!entry.isDirectory() || !revisionPattern.test(entry.name)) continue;
      const candidate = binary(
        join(builds, entry.name, "extracted", mac ? "Carrier.app" : "carrier"),
      );
      try {
        const identity = object(await json(join(builds, entry.name, "extracted.json")));
        if (
          identity.revision === entry.name &&
          typeof identity.binarySha256 === "string" &&
          /^[0-9a-f]{64}$/.test(identity.binarySha256) &&
          (await sha256(candidate)) === identity.binarySha256
        )
          return candidate;
      } catch {}
    }
  }
  return null;
}
async function recoverInterruptedSwap() {
  if (!(await exists(swapFile))) return true;
  const transaction = swapTransaction(await json(swapFile));
  if (await completedSwap(transaction.revision)) {
    await removeMatchingPending(transaction.revision);
    await rm(swapFile, { force: true });
    return true;
  }
  if (await running()) {
    log("Carrier is running; interrupted install recovery deferred.");
    return false;
  }
  const backup = join(root, "backups", transaction.backup);
  const previous = join(backup, mac ? "Carrier.app" : "carrier");
  const discarded = join(backup, mac ? "interrupted-new.app" : "interrupted-new");
  const previousExists = await exists(previous);
  if (transaction.hadPrevious && !previousExists && !(await exists(target))) {
    throw new Error("Interrupted install has neither the current app nor its rollback copy");
  }
  if (previousExists) {
    if (await exists(target)) {
      await removeBestEffort(discarded, "interrupted replacement");
      await rename(target, discarded);
      if (await running()) {
        await rename(discarded, target);
        log("Carrier launched during interrupted install recovery; recovery deferred.");
        return false;
      }
    }
    await rename(previous, target);
  } else if (!transaction.hadPrevious && (await exists(target))) {
    await rename(target, discarded);
    if (await running()) {
      await rename(discarded, target);
      log("Carrier launched during interrupted install recovery; recovery deferred.");
      return false;
    }
  }
  await removeBestEffort(backup, "interrupted install directory");
  await rm(swapFile, { force: true });
  log("Recovered the previous Carrier installation after an interrupted swap.");
  return true;
}
async function manifest(dir: string, revision: string) {
  await verifyProvenance(dir, revision);
  const raw = object(await json(join(dir, "build.json")));
  const info = buildInfo(raw);
  if (info.revision !== revision || info.platform !== platform || info.arch !== arch)
    throw new Error("Wrong commit or platform");
  const files = object(raw.files);
  const expected = mac
    ? ["Carrier-debug-macos.zip", "Carrier-debug-symbols.zip", "update.ts", "policy.ts"]
    : ["Carrier-debug-linux.tar.gz", "update.ts", "policy.ts"];
  for (const name of expected) {
    if (typeof files[name] !== "string" || !/^[0-9a-f]{64}$/.test(files[name]))
      throw new Error(`Missing checksum for ${name}`);
    const hash = createHash("sha256")
      .update(await readFile(join(dir, name)))
      .digest("hex");
    if (hash !== files[name]) throw new Error(`Checksum mismatch: ${name}`);
  }
  return info;
}
async function verifyProvenance(dir: string, revision: string) {
  const names = mac ? ["build.json"] : ["build.json", "Carrier-debug-linux.tar.gz"];
  for (const name of names) {
    await command([
      "gh",
      "attestation",
      "verify",
      join(dir, name),
      "--repo",
      repo,
      "--signer-workflow",
      `${repo}/.github/workflows/debug.yml`,
      "--source-digest",
      revision,
    ]);
  }
}
async function verify(path: string, info: BuildInfo, symbols?: string) {
  if (mac) {
    await command(["codesign", "--verify", "--deep", "--strict", path]);
    const p = Bun.spawn(["codesign", "-d", "--verbose=4", path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const detail = await new Response(p.stderr).text();
    if (
      (await p.exited) !== 0 ||
      !detail.includes("TeamIdentifier=S5Q742QZEL") ||
      !detail.includes("Identifier=io.github.kristofferr.carrier\n")
    )
      throw new Error("Wrong signing identity");
    await command(["spctl", "--assess", "--type", "execute", path]);
    await command(["xcrun", "stapler", "validate", path]);
    if (symbols) {
      const uuids = (text: string) =>
        [...text.matchAll(/UUID: ([A-F0-9-]+)/g)]
          .map((m) => m[1])
          .sort()
          .join(",");
      const appUUID = uuids((await command(["xcrun", "dwarfdump", "--uuid", binary(path)])).out);
      const symbolUUID = uuids((await command(["xcrun", "dwarfdump", "--uuid", symbols])).out);
      if (!appUUID || appUUID !== symbolUUID) throw new Error("Debug symbols do not match app");
    }
  } else {
    const sections = (await command(["readelf", "-S", path])).out;
    if (!sections.includes(".debug_info") || !sections.includes(".debug_line"))
      throw new Error("Debug symbols missing");
  }
  matchesBuild(JSON.parse((await command([binary(path), "--build-info"])).out), info);
}
async function extract(dir: string, info: BuildInfo) {
  const extracted = join(dir, "extracted");
  // Always reconstruct from the checksum-verified archives, including after a failed apply.
  await rm(extracted, { recursive: true, force: true });
  await mkdir(extracted);
  if (mac) {
    await command(["ditto", "-x", "-k", join(dir, "Carrier-debug-macos.zip"), extracted]);
    await command(["ditto", "-x", "-k", join(dir, "Carrier-debug-symbols.zip"), extracted]);
    const symbols = (await readdir(extracted)).filter((name) => name.endsWith(".dSYM"));
    if (symbols.length !== 1) throw new Error("Expected one matching symbol bundle");
    await verify(join(extracted, "Carrier.app"), info, join(extracted, symbols[0]!));
  } else {
    await command(["tar", "-xzf", join(dir, "Carrier-debug-linux.tar.gz"), "-C", extracted]);
    await chmod(join(extracted, "carrier"), 0o755);
    await verify(join(extracted, "carrier"), info);
  }
  const source = join(extracted, mac ? "Carrier.app" : "carrier");
  await atomicJson(join(dir, "extracted.json"), {
    revision: info.revision,
    binarySha256: await sha256(binary(source)),
  });
  return source;
}
async function install(dir: string, info: BuildInfo) {
  if (await running()) {
    log("Carrier is running; verified debug update remains staged.");
    return;
  }
  const source = apply
    ? join(dir, "extracted", mac ? "Carrier.app" : "carrier")
    : await extract(dir, info);
  if (!apply) {
    // The incoming binary supplies the same lock even for the first migration.
    const result = await command(
      [
        binary(source),
        "--debug-install-lock",
        process.execPath,
        import.meta.path,
        "--apply",
        info.revision,
      ],
      [0, 75],
    );
    if (result.out.trim()) console.log(result.out.trim());
    if (result.status === 75) log("Carrier launched during preparation; update deferred.");
    return;
  }
  if (await running()) {
    log("Carrier launched; update deferred.");
    return;
  }
  await verify(source, info);
  await mkdir(dirname(target), { recursive: true });
  const staged = mac
    ? `/Applications/.Carrier-debug-${randomUUID()}.app`
    : `${target}.${randomUUID()}.tmp`;
  if (mac) await command(["ditto", source, staged]);
  else {
    await copyFile(source, staged);
    await chmod(staged, 0o755);
  }
  await verify(staged, info);
  const backupName = `${Date.now()}-${info.revision}`;
  const previous = join(root, "backups", backupName, mac ? "Carrier.app" : "carrier");
  const backup = dirname(previous);
  await mkdir(backup, { recursive: true });
  const hadPrevious = await exists(target);
  await atomicJson(swapFile, { revision: info.revision, backup: backupName, hadPrevious });
  if (hadPrevious) await rename(target, previous);
  if (hadPrevious && (await running())) {
    await rename(previous, target);
    await removeBestEffort(staged, "staged install");
    await removeBestEffort(backup, "rollback directory");
    await removeBestEffort(swapFile, "install transaction");
    log("Carrier launched during preparation; update deferred.");
    return;
  }
  try {
    await rename(staged, target);
    await verify(target, info);
  } catch (error) {
    if (await exists(target)) await rename(target, staged);
    if (hadPrevious) await rename(previous, target);
    await removeBestEffort(staged, "staged install");
    await removeBestEffort(backup, "rollback directory");
    await removeBestEffort(swapFile, "install transaction");
    throw error;
  }
  try {
    await writeFile(
      join(root, "debug-only"),
      "Only diagnostics debug builds. Managed by carrier-debug-update.\n",
      { mode: 0o600 },
    );
    const nextUpdater = join(root, `updater-${randomUUID()}`);
    await symlink(dir, nextUpdater);
    await rename(nextUpdater, join(root, "updater"));
    const binarySha256 = createHash("sha256")
      .update(await readFile(binary(target)))
      .digest("hex");
    if (mac) {
      await mkdir(join(root, "symbols"), { recursive: true });
      await copyFile(
        join(dir, "Carrier-debug-symbols.zip"),
        join(root, "symbols", `${info.revision}.zip`),
      );
      await copyFile(join(dir, "build.json"), join(root, "symbols", `${info.revision}.json`));
    }
    await atomicJson(join(root, "installed.json"), {
      binarySha256,
      ...info,
      installedAt: new Date().toISOString(),
      previous,
    });
  } catch (error) {
    await rename(target, staged);
    if (hadPrevious) await rename(previous, target);
    await removeBestEffort(staged, "staged install");
    await removeBestEffort(backup, "rollback directory");
    await removeBestEffort(swapFile, "install transaction");
    throw error;
  }
  await rm(swapFile, { force: true });
  await rm(join(root, "pending.json"), { force: true });
  await prune(info.revision);
  log(
    `Installed Carrier ${info.version} debug ${info.revision.slice(0, 12)}. Previous app and symbols retained.`,
  );
}
async function prune(current: string) {
  // Bound large binaries to the latest three builds and two rollback apps.
  // macOS symbol ZIPs for installed builds are small enough to retain separately.
  const entries = (await readdir(builds, { withFileTypes: true })).filter(
    (e) => e.isDirectory() && revisionPattern.test(e.name),
  );
  const dated = await Promise.all(
    entries.map(async (e) => ({
      path: join(builds, e.name),
      name: e.name,
      date: (await stat(join(builds, e.name))).mtimeMs,
    })),
  );
  dated.sort((a, b) => b.date - a.date);
  for (const old of dated.filter((e) => e.name !== current).slice(2)) {
    await rm(old.path, { recursive: true, force: true });
  }
  const backupRoot = join(root, "backups");
  const backups = (await readdir(backupRoot))
    .filter((name) => /^\d+-[0-9a-f]{40}$/.test(name))
    .sort()
    .reverse();
  for (const name of backups.slice(2))
    await rm(join(backupRoot, name), { recursive: true, force: true });
}
async function update() {
  await mkdir(builds, { recursive: true, mode: 0o700 });
  if (apply) {
    if (process.env.CARRIER_DEBUG_LOCK_OWNER !== String(process.ppid)) {
      throw new Error("Installation must run under Carrier's native install lock");
    }
    const revision = args[args.indexOf("--apply") + 1];
    if (!revision || !revisionPattern.test(revision)) throw new Error("Invalid staged revision");
    const dir = join(builds, revision);
    await install(dir, await manifest(dir, revision));
    return;
  }
  const installedPath = join(root, "installed.json");
  let installed = (await exists(installedPath)) ? buildInfo(await json(installedPath)) : null;
  let drafts: Array<NonNullable<ReturnType<typeof debugDraft>>> | null = null;
  const loadDrafts = async () => {
    if (drafts) return drafts;
    const releases = await api("releases?per_page=100");
    if (!Array.isArray(releases)) throw new Error("Invalid release list");
    drafts = releases.map(debugDraft).filter((candidate) => candidate !== null);
    return drafts;
  };
  const eligible = async (
    candidate: NonNullable<ReturnType<typeof debugDraft>>,
    current: BuildInfo | null,
  ) => {
    if (current && current.revision !== candidate.revision) {
      const comparison = object(await api(`compare/${current.revision}...${candidate.revision}`));
      if (comparison.status !== "ahead") return null;
    }
    const ancestry = object(await api(`compare/${candidate.revision}...main`));
    if (!new Set(["ahead", "identical"]).has(String(ancestry.status))) return null;
    if (typeof ancestry.ahead_by !== "number") throw new Error("Invalid comparison response");
    const ci = object(
      await api(
        `actions/workflows/ci.yml/runs?head_sha=${candidate.revision}&branch=main&event=push&status=success&per_page=1`,
      ),
    );
    return Array.isArray(ci.workflow_runs) && ci.workflow_runs.length ? ancestry.ahead_by : null;
  };
  const pending = join(root, "pending.json");
  if (await exists(pending)) {
    const info = buildInfo(await json(pending));
    if (installed?.revision === info.revision) {
      await rm(pending, { force: true });
    } else {
      const candidate = (await loadDrafts()).find(
        (draft) =>
          draft.revision === info.revision &&
          draft.tag === `debug-v${info.version}-${info.revision.slice(0, 12)}`,
      );
      if (!candidate || (await eligible(candidate, installed)) === null) {
        await rm(pending, { force: true });
        log("Pending debug build is no longer eligible; current install preserved.");
      } else {
        await install(
          join(builds, info.revision),
          await manifest(join(builds, info.revision), info.revision),
        );
        installed = (await exists(installedPath)) ? buildInfo(await json(installedPath)) : null;
      }
    }
  }
  const checkFile = join(root, "last-check");
  if (
    automatic &&
    !forceCheck &&
    (await exists(checkFile)) &&
    Date.now() - (await stat(checkFile)).mtimeMs < 60 * 60 * 1000
  )
    return;
  const availableDrafts = await loadDrafts();
  if (!availableDrafts.length) {
    log("No complete personal debug draft yet; current install preserved.");
    return;
  }
  const onMain: Array<(typeof availableDrafts)[number] & { distance: number }> = [];
  for (const candidate of availableDrafts) {
    const distance = await eligible(candidate, installed);
    if (distance !== null) onMain.push({ ...candidate, distance });
  }
  onMain.sort((a, b) => a.distance - b.distance);
  const draft = onMain[0] ?? null;
  if (!draft) {
    log("No newer debug build with successful CI is ready; current install preserved.");
    return;
  }
  const { revision, tag } = draft;
  if (installed?.revision === revision) {
    await writeFile(checkFile, revision);
    return;
  }
  const dir = join(builds, revision);
  if (!(await exists(dir))) {
    const temporary = await mkdtemp(join(builds, ".download-"));
    try {
      const manifestName = `build-${platform}-${arch}.json`;
      const assets = mac
        ? ["Carrier-debug-macos.zip", "Carrier-debug-symbols.zip"]
        : ["Carrier-debug-linux.tar.gz"];
      await command([
        "gh",
        "release",
        "download",
        tag,
        "--repo",
        repo,
        "--dir",
        temporary,
        ...[...assets, manifestName, "update.ts", "policy.ts"].flatMap((name) => [
          "--pattern",
          name,
        ]),
      ]);
      await rename(join(temporary, manifestName), join(temporary, "build.json"));
      await manifest(temporary, revision);
      await rename(temporary, dir);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  const info = await manifest(dir, revision);
  await extract(dir, info);
  await atomicJson(pending, info);
  await writeFile(checkFile, revision);
  log(`Verified and staged Carrier ${info.version} debug ${revision.slice(0, 12)}.`);
  await install(dir, info);
}

// The installed diagnostic binary provides an OS-owned scheduler lock. It is
// released on crashes too. Bootstrap is a single manual run before enrollment.
try {
  if (!apply && !args.includes("--locked")) {
    const lockBinary = await updateLockBinary();
    if (!lockBinary) {
      if (await exists(swapFile))
        throw new Error("Interrupted install recovery has no verified Carrier lock binary");
      await update();
    } else {
      const result = await command(
        [
          lockBinary,
          "--debug-update-lock",
          process.execPath,
          import.meta.path,
          ...args,
          "--locked",
        ],
        [0, 75],
      );
      if (result.out.trim()) console.log(result.out.trim());
    }
  } else {
    const recoveryReady = apply || (await recoverInterruptedSwap());
    if (!recoveryReady) {
      // Leave both the journal and rollback copy for the next scheduled run.
    } else {
      await update();
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
