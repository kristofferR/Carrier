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

## muda native menu item ownership fix

`muda/` is the published **0.19.3** crate with the macOS use-after-free fix from
[`a1550bd9698208b6698cd8fb27c5169808ed892f`](https://github.com/tauri-apps/muda/commit/a1550bd9698208b6698cd8fb27c5169808ed892f)
([muda #361](https://github.com/tauri-apps/muda/pull/361)) backported. The About-item
hunk is adapted to 0.19.3's unsafe-block layout; behavior matches upstream.
Native menu items retain their Rust owner instead of storing a dangling raw
pointer when AppKit keeps an item alive after its Rust menu is dropped.
Only `src/platform_impl/macos/mod.rs` differs from the published source.
Registry bookkeeping, the original manifest, lockfile, and examples are omitted;
upstream licenses are included.

Do not independently upgrade Carrier's direct dependency to 0.20 while Tauri
still uses 0.19: these versions have separate global event handlers and register
the same Objective-C class names. Carrier's Dock menu and Tauri must share one
instance. This backport covers the memory-safety fix in the Dependabot update
(Ref #287), rather than importing 0.20's breaking API and GTK changes.

Remove this patch once Tauri and Carrier can use the same stable muda release
containing #361. Validate on macOS with:

```sh
cargo run --manifest-path src-tauri/Cargo.toml --example menu_lifecycle
```

The check retains a native menu item after dropping its Rust menu and item,
invokes its action, and verifies both event delivery and native teardown.
