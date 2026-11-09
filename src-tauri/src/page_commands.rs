//! Commands the Messenger page calls to touch files: save-location prompts,
//! share-sheet downloads and image copies. `capabilities/default.json` grants
//! them only to facebook.com and messenger.com, and each request must carry
//! the calling window's own signature (see `chatpaneAuthorizedEmit` in
//! `window.rs`), so the page's own scripts cannot forge one.
//!
//! Results go back as signed `<event>-result` page events, as before: the
//! choose-download prompt reports twice, and the page verifies each one.

use serde::de::DeserializeOwned;
use tauri::{Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::{
    AppState, DownloadChoice, NativeResultPhase, SignedAction, downloads_dir, i18n,
    is_allowed_download, is_allowed_download_path, is_unsafe_download, reserve_prompted_download,
    sanitize_filename, send_choose_download_result, signed_action_window,
};

type CommandResult = Result<(), &'static str>;

/// Check that the calling window signed `signed` for `event`, then parse its
/// message. A window can act only for itself, never for another window.
fn verified<T: DeserializeOwned>(
    window: &WebviewWindow,
    event: &str,
    signed: &SignedAction,
) -> Result<T, &'static str> {
    if signed_action_window(window.app_handle(), event, signed).as_deref() != Some(window.label()) {
        log::warn!("{event} was not authorized by this window");
        return Err("not authorized");
    }
    serde_json::from_str(&signed.message).map_err(|_| {
        log::warn!("{event} message did not parse");
        "malformed request"
    })
}

/// In ask mode, the trusted click path asks for a save location before the
/// WebView download starts. Only the opaque URL key returns to the page; the
/// chosen path stays in `AppState` until `on_download` consumes it.
#[tauri::command]
pub(crate) async fn choose_download(window: WebviewWindow, signed: SignedAction) -> CommandResult {
    #[derive(serde::Deserialize)]
    struct ChooseDownloadMsg {
        url: String,
        name: String,
        request: String,
    }

    let event = "chatpane:choose-download";
    let msg: ChooseDownloadMsg = verified(&window, event, &signed)?;
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let asks = app
        .state::<AppState>()
        .settings
        .lock()
        .unwrap()
        .download_behavior
        == crate::settings::DownloadBehavior::Ask;
    let name = sanitize_filename(&msg.name);
    let allowed_url = url::Url::parse(&msg.url)
        .ok()
        .filter(|url| is_allowed_download(url, &name) && !is_unsafe_download(&name));
    let allowed = allowed_url.is_some();
    let Some(parsed_url) = allowed_url.filter(|_| asks) else {
        log::warn!("{event} rejected (ask mode: {asks}, allowed download: {allowed})");
        send_choose_download_result(
            &app,
            &label,
            &msg.request,
            DownloadChoice::Rejected,
            NativeResultPhase::Complete,
        );
        return Ok(());
    };

    let mut dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title(i18n::t("download.dialog.title"))
        .set_file_name(&name);
    if let Some(directory) = downloads_dir() {
        dialog = dialog.set_directory(directory);
    }
    let result_app = app.clone();
    let result_label = label.clone();
    let result_request = msg.request.clone();
    dialog.save_file(move |selection| {
        let choice = match selection.map(|path| path.into_path()) {
            None => DownloadChoice::Cancelled,
            Some(Err(_)) => {
                log::warn!("{event} selection was not a filesystem path");
                DownloadChoice::Rejected
            }
            Some(Ok(path)) if !is_allowed_download_path(&parsed_url, &path) => {
                log::warn!("{event} selection failed the download policy");
                DownloadChoice::Rejected
            }
            Some(Ok(path)) => {
                if reserve_prompted_download(&result_app, &result_label, &msg.url, path) {
                    DownloadChoice::Chosen
                } else {
                    log::warn!("{event} reservation cap was reached");
                    DownloadChoice::Rejected
                }
            }
        };
        send_choose_download_result(
            &result_app,
            &result_label,
            &result_request,
            choice,
            NativeResultPhase::Complete,
        );
    });
    send_choose_download_result(
        &app,
        &label,
        &msg.request,
        DownloadChoice::Chosen,
        NativeResultPhase::Presented,
    );
    Ok(())
}

