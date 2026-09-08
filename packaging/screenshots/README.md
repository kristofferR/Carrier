# Store screenshots

Use only fictional English content. Never capture a signed-in personal profile,
real conversations, contact names, photos, notifications, IDs, or desktop content.

The current images in `docs/screenshots/` were captured on Ubuntu from a floating
Carrier debug window with native GNOME / Yaru decorations, rounded corners, and
window shadows. They retain the website demo's 993 × 620 CSS-pixel conversation
area at 100% zoom. The resulting PNGs are 1021 × 712 pixels, including the native
menu, title bar, and shadow. Light is the default AppStream screenshot; use dark
first and light second in the Snap listing.
The capture build uses the title `Carrier`; normal debug builds retain their
debug label. The title is rendered by the window manager, not edited into the PNG.

## Content provenance

The fixture uses the static English conversation markup in `docs/index.html`
and the seven portraits in `docs/avatars/en/`. All conversations are invented;
all portraits depict AI-generated fictional people. The original provenance is
documented in commits `17fab64` and `bc1c168` and the website's avatar CSS comment.

The fixture is rendered inside Carrier's real WebKit window. It replaces the
page with the website's demo conversation markup; it is not a capture of live
Messenger conversations. The native Linux menu and Ubuntu title bar are real.
No image compositing or post-capture editing is used.

Before any upload, both captures were visually inspected in full, their content
was checked against the fixture, and their PNG chunks were inspected. They have
only IHDR, sBIT, tEXt, IDAT, and IEND chunks. The sole text field is
`Software=gnome-screenshot`; there is no account, location, or EXIF metadata. No desktop
notifications, pointer, underlying windows, or personal data are visible.

| Image | SHA-256 |
| --- | --- |
| `carrier-linux-en-light.png` | `25062985d53d566fe313f619a07bd49fd7691edbf2a5435f6775cbe47f30f53a` |
| `carrier-linux-en-dark.png` | `dfa908e4d63c71ea515500699fe009c12fec6a8095be16ba04b8447084371b6c` |

The AppStream URLs point to these inspected files on the permanent artifact
host. Replacing either image requires a new privacy inspection before upload.

## Regeneration

1. Temporarily change only `APP_TITLE`'s debug string in `src-tauri/src/lib.rs`
   from `Carrier (debug)` to `Carrier`. Build with
   `cargo build --manifest-path src-tauri/Cargo.toml --features mcp`, then restore
   that source change immediately. Use this binary only for the capture; keep
   the MCP release-build prohibition intact and rebuild normally afterward.
2. Launch it with fresh, empty `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and
   `XDG_CACHE_HOME` directories and a dedicated `CARRIER_MCP_SOCKET_PATH`. Never
   copy cookies, a browser profile, or user settings into this capture profile.
3. Use an isolated Ubuntu GNOME session with Yaru (or Yaru-dark), the Ubuntu
   settings overrides, and `gsd-xsettings` running. A separate Xvfb display and
   D-Bus session keep captures independent of the signed-in test desktop. Use
   `GSETTINGS_BACKEND=keyfile` with the empty capture configuration directory so
   theme changes cannot affect the test account's dconf settings. In Carrier,
   set zoom to 100, the desired light/dark theme, `title_bar` to `auto`, and disable
   autostart, updates, tray, and global hotkey. Keep the window unmaximized and
   resize until its WebKit viewport is exactly 993 × 620 (993 × 646 client area
   with the current Ubuntu menu).
4. Run `bun packaging/screenshots/inject-demo.ts <dedicated-socket> light`
   (or `dark`). The script takes no content from the original page, embeds only
   English portraits, blocks external resources, and stops existing page timers.
5. Wait for portraits to render. Capture the focused window with
   `gnome-screenshot --window --file=<output.png>`, with the pointer outside it.
   Set both `DISPLAY` and `DBUS_SESSION_BUS_ADDRESS` to the isolated capture
   session: setting only `DISPLAY` can capture the other desktop through D-Bus.
   Read geometry after positioning; don't reuse stale bounds. The native
   screenshot includes the title bar, rounded corners, and transparent shadow.
6. Inspect every pixel region and PNG metadata before uploading. Update the
   images, checksums, and AppStream URLs together. Restore temporary compositor
   settings and close only the capture instance when finished.

The fixture's provenance, including its generated portraits, must be disclosed
by the human author of the Flathub submission.
