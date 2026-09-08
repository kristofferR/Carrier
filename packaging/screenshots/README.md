# Store screenshots

Use only fictional English content. Never capture a signed-in personal profile,
real conversations, contact names, photos, notifications, IDs, or desktop content.

The current images in `docs/screenshots/` were captured on Linux from a floating
Carrier debug window with the installed Floating Mode / Hyprbars decoration.
They retain the website demo's 993 × 620 CSS-pixel conversation area at 100% zoom.
The resulting PNGs are 1241 × 846 pixels, including the native menu and title bar.
The debug label is retained rather than editing the captured image.

## Content provenance

The fixture uses the static English conversation markup in `docs/index.html`
and the seven portraits in `docs/avatars/en/`. All conversations are invented;
all portraits depict AI-generated fictional people. The original provenance is
documented in commits `17fab64` and `bc1c168` and the website's avatar CSS comment.

The fixture is rendered inside Carrier's real WebKit window. It replaces the
page with the website's demo conversation markup; it is not a capture of live
Messenger conversations. The native Linux menu and Floating Mode title bar are
real. No image compositing or post-capture editing is used.

Before any upload, both captures were visually inspected in full, their content
was checked against the fixture, and their PNG chunks were inspected. They have
only IHDR, IDAT, and IEND chunks, with no text or EXIF metadata. No desktop
notifications, pointer, underlying windows, or personal data are visible.

| Image | SHA-256 |
| --- | --- |
| `carrier-linux-en-light.png` | `d4e2be002f9fe0fa8491e8654cb22b7397441bacc581a2c2cde2c781d0a6e1be` |
| `carrier-linux-en-dark.png` | `dd5247862801a7f3881a0bbbd036411ee7071e0854c11fe849001c3fc05cd79e` |

The AppStream URLs point to these inspected files on the permanent artifact
host. Replacing either image requires a new privacy inspection before upload.

## Regeneration

1. Build the debug app with `cargo build --manifest-path src-tauri/Cargo.toml --features mcp`.
2. Launch it with fresh, empty `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and
   `XDG_CACHE_HOME` directories and a dedicated `CARRIER_MCP_SOCKET_PATH`. Never
   copy cookies, a browser profile, or user settings into this capture profile.
3. In that isolated profile, set zoom to 100, the desired light/dark theme,
   `title_bar` to `hide`, and disable autostart, updates, tray, and global hotkey.
   Use Floating Mode's native decoration for the title bar. Make the window
   opaque and floating. Resize until its WebKit viewport is exactly 993 × 620.
4. Run `bun packaging/screenshots/inject-demo.ts <dedicated-socket> light`
   (or `dark`). The script takes no content from the original page, embeds only
   English portraits, blocks external resources, and stops existing page timers.
5. Wait for portraits to render. Capture only the exact window and its title bar,
   with the pointer outside it and no overlapping notifications. Read geometry
   after the window manager has finished positioning; don't reuse stale bounds.
6. Inspect every pixel region and PNG metadata before uploading. Update the
   images, checksums, and AppStream URLs together. Restore temporary compositor
   settings and close only the capture instance when finished.

The fixture's provenance, including its generated portraits, must be disclosed
by the human author of the Flathub submission.
