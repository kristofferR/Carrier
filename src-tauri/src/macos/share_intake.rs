//! Share-into-Carrier intake (Ref #213): the share extension copies the
//! shared files into the app-group inbox and opens `carrier://share-inbox/<id>`;
//! this module validates that handoff and delivers the bytes to the page.
//!
//! Trust model: the URL only ever names an inbox *id* — the filesystem paths
//! are derived here, from the app-group container this app owns. The page
//! receives validated bytes and names, never a path.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use base64::Engine;
use tauri::Manager;

use crate::settings::AppState;

const APP_GROUP: &str = "S5Q742QZEL.io.github.kristofferr.carrier";
/// The extension's activation rule allows up to 10 images + 1 movie + 10
/// files in one mixed selection, so the intake must accept every selection
/// the sheet can produce.
const MAX_SHARED_FILES: usize = 21;
/// Total payload cap across all shared files.
const MAX_SHARED_BYTES: u64 = 100 * 1024 * 1024;
/// An undelivered share expires rather than surprising the user minutes later.
pub(crate) const SHARE_INTAKE_TTL: Duration = Duration::from_secs(2 * 60);

pub(crate) struct PendingShare {
    payload: String,
    received_at: Instant,
}

/// `carrier://share-inbox/<32-hex id>` → the inbox id.
pub(crate) fn share_inbox_id(url: &str) -> Option<&str> {
    let id = url
        .strip_prefix("carrier://share-inbox/")?
        .trim_end_matches('/');
    (id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(id)
}

fn inbox_dir(id: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    // The group container path is fixed for a non-sandboxed app; going through
    // NSFileManager would resolve to the same place.
    let dir = PathBuf::from(home)
        .join("Library/Group Containers")
        .join(APP_GROUP)
        .join("Library/Caches/share-inbox")
        .join(id);
    dir.is_dir().then_some(dir)
}

/// Read, validate, and clear one inbox; returns the JSON payload for the page
/// hook: `[{ "name": …, "data": <base64> }, …]`.
fn take_inbox_payload(id: &str) -> Option<String> {
    let dir = inbox_dir(id)?;
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut total: u64 = 0;
    for entry in std::fs::read_dir(&dir).ok()?.flatten() {
        // Regular files only — the extension writes flat names, so anything
        // else in here is not ours to touch.
        if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        // Enforce the caps from metadata before reading: a multi-gigabyte
        // movie must be rejected without ever being loaded into memory.
        let size = entry.metadata().map(|meta| meta.len()).unwrap_or(u64::MAX);
        total = total.saturating_add(size);
        if total > MAX_SHARED_BYTES || files.len() >= MAX_SHARED_FILES {
            log::warn!("share intake over size or count cap; dropping the handoff");
            let _ = std::fs::remove_dir_all(&dir);
            return None;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(bytes) = std::fs::read(entry.path()) else {
            continue;
        };
        files.push((name, bytes));
    }
    let _ = std::fs::remove_dir_all(&dir);
    if files.is_empty() {
        return None;
    }
    // Names are sorted so multi-file shares arrive in the extension's
    // "<index>-<name>" order.
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let entries: Vec<serde_json::Value> = files
        .into_iter()
        .map(|(name, bytes)| {
            // Strip the extension's ordering prefix for the user-visible name.
            let display = name.split_once('-').map_or(name.as_str(), |(_, rest)| rest);
            serde_json::json!({
                "name": display,
                "data": base64::engine::general_purpose::STANDARD.encode(bytes),
            })
        })
        .collect();
    serde_json::to_string(&entries).ok()
}

/// Sweep abandoned inboxes (a share the user cancelled mid-flight, or a
/// handoff the app never received). Called once at startup.
pub(crate) fn sweep_stale_inboxes() {
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let root = PathBuf::from(home)
        .join("Library/Group Containers")
        .join(APP_GROUP)
        .join("Library/Caches/share-inbox");
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let cutoff = std::time::SystemTime::now() - Duration::from_secs(60 * 60);
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .is_ok_and(|modified| modified < cutoff);
        if stale {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// The Messenger window a share should land in: the focused one when the user
/// works in a secondary window (File → New Window), else `main`. The Settings
/// window has no composer and is never a target.
fn target_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    let windows = app.webview_windows();
    windows
        .values()
        .find(|window| window.label() != "settings" && window.is_focused().unwrap_or(false))
        .cloned()
        .or_else(|| windows.get("main").cloned())
}

/// Handle one `carrier://share-inbox/<id>` open: read and clear the inbox,
/// park the payload, surface the window, and attempt delivery. Parking comes
/// first — the inbox is gone by now, so this in-memory copy must survive a
/// missing window (e.g. a theme rebuild in flight).
pub(crate) fn handle_share_open(app: &tauri::AppHandle, url: &str) {
    let Some(id) = share_inbox_id(url) else {
        log::warn!("ignoring malformed carrier:// open");
        return;
    };
    let Some(payload) = take_inbox_payload(id) else {
        log::warn!("share inbox {id} was empty or invalid");
        return;
    };
    let state = app.state::<AppState>();
    *state.pending_share.lock().unwrap() = Some(PendingShare {
        payload,
        received_at: Instant::now(),
    });
    crate::tray::show_main(app);
    deliver_pending(app);
}

/// Deliver the parked share and consume it on success, so a later page load
/// cannot attach the same files twice. Called from the handoff itself and
/// from page-load (cold start, or a reload/rebuild that raced the handoff);
/// a share that cannot be delivered stays parked until [`SHARE_INTAKE_TTL`].
pub(crate) fn deliver_pending(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let mut pending = state.pending_share.lock().unwrap();
    if pending
        .as_ref()
        .is_some_and(|share| share.received_at.elapsed() > SHARE_INTAKE_TTL)
    {
        *pending = None;
    }
    let Some(window) = target_window(app) else {
        return;
    };
    // Only a loaded Messenger page has the intake hook (installed at document
    // start); an eval into the splash or connectivity screen would consume the
    // share into the void. Parked shares wait for the page-load call.
    let on_messenger = window
        .url()
        .is_ok_and(|url| crate::url_rules::is_messenger_web_url(&url));
    if !on_messenger {
        return;
    }
    let Some(share) = pending.take() else {
        return;
    };
    let script = format!("window.__carrierShareMedia?.({});", share.payload);
    if window.eval(&script).is_err() {
        // The webview died mid-flight; keep the share for the next page load.
        *pending = Some(share);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_inbox_ids_are_strict_32_hex() {
        assert_eq!(
            share_inbox_id("carrier://share-inbox/0123456789abcdef0123456789abcdef"),
            Some("0123456789abcdef0123456789abcdef")
        );
        assert_eq!(
            share_inbox_id("carrier://share-inbox/0123456789abcdef0123456789abcdef/"),
            Some("0123456789abcdef0123456789abcdef")
        );
        assert_eq!(share_inbox_id("carrier://share-inbox/short"), None);
        assert_eq!(
            share_inbox_id("carrier://share-inbox/../../etc/passwd"),
            None
        );
        assert_eq!(
            share_inbox_id("carrier://other/0123456789abcdef0123456789abcdef"),
            None
        );
        assert_eq!(
            share_inbox_id("https://share-inbox/0123456789abcdef0123456789abcdef"),
            None
        );
    }
}
