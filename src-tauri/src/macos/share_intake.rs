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
/// Matches the extension's activation rule (10 files) with headroom.
const MAX_SHARED_FILES: usize = 10;
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
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(bytes) = std::fs::read(entry.path()) else {
            continue;
        };
        total = total.saturating_add(bytes.len() as u64);
        if total > MAX_SHARED_BYTES || files.len() >= MAX_SHARED_FILES {
            log::warn!("share intake over size or count cap; dropping the handoff");
            let _ = std::fs::remove_dir_all(&dir);
            return None;
        }
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

/// Deliver the pending share to the main window's page, if any is live.
/// Returns true when the eval was issued (the page hook buffers until the
/// composer can take the files).
fn deliver(app: &tauri::AppHandle, payload: &str) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    let script = format!("window.__carrierShareMedia?.({payload});");
    window.eval(&script).is_ok()
}

/// Handle one `carrier://share-inbox/<id>` open: read the inbox, focus the
/// window, and deliver — or park the payload for `deliver_pending` if the
/// page is not up yet (cold start).
pub(crate) fn handle_share_open(app: &tauri::AppHandle, url: &str) {
    let Some(id) = share_inbox_id(url) else {
        log::warn!("ignoring malformed carrier:// open");
        return;
    };
    let Some(payload) = take_inbox_payload(id) else {
        log::warn!("share inbox {id} was empty or invalid");
        return;
    };
    crate::tray::show_main(app);
    if !deliver(app, &payload) {
        return;
    }
    // Also park it: a page mid-reload evals into the void, and the page-load
    // hook below re-delivers. The page hook dedupes by taking the composer
    // path only once per payload id.
    let state = app.state::<AppState>();
    *state.pending_share.lock().unwrap() = Some(PendingShare {
        payload,
        received_at: Instant::now(),
    });
}

/// Re-deliver a parked share after a page load (cold start, or a reload that
/// raced the handoff). Drops anything older than [`SHARE_INTAKE_TTL`].
pub(crate) fn deliver_pending(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let mut pending = state.pending_share.lock().unwrap();
    let Some(share) = pending.take() else {
        return;
    };
    if share.received_at.elapsed() > SHARE_INTAKE_TTL {
        return;
    }
    let payload = share.payload;
    *pending = Some(PendingShare {
        payload: payload.clone(),
        received_at: share.received_at,
    });
    drop(pending);
    deliver(app, &payload);
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
