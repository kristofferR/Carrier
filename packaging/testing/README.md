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

- A real incoming Flatpak message produced a native notification with its
  sender avatar and increased the unread badge.
- Downloading a received photo from Messenger saved a valid 2160 × 3840 JPEG
  (2,478,216 bytes) to the real Downloads directory.
- Clicking the Flatpak notification routed to the chat but did not bring the
  window forward: GNOME displayed a second “Carrier is ready” notice. The
  privacy-safe D-Bus monitor confirmed that GNOME sent `ActivationToken` before
  `ActionInvoked`; this candidate did not consume that token.

The exact CI Snap also downloaded the received photo into the real Downloads
directory as `Messenger (1).jpeg`. Its contents matched the Flatpak download,
and the original file remained unchanged. Help → Report an Issue opened the
project's GitHub issue list in Firefox.

The rebuilt Flatpak activation fix passed the Wayland click check below.
Signed-in notification actions remain pending for the exact Snap artifact.
Media/calls remain unvalidated.

Snap's WebKit memory
pressure monitor also produced AppArmor denials for `/proc/zoneinfo` and its
cgroup memory limit while Messenger remained functional; no confinement policy
was relaxed.

## Local activation-fix candidate

The notification activation fix was built with the GNOME 50 Flatpak SDK and
installed over the signed-in app on 2026-09-09. Login persisted and the native
Wayland window rendered. With Carrier minimized, a fresh incoming message
displayed a native banner with the sender avatar. A single click brought Carrier
directly to the correct chat and displayed the new message, without GNOME's
extra “Carrier is ready” notice. The privacy-safe D-Bus monitor confirmed
`ActivationToken`, `ActionInvoked`, and `NotificationClosed` delivery.
After the chat became read, both dock and tray badges returned from four to
three, preserving the other unread conversations.

- Bundle SHA-256: `73fc5dd863d27d617f02247bcfae60c572973b457152e54f1194d987f96e12f6`
- Installed Flatpak commit: `cee9847f5b52240fb6c6acec71af5652fd54a94dc7f00a7806723f9deb6b047a`
- Local validation: 266 Rust tests, Clippy with warnings denied, and
  `bun run check` (496 tests) passed. CodeRabbit local preflight was clean.

## Local Snap activation-fix candidate

Source commit `fa47dbc` was rebuilt with Snapcraft in the Ubuntu VM on
2026-09-09. The extracted source matched every tracked checkout file by SHA-256.
Installing the resulting strict-confinement Snap as local revision `x8`
preserved login and rendered Messenger on native Wayland. A real message
displayed the sender avatar, but clicking still produced GNOME's extra
“Carrier is ready” notice. A second test with no concurrent VM interaction
reproduced the failure. The protocol trace showed GTK requesting a new token
instead of using the notification's supplied token.

A follow-up build (`x9`) passed the token to GDK's display instead, but the
same failure remained. The system journal then established the cause:
Snap's AppArmor policy denied receiving the `ActivationToken` D-Bus signal
on `/org/freedesktop/Notifications` from the notification daemon. Host-side
signal monitoring alone had incorrectly suggested successful delivery.

Snapd `2.76.3+ubuntu24.04` allows `ActionInvoked`, `NotificationClosed`, and
`NotificationReplied`, but omits `ActivationToken`. The current upstream desktop
and unity7 interface policies also omit it. Ubuntu's notification portal exposes
version 1. Its non-exported `ActionInvoked` signal has no activation token, but
exported `app.*` actions take a different path: GNOME calls the application's
`org.freedesktop.Application.ActivateAction` with platform activation data.

The speculative GDK-display change was removed. Keep the notification-token
handling verified with Flatpak; do not weaken AppArmor or add GNOME overrides
for this test. Direct notification activation was still failing in these two
candidates. Avatar delivery, badge arrival, photo downloads,
and external-browser launching passed; badge clearing after a successful
notification activation has not passed for Snap.

- Original token-fix bundle (`x8`) SHA-256: `f555b9d5f9f559ecbbe9b3e31b1beef26e5ac21ee9eee629c4bb6f1c758e0dd0`
- Diagnostic follow-up bundle (`x9`) SHA-256: `72cdbc33c16fb58ed3fe516c803c63cd1fc823eca36643e23bb1ac99184efa9e`

### Exported portal action

A confined GTK probe on the same stock Wayland desktop passed a direct click
from a minimized window, with no secondary activation banner. The probe used
the portal's `snap.carrier` app ID, a matching preserved desktop file, and an
exported `app.probe` action. A log confirmed that the action handler ran.
This required normal package declarations only, with no host policy edits.

A second probe compiled Carrier's production Rust portal module into a minimal
GTK window, packaged it inside the same strict Snap, and repeated the click.
It returned `Open` with an activation token and restored the minimized window
directly, without a secondary banner. The version-1 portal rejected the newer
sound key; the implementation now queries its version and sends that key only
to version 2 or newer. The rebuilt signed-in application still needs its final
message-routing and badge check.

Packaging checks then caught two desktop-identity requirements. Snapcraft's
app `desktop` extraction renames the file, so the portal entry must be supplied
directly through `snap/gui/`. Ubuntu 24.04 also associates the running window
with the normal `carrier_carrier.desktop` Snap ID; replacing that entry loses
the dock icon and badge. The package therefore retains the regular launcher
and adds a preserved `snap.carrier.desktop` with `NoDisplay=true` for portal
actions. CI verifies both entries and that the portal entry stays hidden.

The final local candidate installed as strict revision `x17` on 2026-09-09.
The artifact identity check passed, and the confined GTK probe repeated its
one-click activation successfully through the hidden portal entry. The package
contains only the production Carrier executable; probe scripts stayed outside
the package. The final real-message routing, avatar, and badge check is pending.

- Portal candidate SHA-256: `bb4220e219c2b1ffda249bc1ac14e785ffddfa70e2b180afd8e825e582e25440`
