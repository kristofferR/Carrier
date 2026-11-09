//! Log Out… (Ref #356). Runs Facebook's own logout in the Messenger page, so
//! the session ends on Facebook's side too, then deletes everything Chatpane
//! keeps for the account and restarts; `settings.json` stays.

use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::i18n::{t, tf};
use crate::settings::AppState;

/// File/app menu and tray: Log Out…, after confirmation.
pub(crate) fn log_out(app: &tauri::AppHandle) {
    let handle = app.clone();
    let mut dialog = app
        .dialog()
        .message(t("dialog.log_out.message"))
        .title(t("dialog.log_out.title"))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            t("dialog.log_out.confirm").into(),
            t("dialog.cancel").into(),
        ));
    if let Some(window) = crate::menu::dialog_parent(app) {
        dialog = dialog.parent(&window);
    }
    dialog.show(move |confirmed| {
        if confirmed {
            tauri::async_runtime::spawn(reset(handle));
        }
    });
}

async fn reset(app: tauri::AppHandle) {
    let logged_out = crate::account::page_request(&app, "log-out", serde_json::Value::Null).await;
    if let Err(error) = crate::settings::schedule_account_reset(&app) {
        log::error!("failed to schedule the account reset: {error}");
        message(
            &app,
            t("dialog.log_out.failed_title"),
            &tf("dialog.log_out.failed_message", &[("error", &error)]),
        );
        return;
    }
    forget_account_in_memory(&app);
    forget_delivered_notifications(&app);
    match logged_out {
        Ok(_) => {
            log::info!("logged out of Facebook; clearing the account and restarting");
            app.restart();
        }
        Err(error) => {
            log::warn!("log out failed before the reset: {error}");
            let handle = app.clone();
            app.dialog()
                .message(tf(
                    "dialog.log_out.facebook_failed_message",
                    &[("error", &error)],
                ))
                .title(t("dialog.log_out.facebook_failed_title"))
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCustom(
                    t("dialog.log_out.restart").into(),
                ))
                .show(move |_| handle.restart());
        }
    }
}

/// Recent conversations and the unread count belong to the old account: empty
/// the Dock, tray and jump-list menus and clear the badges now. The login page
/// never reports them (an empty chat list keeps the badge reader waiting).
fn forget_account_in_memory(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    state.recent_threads.lock().unwrap().clear();
    state
        .unread_count
        .store(0, std::sync::atomic::Ordering::Release);
    let settings = state.settings.lock().unwrap().clone();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        crate::menu::rebuild_recent_menus(&handle);
        crate::refresh_unread_indicators(&handle, &settings, 0);
    });
}

/// Remove the account's notifications from the system's notification list,
/// and the cached sender avatars.
fn forget_delivered_notifications(app: &tauri::AppHandle) {
    crate::notifications::remove_avatar_cache();
    #[cfg(target_os = "macos")]
    crate::macos::notifications::clear_all_delivered();
    #[cfg(target_os = "windows")]
    crate::windows::toast::clear_all(app);
    let _ = app;
}

fn message(app: &tauri::AppHandle, title: &str, text: &str) {
    let mut dialog = app
        .dialog()
        .message(text)
        .title(title)
        .kind(MessageDialogKind::Warning);
    if let Some(window) = crate::menu::dialog_parent(app) {
        dialog = dialog.parent(&window);
    }
    dialog.show(|_| {});
}