/// Bind a claimed Share menu action to the download it is about to start.
#[tauri::command]
pub(crate) async fn prepare_download(window: WebviewWindow, signed: SignedAction) -> CommandResult {
    #[cfg(target_os = "macos")]
    {
        #[derive(serde::Deserialize)]
        struct PrepareDownloadMsg {
            action: String,
            url: String,
        }

        let msg: PrepareDownloadMsg = verified(&window, "chatpane:prepare-download", &signed)?;
        if !crate::prepare_context_download(
            window.app_handle(),
            window.label(),
            &msg.action,
            &msg.url,
        ) {
            log::warn!("chatpane:prepare-download had no unbound share action");
            return Err("no share action");
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, signed);
        Err("unsupported")
    }
}

/// Share a just-downloaded file through the macOS share sheet. The path comes
/// only from the trusted download map, never from the page.
#[tauri::command]
pub(crate) async fn share_download(window: WebviewWindow, signed: SignedAction) -> CommandResult {
    #[cfg(target_os = "macos")]
    {
        use crate::{consume_context_activation, send_share_download_result};

        #[derive(serde::Deserialize)]
        struct ShareDownloadMsg {
            download_id: String,
            x: f64,
            y: f64,
            action: String,
            request: String,
        }

        let msg: ShareDownloadMsg = verified(&window, "chatpane:share-download", &signed)?;
        let app = window.app_handle().clone();
        let label = window.label().to_string();
        if !consume_context_activation(&app, &label, &msg.action, Some(&msg.download_id)) {
            log::warn!("chatpane:share-download had no selected native menu action");
            send_share_download_result(&app, &label, &msg.request, false);
            return Ok(());
        }
        let Some(path) = crate::lookup_download_id(&msg.download_id) else {
            log::warn!("chatpane:share-download had no recent matching download");
            send_share_download_result(&app, &label, &msg.request, false);
            return Ok(());
        };
        let result_app = app.clone();
        let result_label = label.clone();
        let result_request = msg.request.clone();
        if let Err(error) = crate::macos::share::show_share_picker(
            move |shown| {
                send_share_download_result(&result_app, &result_label, &result_request, shown);
            },
            &app,
            &label,
            path,
            msg.x,
            msg.y,
        ) {
            log::warn!("failed to schedule macOS share picker: {error}");
            send_share_download_result(&app, &label, &msg.request, false);
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, signed);
        Err("unsupported")
    }
}

/// Copy an image the user picked from Chatpane's context menu to the macOS
/// pasteboard. Runs off the main thread: the pasteboard write hops to it.
#[tauri::command]
pub(crate) async fn copy_image(window: WebviewWindow, signed: SignedAction) -> CommandResult {
    #[cfg(target_os = "macos")]
    {
        use base64::Engine;

        use crate::{consume_context_activation, send_copy_image_result};

        #[derive(serde::Deserialize)]
        struct CopyImageMsg {
            data_url: String,
            action: String,
            request: String,
        }

        let event = "chatpane:copy-image";
        let msg: CopyImageMsg = verified(&window, event, &signed)?;
        let app = window.app_handle().clone();
        let label = window.label().to_string();
        let fail = |reason: &str| {
            log::warn!("{event} {reason}");
            send_copy_image_result(&app, &label, &msg.request, false);
            Ok(())
        };
        if !consume_context_activation(&app, &label, &msg.action, None) {
            return fail("had no selected native menu action");
        }
        let Some((header, encoded)) = msg.data_url.split_once(',') else {
            return fail("data URL did not parse");
        };
        if !header.starts_with("data:image/")
            || !header.ends_with(";base64")
            || encoded.len() > 44 * 1024 * 1024
        {
            return fail("data URL was invalid or too large");
        }
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
            return fail("base64 did not decode");
        };
        if bytes.len() > 32 * 1024 * 1024 {
            return fail("exceeded the clipboard size cap");
        }
        let copied = crate::macos::clipboard::copy_image(&app, bytes);
        send_copy_image_result(&app, &label, &msg.request, copied);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, signed);
        Err("unsupported")
    }
}
