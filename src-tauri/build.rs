/// Every command in `generate_handler!`. Declaring them gives each an
/// `allow-<command>` permission and makes Tauri check all of them against the
/// capabilities, so no window or origin reaches a command it is not granted.
const COMMANDS: &[&str] = &[
    "window_control",
    "get_settings",
    "autostart_status",
    "open_login_items",
    "update_setting",
    "reset_settings",
    "check_for_updates",
    "update_install_mode",
    "open_manual_update",
    "discovered_update",
    "update_release_notes",
    "install_update",
    "connect_messenger",
    "open_messenger_anyway",
    "open_log_folder",
    "restart_app",
    "open_custom_css",
    "send_test_notification",
    "copy_share_message",
    "open_github",
    "messenger_account",
    "set_messenger_account",
    "messenger_profile",
    "log_out",
    "open_facebook_language",
    "list_themes",
    "add_theme",
    "remove_theme",
    "open_themes_folder",
    "open_theme_guide",
    "list_fonts",
    "notification_sounds",
    "choose_notification_sound",
    "preview_notification_sound",
    "copy_messenger_sound",
    "choose_download",
    "prepare_download",
    "share_download",
    "copy_image",
];

fn main() {
    println!("cargo:rerun-if-env-changed=CHATPANE_BUILD_REVISION");
    let revision = std::env::var("CHATPANE_BUILD_REVISION").unwrap_or_else(|_| "local".into());
    assert!(
        revision == "local"
            || (revision.len() == 40 && revision.bytes().all(|b| b.is_ascii_hexdigit()))
    );
    println!("cargo:rustc-env=CHATPANE_BUILD_REVISION={revision}");
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run the Tauri build script");
}
