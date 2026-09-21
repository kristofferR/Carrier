#!/usr/bin/env bun
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
// Run after the first verified debug installation. Never changes package-manager state.
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { buildInfo, matchesBuild } from "./policy";

const mac = process.platform === "darwin";
if (!mac && process.platform !== "linux") throw new Error("Unsupported platform");
const home = homedir();
const root = join(
  home,
  mac ? "Library/Application Support/CarrierDebug" : ".local/share/carrier-debug",
);
const binary = mac
  ? "/Applications/Carrier.app/Contents/MacOS/carrier"
  : join(home, ".local/bin/carrier");
const installed = buildInfo(JSON.parse(await readFile(join(root, "installed.json"), "utf8")));
const probe = Bun.spawnSync([binary, "--build-info"]);
if (probe.exitCode !== 0) throw new Error("Installed debug probe failed");
matchesBuild(JSON.parse(probe.stdout.toString()), installed);
const account = Bun.spawnSync(["gh", "api", "user", "--jq", ".login"], {
  env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  stderr: "pipe",
});
if (account.exitCode !== 0 || account.stdout.toString().trim().toLowerCase() !== "kristofferr") {
  throw new Error(
    "Restore the kristofferR GitHub CLI login before enrolling: gh auth login --hostname github.com --web",
  );
}

if (
  mac &&
  Bun.spawnSync(["brew", "list", "--cask", "carrier"], { stderr: "ignore" }).exitCode === 0
)
  throw new Error("Remove the Homebrew Carrier cask before enrolling");
if (!mac && Bun.spawnSync(["pacman", "-Q", "carrier"], { stderr: "ignore" }).exitCode === 0)
  throw new Error("Remove the AUR carrier package before enrolling");
if (process.argv.includes("--hold-failures")) {
  const active = Bun.spawnSync(["pgrep", "-u", String(userInfo().uid), "-x", "carrier"]);
  if (active.exitCode !== 1) throw new Error("Quit Carrier before enrolling with --hold-failures");
  const config = mac
    ? join(home, "Library/Application Support")
    : process.env.XDG_CONFIG_HOME || join(home, ".config");
  const file = join(config, "io.github.kristofferr.carrier/settings.json");
  const original = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    // Rust's serde defaults fill in missing preferences on a fresh install.
    if (error.code === "ENOENT") return "{}";
    throw error;
  });
  await mkdir(dirname(file), { recursive: true });
  const settings: unknown = JSON.parse(original);
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error("Invalid Carrier settings");
  await writeFile(join(root, "settings-before-enrollment.json"), original, {
    mode: 0o600,
    flag: "wx",
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await writeFile(
    `${file}.debug-install.tmp`,
    JSON.stringify({ ...settings, hold_failures: true, automatic_update_checks: false }, null, 2),
    { mode: 0o600 },
  );
  await rename(`${file}.debug-install.tmp`, file);
}
await mkdir(join(home, ".local/bin"), { recursive: true });
const wrapper = join(home, ".local/bin/carrier-debug-update");
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const path = [
  join(home, ".local/bin"),
  join(home, ".bun/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
].join(":");
await writeFile(
  wrapper,
  `#!/bin/sh\nexport PATH=${quote(path)}\nexec ${quote(process.execPath)} ${quote(join(root, "updater/update.ts"))} "$@"\n`,
);
await chmod(wrapper, 0o755);
async function run(argv: string[], accepted = [0]) {
  const p = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" });
  if (!accepted.includes(await p.exited)) throw new Error(`${argv[0]} failed`);
}
if (mac) {
  const xml = (s: string) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const agents = join(home, "Library/LaunchAgents");
  await mkdir(agents, { recursive: true });
  const plist = join(agents, "io.github.kristofferr.carrier.debug-update.plist");
  await writeFile(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>io.github.kristofferr.carrier.debug-update</string>
<key>ProgramArguments</key><array><string>${xml(wrapper)}</string><string>--automatic</string></array>
<key>StartInterval</key><integer>300</integer><key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${xml(join(root, "updater.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(root, "updater.log"))}</string>
</dict></plist>\n`,
  );
  await run(["plutil", "-lint", plist]);
  await run(
    ["launchctl", "bootout", `gui/${userInfo().uid}/io.github.kristofferr.carrier.debug-update`],
    [0, 3, 113],
  );
  await run(["launchctl", "bootstrap", `gui/${userInfo().uid}`, plist]);
} else {
  const data = process.env.XDG_DATA_HOME || join(home, ".local/share");
  const applications = join(data, "applications");
  const icons = join(data, "icons/hicolor/128x128/apps");
  await mkdir(applications, { recursive: true });
  await mkdir(icons, { recursive: true });
  await copyFile(
    join(import.meta.dir, "../../src-tauri/icons/128x128.png"),
    join(icons, "io.github.kristofferr.carrier.png"),
  );
  const desktopQuote = (s: string) =>
    `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("`", "\\`").replaceAll("$", "\\$")}"`;
  await writeFile(
    join(applications, "carrier.desktop"),
    `[Desktop Entry]\nCategories=Network;InstantMessaging;\nComment=Distraction-free Messenger desktop client\nExec=${desktopQuote(binary)}\nStartupWMClass=carrier\nIcon=io.github.kristofferr.carrier\nName=Carrier\nTerminal=false\nType=Application\nActions=new-conversation;settings;\n\n[Desktop Action new-conversation]\nName=New Conversation\nExec=${desktopQuote(binary)} --new-conversation\n\n[Desktop Action settings]\nName=Settings\nExec=${desktopQuote(binary)} --settings\n`,
  );
  const units = join(home, ".config/systemd/user");
  await mkdir(units, { recursive: true });
  const systemdQuote = (s: string) =>
    `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
  await writeFile(
    join(units, "carrier-debug-update.service"),
    `[Unit]\nDescription=Stage verified Carrier debug builds and install while quit\n[Service]\nType=oneshot\nExecStart=${systemdQuote(wrapper)} --automatic\nTimeoutStartSec=15min\n`,
  );
  await writeFile(
    join(units, "carrier-debug-update.timer"),
    "[Unit]\nDescription=Keep Carrier on debug builds from main\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=5min\n[Install]\nWantedBy=timers.target\n",
  );
  await run(["systemctl", "--user", "daemon-reload"]);
  await run(["systemctl", "--user", "enable", "--now", "carrier-debug-update.timer"]);
}
console.log(
  "Enrolled: hourly checks for debug drafts; install every five minutes while quit. No automatic restart.",
);
