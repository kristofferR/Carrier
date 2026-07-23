//! Carrier — a tiny, distraction-free desktop client for Facebook Messenger.
//!
//! Opens a WebView window pointed at the Messenger web app, injects a stylesheet
//! that hides Facebook's surrounding chrome, and adds quality-of-life features:
//! shortcuts, zoom, an image viewer, a settings panel, copy/download image,
//! native notifications, theme sync, and tracking-redirect-free external links.
//! Anything that isn't Messenger is handed to the user's default browser.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Listener, Manager};
use tauri_plugin_opener::OpenerExt;
mod commands;
mod custom_css;
mod diag;
mod download;
mod hotkey;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod menu;
mod notifications;
mod preflight;
mod settings;
mod tray;
mod url_rules;
mod webview_watchdog;
mod window;

use diag::{parse_diag_payload, sanitize_diag, DIAG_SESSION_CAP, LOG_FILE_MAX_BYTES};
use download::lookup_download;
use hotkey::reconcile_startup_global_hotkey;
#[cfg(target_os = "linux")]
use linux::observe_system_theme_changes;
#[cfg(target_os = "macos")]
use macos::{
    dock::install_dock_menu_provider, notifications::setup_macos_notifications,
    theme::observe_system_theme_changes,
};
use menu::{rebuild_recent_menus, sanitize_recent_threads, RecentThread};
use notifications::{
    clear_avatar_cache, show_message_notification, show_sync_alert, update_notification_route,
    NotifyMsg, NotifyRouteMsg, SyncAlertKind, SyncAlertSource,
};
use settings::AppState;
use settings::{
    apply_settings, clamp_zoom, clear_pending_webview_data, load_settings, load_settings_early,
    save_settings, SaveOutcome,
};
use tray::show_main;
#[cfg(target_os = "macos")]
use tray::{reopen_main_if_needed, tray_unread_title};
use window::{build_app_window, install_main_close_handler, show_settings_window};

fn valid_download_reveal_token(tokens: &HashMap<String, String>, candidate: &str) -> bool {
    !candidate.is_empty() && tokens.values().any(|token| token == candidate)
}

/// The page we wrap.
const HOME_URL: &str = "https://www.facebook.com/messages";
const HOME_HOST: &str = "www.facebook.com";
const HOME_PORT: u16 = 443;
const MESSENGER_DNS_TIMEOUT: Duration = Duration::from_millis(1500);

/// Window/app title. Debug builds are marked so a dev build (e.g. the
/// tauri-mcp one) isn't mistaken for a release install.
const APP_TITLE: &str = if cfg!(debug_assertions) {
    "Carrier (debug)"
} else {
    "Carrier"
};

/// Injected assets (see `inject/`).
const INJECT_CSS: &str = include_str!("../inject/messenger.css");
const INJECT_JS: &str = include_str!("../inject/messenger.js");
const INJECT_PANEL: &str = include_str!("../inject/panel.js");

// The `mcp` feature wires a JS-eval responder into the remote Facebook page and
// opens a local control socket — strictly a dev tool. Enabling it in a release
// build is always a mistake, so fail the build loudly rather than risk shipping
// it.
#[cfg(all(feature = "mcp", not(debug_assertions)))]
compile_error!("the `mcp` feature is dev-only and must not be enabled in release builds");

// Dev-only (`mcp` feature): the tauri-plugin-mcp guest responder, injected into
// the remote Facebook page so execute_js / get_dom round-trips work. Empty in
// release builds, so the JS-eval responder never ships.
#[cfg(all(feature = "mcp", debug_assertions))]
const INJECT_MCP_BRIDGE: &str = include_str!("../inject/mcp-bridge.js");
#[cfg(not(all(feature = "mcp", debug_assertions)))]
const INJECT_MCP_BRIDGE: &str = "";

