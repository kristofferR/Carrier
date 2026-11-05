# Messenger user-agent policy

Ref #258, #335.

Carrier leaves the user agent unset so the embedded engine maintains its own
identity, with one recorded exception: macOS identifies as the system Safari.
`src-tauri/src/user_agent.rs` is the only compatibility-policy module;
`window::build_app_window` applies it to initial, extra, and recreated Messenger
windows. Local Settings windows retain their defaults too.

| Platform | Engine | Carrier override |
| --- | --- | --- |
| macOS | OS-provided WKWebView | Safari identity, installed Safari version |
| Windows | Installed WebView2 runtime | None |
| Linux `.deb` / `.rpm` | System WebKitGTK | None |
| Linux AppImage | Bundled WebKitGTK | None |
| Unrecognized platform | Platform default | None |

This removed the fixed Safari 17.4 and Chrome 124 identities, including Linux's
claim to be Chromium despite running WebKit. Native UA tokens can themselves be
frozen or contain compatibility tokens; Carrier passes through the engine's own
policy rather than deriving browser versions from those tokens or the OS version.

## macOS exception: calls need a Safari identity

WKWebView's native UA is WebKit's frozen macOS identity with no browser token:
`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)`.
Since v1.13.0 (#278) Messenger has classified it as an unknown browser, and voice
and video calls stopped working (#335).

- Reported on macOS 15.7.5 (Apple silicon): call buttons are greyed out or open
  "This feature isn't supported by your browser" with an Install Chrome button.
- Observed on 2026-11-05 in Carrier 2.0.6 on macOS 27.2 / Safari 27.2: Facebook's
  `UserAgentData` module reports `browserName: "Unknown"` with engine `WebKit`.
  `ZenonIncomingRingSDK.isCallSupported` defers to
  `RTWebIncomingRingConfiguration.isSupportedClient()`, a list of browser checks
  such as `Chrome >= 77`, `Firefox >= 70` and `Safari >= 16`. An unknown browser
  matches none, so calls take the unsupported-browser dialog
  (`useRTWebOutgoingUnsupportedBrowserDialog`). The engine itself exposes
  `getUserMedia`, `getDisplayMedia`, insertable streams and script transforms.
- Native versus override: calls worked under the previous fixed Safari 17.4
  identity, including the camera and microphone fixes made with it.

Carrier therefore appends Safari's own suffix, `Version/<version> Safari/605.1.15`,
to the frozen identity. The version is read from `CFBundleShortVersionString` of
`/Applications/Safari.app` (the system Safari, a link into the system cryptex on
macOS 13+), never guessed: Safari and WKWebView share the system WebKit, and Safari
updates on older macOS update that framework too, so the version describes this
engine's real capabilities. Carrier checks that at startup: Safari's build number
(`CFBundleVersion`) must equal the build of the WebKit framework that provides
`WKWebView` in Carrier's process. If they differ, as they would if an older macOS
paired a newer Safari with an older engine, or if the version is missing or
malformed, Carrier keeps the native UA and logs a warning.

A future exception must record the failing OS and engine versions, observed
Messenger behavior, native-versus-override results, and evidence that the override
does not advertise unsupported capabilities. Scope it to the affected engine and
runtime range if a platform-wide exception would be inaccurate. Keep selection in
the policy module and add focused tests for that exception. Unknown platforms
fall back to native. Do not retry failed loads with guessed browser identities:
network errors, authentication challenges, and missing engine features cannot be
fixed reliably with a user-agent string.

Navigation rules, CSP, remote-origin permissions, and injected scripts are
unchanged. This policy does not add browser capabilities or guarantee Messenger
support on an old engine.

## Verification record

**Status: implementation checked locally; cross-platform compatibility remains
unverified. Do not treat the matrix below as release qualification.**

On 2026-09-07 (Europe/Oslo; 2026-09-06 UTC), a standalone GTK 3 / WebKitGTK 2.52.6
probe on Omarchy used a fresh
ephemeral WebContext to visit `https://www.facebook.com/messages/` without a UA
override. It reached `/login.php` and, after client rendering (checked at 35
seconds), displayed both email and password inputs. Carrier's previous Chrome 124
override produced the same result. The initial load-finished event preceded the
form's rendering in both runs. This verifies reaching the login form, not
successful authentication. No credentials or conversation content were collected.

The installed Tauri 2.11.5 / Wry 0.55.1 source confirms that an unset UA preserves
the native default on all three backends. WebKitGTK documents the same behavior
for a null custom user agent:
[WebKitGTK Settings.set_user_agent](https://webkitgtk.org/reference/webkit2gtk/2.40.0/method.Settings.set_user_agent.html).
This verifies configuration semantics, not Messenger acceptance.

`Pending` means not tested. `Form only` means the unauthenticated probe rendered
email/password inputs without attempting login. Record versions when executing rows;
there is no tested Windows/Linux minimum implied by this table.

| OS / runtime coverage | Login | Compose | Media | Calls | Downloads | Logout |
| --- | --- | --- | --- | --- | --- | --- |
| macOS 10.15, configured minimum / system WKWebView | Pending | Pending | Pending | Pending | Pending | Pending |
| Current supported macOS / system WKWebView | Pending | Pending | Pending | Pending | Pending | Pending |
| Oldest supported Windows / compatible WebView2 | Pending | Pending | Pending | Pending | Pending | Pending |
| Current supported Windows / current WebView2 | Pending | Pending | Pending | Pending | Pending | Pending |
| Oldest supported Linux packages / system WebKitGTK | Pending | Pending | Pending | Pending | Pending | Pending |
| Omarchy / system WebKitGTK 2.52.6 (standalone probe) | Form only | Pending | Pending | Pending | Pending | Pending |
| Linux AppImage / bundled WebKitGTK | Pending | Pending | Pending | Pending | Pending | Pending |

For each row, use an actual Carrier build with native UA, record OS, architecture,
engine/runtime version and package format, then check:

1. Fresh login, any authentication challenge, and session persistence after restart.
2. Open a conversation, compose and send a message to an authorized test recipient,
   and receive a reply.
3. Upload/open an image and play audio/video.
4. Start and receive voice/video calls with a consenting test partner; exercise
   microphone/camera permissions and record unsupported engine features separately.
5. Download an image and an attachment through Carrier's existing download flow.
6. Log out and confirm the login form is usable again.
7. Repeat in an extra window and after a theme-triggered window recreation.

A credentialed test session, macOS/Windows hosts, and older OS/package environments
were not available in this task. Complete these rows before claiming #258's full
compatibility verification is finished. Unit tests cover supported-platform
selection and the unknown-platform native fallback; they do not replace this matrix.
