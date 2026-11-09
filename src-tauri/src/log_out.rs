//! Log Out… (Ref #356). Runs Facebook's own logout in the Messenger page, so
//! the session ends on Facebook's side too, then deletes everything Chatpane
//! keeps for the account and restarts; `settings.json` stays.

use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::settings::AppState;

/// File/app menu and tray: Log Out…, after confirmation.
pub(crate) fn log_out(app: &tauri::AppHandle) {
    let handle = app.clone();
    let mut dialog = app
        .dialog()
        .message(
            "Chatpane logs you out of Facebook, deletes what it stored for this account on \
             this computer (cookies, Messenger's data and cache, notification history and \
             recent conversations) and restarts. Your Chatpane settings are kept.",
        )
        .title("Log Out")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Log Out".into(),
            "Cancel".into(),
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
            "Couldn't Log Out",
            &format!("Chatpane couldn't prepare the log out: {error}"),
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
                .message(format!(
                    "Facebook didn't end the session ({error}). Chatpane still deletes this \
                     account's data from this computer and restarts. To end the session on \
                     Facebook too, log out of this device in Facebook's \"Where you're logged \
                     in\" settings."
                ))
                .title("Couldn't Log Out of Facebook")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCustom("Restart".into()))
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
