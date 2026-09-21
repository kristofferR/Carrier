# Personal debug installations

Kris's MacBook and Omarchy run diagnostics builds of Carrier from `main`. They do
not use Homebrew, AUR, Snap, or the public-release updater. This policy follows
commits, including new commits with the same app version; it never pins a version.
Public releases and their package-manager distribution are unchanged.

## Build and update path

`.github/workflows/debug.yml` builds both personal platforms before every public release build:

- Linux x86_64: native executable with embedded debug symbols.
- macOS arm64: Developer ID signed, notarized app and matching dSYM archive.

Both use `--debug --features diagnostics`. This feature includes authenticated
local MCP inspection and DevTools; enabling it in a release profile fails to
compile. `--build-info` reports compiled capabilities, version, platform, and the
exact source commit without starting the GUI or contacting the running instance.

After both builds succeed, CI attaches them and their symbols to a separate
**draft prerelease** named `debug-v<VERSION>-<COMMIT>`. These drafts stay private
to authenticated repository access and are never published. The public release
workflow cannot start its platform builds until this draft is complete. A manual
`debug.yml` run builds an unreleased main commit without starting public builds.

The personal updater downloads only completed debug drafts whose source commit
also passed main CI and remains on main. It verifies artifact SHA-256
checksums, the executable's compiled identity, and debug symbols. macOS also
requires the expected signing identity, Gatekeeper acceptance, a stapled ticket,
and matching app/dSYM UUIDs. Missing, incomplete, failed, divergent, or downgraded
builds leave the current installation in place. It never falls back to a release.

Checks for new debug drafts run hourly. Every five minutes the scheduler tries to install a staged
build if Carrier is **quit**, including its tray process. It never terminates,
reloads, restarts, or focuses Carrier. Native shared/exclusive file locks protect
against launching during installation and concurrent updater runs. The next
normal launch uses the new debug build.

- macOS app: `/Applications/Carrier.app`
- Linux app: `~/.local/bin/carrier` (both desktop and autostart entries use it)
- Check now: `~/.local/bin/carrier-debug-update --check`
- macOS scheduler: `io.github.kristofferr.carrier.debug-update` LaunchAgent
- Linux scheduler: `carrier-debug-update.timer` user unit

Authenticated `gh`, Bun, and platform verification tools must remain available.
The updater uses the existing GitHub login; it stores no tokens. Updates download
through authenticated GitHub draft assets, which do not expire like Actions
artifacts. Draft tags use `debug-v*`, so they cannot trigger the public `v*` flow.

## First installation / migration

1. Build/push the implementation, let its main CI succeed, then manually run `debug.yml` for that main commit.
   Future public releases trigger the debug draft automatically.
2. Preserve existing app data and the current debug app. On Linux copy Carrier's
   launcher icons to the user's icon directory before removing the AUR package.
   Remove only the Carrier package/cask, never dependencies or app data. Do not
   run `brew uninstall --zap`.
3. Quit Carrier when the live state no longer needs preservation. Run
   `bun scripts/debug/update.ts --check` from the repo. It verifies and installs
   the latest eligible debug draft, keeping the previous application.
4. Run `bun scripts/debug/enroll.ts --hold-failures`. Enrollment refuses an AUR/Homebrew-owned
   Carrier install, verifies the installed debug identity, and installs the user
   scheduler and command. The helper advances with each verified app build.
5. Launch normally. Enrollment enables **Settings → Advanced → Hold Failures
   for Investigation** with `--hold-failures`; the setting persists across builds.

The `debug-only` marker in the management directory makes future Carrier builds
without full diagnostics refuse to start on these machines. Debug builds reject
public-release discovery and installation in the backend, including direct IPC.
Removing package-manager ownership prevents routine package upgrades from
replacing the app. If the installed executable is removed or changed outside the
updater, updates stop for manual repair; an intentional uninstall is never silently
reversed. Deliberately installing an old release that predates this
policy can bypass its startup guard, so do not re-enroll these machines in a
release package manager.

## Diagnostics and failure preservation

Normal Dock/menu/login launches enable native stdout/stderr capture, full Rust
panic backtraces, MCP, DevTools, and existing webview instrumentation. No special
launch command or environment is required. Native output rotates at 20 MiB with
one previous file per session; the latest five completed sessions and all live sessions are retained.
Carrier's existing bounded application log remains available in **Open Log
Folder**. Native output may contain third-party diagnostics; keep it private.

**Hold Failures** pauses both native watchdog recovery and injected automatic
reloads, while heartbeats and diagnostics continue. Manual reload and navigation
remain available. Before automatic recovery (when enabled), Carrier records
native watchdog state and requests a content-free page snapshot with DOM counts,
visibility, document age, and transport health. Unresponsive renderers cannot
supply a page snapshot; the native evidence is still recorded. No message text,
contact names, draft contents, or raw DOM are captured by this snapshot.

Management data lives under `~/Library/Application Support/CarrierDebug` on Mac
and `~/.local/share/carrier-debug` on Linux:

- `installed.json`: active source commit and previous app path.
- `pending.json`: a verified update waiting for Carrier to quit.
- `builds/`: latest three downloaded builds with manifests and symbols.
- `backups/`: latest two replaced apps for manual rollback.
- `symbols/`: macOS dSYM ZIP and manifest for every installed managed build.
- `debug-only`: persistent local installation policy.

Linux retains symbols inside each stored executable. Copy an investigation's
binary/logs out of the rolling cache when preserving evidence long term. macOS
symbol archives are retained separately even after old app bundles are pruned.
For rollback, stop the updater scheduler, quit Carrier, restore the desired
backup, and retain its matching manifest/symbols. Automatic downgrade is rejected.
