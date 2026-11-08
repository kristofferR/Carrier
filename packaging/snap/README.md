# Snap Store

`snap/snapcraft.yaml` builds Chatpane (formerly Carrier) as the `chatpane` snap from the current checkout for AMD64 and
ARM64, using core24 and the GNOME extension. The version comes from Cargo.toml.
Committed inject bundles and static frontend files are embedded by Cargo; the
dev-only MCP feature is disabled.

## Build and test

Use Snapcraft with its LXD build provider on Linux, from the repository root:

```sh
snapcraft
sudo snap install --dangerous ./chatpane_<version>_amd64.snap
snap run chatpane
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
- `browser-support` covers WebKit's shared-memory and process needs. It omits
  `allow-sandbox`: WebKitGTK never starts its Bubblewrap sandbox inside a Snap
  (`shouldUseBubblewrap()` in WebKit's `wtf/glib/Sandbox.cpp`), and the Store
  reserves that attribute for vetted publishers.
- The D-Bus slot matches the installed single-instance plugin's exact name:
  `io.github.kristofferr.carrier.SingleInstance`.
- Notifications use the XDG notification portal and export actions on
  `snap.chatpane` at `/snap/chatpane` (derived from `SNAP_NAME`). This receives Wayland activation data in
  a directed method call; Snap blocks the freedesktop `ActivationToken` broadcast.
- The desktop plug preserves a hidden `snap.chatpane.desktop` with
  `desktop-file-ids` (snapd 2.66 or newer). Its ID matches the portal's
  `snap.chatpane` identity. Supply it directly in `snap/gui/`; Snapcraft's app
  `desktop` key renames extracted files. The regular `chatpane.desktop` remains
  the visible launcher: Ubuntu identifies the running window and its badges
  through `chatpane_chatpane.desktop`. `NoDisplay=true` on the portal entry avoids
  a duplicate menu item. CI checks both entries inside the built package.

The two D-Bus slots and the preserved desktop ID need Snap Store review; see
the release steps below.

Snap owns updates. Chatpane disables its GitHub update polling and installer in
the package. Login startup remains unavailable until Snap autostart integration
is implemented. Multi Instance is disabled because exported notification actions
require one Chatpane process to own the application bus name. Notification avatars are sent as serialized bytes icons over
D-Bus, so the host does not need access to files inside the sandbox. Reply
buttons open Chatpane's composer. Portal version 1 leaves notification sound
to the desktop; version 2 supports Chatpane's sound preference.

Ubuntu 24.04 can strip notification avatars because AppArmor blocks the host
portal's sandboxed icon validator ([Ubuntu #2069526](https://bugs.launchpad.net/bugs/2069526)).
One-click activation still works. See the [VM results](../testing/README.md)
for tested package versions and evidence; do not disable host confinement to
make the avatar test pass.

## Publisher setup and release

`snapcraft.io/chatpane` has no published revision (checked 2026-11-08). Only
registration confirms the name is free. Register and upload only after the
Chatpane rename release ships, so the snap never shows the old in-app name.

To use a different name, change `name`, the app key, `snap/gui/snap.<name>.desktop`,
`desktop-file-ids`, and the notification D-Bus slot together. Carrier's Rust
code derives the portal bus name, object path, and launcher desktop ID
(`<name>_<name>`) from `SNAP_NAME`, so the app key must equal the snap name.

First release, with the publisher's Snap Store account (Ubuntu One):

1. `snapcraft login`, then `snapcraft register chatpane`.
2. Build or download both CI candidates (**Linux store packages**, run manually)
   and upload them: `snapcraft upload --release=candidate ./chatpane_<version>_<arch>.snap`.
   The D-Bus slots stop each upload in manual review.
3. Post one request in the forum's
   [store-requests](https://forum.snapcraft.io/c/store-requests/19) category
   asking reviewers to clear the revisions and grant a snap declaration for:
   the session-bus `dbus` slots `snap.chatpane` (exported notification actions)
   and `io.github.kristofferr.carrier.SingleInstance` (second launches), and the
   `desktop` plug's `desktop-file-ids: [snap.chatpane]`. Optionally ask for
   `camera` and `audio-record` auto-connection for Messenger calls; without it,
   users connect them in their software center. A declaration lets later
   uploads pass automatically.
4. In the publisher dashboard listing, set the icon, category (Social), the
   screenshots in `docs/screenshots/` (dark first), and support links.
5. Test both candidate revisions (see above), then
   `snapcraft release chatpane <revision> stable` for each architecture.

Later releases: create a package-scoped credential with
`snapcraft export-login --snaps=chatpane --channels=edge,beta,candidate --acls package_access,package_push,package_update,package_release -`,
store it as `SNAPCRAFT_STORE_CREDENTIALS` in the repository's `snap-store`
environment, and set the repository variable `SNAP_STORE_PUBLISH` to `true`.
The **Snap Store** workflow then uploads each `v*` tag to `candidate`; promote
tested revisions to stable by hand. Keep credentials out of the repository.

References: [Tauri packaging](https://v2.tauri.app/distribute/snapcraft/),
[GNOME extension](https://ubuntu.com/docs/snapcraft/9/reference/extensions/gnome-extension/),
[D-Bus interface](https://snapcraft.io/docs/reference/interfaces/dbus-interface/),
[desktop IDs](https://snapcraft.io/docs/reference/interfaces/desktop-interface/).
