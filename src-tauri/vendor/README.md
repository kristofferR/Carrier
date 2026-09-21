# Tauri native webview ownership fix

`tauri-runtime-wry/` is the published **2.11.4** crate, with the two-file fix from
upstream commit
[`a370f653330506c2a5f59b643645a15b4cc30c18`](https://github.com/tauri-apps/tauri/commit/a370f653330506c2a5f59b643645a15b4cc30c18)
([Tauri PR #15224](https://github.com/tauri-apps/tauri/pull/15224)) applied.
The modified files carry change notices, and a local rustfmt configuration
preserves upstream's two-space indentation.
Registry bookkeeping, the redundant original manifest, and the crate's own
lockfile are omitted. Upstream licenses are included.

The released runtime leaks a retain on the WKWebView, its user-content
controller, and its NSWindow each time `with_webview` runs on macOS. Carrier
uses it to make every Messenger view transparent and to present share sheets.
Consequently, destroying a window during recovery leaves its old webview alive.
The backport keeps the native objects owned for the callback's lifetime and
releases those temporary references when the callback returns.

Remove this directory and the `[patch.crates-io]` entry once a stable runtime
contains the fix, then update `Cargo.lock`. Do not compensate by manually
releasing pointers in Carrier's callbacks: they are borrowed in the fixed API.

Verify native teardown on macOS with:

```sh
cargo run --manifest-path src-tauri/Cargo.toml --example webview_lifecycle
```

The check repeatedly creates an isolated blank webview, exercises
`with_webview`, destroys the window, and verifies through a weak Objective-C
reference that the webview deallocated. It does not open Messenger or use its
session. The unpatched runtime should fail this check.
