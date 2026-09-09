# Linux store runtime testing

Use a disposable Ubuntu desktop VM for strict Snap testing and an independent
Flatpak installation. Build success does not validate desktop integration.

## Local lab

The workstation lab lives outside the checkout at
`~/.cache/carrier-store-tools/vm/`. It uses Ubuntu 24.04.4, KVM, four vCPUs,
6 GiB RAM, and a 48 GiB sparse overlay over a checksummed official Ubuntu cloud
image. Ubuntu Desktop, snapd, Snapcraft, Flatpak, and desktop portals are installed.
The lab has been tested with GNOME on X11 and Wayland. Its current virtual
display is Virtio VGA, which exposes the DRM devices needed by native Wayland.

Management uses a dedicated SSH key and a host key verified against the VM's
serial console. SSH and the browser console listen on loopback; a Tailscale Serve
HTTPS proxy on port 8443 makes the console available privately to the tailnet. The VM has
no host home-directory mount or copied personal profile.

```sh
lab_dir="$HOME/.cache/carrier-store-tools/vm"
# Start only when stopped; the overlay preserves the test installation.
bash "$lab_dir/start.sh"
ssh -F "$lab_dir/ssh-config" -O check carrier-lab
ssh -F "$lab_dir/ssh-config" carrier-lab
# Graceful shutdown:
bun "$lab_dir/qmp.ts" '{"execute":"system_powerdown"}'
```

The browser console is <http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale>.
For remote access, use the workstation's Tailscale hostname with port 8443 and
the same `/vnc.html?autoconnect=true&resize=scale` path. The guest input layout is
Norwegian Macintosh (`no+mac`) to match the remote test keyboard.
If its server is stopped, start it locally with:

```sh
uv run --with websockify==0.13.0 websockify \
  --web="$lab_dir/noVNC-1.7.0" --unix-target="$lab_dir/vnc.sock" 127.0.0.1:6080
```

When converting the cloud image to a desktop, use NetworkManager consistently
and disable the server's obsolete networkd wait service. Otherwise desktop
installation can interrupt SSH and subsequent boots can stall waiting for it.

## Checks before publication

Test Snap and Flatpak separately: both use Carrier's single-instance D-Bus name.
Quit the actual app before switching packages; stopping the launcher alone may
leave the sandbox's app scope running. For Flatpak, use
`flatpak kill io.github.kristofferr.carrier`.

- Clean install, launch, cookie refusal, login, and persistence after restart.
- Settings, store-owned updates, disabled unsupported autostart, and second launch.
- Downloads into the real Downloads directory, attachments, and external links.
- Notifications, actions, tray, badges, and global shortcuts.
- Media playback and calls where test hardware is available.
- X11 and Wayland sessions, followed by installation of the exact release build.
- AppArmor/portal errors under strict confinement, without disabling WebKit's sandbox.

Use a dedicated account for signed-in checks and have its owner enter credentials.
Never upload runtime screenshots or logs containing account data. Public store
images must continue to use the fictional fixture documented in
[`../screenshots/README.md`](../screenshots/README.md).

The first VM pass exposed a missing Snap network-status permission, a Rustup
Snap/SDK libc conflict during builds, and login consent/layout bugs. The first
signed-in pass also landed on Facebook's home feed instead of Messenger;
recovery must only redirect the plain feed, preserving required post-login UI.
The first CI pass also exposed missing D-Bus session setup and the Flatpak checkout
manifest's out-of-directory source path. Keep ARM64 CI and signed-in runtime
checks separate from the x86-64 build evidence.

## Exact CI candidate: e4ec40e

The x86-64 artifacts from GitHub Actions run `34281913517` were downloaded and
installed in the Ubuntu VM on 2026-09-09. Host and guest SHA-256 hashes match:

| Artifact | SHA-256 |
| --- | --- |
| `carrier_1.13.0_amd64.snap` | `801d353a0673e25e4630f7b84db450e6ba88176bbb0e3786798aa99658118eeb` |
| `carrier.flatpak` | `d8d737464f184ba6c25e2b810240c8f93a7b174a9222fd7c4e4103e07b60334c` |

Confirmed on X11:

- Snap installation preserved the dedicated account's login and opened Messenger.
- Flatpak installation succeeded and displayed its separate login screen.
- Flatpak sign-in reached Messenger and persisted through a full app restart.
- A second Flatpak launch with `--settings` opened Settings in the existing
  instance. Unsupported autostart was disabled with its Flatpak explanation.
- Both sandboxes could write a probe file to the real Downloads directory and
  query GNOME's notification capabilities.
- Flatpak exposed FileChooser portal version 3 and could not read an unrelated
  home-directory file.

Confirmed on Wayland:

- Replacing standard VGA with Virtio VGA enabled `/dev/dri/card0` and
  `/dev/dri/renderD128`; `loginctl` confirmed the desktop's session type.
- Both CI packages rendered signed-in Messenger after the VM restart. Explicit
  `GDK_BACKEND=wayland` launches succeeded; Carrier was absent from `xlsclients`.
- Flatpak registered its tray item with Ubuntu's StatusNotifierWatcher.
- Stock Ubuntu's portal did not expose `org.freedesktop.portal.GlobalShortcuts`.
  Global-hotkey registration cannot be validated on this desktop without that
  portal; the desktop was not modified to add it.

These permission and rendering checks do not establish end-to-end message
notification or download behavior. Real message delivery and actions,
attachment downloads, and media/calls remain pending for these exact artifacts.
Snap's WebKit memory
pressure monitor also produced AppArmor denials for `/proc/zoneinfo` and its
cgroup memory limit while Messenger remained functional; no confinement policy
was relaxed.
