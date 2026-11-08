//! Log Out, and Log Out and Reset Carrier… (Ref #356). Both run Facebook's
//! own logout in the Messenger page, so the session ends on Facebook's side
//! too. The reset then deletes everything Carrier keeps for the account and
//! restarts; `settings.json` stays.

use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::settings::AppState;

/// File/app menu and tray: Log Out.
pub(crate) fn log_out(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match crate::account::page_request(&app, "log-out", serde_json::Value::Null).await {
            Ok(_) => {
                log::info!("logged out of Facebook");
                forget_account_in_memory(&app);
                show_login_page(&app);
            }
            Err(error) => {
                log::warn!("log out failed: {error}");
                message(
                    &app,
                    "Couldn't Log Out",
                    &format!("Facebook didn't end the session. {error}"),
                );
            }
        }
    });
}

/// File/app menu and tray: Log Out and Reset Carrier…, after confirmation.
pub(crate) fn confirm_reset(app: &tauri::AppHandle) {
    let handle = app.clone();
    let mut dialog = app
        .dialog()
        .message(
            "Carrier logs you out of Facebook, deletes everything it stored for this account \
             (cookies, Messenger's data and cache, notification history and recent \
             conversations) and restarts. Your Carrier settings are kept.",
        )
        .title("Log Out and Reset Carrier")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Log Out and Reset".into(),
            "Cancel".into(),
        ));
    if let Some(window) = crate::menu::target_window(app) {
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
            "Couldn't Reset Carrier",
            &format!("Carrier couldn't prepare the reset: {error}"),
        );
        return;
    }
    forget_account_in_memory(&app);
    forget_delivered_notifications(&app);
    match logged_out {
        Ok(_) => {
            log::info!("logged out of Facebook; resetting Carrier");
            app.restart();
        }
        Err(error) => {
            log::warn!("log out failed before the reset: {error}");
            let handle = app.clone();
            app.dialog()
                .message(format!(
                    "Facebook didn't end the session ({error}). Carrier still deletes this \
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

/// Every Messenger window shows Facebook's login page afterwards.
fn show_login_page(app: &tauri::AppHandle) {
    let Ok(url) = tauri::Url::parse(crate::HOME_URL) else {
        return;
    };
    for (label, window) in app.webview_windows() {
        if crate::window::is_messenger_window_label(&label)
            && let Err(error) = window.navigate(url.clone())
        {
            log::warn!("failed to show the login page in {label}: {error}");
        }
    }
}

fn message(app: &tauri::AppHandle, title: &str, text: &str) {
    let mut dialog = app
        .dialog()
        .message(text)
        .title(title)
        .kind(MessageDialogKind::Warning);
    if let Some(window) = crate::menu::target_window(app) {
        dialog = dialog.parent(&window);
    }
    dialog.show(|_| {});
}