/// A modern browser UA so Facebook serves the full Messenger web app.
const fn user_agent() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
         (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
    }
    #[cfg(target_os = "windows")]
    {
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
         (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
    #[cfg(target_os = "linux")]
    {
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 \
         (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
}

#[cfg(any(test, target_os = "linux"))]
fn should_disable_webkit_dmabuf_renderer(
    has_wayland_display: bool,
    has_dmabuf_override: bool,
) -> bool {
    has_wayland_display && !has_dmabuf_override
}

#[cfg(target_os = "linux")]
fn configure_linux_webkit_renderer() {
    if should_disable_webkit_dmabuf_renderer(
        std::env::var_os("WAYLAND_DISPLAY").is_some(),
        std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some(),
    ) {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

fn should_enforce_single_instance(
    multi_instance: bool,
    mcp_debug_build: bool,
    has_isolated_mcp_socket: bool,
) -> bool {
    if mcp_debug_build {
        !has_isolated_mcp_socket
    } else {
        !multi_instance
    }
}

#[cfg(any(all(feature = "mcp", debug_assertions), test))]
fn select_isolated_mcp_socket(
    primary: Option<std::ffi::OsString>,
    fallback: Option<std::ffi::OsString>,
) -> Option<std::path::PathBuf> {
    primary
        .filter(|path| !path.is_empty())
        .or_else(|| fallback.filter(|path| !path.is_empty()))
        .map(std::path::PathBuf::from)
}

pub fn run() {
    #[cfg(target_os = "linux")]
    configure_linux_webkit_renderer();

    let initial = load_settings_early();

    let mut builder = tauri::Builder::default();

    // Only an explicitly isolated MCP socket opts a debug build out of
    // single-instance enforcement. Two default-socket builds would otherwise
    // contend for /tmp/tauri-mcp.sock.
    #[cfg(all(feature = "mcp", debug_assertions))]
    let isolated_mcp_socket = select_isolated_mcp_socket(
        std::env::var_os("CARRIER_MCP_SOCKET_PATH"),
        std::env::var_os("TAURI_MCP_IPC_PATH"),
    );
    #[cfg(not(all(feature = "mcp", debug_assertions)))]
    let isolated_mcp_socket: Option<std::path::PathBuf> = None;
    if should_enforce_single_instance(
        initial.multi_instance,
        cfg!(all(feature = "mcp", debug_assertions)),
        isolated_mcp_socket.is_some(),
    ) {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }));
    }

    // Dev-only (the `mcp` feature): expose the webview to tauri-plugin-mcp for
    // DOM/JS inspection. Restrict it to debug builds even when the Cargo feature
    // is accidentally enabled for a release build.
    #[cfg(all(feature = "mcp", debug_assertions))]
    {
        let socket_path = isolated_mcp_socket
            .clone()
            .unwrap_or_else(|| "/tmp/tauri-mcp.sock".into());
        builder = builder.plugin(tauri_plugin_mcp::init_with_config(
            tauri_plugin_mcp::PluginConfig::new(APP_TITLE.to_string())
                .start_socket_server(true)
                .socket_path(socket_path),
        ));
    }

    builder
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // The summon shortcut itself is (un)registered in `apply_settings`,
        // following the Global Hotkey setting.
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Persist geometry only — NOT visibility, so the app always shows
                // its window on launch (unless Start to Tray) rather than coming
                // back hidden after a previous hide-to-tray.
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .with_denylist(&["settings"]) // fixed-size dialog; don't persist its geometry
                .build(),
        )
        // Warnings and errors land in a file under the app log dir (surfaced
        // via Settings → Advanced → Open log folder) besides stderr. Global
        // level Warn keeps dependency noise out; Carrier's own info lines
        // still make it through.
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                ])
                .level(log::LevelFilter::Warn)
                .level_for("carrier_lib", log::LevelFilter::Info)
                .max_file_size(LOG_FILE_MAX_BYTES)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
        .manage(AppState {
            settings: Mutex::new(initial.clone()),
            settings_worker: tokio::sync::Mutex::new(()),
            tray: Mutex::new(None),
            next_window: AtomicUsize::new(2),
            update_installing: std::sync::atomic::AtomicBool::new(false),
            update_checking: tokio::sync::Mutex::new(()),
            update_available: Mutex::new(None),
            update_check_wake: tokio::sync::Notify::new(),
            tray_notice_delivered: std::sync::atomic::AtomicBool::new(initial.tray_notice_shown),
            revealing_main: AtomicUsize::new(0),
            next_reveal_generation: AtomicUsize::new(0),
            zoom_generation: AtomicUsize::new(0),
            recreating: std::sync::atomic::AtomicBool::new(false),
            recent_threads: Mutex::new(Vec::new()),
            download_reveal_tokens: Mutex::new(HashMap::new()),
        })
        .menu(menu::build_menu)
        .on_menu_event(menu::handle_menu_event)
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::set_settings,
            commands::reset_settings,
            commands::check_for_updates,
            commands::update_install_mode,
            commands::open_manual_update,
            commands::discovered_update,
            commands::install_update,
            commands::connect_messenger,
            commands::open_messenger_anyway,
            commands::open_log_folder,
            commands::open_custom_css
        ])
        .setup(move |app| {
            // Event listening is needed only by the development MCP responder.
            // Add it dynamically so release builds never grant remote Facebook
            // scripts access to app events.
            #[cfg(all(feature = "mcp", debug_assertions))]
            app.add_capability(include_str!("../dev-capabilities/mcp.json"))?;

            clear_pending_webview_data(app.handle());

            let mut settings = load_settings(app.handle());
            *app.state::<AppState>().settings.lock().unwrap() = settings.clone();

            let window = build_app_window(app.handle(), "main", &settings)?;

            // Close button: hide to tray (if enabled) instead of quitting.
            // A themed rebuild reinstalls this on the new main window too.
            install_main_close_handler(app.handle(), &window);

            // Follow live OS light/dark switches while Theme = System (macOS only;
            // other platforms re-theme the chrome on their own). Registered once —
            // the observer is process-wide and survives the window rebuilds.
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            observe_system_theme_changes(app.handle());

            // Don't sync autostart at startup; the OS registration already
            // reflects the user's last explicit choice.
            reconcile_startup_global_hotkey(app.handle(), &mut settings);
            *app.state::<AppState>().settings.lock().unwrap() = settings.clone();
            apply_settings(app.handle(), &settings);

            // Start hidden only when a tray was actually created to reopen from.
            let has_tray = app.state::<AppState>().tray.lock().unwrap().is_some();
            if settings.start_to_tray && has_tray {
                let _ = window.hide();
            }

            // The Facebook page is a remote origin and can't call Carrier's own
            // commands, so the F3 shortcut emits an event that we handle here.
            let h = app.handle().clone();
            app.listen_any("carrier:open-settings", move |_| {
                let h = h.clone();
                tauri::async_runtime::spawn(async move { show_settings_window(&h) });
            });

            // The injected toast handler echoes the download URL together with
            // its closure-scoped per-window secret. Remote page scripts can emit
            // this event too, so require that authorization before resolving the
            // URL through the trusted map populated by `on_download`; a page-
            // supplied filesystem path is never accepted.
            let reveal_handle = app.handle().clone();
            app.listen_any("carrier:reveal-download", move |event| {
                #[derive(serde::Deserialize)]
                struct RevealDownloadMsg {
                    url: String,
                    authorization: String,
                }

                let Ok(msg) = serde_json::from_str::<RevealDownloadMsg>(event.payload()) else {
                    log::warn!("carrier:reveal-download payload did not parse");
                    return;
                };
                let authorized = {
                    let state = reveal_handle.state::<AppState>();
                    let tokens = state.download_reveal_tokens.lock().unwrap();
                    valid_download_reveal_token(&tokens, &msg.authorization)
                };
                if !authorized {
                    log::warn!("carrier:reveal-download was not authorized by a trusted click");
                    return;
                }
                let Some(path) = lookup_download(&msg.url) else {
                    log::warn!("carrier:reveal-download had no recent matching download");
                    return;
                };
                let h = reveal_handle.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(error) = h.opener().reveal_item_in_dir(path) {
                        log::warn!("failed to reveal recent download: {error}");
                    }
                });
            });

            // Unread count from the page → tray tooltip (the Dock badge is set
            // page-side; this keeps the tray useful in menu-bar-only mode).
            let h = app.handle().clone();
            app.listen_any("carrier:unread", move |event| {
                let n: i64 = event.payload().trim().parse().unwrap_or(0);
                let state = h.state::<AppState>();
                let settings = state.settings.lock().unwrap().clone();
                let tray_n = if settings.unread_badge { n } else { 0 };
                let tray = state.tray.lock().unwrap();
                if let Some(tray) = tray.as_ref() {
                    let tip = if tray_n > 0 {
                        format!("{APP_TITLE} — {tray_n} unread")
                    } else {
                        APP_TITLE.to_string()
                    };
                    let _ = tray.set_tooltip(Some(&tip));
                    #[cfg(target_os = "macos")]
                    {
                        let _ = tray.set_title(tray_unread_title(&settings, tray_n));
                    }
                }
            });

            // Keyboard/menu zoom from the page → persist it in settings so the
            // Settings window, other Messenger windows, and the next launch pick
            // it up. The payload comes from the remote-origin page, so treat it
            // as untrusted: parse, clamp, and ignore junk.
            let h = app.handle().clone();
            app.listen_any("carrier:zoom", move |event| {
                let Ok(zoom) = event.payload().trim().parse::<i32>() else {
                    return;
                };
                let zoom = clamp_zoom(zoom);
                let generation = h
                    .state::<AppState>()
                    .zoom_generation
                    .fetch_add(1, Ordering::AcqRel)
                    .wrapping_add(1);
                let h = h.clone();
                // Event listeners run on the UI thread. Waiting there on the
                // settings transaction can deadlock with a concurrent save
                // that is applying native window changes on that same thread.
                tauri::async_runtime::spawn(async move {
                    let worker_h = h.clone();
                    let state = h.state::<AppState>();
                    let _settings_worker = state.settings_worker.lock().await;
                    if state.zoom_generation.load(Ordering::Acquire) != generation {
                        return;
                    }
                    if let Err(e) = tauri::async_runtime::spawn_blocking(move || {
                        let state = worker_h.state::<AppState>();
                        let s = {
                            let settings = state.settings.lock().unwrap();
                            if settings.zoom == zoom {
                                return;
                            }
                            let mut next = settings.clone();
                            next.zoom = zoom;
                            next
                        };
                        match save_settings(&worker_h, &s) {
                            Ok(SaveOutcome::Written) => {
                                *state.settings.lock().unwrap() = s.clone();
                                apply_settings(&worker_h, &s);
                            }
                            Ok(SaveOutcome::Superseded) => {
                                log::warn!("zoom settings update was superseded");
                            }
                            Err(e) => {
                                log::error!("failed to save settings: {e}");
                            }
                        }
                    })
                    .await
                    {
                        log::error!("zoom settings worker failed: {e}");
                    }
                });
            });

            // Recent conversations scraped from the page's chat list → the
            // macOS Dock menu / tray menu. Kept in memory only; the menus are
            // rebuilt on the main thread (menu APIs require it on macOS).
            let h = app.handle().clone();
            app.listen_any("carrier:recent-threads", move |event| {
                let Ok(threads) = serde_json::from_str::<Vec<RecentThread>>(event.payload()) else {
                    return;
                };
                let threads = sanitize_recent_threads(threads);
                {
                    let state = h.state::<AppState>();
                    let mut current = state.recent_threads.lock().unwrap();
                    if *current == threads {
                        return;
                    }
                    *current = threads;
                }
                let handle = h.clone();
                let _ = h.run_on_main_thread(move || rebuild_recent_menus(&handle));
            });

            // New-message notifications: the page's `Notification` bridge sends
            // sender/preview/avatar here; we render them natively (with the
            // avatar), notify you while Carrier is in the background, and open the
            // conversation on click. See `show_message_notification`.
            clear_avatar_cache();
            // macOS delivery now goes through UNUserNotificationCenter under the
            // app's own bundle id (set up in `setup_macos_notifications` once the
            // app is ready), so there's no per-process registration to do here.
            let notify_handle = app.handle().clone();
            app.listen_any("carrier:notify", move |event| {
                // Content-free receipt breadcrumb: with the page-side
                // `notify.fired` diag and the macOS delivery logging, every
                // hop of the notification pipeline is visible in the log.
                match serde_json::from_str::<NotifyMsg>(event.payload()) {
                    Ok(msg) => {
                        log::info!("carrier:notify received (id {})", msg.id());
                        show_message_notification(notify_handle.clone(), msg);
                    }
                    Err(e) => log::warn!("carrier:notify payload did not parse: {e}"),
                }
            });

            // Health notice from the page's sync monitor: a native heads-up
            // when Messenger's data sync degrades while the app looks fine.
            // Fixed strings only — the remote page's text is never rendered.
            let sync_alert_handle = app.handle().clone();
            app.listen_any("carrier:sync-alert", move |event| {
                #[derive(serde::Deserialize)]
                struct SyncAlertMsg {
                    kind: SyncAlertKind,
                }
                match serde_json::from_str::<SyncAlertMsg>(event.payload()) {
                    Ok(msg) => {
                        show_sync_alert(sync_alert_handle.clone(), SyncAlertSource::Page, msg.kind);
                    }
                    Err(e) => log::warn!("carrier:sync-alert payload did not parse: {e}"),
                }
            });

            // Late route update for a page-first notification (see
            // `update_notification_route`): the row-driven pairing found the
            // conversation after the native notification had already fired.
            app.listen_any(
                "carrier:notify-route",
                move |event| match serde_json::from_str::<NotifyRouteMsg>(event.payload()) {
                    Ok(msg) => update_notification_route(&msg),
                    Err(e) => log::warn!("carrier:notify-route payload did not parse: {e}"),
                },
            );

            // Page diagnostics (`diag()` in messenger.js): selector-health and
            // IPC failures from the injected script, routed into the log file
            // so field breakage of the page features is visible in bug reports.
            let diag_count = std::sync::Arc::new(AtomicUsize::new(0));
            app.listen_any("carrier:diag", move |event| {
                let n = diag_count.fetch_add(1, Ordering::Relaxed);
                if n >= DIAG_SESSION_CAP as usize {
                    if n == DIAG_SESSION_CAP as usize {
                        log::warn!("page diagnostics muted for this session (cap reached)");
                    }
                    return;
                }
                if let Some(d) = parse_diag_payload(event.payload()) {
                    let key = sanitize_diag(&d.key);
                    let msg = sanitize_diag(&d.msg);
                    if !key.is_empty() {
                        log::warn!("page diagnostic [{key}] {msg}");
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Carrier")
        .run(|app, event| {
            if let tauri::RunEvent::Ready = event {
                commands::spawn_automatic_update_checks(app.clone());
                // macOS needs notification authorization (for banners + the
                // Dock badge) and the centre delegate installed once the app is
                // ready (UNUserNotificationCenter needs the app fully launched
                // — doing it during setup is a silent no-op). See
                // `setup_macos_notifications` and issue #5.
                #[cfg(target_os = "macos")]
                {
                    setup_macos_notifications(app);
                    // The Dock-menu delegate hook also needs the app fully
                    // launched (tao installs its NSApplication delegate by now).
                    install_dock_menu_provider();
                }
            }

            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                reopen_main_if_needed(app, has_visible_windows);
            }

            // A theme switch or blank-webview recovery destroys and rebuilds
            // windows; don't let the momentary zero-window state quit the app.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if app
                    .state::<AppState>()
                    .recreating
                    .load(std::sync::atomic::Ordering::SeqCst)
                {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webkit_dmabuf_renderer_is_disabled_only_for_wayland_without_override() {
        assert!(should_disable_webkit_dmabuf_renderer(true, false));
        assert!(!should_disable_webkit_dmabuf_renderer(false, false));
        assert!(!should_disable_webkit_dmabuf_renderer(true, true));
        assert!(!should_disable_webkit_dmabuf_renderer(false, true));
    }

    #[test]
    fn mcp_default_socket_always_keeps_single_instance_enforcement() {
        assert!(should_enforce_single_instance(false, true, false));
        assert!(should_enforce_single_instance(true, true, false));
        assert!(!should_enforce_single_instance(false, true, true));
        assert!(!should_enforce_single_instance(true, true, true));
        assert!(should_enforce_single_instance(false, false, false));
        assert!(!should_enforce_single_instance(true, false, false));
    }

    #[test]
    fn mcp_socket_selection_skips_empty_overrides() {
        use std::ffi::OsString;

        assert_eq!(
            select_isolated_mcp_socket(
                Some(OsString::new()),
                Some(OsString::from("/tmp/fallback.sock")),
            ),
            Some(std::path::PathBuf::from("/tmp/fallback.sock"))
        );
        assert_eq!(
            select_isolated_mcp_socket(Some(OsString::new()), Some(OsString::new())),
            None
        );
        assert_eq!(
            select_isolated_mcp_socket(
                Some(OsString::from("/tmp/primary.sock")),
                Some(OsString::from("/tmp/fallback.sock")),
            ),
            Some(std::path::PathBuf::from("/tmp/primary.sock"))
        );
    }

    #[test]
    fn download_reveal_tokens_must_match_a_registered_window() {
        let tokens = HashMap::from([
            ("main".to_string(), "main-secret".to_string()),
            ("win-2".to_string(), "second-secret".to_string()),
        ]);

        assert!(valid_download_reveal_token(&tokens, "main-secret"));
        assert!(valid_download_reveal_token(&tokens, "second-secret"));
        assert!(!valid_download_reveal_token(&tokens, ""));
        assert!(!valid_download_reveal_token(&tokens, "page-supplied"));
    }
}
