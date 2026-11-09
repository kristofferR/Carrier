# Store screenshots

Use only fictional English content. Never capture a signed-in personal profile,
real conversations, contact names, photos, notifications, IDs, or personal desktop content.

None of the images in `docs/screenshots/` are captures of the app. They are
renders of the website's window mock in `docs/index.html`.

- **Linux** (`chatpane-linux-en-*.png`): the mock framed as a KDE Breeze window
  with the title `Chatpane` and a File, Edit, View and Help menu bar. Both PNGs
  are 1021 × 744 pixels. Light is the default AppStream screenshot; use dark
  first and light second in the Snap listing.
- **Windows** (`chatpane-windows-en-*.png`): the mock in its Windows mode,
  rendered with Segoe UI and Segoe UI Emoji, composited onto a 1920 × 1080
  capture of a clean Windows 11 test VM desktop with its taskbar. The website's
  Windows notification mock sits above the system tray. The desktop holds only
  default icons and a Chatpane shortcut; the VM's own Chatpane window was moved
  off-screen before the capture. Use these for winget, Microsoft Store and
  directory listings.

## Content provenance

The mock uses the static English conversation markup in `docs/index.html`
and the seven portraits in `docs/avatars/en/`. All conversations are invented;
all portraits depict AI-generated fictional people. The original provenance is
documented in commits `17fab64` and `bc1c168` and the website's avatar CSS comment.

All images were visually inspected in full. Their PNGs hold only IHDR, IDAT
and IEND chunks: no text, account, location, or EXIF metadata.

| Image | SHA-256 |
| --- | --- |
| `chatpane-linux-en-light.png` | `61c602d1cb33cf092157977f2b6e69e6bf735bf99807da49e59ab0b850795ebb` |
| `chatpane-linux-en-dark.png` | `5c2367c82934a6245fedca067e0c734b452dc5cb5dcafe8b1de87bfb5eb8c99e` |
| `chatpane-windows-en-light.png` | `153d5907a5b80bf29e6faa4fa9e94cc663546276a024c2dd9b88b161bb038fad` |
| `chatpane-windows-en-dark.png` | `d913fe701daa14832571ca0e24e139b1e8a30c28f520c48439f323238a1df566` |

The AppStream URLs point to the Linux files on https://chatpane.app/screenshots/.
Replacing any image requires a new privacy inspection.

## Real captures

A store that needs real app captures can use this process instead.

1. Temporarily change only `APP_TITLE`'s debug string in `src-tauri/src/lib.rs`
   from `Chatpane (debug)` to `Chatpane`. Build with
   `cargo build --manifest-path src-tauri/Cargo.toml --features mcp`, then restore
   that source change immediately. Use this binary only for the capture; keep
   the MCP release-build prohibition intact and rebuild normally afterward.
2. Launch it with fresh, empty `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and
   `XDG_CACHE_HOME` directories and a dedicated `CHATPANE_MCP_SOCKET_PATH`. Never
   copy cookies, a browser profile, or user settings into this capture profile.
3. Use an isolated Ubuntu GNOME session with Yaru (or Yaru-dark), the Ubuntu
   settings overrides, and `gsd-xsettings` running. A separate Xvfb display and
   D-Bus session keep captures independent of the signed-in test desktop. Use
   `GSETTINGS_BACKEND=keyfile` with the empty capture configuration directory so
   theme changes cannot affect the test account's dconf settings. In Chatpane,
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
