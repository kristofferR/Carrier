# Carrier Flatpak spike

## Decision

**Proceed with a Flathub submission.** The 2026-07-24 spike met the runtime,
size, and sandbox goals. The manifest in this directory is the working
in-repository build; a Flathub submission repository should replace its local
`dir` source with the corresponding tagged Carrier release archive.

## Evidence

The manifest was built and exported on x86-64 against:

- `org.gnome.Platform` / `org.gnome.Sdk` 50
- WebKitGTK 2.52.5 (`webkit2gtk-4.1`)
- GTK 3.24.52
- Rust 1.97.1 from `org.freedesktop.Sdk.Extension.rust-stable` 25.08

`flatpak-builder` completed the offline Cargo build, AppStream composition, and
export. The resulting app was 4.2 MB to download and 9.9 MB installed, excluding
the shared runtime. The v1.6.0 x86-64 AppImage is 92,551,672 bytes, so the
shared-runtime package delivers the intended order-of-magnitude size reduction.

The installed sandbox was checked from inside the app:

- Notifications: `org.freedesktop.Notifications.GetCapabilities` succeeded and
  advertised actions, body text, persistence, and inline replies.
- Downloads: only `xdg-download` is writable; Carrier's existing media URL and
  extension allowlists remain in front of that access.
- Tray: Carrier registered its StatusNotifierItem through the KDE watcher; the
  host exposed the sandbox's unique connection with `Title="Carrier"` and
  `Id="carrier"`. The manifest grants access to the watcher, not the whole
  session bus.
- External navigation and global shortcuts: the desktop portal was reachable;
  the runtime supplies its portal-aware `xdg-open`, and Carrier continues to use
  the GlobalShortcuts portal on Wayland.
- WebKit: the release binary linked and launched with the runtime WebKitGTK; no
  private WebKit copy is included in the app.

## Package-owned behavior

Flatpak, not the app, owns updates. Carrier detects `/.flatpak-info`, disables
automatic GitHub update checks, blocks the built-in installer, and directs
manual checks to Flatpak/Flathub instructions.

The existing autostart plugin writes host desktop files, which is not valid from
the sandbox. Carrier therefore disables that setting under Flatpak. It can be
enabled in a later release after implementing the Background portal.

## Build

Install the GNOME 50 SDK/runtime and the matching Rust extension, then run:

```sh
flatpak-builder \
  --user \
  --force-clean \
  --install-deps-from=flathub \
  --install \
  build-flatpak \
  packaging/flatpak/io.github.kristofferr.carrier.yml
```

`--install-deps-from=flathub` may download the SDK and runtime. The Cargo build
itself is network-isolated: `cargo-sources.json` vendors every Cargo source from
`src-tauri/Cargo.lock`; regenerate it with the official
`flatpak-builder-tools/cargo/flatpak-cargo-generator.py` whenever the lockfile
changes.
