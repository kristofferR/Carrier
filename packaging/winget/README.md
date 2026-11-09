# winget

Package `kristofferR.Chatpane` ("Chatpane for Messenger", moniker `chatpane`).
`manifests/` mirrors the [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs)
layout, so a version folder copies straight across. Later versions are opened
automatically by [`.github/workflows/winget.yml`](../../.github/workflows/winget.yml).

The package uses the per-user NSIS installers (`Chatpane_<ver>_win_{x64,arm}_setup.exe`,
`Scope: user`, silent switch `/S`). The portable zip is left to Scoop.

## Updates and version detection

- The installer registers `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Chatpane`
  (`DisplayName` Chatpane, `Publisher` kristofferR, `DisplayVersion` = app
  version) and installs to `%LocalAppData%\Chatpane`. The manifest pins that key
  as `ProductCode`, so winget matches the install exactly.
- The built-in updater runs the same NSIS installer (`/P /UPDATE`), which
  rewrites the same key. winget and the updater therefore share one install:
  after a self-update, `winget upgrade` sees the new version and offers nothing.
- A silent install or upgrade closes the running app and does not relaunch it.
- Installing over a version older than 3.1 migrates it: the installer runs the
  old uninstaller without deleting app data and removes the old uninstall
  entry, so only `Chatpane` remains, with settings and login kept.
- The installer is not Authenticode-signed. winget marks downloaded installers as
  coming from the internet, so users get a SmartScreen "Windows protected your
  PC" prompt (More info, then Run anyway) on install and on every
  `winget upgrade`. The in-app updater's download is not marked, so it is not
  blocked. Signing replaces "unknown publisher" with a verified one, but a new
  signature can still get an "unrecognized app" prompt until SmartScreen
  reputation builds up over the first releases.

Checked in the Windows VM with winget 1.29: `winget validate` passes for 3.1.0,
and `winget install --manifest` over a running 3.0.1 install left a single
`Chatpane` 3.1.0 uninstall entry, Chatpane shortcuts and the existing login.

## First submission (manual)

1. Run `winget validate --manifest <version folder>` on Windows.
2. Submit from the existing `kristofferR/winget-pkgs` fork, either with
   [komac](https://github.com/russellbanks/Komac):
   `komac submit packaging/winget/manifests/k/kristofferR/Chatpane/<version>`,
   or by copying the folder into a branch of the fork and opening
   "New package: kristofferR.Chatpane version <version>".
3. Sign the Microsoft CLA when the bot asks. Validation runs the installer in a
   sandbox; a new package can take a few days.

## Automation (after the first PR merges)

Create a classic personal access token with only the `public_repo` scope and
store it as the `WINGET_TOKEN` repository secret. When the Release workflow
finishes for a `v*` tag and the release is public, `winget.yml` runs
`komac update` with the two setup URLs and opens the PR from the token owner's
winget-pkgs fork (it must exist; komac does not create it). It skips
cleanly when the secret is missing, the package is not in winget-pkgs yet, or
the version is already there. A held draft can be submitted later with
**Run workflow** and the tag.
