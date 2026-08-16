//! Windows-native integration. Currently the toast-notification path (a raw
//! WinRT implementation that notify-rust's backend cannot cover: text input,
//! toast tag/group, and Action Center history removal). The module compiles on
//! any OS for `cfg(test)` so the pure helpers are unit-testable on CI; the WinRT
//! delivery inside is gated to `target_os = "windows"`.

pub(crate) mod toast;

// The jump list is pure Win32 COM with no OS-independent helpers to test.
#[cfg(target_os = "windows")]
pub(crate) mod jumplist;
