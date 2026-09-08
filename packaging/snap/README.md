# Snap Store

`snap/snapcraft.yaml` builds Carrier from the current checkout for AMD64 and
ARM64, using core24 and the GNOME extension. The version comes from Cargo.toml.
Committed inject bundles and static frontend files are embedded by Cargo; the
dev-only MCP feature is disabled.

## Build and test

Use Snapcraft with its LXD build provider on Linux, from the repository root:

```sh
snapcraft
sudo snap install --dangerous ./carrier_1.13.0_amd64.snap
snap run carrier
```

The **Linux store packages** GitHub Actions workflow builds candidate artifacts
on Ubuntu for both architectures when packaging changes in a PR, or when run
manually. It does not upload to the store.

Before releasing to stable, test the installed package under strict confinement:
login and persisted session after a refresh; notifications and clicks; unread
badges and tray menus; second launch; desktop actions; downloads and file picking;
external links; media playback; camera/microphone capture; Wayland and X11.
Inspect AppArmor denials if an integration fails. A successful build alone does
not establish that the sandbox permissions are sufficient.

## Permissions and behavior

- The GNOME extension supplies desktop, graphics, theme, portal integration,
  and WebKit. Use its matching runtime libraries; staging another GTK/WebKit
  stack can shadow the runtime's SVG loader with an incompatible library.
- `network` connects to Messenger; `network-status` lets WebKit query connection
  availability through the desktop portal; `home` supports downloads and attachments.
- `audio-playback`, `audio-record`, and `camera` support messaging and calls.
  Camera and microphone interfaces may need explicit connections by the user.
- `unity7` supports tray and launcher integration.
- `browser-support` with `allow-sandbox: true` preserves WebKit's inner sandbox.
- The D-Bus slot matches the installed single-instance plugin's exact name:
  `io.github.kristofferr.carrier.SingleInstance`.

The D-Bus slot and sandbox permission need Snap Store review. Request the
necessary declarations and connections through the publisher dashboard when
the first upload enters review. Do not disable WebKit's sandbox to clear denials.

Snap owns updates. Carrier disables its GitHub update polling and installer in
the package. Login startup remains unavailable until Snap autostart integration
is implemented. Notification avatars are sent as inline image data over D-Bus,
so the host notification
daemon does not need access to files inside the sandbox.

## Publisher setup and release

Create a publisher account at <https://snapcraft.io>, then register `carrier`.
Availability is only confirmed when registration succeeds. If a different name
is needed, update `name` in the manifest; keep the application key `carrier` so
the desktop actions and launcher badge mapping remain consistent.

After strict-confinement testing and store review:

```sh
snapcraft login
snapcraft register carrier
snapcraft upload --release=candidate ./carrier_1.13.0_amd64.snap
snapcraft upload --release=candidate ./carrier_1.13.0_arm64.snap
snapcraft status carrier
```

Test both candidate revisions before promoting each approved revision with
`snapcraft release carrier <revision> stable`. Configure the listing's icon,
screenshots, description, and support links in the publisher dashboard first.
Keep credentials out of the repository. Future CI publishing should use a
package-scoped store credential only after the account and name are established.

References: [Tauri packaging](https://v2.tauri.app/distribute/snapcraft/),
[GNOME extension](https://ubuntu.com/docs/snapcraft/9/reference/extensions/gnome-extension/),
[D-Bus interface](https://snapcraft.io/docs/reference/interfaces/dbus-interface/).
