//! Share-into-Carrier intake (Ref #213): the share extension serializes the
//! shared files onto a private named pasteboard and opens
//! `carrier://share-pasteboard`; this module validates that handoff and
//! delivers the files to the page.
//!
//! Trust model: anything local can write that pasteboard and fire the URL, so
//! nothing read here is trusted — the payload must parse as the expected
//! shape, within count and size caps, with traversal-free names, before a
//! single byte reaches the page. Even then it only becomes a composer
//! attachment the user still has to send.

use std::time::{Duration, Instant};

use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::NSString;
use tauri::Manager;

use crate::settings::AppState;

const PASTEBOARD_NAME: &str = "io.github.kristofferr.carrier.share";
pub(crate) const SHARE_HANDOFF_URL: &str = "carrier://share-pasteboard";
/// The extension's activation rule allows up to 10 images + 1 movie + 10
/// files in one mixed selection, so the intake must accept every selection
/// the sheet can produce.
const MAX_SHARED_FILES: usize = 21;
/// Base64 of the extension's 100 MB cap, with slack for encoding overhead.
const MAX_PAYLOAD_LEN: usize = 140 * 1024 * 1024;
const MAX_NAME_LEN: usize = 255;
/// An undelivered share expires rather than surprising the user minutes later.
pub(crate) const SHARE_INTAKE_TTL: Duration = Duration::from_secs(2 * 60);

pub(crate) struct PendingShare {
    payload: String,
    received_at: Instant,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct SharedFile {
    name: String,
    data: String,
}

/// Whether this open is the share handoff (the only `carrier://` URL Carrier
/// answers).
pub(crate) fn is_share_handoff(url: &str) -> bool {
    url.trim_end_matches('/') == SHARE_HANDOFF_URL
}

/// A name is only ever used as a composer attachment's file name: no path
/// separators, no traversal, no dotfiles, nothing unbounded.
fn name_is_safe(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_LEN
        && !name.starts_with('.')
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
}

/// Validate the raw pasteboard string into the JSON the page hook receives.
pub(crate) fn validate_payload(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.len() > MAX_PAYLOAD_LEN {
        return None;
    }
    let files: Vec<SharedFile> = serde_json::from_str(raw).ok()?;
    if files.is_empty() || files.len() > MAX_SHARED_FILES {
        return None;
    }
    if !files
        .iter()
        .all(|file| name_is_safe(&file.name) && !file.data.is_empty())
    {
        return None;
    }
    serde_json::to_string(&files).ok()
}

/// Read and clear the handoff pasteboard. Must run on the main thread.
fn take_pasteboard_payload() -> Option<String> {
    // SAFETY: standard NSPasteboard reads on the main thread; every value is
    // checked for null before use and the string is copied out immediately.
    unsafe {
        let name = NSString::from_str(PASTEBOARD_NAME);
        let pasteboard: *mut AnyObject =
            msg_send![class!(NSPasteboard), pasteboardWithName: &*name];
        if pasteboard.is_null() {
            return None;
        }
        let string_type = NSString::from_str("public.utf8-plain-string");
        let value: *mut AnyObject = msg_send![pasteboard, stringForType: &*string_type];
        let raw = (!value.is_null()).then(|| {
            let value = &*(value as *mut NSString);
            value.to_string()
        });
        // Clear either way: a payload we refuse must not linger for the next
        // handoff to pick up.
        let _: isize = msg_send![pasteboard, clearContents];
        raw
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

/// Handle one `carrier://share-pasteboard` open: take and validate the
/// payload, park it, surface the window, and attempt delivery. Parking comes
/// first — the pasteboard is cleared by now, so this in-memory copy must
/// survive a missing window (e.g. a theme rebuild in flight).
pub(crate) fn handle_share_open(app: &tauri::AppHandle, url: &str) {
    if !is_share_handoff(url) {
        log::warn!("ignoring unknown carrier:// open");
        return;
    }
    let Some(payload) = take_pasteboard_payload()
        .as_deref()
        .and_then(validate_payload)
    else {
        log::warn!("share handoff carried no valid payload");
        return;
    };
    let state = app.state::<AppState>();
    *state.pending_share.lock().unwrap() = Some(PendingShare {
        payload,
        received_at: Instant::now(),
    });
    log::info!("share handoff accepted");
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

    fn payload(files: &[(&str, &str)]) -> String {
        let entries: Vec<serde_json::Value> = files
            .iter()
            .map(|(name, data)| serde_json::json!({ "name": name, "data": data }))
            .collect();
        serde_json::to_string(&entries).expect("payload serializes")
    }

    #[test]
    fn only_the_share_handoff_url_is_answered() {
        assert!(is_share_handoff("carrier://share-pasteboard"));
        assert!(is_share_handoff("carrier://share-pasteboard/"));
        assert!(!is_share_handoff("carrier://share-pasteboard/extra"));
        assert!(!is_share_handoff("carrier://something-else"));
        assert!(!is_share_handoff("https://share-pasteboard"));
    }

    #[test]
    fn a_well_formed_payload_survives_validation() {
        let raw = payload(&[("photo.png", "aGk="), ("clip.mov", "aGk=")]);
        let validated = validate_payload(&raw).expect("payload is valid");
        assert!(validated.contains("photo.png"));
        assert!(validated.contains("clip.mov"));
    }

    #[test]
    fn payloads_with_unsafe_names_are_refused_whole() {
        for name in [
            "../escape.png",
            "dir/photo.png",
            ".hidden",
            "",
            "back\\slash.png",
        ] {
            assert_eq!(
                validate_payload(&payload(&[("ok.png", "aGk="), (name, "aGk=")])),
                None,
                "{name} should be refused"
            );
        }
    }

    #[test]
    fn malformed_empty_and_oversized_payloads_are_refused() {
        assert_eq!(validate_payload(""), None);
        assert_eq!(validate_payload("not json"), None);
        assert_eq!(validate_payload("[]"), None);
        assert_eq!(validate_payload(r#"[{"name":"a.png"}]"#), None);
        assert_eq!(validate_payload(&payload(&[("a.png", "")])), None);

        let too_many: Vec<(&str, &str)> = (0..MAX_SHARED_FILES + 1)
            .map(|_| ("a.png", "aGk="))
            .collect();
        assert_eq!(validate_payload(&payload(&too_many)), None);
    }
}
