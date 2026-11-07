//! File ▸ Export Conversation as HTML/JSON… (Ref #371). The page renders the
//! export from Messenger's local database; this side asks where to save it and
//! writes the file. Nothing is uploaded.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{Listener, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::download::{downloads_dir, is_unsafe_download, remember_download, sanitize_filename};
use crate::settings::AppState;
use crate::{NativeResultPhase, SignedAction, result_signature, signed_action_window};

pub(crate) const EVENT: &str = "carrier:export-conversation";
/// The request carries the whole rendered file. The page refuses exports over
/// 32 MiB before JSON-escaping them into the signed message.
pub(crate) const MESSAGE_MAX: usize = 64 * 1024 * 1024;
const REVEAL_PREFIX: &str = "carrier-export:";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Format {
    Html,
    Json,
}

impl Format {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "html" => Some(Self::Html),
            "json" => Some(Self::Json),
            _ => None,
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Html => "html",
            Self::Json => "json",
        }
    }

    fn filter_name(self) -> &'static str {
        match self {
            Self::Html => "Web page",
            Self::Json => "JSON",
        }
    }

    /// The page call the native menu item makes.
    pub(crate) fn page_script(self) -> String {
        format!(
            "window.__carrierExportConversation && window.__carrierExportConversation('{}')",
            self.extension()
        )
    }
}

#[derive(Deserialize)]
struct ExportMsg {
    request: String,
    format: String,
    name: String,
    content: String,
    reveal: String,
}

/// The suggested file name: the page's title stem, made safe, plus the format's extension.
fn suggested_file_name(name: &str, format: Format) -> String {
    let stem: String = sanitize_filename(name).chars().take(80).collect();
    format!("{}.{}", stem.trim(), format.extension())
}

/// The user may edit the name in the dialog; still refuse executable types.
fn destination_allowed(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| !is_unsafe_download(name))
}

/// The opaque key the page's toast uses to reveal the saved file.
fn reveal_url(reveal: &str) -> Option<url::Url> {
    let token = reveal.strip_prefix(REVEAL_PREFIX)?;
    if token.len() != 32 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    url::Url::parse(reveal).ok()
}

#[derive(Clone, Copy)]
enum Outcome {
    Saved,
    Cancelled,
    Failed,
}

fn send_result(
    app: &tauri::AppHandle,
    label: &str,
    request: &str,
    outcome: Outcome,
    phase: NativeResultPhase,
) {
    // Field order must match the result object carrierNativeCall verifies.
    #[derive(serde::Serialize)]
    struct ExportResult<'a> {
        request: &'a str,
        saved: bool,
        phase: NativeResultPhase,
        cancelled: bool,
    }

    let result_event = format!("{EVENT}-result");
    let result = ExportResult {
        request,
        saved: matches!(outcome, Outcome::Saved),
        phase,
        cancelled: matches!(outcome, Outcome::Cancelled),
    };
    let signature = app
        .state::<AppState>()
        .download_reveal_tokens
        .lock()
        .unwrap()
        .get(label)
        .and_then(|secret| result_signature(secret, &result_event, &result));
    let Some(signature) = signature else {
        log::warn!("failed to authenticate {result_event}");
        return;
    };
    let mut detail = serde_json::to_value(&result).expect("export result serializes");
    detail["signature"] = signature.into();
    if let Some(window) = app.get_webview_window(label)
        && let Err(error) = window.eval(format!(
            "window.dispatchEvent(new CustomEvent('{result_event}', {{ detail: {detail} }}));"
        ))
    {
        log::warn!("failed to report {result_event}: {error}");
    }
}

