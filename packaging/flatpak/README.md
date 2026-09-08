# Carrier Flatpak / Flathub packaging

## Package sources

The manifest in this directory builds the current checkout. Generate a portable
release manifest with a checksummed source archive, matching Cargo sources, and
current AppStream metadata:

```sh
uv run packaging/flatpak/prepare-release.py v1.13.0 /tmp/carrier-flatpak-1.13.0
```

The output directory must not exist. The script rejects a release whose lockfile
differs from this checkout, preventing accidental use of mismatched dependencies.
The generated files are packaging inputs; the script does not submit anything.

On 2026-09-08, the generated v1.13.0 source-archive manifest built offline on
x86-64, exported an installable bundle, and passed Flathub manifest and repository
lint. Screenshot composition used PNG for compatibility with Flathub's linter.
Interactive testing of this release and an ARM64 build are still required.

## Historical runtime evidence

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

Install the GNOME 50 SDK/runtime and the matching Rust extension:

```sh
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install --user flathub org.gnome.Sdk//50 org.gnome.Platform//50 org.freedesktop.Sdk.Extension.rust-stable//25.08 org.flatpak.Builder
```

Build with Flathub's maintained builder and screenshot-composition options so
repository lint checks the same metadata that Flathub will produce:

```sh
sed -e 's|path: ../..|path: .|' -e 's|- cargo-sources.json|- packaging/flatpak/cargo-sources.json|' \
  packaging/flatpak/io.github.kristofferr.carrier.yml > io.github.kristofferr.carrier.yml
flatpak run --command=flathub-build org.flatpak.Builder \
  --repo=flatpak-repo io.github.kristofferr.carrier.yml
```

The temporary manifest sits at the checkout root so sandboxed source loading
can access the app and Cargo sources without traversing outside its directory.
Its filename matches the app ID, as required by Flathub's manifest linter.

The builder may download the SDK and runtime. The Cargo build itself is
network-isolated: `cargo-sources.json` vendors every Cargo source from
`src-tauri/Cargo.lock`; regenerate it with the official
`flatpak-builder-tools/cargo/flatpak-cargo-generator.py` whenever the lockfile
changes.

To validate the exact release inputs, build a separate repository from the
generated release manifest, then validate and bundle that repository:

```sh
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest /tmp/carrier-flatpak-1.13.0/io.github.kristofferr.carrier.yml
flatpak run --command=flathub-build org.flatpak.Builder --repo=flatpak-release-repo /tmp/carrier-flatpak-1.13.0/io.github.kristofferr.carrier.yml
flatpak run --command=flatpak-builder-lint org.flatpak.Builder repo flatpak-release-repo
flatpak build-bundle flatpak-release-repo carrier.flatpak io.github.kristofferr.carrier --runtime-repo=https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user ./carrier.flatpak
flatpak run io.github.kristofferr.carrier
```

The **Linux store packages** workflow also builds an x86-64 candidate for
packaging PRs and manual runs. It does not publish it. Test login/session persistence, downloads and attachments,
notifications/actions, tray, shortcuts, external links, media, and both Wayland
and X11 before submitting. Historical spike evidence is not a substitute for
testing the version being submitted.

## Cargo source refresh

Run the official generator with `uv` from the repository root. The pinned
generator used for the current source list is
`flatpak/flatpak-builder-tools@1fc32195e3e60fe5c97f0af646dec7a99df5962b`:

```sh
curl --fail --location https://raw.githubusercontent.com/flatpak/flatpak-builder-tools/1fc32195e3e60fe5c97f0af646dec7a99df5962b/cargo/flatpak-cargo-generator.py -o /tmp/flatpak-cargo-generator.py
uv run --with 'aiohttp>=3.9.5,<4' --with 'tomlkit>=0.13.3,<1' /tmp/flatpak-cargo-generator.py src-tauri/Cargo.lock -o packaging/flatpak/cargo-sources.json
```

## Submission ownership

Follow [Flathub's submission process](https://docs.flathub.org/docs/for-app-authors/submission)
after validating the portable release package. Flathub's
[generative AI policy](https://docs.flathub.org/docs/for-app-authors/requirements#generative-ai-policy)
requires the human submitter to disclose affected parts and approximate extent
of AI-generated material. Agents may prepare packaging, but may not open or
automate the submission PR or generate its commit messages, description, review
comments, or replies. The human submitter must author those interactions.

After acceptance, verify ownership through the Flathub developer dashboard and
only then add Flathub installation links to Carrier's website and README.