pub(crate) fn install(app: &tauri::AppHandle) {
    let handle = app.clone();
    app.listen_any(EVENT, move |event| {
        let Ok(signed) = serde_json::from_str::<SignedAction>(event.payload()) else {
            log::warn!("{EVENT} payload did not parse");
            return;
        };
        let Some(label) = signed_action_window(&handle, EVENT, &signed) else {
            log::warn!("{EVENT} was not authorized");
            return;
        };
        let Ok(msg) = serde_json::from_str::<ExportMsg>(&signed.message) else {
            log::warn!("{EVENT} message did not parse");
            return;
        };
        if msg.request.len() != 32 || !msg.request.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            log::warn!("{EVENT} had an invalid request token");
            return;
        }
        let (Some(format), Some(reveal)) = (Format::parse(&msg.format), reveal_url(&msg.reveal))
        else {
            log::warn!("{EVENT} had an invalid format or reveal key");
            send_result(
                &handle,
                &label,
                &msg.request,
                Outcome::Failed,
                NativeResultPhase::Complete,
            );
            return;
        };
        let Some(window) = handle.get_webview_window(&label) else {
            log::warn!("{EVENT} window was no longer available");
            return;
        };

        let mut dialog = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Export Conversation")
            .set_file_name(suggested_file_name(&msg.name, format))
            .add_filter(format.filter_name(), &[format.extension()]);
        if let Some(directory) = downloads_dir() {
            dialog = dialog.set_directory(directory);
        }
        let result_handle = handle.clone();
        let result_label = label.clone();
        let request = msg.request.clone();
        let content = msg.content;
        dialog.save_file(move |selection| {
            let Some(selection) = selection else {
                send_result(
                    &result_handle,
                    &result_label,
                    &request,
                    Outcome::Cancelled,
                    NativeResultPhase::Complete,
                );
                return;
            };
            let path: Option<PathBuf> = selection
                .into_path()
                .ok()
                .filter(|path| destination_allowed(path));
            let Some(path) = path else {
                log::warn!("{EVENT} destination was refused");
                send_result(
                    &result_handle,
                    &result_label,
                    &request,
                    Outcome::Failed,
                    NativeResultPhase::Complete,
                );
                return;
            };
            tauri::async_runtime::spawn_blocking(move || {
                let outcome = match std::fs::write(&path, content.as_bytes()) {
                    Ok(()) => {
                        let id = reveal.path().to_string();
                        remember_download(&reveal, id, path);
                        Outcome::Saved
                    }
                    Err(error) => {
                        log::warn!("failed to write conversation export: {error}");
                        Outcome::Failed
                    }
                };
                send_result(
                    &result_handle,
                    &result_label,
                    &request,
                    outcome,
                    NativeResultPhase::Complete,
                );
            });
        });
        // The dialog can stay open indefinitely; acknowledge it so the page
        // drops its response timeout.
        send_result(
            &handle,
            &label,
            &msg.request,
            Outcome::Saved,
            NativeResultPhase::Presented,
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggests_a_safe_name_with_the_format_extension() {
        assert_eq!(
            suggested_file_name("Weekend plans", Format::Html),
            "Weekend plans.html"
        );
        assert_eq!(suggested_file_name("a/b:c", Format::Json), "a_b_c.json");
        assert_eq!(suggested_file_name("...", Format::Json), "download.json");
        let long = "x".repeat(200);
        assert_eq!(
            suggested_file_name(&long, Format::Html),
            format!("{}.html", "x".repeat(80))
        );
    }

    #[test]
    fn refuses_executable_destinations() {
        assert!(destination_allowed(Path::new("/tmp/chat.html")));
        assert!(destination_allowed(Path::new("/tmp/chat")));
        assert!(!destination_allowed(Path::new("/tmp/chat.sh")));
        assert!(!destination_allowed(Path::new("/tmp/chat.exe")));
    }

    #[test]
    fn accepts_only_opaque_reveal_keys() {
        let key = format!("{REVEAL_PREFIX}{}", "a".repeat(32));
        assert_eq!(reveal_url(&key).map(|url| url.to_string()), Some(key));
        assert!(reveal_url("carrier-export:short").is_none());
        assert!(reveal_url(&format!("https://{}", "a".repeat(32))).is_none());
        assert!(reveal_url(&format!("{REVEAL_PREFIX}{}", "g".repeat(32))).is_none());
    }

    #[test]
    fn parses_only_known_formats() {
        assert_eq!(Format::parse("html"), Some(Format::Html));
        assert_eq!(Format::parse("json"), Some(Format::Json));
        assert_eq!(Format::parse("pdf"), None);
        assert!(Format::Json.page_script().ends_with("('json')"));
    }
}
