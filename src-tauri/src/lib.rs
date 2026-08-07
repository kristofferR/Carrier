//! Carrier — a tiny, distraction-free desktop client for Facebook Messenger.
//!
//! Opens a WebView window pointed at the Messenger web app, injects a stylesheet
//! that hides Facebook's surrounding chrome, and adds quality-of-life features:
//! shortcuts, zoom, an image viewer, a settings panel, copy/download image,
//! native notifications, theme sync, and tracking-redirect-free external links.
//! Anything that isn't Messenger is handed to the user's default browser.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use tauri::{Listener, Manager};
use tauri_plugin_opener::OpenerExt;
mod cli;
mod commands;
mod custom_css;
mod diag;
mod download;
mod hotkey;
#[cfg(target_os = "linux")]
mod hotkey_portal;
mod install_environment;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod menu;
mod notifications;
mod preflight;
mod settings;
mod tray;
#[cfg(any(target_os = "linux", test))]
mod tray_badge;
mod url_rules;
mod webview_watchdog;
mod window;

use diag::{parse_diag_payload, sanitize_diag, DIAG_SESSION_CAP, LOG_FILE_MAX_BYTES};
use download::lookup_download;
#[cfg(target_os = "macos")]
use download::lookup_download_id;
use hotkey::reconcile_startup_global_hotkey;
#[cfg(target_os = "linux")]
use linux::observe_system_theme_changes;
#[cfg(target_os = "macos")]
use macos::{
    dock::install_dock_menu_provider, notifications::setup_macos_notifications,
    theme::observe_system_theme_changes,
};
use menu::{rebuild_recent_menus, sanitize_recent_threads, RecentThread};
#[cfg(target_os = "linux")]
use notifications::handle_reply_result;
use notifications::{
    clear_avatar_cache, show_message_notification, show_sync_alert, update_notification_route,
    NotifyMsg, NotifyRouteMsg, SyncAlertKind, SyncAlertSource,
};
use settings::AppState;
#[cfg(any(target_os = "macos", test))]
use settings::ContextMenuActivation;
use settings::{
    apply_settings, clamp_zoom, clear_pending_webview_data, load_settings, load_settings_early,
    save_settings, SaveOutcome,
};
use tray::show_main;
#[cfg(target_os = "macos")]
use tray::{reopen_main_if_needed, tray_unread_title};
use window::{build_app_window, install_main_close_handler, show_settings_window};

pub(crate) fn refresh_unread_indicators(
    app: &tauri::AppHandle,
    settings: &settings::Settings,
    raw_count: i64,
) {
    let unread = if settings.unread_badge {
        raw_count.max(0)
    } else {
        0
    };
    let state = app.state::<AppState>();
    let tray = state.tray.lock().unwrap();
    if let Some(tray) = tray.as_ref() {
        let tooltip = if unread > 0 {
            format!("{APP_TITLE} — {unread} unread")
        } else {
            APP_TITLE.to_string()
        };
        let _ = tray.set_tooltip(Some(&tooltip));
        #[cfg(target_os = "linux")]
        let _ = tray.set_unread(unread);
        #[cfg(target_os = "macos")]
        let _ = tray.set_title(tray_unread_title(settings, unread));
    }
    drop(tray);

    // LauncherEntry works independently of the tray and is honored by KDE's
    // task manager plus Ubuntu Dock/Dash-to-Dock.
    #[cfg(target_os = "linux")]
    tray_badge::update_unity_launcher_count(unread);
}

#[derive(Deserialize)]
struct SignedAction {
    message: String,
    nonce: String,
    timestamp: u64,
    signature: String,
}

const SIGNED_ACTION_MAX_AGE: Duration = Duration::from_secs(5 * 60);
const SIGNED_ACTION_FUTURE_SKEW: Duration = Duration::from_secs(30);
const SIGNED_ACTION_NONCE_CAP: usize = 4_096;
const SIGNED_ACTION_CONTROL_MESSAGE_MAX: usize = 64 * 1024;
const SIGNED_ACTION_CONTEXT_MENU_MESSAGE_MAX: usize = 512 * 1024;
const SIGNED_ACTION_COPY_IMAGE_MESSAGE_MAX: usize = 48 * 1024 * 1024;
const SIGNED_ACTION_LARGE_MESSAGE_THRESHOLD: usize = 1024 * 1024;
const SIGNED_ACTION_LARGE_MESSAGE_COOLDOWN: Duration = Duration::from_secs(1);

fn signed_action_message_limit(event: &str) -> usize {
    match event {
        "carrier:context-menu" => SIGNED_ACTION_CONTEXT_MENU_MESSAGE_MAX,
        "carrier:copy-image" => SIGNED_ACTION_COPY_IMAGE_MESSAGE_MAX,
        _ => SIGNED_ACTION_CONTROL_MESSAGE_MAX,
    }
}

// Called only for actions whose signature already verified: an unsigned flood
// must not be able to touch the cooldown state and starve genuine copy-image
// actions. Keyed per window so one window's burst never blocks another.
fn claim_large_signed_action(event: &str, message_len: usize, label: &str) -> bool {
    if event != "carrier:copy-image" || message_len <= SIGNED_ACTION_LARGE_MESSAGE_THRESHOLD {
        return true;
    }
    static LAST_LARGE_MESSAGE: Mutex<Option<(String, Instant)>> = Mutex::new(None);
    let now = Instant::now();
    let mut last = LAST_LARGE_MESSAGE.lock().unwrap();
    if last.as_ref().is_some_and(|(seen_label, seen)| {
        seen_label == label && now.duration_since(*seen) < SIGNED_ACTION_LARGE_MESSAGE_COOLDOWN
    }) {
        return false;
    }
    *last = Some((label.to_string(), now));
    true
}

fn authorize_signed_action(
    tokens: &HashMap<String, String>,
    used_nonces: &mut HashMap<String, HashMap<String, Instant>>,
    event: &str,
    signed: &SignedAction,
) -> Option<String> {
    if signed.message.len() > signed_action_message_limit(event)
        || signed.nonce.len() != 32
        || !signed.nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
        || signed.signature.len() != 64
    {
        return None;
    }
    let issued_at = UNIX_EPOCH.checked_add(Duration::from_millis(signed.timestamp))?;
    let wall_now = SystemTime::now();
    if issued_at > wall_now.checked_add(SIGNED_ACTION_FUTURE_SKEW)?
        || wall_now
            .duration_since(issued_at)
            .is_ok_and(|age| age > SIGNED_ACTION_MAX_AGE)
    {
        return None;
    }
    let signature = hex::decode(&signed.signature).ok()?;
    let authenticated = format!(
        "{event}\n{}\n{}\n{}",
        signed.timestamp, signed.nonce, signed.message
    );
    let label = tokens.iter().find_map(|(label, token)| {
        let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).ok()?;
        mac.update(authenticated.as_bytes());
        mac.verify_slice(&signature).ok().map(|()| label.clone())
    })?;
    if !claim_large_signed_action(event, signed.message.len(), &label) {
        return None;
    }
    let now = Instant::now();
    let window_nonces = used_nonces.entry(label.clone()).or_default();
    window_nonces.retain(|_, inserted| now.duration_since(*inserted) <= SIGNED_ACTION_MAX_AGE);
    if window_nonces.contains_key(&signed.nonce) || window_nonces.len() >= SIGNED_ACTION_NONCE_CAP {
        return None;
    }
    window_nonces.insert(signed.nonce.clone(), now);
    Some(label)
}

fn signed_action_window(
    app: &tauri::AppHandle,
    event: &str,
    signed: &SignedAction,
) -> Option<String> {
    let state = app.state::<AppState>();
    let tokens = state.download_reveal_tokens.lock().unwrap();
    let mut nonces = state.signed_action_nonces.lock().unwrap();
    authorize_signed_action(&tokens, &mut nonces, event, signed)
}

/// Sign a native result for the page. The struct field order must match the
/// object literal the page passes to `verifyResult`: both sides HMAC the
/// serialized JSON text, so key order is part of the wire contract.
fn result_signature<T: serde::Serialize>(secret: &str, event: &str, value: &T) -> Option<String> {
    let message = serde_json::to_string(value).ok()?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(format!("{event}\n{message}").as_bytes());
    Some(hex::encode(mac.finalize().into_bytes()))
}

pub(crate) fn download_finished_signature(
    secret: &str,
    id: &str,
    url: &str,
    success: bool,
) -> Option<String> {
    #[derive(serde::Serialize)]
    struct DownloadFinished<'a> {
        id: &'a str,
        url: &'a str,
        success: bool,
    }

    result_signature(
        secret,
        "carrier:download-finished",
        &DownloadFinished { id, url, success },
    )
}

pub(crate) fn context_action_signature(secret: &str, action: &str) -> Option<String> {
    #[derive(serde::Serialize)]
    struct ContextAction<'a> {
        action: &'a str,
    }

    result_signature(secret, "carrier:context-action", &ContextAction { action })
}

/// The signed `{ request, <field> }` payload of a boolean native result. The
/// flatten keeps `request` first, matching the object literal the page passes
/// to `verifyResult` — the serialization here must match it byte for byte.
fn native_result_signature(
    secret: &str,
    result_event: &str,
    field: &str,
    request: &str,
    value: bool,
) -> Option<String> {
    #[derive(serde::Serialize)]
    struct NativeResult<'a> {
        request: &'a str,
        #[serde(flatten)]
        value: HashMap<&'a str, bool>,
    }

    result_signature(
        secret,
        result_event,
        &NativeResult {
            request,
            value: HashMap::from([(field, value)]),
        },
    )
}

fn send_native_result(
    app: &tauri::AppHandle,
    label: &str,
    event: &str,
    field: &str,
    request: &str,
    value: bool,
) {
    // Every result correlates to a page-generated 32-hex request token; refuse
    // anything else before echoing it into an eval'd script.
    if request.len() != 32 || !request.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        log::warn!("{event} result had an invalid request token");
        return;
    }
    let result_event = format!("{event}-result");
    let signature = {
        let state = app.state::<AppState>();
        let tokens = state.download_reveal_tokens.lock().unwrap();
        tokens.get(label).and_then(|secret| {
            native_result_signature(secret, &result_event, field, request, value)
        })
    };
    let Some(signature) = signature else {
        log::warn!("failed to authenticate {result_event}");
        return;
    };
    let request = serde_json::to_string(request).expect("request serializes");
    let signature = serde_json::to_string(&signature).expect("signature serializes");
    let script = format!(
        "window.dispatchEvent(new CustomEvent('{result_event}', {{ detail: {{ request: {request}, {field}: {value}, signature: {signature} }} }}));"
    );
    if let Some(window) = app.get_webview_window(label) {
        if let Err(error) = window.eval(&script) {
            log::warn!("failed to report {result_event}: {error}");
        }
    }
}

#[cfg(target_os = "macos")]
fn send_copy_image_result(app: &tauri::AppHandle, label: &str, request: &str, copied: bool) {
    send_native_result(app, label, "carrier:copy-image", "copied", request, copied);
}

#[cfg(target_os = "macos")]
fn send_share_download_result(app: &tauri::AppHandle, label: &str, request: &str, shown: bool) {
    send_native_result(
        app,
        label,
        "carrier:share-download",
        "shown",
        request,
        shown,
    );
}

fn send_context_menu_result(app: &tauri::AppHandle, label: &str, request: &str, shown: bool) {
    send_native_result(app, label, "carrier:context-menu", "shown", request, shown);
}

/// Move a fresh `Selected` activation to `Claimed`. Pure over the map so the
/// transition is unit-testable on every platform.
#[cfg(any(target_os = "macos", test))]
fn claim_activation(
    activations: &mut HashMap<(String, String), ContextMenuActivation>,
    key: &(String, String),
    now: Instant,
) -> bool {
    let Some(activation) = activations.get(key).cloned() else {
        return false;
    };
    if !context_menu_activation_can_be_claimed(activation, now) {
        return false;
    }
    activations.insert(
        key.clone(),
        ContextMenuActivation::Claimed {
            download_id: None,
            claimed_at: now,
        },
    );
    true
}

/// Bind a claimed activation to its download. Returns false when the claim is
/// missing, already bound, or the URL is implausibly long.
#[cfg(any(target_os = "macos", test))]
fn bind_activation_download(
    activations: &mut HashMap<(String, String), ContextMenuActivation>,
    key: &(String, String),
    url_len: usize,
) -> bool {
    let Some(ContextMenuActivation::Claimed {
        download_id: bound, ..
    }) = activations.get_mut(key)
    else {
        return false;
    };
    if bound.is_some() || url_len > 4096 {
        return false;
    }
    // The reservation value becomes the download ID: `on_download` in
    // `window.rs` consumes it through `take_download_reservation`, so a
    // claimed share action and its download share one identifier.
    // `consume_activation` compares the two, so keep both sides in step.
    *bound = Some(key.1.clone());
    true
}

/// Spend an activation. A download-bound consume (`download_id` set) requires
/// the matching `Claimed` binding; a plain consume (`None`) also accepts a
/// fresh `Selected` — copy-image never claims a download, the user's menu
/// selection alone authorizes it.
#[cfg(any(target_os = "macos", test))]
fn consume_activation(
    activations: &mut HashMap<(String, String), ContextMenuActivation>,
    key: &(String, String),
    download_id: Option<&str>,
    now: Instant,
) -> bool {
    let Some(activation) = activations.get(key).cloned() else {
        return false;
    };
    if !context_menu_activation_is_current(activation, now) {
        activations.remove(key);
        return false;
    }
    match activations.remove(key) {
        Some(ContextMenuActivation::Claimed {
            download_id: bound, ..
        }) => download_id.is_none() || bound.as_deref() == download_id,
        Some(ContextMenuActivation::Selected(_)) => download_id.is_none(),
        _ => false,
    }
}

#[cfg(target_os = "macos")]
fn claim_context_activation(app: &tauri::AppHandle, label: &str, action: &str) -> bool {
    let state = app.state::<AppState>();
    let key = (label.to_string(), action.to_string());
    let mut activations = state.context_menu_activations.lock().unwrap();
    claim_activation(&mut activations, &key, Instant::now())
}

#[cfg(target_os = "macos")]
fn prepare_context_download(app: &tauri::AppHandle, label: &str, action: &str, url: &str) -> bool {
    let state = app.state::<AppState>();
    let key = (label.to_string(), action.to_string());
    let mut activations = state.context_menu_activations.lock().unwrap();
    if !bind_activation_download(&mut activations, &key, url.len()) {
        return false;
    }
    drop(activations);
    state
        .download_reservations
        .lock()
        .unwrap()
        .insert((label.to_string(), url.to_string()), action.to_string());
    true
}

#[cfg(target_os = "macos")]
pub(crate) fn take_download_reservation(
    app: &tauri::AppHandle,
    label: &str,
    url: &str,
) -> Option<String> {
    app.state::<AppState>()
        .download_reservations
        .lock()
        .unwrap()
        .remove(&(label.to_string(), url.to_string()))
}

#[cfg(target_os = "macos")]
fn consume_context_activation(
    app: &tauri::AppHandle,
    label: &str,
    action: &str,
    download_id: Option<&str>,
) -> bool {
    let state = app.state::<AppState>();
    let key = (label.to_string(), action.to_string());
    let mut activations = state.context_menu_activations.lock().unwrap();
    consume_activation(&mut activations, &key, download_id, Instant::now())
}

#[cfg(any(target_os = "macos", test))]
fn context_menu_activation_can_be_claimed(activation: ContextMenuActivation, now: Instant) -> bool {
    match activation {
        ContextMenuActivation::Selected(selected_at) => {
            context_menu_activation_is_current(ContextMenuActivation::Selected(selected_at), now)
        }
        _ => false,
    }
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn context_menu_activation_is_current(
    activation: ContextMenuActivation,
    now: Instant,
) -> bool {
    match activation {
        ContextMenuActivation::Pending => false,
        ContextMenuActivation::Selected(selected_at) => now
            .checked_duration_since(selected_at)
            .is_some_and(|age| age <= CONTEXT_MENU_ACTIVATION_TTL),
        ContextMenuActivation::Claimed { claimed_at, .. } => !now
            .checked_duration_since(claimed_at)
            .is_some_and(|age| age > CONTEXT_MENU_CLAIM_TTL),
    }
}

/// The page we wrap.
const HOME_URL: &str = "https://www.facebook.com/messages";
const HOME_HOST: &str = "www.facebook.com";
const HOME_PORT: u16 = 443;
const MESSENGER_DNS_TIMEOUT: Duration = Duration::from_millis(1500);
#[cfg(any(target_os = "macos", test))]
const CONTEXT_MENU_ACTIVATION_TTL: Duration = Duration::from_secs(10 * 60);
#[cfg(any(target_os = "macos", test))]
const CONTEXT_MENU_CLAIM_TTL: Duration = Duration::from_secs(15 * 60);
const DEFAULT_MCP_SOCKET: &str = "/tmp/tauri-mcp.sock";

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
fn select_mcp_socket_override(
    primary: Option<std::ffi::OsString>,
    fallback: Option<std::ffi::OsString>,
) -> Option<std::path::PathBuf> {
    primary
        .filter(|path| !path.is_empty())
        .or_else(|| fallback.filter(|path| !path.is_empty()))
        .map(std::path::PathBuf::from)
}

fn is_isolated_mcp_socket(path: Option<&std::path::Path>) -> bool {
    path.is_some_and(|path| path != std::path::Path::new(DEFAULT_MCP_SOCKET))
}

pub fn run() {
    #[cfg(target_os = "linux")]
    configure_linux_webkit_renderer();

    let initial = load_settings_early();
    let cold_cli_action = cli::parse_cli_action(std::env::args_os());
    let pending_cold_new_conversation = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(
        cold_cli_action == Some(cli::CliAction::NewConversation),
    ));

    let mut builder = tauri::Builder::default();

    // Only an explicitly isolated MCP socket opts a debug build out of
    // single-instance enforcement. Two default-socket builds would otherwise
    // contend for /tmp/tauri-mcp.sock.
    #[cfg(all(feature = "mcp", debug_assertions))]
    let mcp_socket_override = select_mcp_socket_override(
        std::env::var_os("CARRIER_MCP_SOCKET_PATH"),
        std::env::var_os("TAURI_MCP_IPC_PATH"),
    );
    #[cfg(not(all(feature = "mcp", debug_assertions)))]
    let mcp_socket_override: Option<std::path::PathBuf> = None;
    if should_enforce_single_instance(
        initial.multi_instance,
        cfg!(all(feature = "mcp", debug_assertions)),
        is_isolated_mcp_socket(mcp_socket_override.as_deref()),
    ) {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(action) = cli::parse_cli_action(argv) {
                cli::perform_cli_action(app, action);
            } else {
                show_main(app);
            }
        }));
    }

    let pending_action = pending_cold_new_conversation.clone();
    builder = builder.on_page_load(move |webview, payload| {
        if webview.label() == "main"
            && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
            && url_rules::is_messenger_web_url(payload.url())
            && pending_action.swap(false, Ordering::AcqRel)
        {
            cli::perform_cli_action(webview.app_handle(), cli::CliAction::NewConversation);
        }
    });

    // Dev-only (the `mcp` feature): expose the webview to tauri-plugin-mcp for
    // DOM/JS inspection. Restrict it to debug builds even when the Cargo feature
    // is accidentally enabled for a release build.
    #[cfg(all(feature = "mcp", debug_assertions))]
    {
        let socket_path = mcp_socket_override
            .clone()
            .unwrap_or_else(|| DEFAULT_MCP_SOCKET.into());
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
        .plugin(tauri_plugin_clipboard_manager::init())
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
            unread_count: AtomicI64::new(0),
            #[cfg(target_os = "linux")]
            linux_panel_dark: std::sync::atomic::AtomicBool::new(false),
            revealing_main: AtomicUsize::new(0),
            next_reveal_generation: AtomicUsize::new(0),
            zoom_generation: AtomicUsize::new(0),
            recreating: std::sync::atomic::AtomicBool::new(false),
            recent_threads: Mutex::new(Vec::new()),
            download_reveal_tokens: Mutex::new(HashMap::new()),
            signed_action_nonces: Mutex::new(HashMap::new()),
            #[cfg(target_os = "macos")]
            context_menu_activations: Mutex::new(HashMap::new()),
            #[cfg(target_os = "macos")]
            download_reservations: Mutex::new(HashMap::new()),
            context_menu_copy_values: Mutex::new(HashMap::new()),
            #[cfg(target_os = "macos")]
            pending_share: Mutex::new(None),
        })
        .menu(menu::build_menu)
        .on_menu_event(menu::handle_menu_event)
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::runtime_capabilities,
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

            #[cfg(target_os = "linux")]
            let settings = load_settings(app.handle());
            #[cfg(not(target_os = "linux"))]
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
            #[cfg(target_os = "linux")]
            reconcile_startup_global_hotkey(app.handle(), &settings);
            #[cfg(not(target_os = "linux"))]
            reconcile_startup_global_hotkey(app.handle(), &mut settings);
            // Non-Linux reconciliation mutates the local snapshot
            // synchronously. Linux reconciliation updates AppState itself from
            // its worker, so overwriting it here could restore stale state.
            #[cfg(not(target_os = "linux"))]
            {
                *app.state::<AppState>().settings.lock().unwrap() = settings.clone();
            }
            apply_settings(app.handle(), &settings);

            // Start hidden only when a tray was actually created to reopen from.
            let has_tray = app.state::<AppState>().tray.lock().unwrap().is_some();
            if settings.start_to_tray && has_tray {
                let _ = window.hide();
            }

            if cold_cli_action == Some(cli::CliAction::Settings) {
                cli::perform_cli_action(app.handle(), cli::CliAction::Settings);
            }

            // The Facebook page is a remote origin and can't call Carrier's own
            // commands, so the F3 shortcut emits an event that we handle here.
            let h = app.handle().clone();
            app.listen_any("carrier:open-settings", move |_| {
                let h = h.clone();
                tauri::async_runtime::spawn(async move { show_settings_window(&h) });
            });

            // The injected toast handler signs the download URL with its
            // non-extractable per-window key. Remote page scripts can emit this
            // event too, so verify the signature before resolving the URL through
            // the trusted map populated by `on_download`; a page-supplied
            // filesystem path is never accepted.
            let reveal_handle = app.handle().clone();
            app.listen_any("carrier:reveal-download", move |event| {
                #[derive(serde::Deserialize)]
                struct RevealDownloadMsg {
                    url: String,
                }

                let Ok(signed) = serde_json::from_str::<SignedAction>(event.payload()) else {
                    log::warn!("carrier:reveal-download payload did not parse");
                    return;
                };
                if signed_action_window(&reveal_handle, "carrier:reveal-download", &signed)
                    .is_none()
                {
                    log::warn!("carrier:reveal-download was not authorized by a trusted click");
                    return;
                }
                let Ok(msg) = serde_json::from_str::<RevealDownloadMsg>(&signed.message) else {
                    log::warn!("carrier:reveal-download message did not parse");
                    return;
                };
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

            // Show a native context menu only for an authorized Messenger window.
            let context_menu_handle = app.handle().clone();
            app.listen_any("carrier:context-menu", move |event| {
                #[derive(serde::Deserialize)]
                struct ContextMenuMsg {
                    items: Vec<menu::NativeContextMenuItem>,
                    request: String,
                }

                let Ok(signed) = serde_json::from_str::<SignedAction>(event.payload()) else {
                    log::warn!("carrier:context-menu payload did not parse");
                    return;
                };
                let Some(label) =
                    signed_action_window(&context_menu_handle, "carrier:context-menu", &signed)
                else {
                    log::warn!("carrier:context-menu was not authorized by a trusted click");
                    return;
                };
                let Ok(msg) = serde_json::from_str::<ContextMenuMsg>(&signed.message) else {
                    log::warn!("carrier:context-menu message did not parse");
                    return;
                };
                if msg.request.len() != 32
                    || !msg.request.bytes().all(|byte| byte.is_ascii_hexdigit())
                {
                    log::warn!("carrier:context-menu request token was invalid");
                    return;
                }
                // Popping up a native menu requires the main thread on macOS;
                // listen_any handlers carry no such guarantee. The result is
                // reported from the same closure once the menu call returns.
                let popup_handle = context_menu_handle.clone();
                let error_label = label.clone();
                let error_request = msg.request.clone();
                let dispatched = context_menu_handle.run_on_main_thread(move || {
                    // Acknowledge at presentation time: popup_menu blocks until
                    // the menu is dismissed, and the page's result timeout must
                    // not fire while the user is still browsing the menu.
                    let presented = std::cell::Cell::new(false);
                    menu::show_native_context_menu(&popup_handle, &label, msg.items, || {
                        presented.set(true);
                        send_context_menu_result(&popup_handle, &label, &msg.request, true);
                    });
                    if !presented.get() {
                        send_context_menu_result(&popup_handle, &label, &msg.request, false);
                    }
                });
                if let Err(error) = dispatched {
                    log::warn!(
                        "failed to dispatch native context menu to the main thread: {error}"
                    );
                    send_context_menu_result(
                        &context_menu_handle,
                        &error_label,
                        &error_request,
                        false,
                    );
                }
            });

            #[cfg(target_os = "macos")]
            {
                let claim_handle = app.handle().clone();
                app.listen_any("carrier:claim-context-action", move |event| {
                    #[derive(serde::Deserialize)]
                    struct ClaimContextActionMsg {
                        action: String,
                    }

                    let Ok(signed) = serde_json::from_str::<SignedAction>(event.payload()) else {
                        log::warn!("carrier:claim-context-action payload did not parse");
                        return;
                    };
                    let Some(label) = signed_action_window(
                        &claim_handle,
                        "carrier:claim-context-action",
                        &signed,
                    ) else {
                        log::warn!("carrier:claim-context-action was not authorized");
                        return;
                    };
                    let Ok(msg) = serde_json::from_str::<ClaimContextActionMsg>(&signed.message)
                    else {
                        log::warn!("carrier:claim-context-action message did not parse");
                        return;
                    };
                    if !claim_context_activation(&claim_handle, &label, &msg.action) {
                        log::warn!("carrier:claim-context-action had no fresh menu selection");
                    }
                });

                let prepare_handle = app.handle().clone();
                app.listen_any("carrier:prepare-download", move |event| {
                    #[derive(serde::Deserialize)]
                    struct PrepareDownloadMsg {
                        action: String,
                        url: String,
                    }

                    let Ok(signed) = serde_json::from_str::<SignedAction>(event.payload()) else {
                        log::warn!("carrier:prepare-download payload did not parse");
                        return;
                    };
                    let Some(label) =
                        signed_action_window(&prepare_handle, "carrier:prepare-download", &signed)
                    else {
                        log::warn!("carrier:prepare-download was not authorized");
                        return;
                    };
                    let Ok(msg) = serde_json::from_str::<PrepareDownloadMsg>(&signed.message)
                    else {
                        log::warn!("carrier:prepare-download message did not parse");
                        return;
                    };
                    if !prepare_context_download(&prepare_handle, &label, &msg.action, &msg.url) {
                        log::warn!("carrier:prepare-download had no unbound share action");
                    }
                });

                // Share a just-downloaded media file via the macOS share sheet.
                // Same trust model as carrier:reveal-download: the per-window
                // credential authorizes it and the file path only ever comes from
                // the trusted download map, never from the page.
                let share_handle = app.handle().clone();
                app.listen_any("carrier:share-download", move |event| {
                    #[derive(serde::Deserialize)]
                    struct ShareDownloadMsg {
                        download_id: String,
                        x: f64,
                        y: f64,
                        action: String,
                        request: String,
                    }

                    let Ok(signed) = serde_json::from_str::<SignedAction>(event.payload()) else {
                        log::warn!("carrier:share-download payload did not parse");
                        return;
                    };
                    let Some(label) =
                        signed_action_window(&share_handle, "carrier:share-download", &signed)
                    else {
                        log::warn!("carrier:share-download was not authorized by a trusted click");
                        return;
                    };
                    let Ok(msg) = serde_json::from_str::<ShareDownloadMsg>(&signed.message) else {
                        log::warn!("carrier:share-download message did not parse");
                        return;
                    };
                    if !consume_context_activation(
                        &share_handle,
                        &label,
                        &msg.action,
                        Some(&msg.download_id),
                    ) {
                        log::warn!("carrier:share-download had no selected native menu action");
                        send_share_download_result(&share_handle, &label, &msg.request, false);
                        return;
                    }
                    let Some(path) = lookup_download_id(&msg.download_id) else {
                        log::warn!("carrier:share-download had no recent matching download");
                        send_share_download_result(&share_handle, &label, &msg.request, false);
                        return;
                    };
                    let result_handle = share_handle.clone();
                    let result_label = label.clone();
                    let result_request = msg.request.clone();
                    if let Err(error) = macos::share::show_share_picker(
                        move |shown| {
                            send_share_download_result(
                                &result_handle,
                                &result_label,
                                &result_request,
                                shown,
                            );
                        },
                        &share_handle,
                        &label,
                        path,
                        msg.x,
                        msg.y,
                    ) {
                        log::warn!("failed to schedule macOS share picker: {error}");
                        send_share_download_result(&share_handle, &label, &msg.request, false);
                    }
                });

                let copy_handle = app.handle().clone();
                app.listen_any("carrier:copy-image", move |event| {
                    use base64::Engine;

                    #[derive(serde::Deserialize)]
                    struct CopyImageMsg {
                        data_url: String,
                        action: String,
                        request: String,
                    }

                    let Ok(signed) = serde_json::from_str::<SignedAction>(event.payload()) else {
                        log::warn!("carrier:copy-image payload did not parse");
                        return;
                    };
                    let Some(label) =
                        signed_action_window(&copy_handle, "carrier:copy-image", &signed)
                    else {
                        log::warn!("carrier:copy-image was not authorized by trusted code");
                        return;
                    };
                    let Ok(msg) = serde_json::from_str::<CopyImageMsg>(&signed.message) else {
                        log::warn!("carrier:copy-image message did not parse");
                        return;
                    };
                    if !consume_context_activation(&copy_handle, &label, &msg.action, None) {
                        log::warn!("carrier:copy-image had no selected native menu action");
                        send_copy_image_result(&copy_handle, &label, &msg.request, false);
                        return;
                    }
                    let Some((header, encoded)) = msg.data_url.split_once(',') else {
                        log::warn!("carrier:copy-image data URL did not parse");
                        send_copy_image_result(&copy_handle, &label, &msg.request, false);
                        return;
                    };
                    if !header.starts_with("data:image/")
                        || !header.ends_with(";base64")
                        || encoded.len() > 44 * 1024 * 1024
                    {
                        log::warn!("carrier:copy-image data URL was invalid or too large");
                        send_copy_image_result(&copy_handle, &label, &msg.request, false);
                        return;
                    }
                    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded)
                    else {
                        log::warn!("carrier:copy-image base64 did not decode");
                        send_copy_image_result(&copy_handle, &label, &msg.request, false);
                        return;
                    };
                    if bytes.len() > 32 * 1024 * 1024 {
                        log::warn!("carrier:copy-image exceeded the clipboard size cap");
                        send_copy_image_result(&copy_handle, &label, &msg.request, false);
                        return;
                    }
                    let copied = macos::clipboard::copy_image(&copy_handle, bytes);
                    send_copy_image_result(&copy_handle, &label, &msg.request, copied);
                });
            }

            // Unread count from the page → every native platform indicator.
            let h = app.handle().clone();
            app.listen_any("carrier:unread", move |event| {
                let n: i64 = event.payload().trim().parse().unwrap_or(0).max(0);
                let state = h.state::<AppState>();
                state.unread_count.store(n, Ordering::Release);
                let settings = state.settings.lock().unwrap().clone();
                refresh_unread_indicators(&h, &settings, n);
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
                        let id = msg.id();
                        let delivery = show_message_notification(notify_handle.clone(), msg);
                        if let Some(window) = notify_handle.get_webview_window("main") {
                            let delivery = serde_json::to_string(&delivery)
                                .expect("notification delivery serializes");
                            if let Err(e) = window
                                .eval(format!("window.__carrierNotifyResult?.({id}, {delivery});"))
                            {
                                log::warn!("carrier:notify result callback failed: {e}");
                            }
                        }
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

            // KDE inline replies are delivered page-side through a content-free
            // id/attempt/ok acknowledgement used by the native waiter.
            #[cfg(target_os = "linux")]
            app.listen_any("carrier:reply-result", move |event| {
                handle_reply_result(event.payload());
            });

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
                    macos::share_intake::sweep_stale_inboxes();
                }
            }

            #[cfg(target_os = "linux")]
            if let tauri::RunEvent::Exit = event {
                tray_badge::clear_unity_launcher_count();
            }

            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                reopen_main_if_needed(app, has_visible_windows);
            }

            // The share extension hands its inbox over as a carrier:// open
            // (running instance or cold start alike). See macos::share_intake.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                for url in urls {
                    macos::share_intake::handle_share_open(app, url.as_str());
                }
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

    fn timestamp_now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    fn signed_action(
        secret: &str,
        event: &str,
        message: &str,
        nonce: &str,
        timestamp: u64,
    ) -> SignedAction {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(format!("{event}\n{timestamp}\n{nonce}\n{message}").as_bytes());
        SignedAction {
            message: message.into(),
            nonce: nonce.into(),
            timestamp,
            signature: hex::encode(mac.finalize().into_bytes()),
        }
    }

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
            select_mcp_socket_override(
                Some(OsString::new()),
                Some(OsString::from("/tmp/fallback.sock")),
            ),
            Some(std::path::PathBuf::from("/tmp/fallback.sock"))
        );
        assert_eq!(
            select_mcp_socket_override(Some(OsString::new()), Some(OsString::new())),
            None
        );
        assert_eq!(
            select_mcp_socket_override(
                Some(OsString::from("/tmp/primary.sock")),
                Some(OsString::from("/tmp/fallback.sock")),
            ),
            Some(std::path::PathBuf::from("/tmp/primary.sock"))
        );
    }

    #[test]
    fn only_non_default_mcp_socket_paths_are_isolated() {
        assert!(!is_isolated_mcp_socket(None));
        assert!(!is_isolated_mcp_socket(Some(std::path::Path::new(
            DEFAULT_MCP_SOCKET
        ))));
        assert!(is_isolated_mcp_socket(Some(std::path::Path::new(
            "/tmp/carrier-isolated.sock"
        ))));
    }

    #[test]
    fn copy_image_results_are_authenticated_with_the_window_secret() {
        assert_eq!(
            native_result_signature(
                "test-secret",
                "carrier:copy-image-result",
                "copied",
                "0123456789abcdef0123456789abcdef",
                true
            )
            .as_deref(),
            Some("5e39e1320822a514ce4a811d2a6c6b9b72f0d63a1a8b59601d20fd8644872007")
        );
    }

    #[test]
    fn share_download_results_are_authenticated_with_the_window_secret() {
        assert_eq!(
            native_result_signature(
                "test-secret",
                "carrier:share-download-result",
                "shown",
                "0123456789abcdef0123456789abcdef",
                true
            )
            .as_deref(),
            Some("a24b608a14250d52d4c6d33458b54d275966b1dfdfd7f41c029a16e3df0476de")
        );
    }

    #[test]
    fn download_finished_results_bind_the_native_identity() {
        let first = download_finished_signature("test-secret", "download-1", "blob:one", true);
        let second = download_finished_signature("test-secret", "download-2", "blob:one", true);
        assert_eq!(
            first.as_deref(),
            Some("a78b039568c100b2dcf4c7d1030481696bf0fb715f9b7d65fb89f45837f9422e")
        );
        assert_ne!(first, second);
    }

    #[test]
    fn context_menu_results_are_authenticated_with_the_window_secret() {
        assert_eq!(
            native_result_signature(
                "test-secret",
                "carrier:context-menu-result",
                "shown",
                "0123456789abcdef0123456789abcdef",
                true
            )
            .as_deref(),
            Some("e46176617a8edbc90c518ab731967ed85965c9df255eab4a0f09629a48e90f59")
        );
    }

    #[test]
    fn context_actions_are_authenticated_with_the_window_secret() {
        assert_eq!(
            context_action_signature("test-secret", "0123456789abcdef0123456789abcdef").as_deref(),
            Some("8a8291c9903534471b568cec36bea453a618639499d975abca0f2e8afcb34a2d")
        );
    }

    #[test]
    fn signed_actions_resolve_to_their_window_and_cannot_be_replayed() {
        let tokens = HashMap::from([
            ("main".to_string(), "main-secret".to_string()),
            ("win-2".to_string(), "second-secret".to_string()),
        ]);
        let event = "carrier:share-download";
        let message = r#"{"url":"blob:test","action":"abc"}"#;
        let nonce = "0123456789abcdef0123456789abcdef";
        let signed = signed_action("second-secret", event, message, nonce, timestamp_now());
        let mut used = HashMap::new();
        assert_eq!(
            authorize_signed_action(&tokens, &mut used, "carrier:context-menu", &signed),
            None
        );
        assert_eq!(
            authorize_signed_action(&tokens, &mut used, event, &signed).as_deref(),
            Some("win-2")
        );
        assert_eq!(
            authorize_signed_action(&tokens, &mut used, event, &signed),
            None
        );
    }

    #[test]
    fn signed_actions_reject_tampered_messages() {
        let tokens = HashMap::from([("main".to_string(), "main-secret".to_string())]);
        let signed = SignedAction {
            message: "tampered".into(),
            nonce: "0123456789abcdef0123456789abcdef".into(),
            timestamp: timestamp_now(),
            signature: "00".repeat(32),
        };
        assert_eq!(
            authorize_signed_action(
                &tokens,
                &mut HashMap::new(),
                "carrier:context-menu",
                &signed
            ),
            None
        );
    }

    #[test]
    fn signed_actions_expire_and_nonce_retention_is_bounded() {
        let tokens = HashMap::from([("main".to_string(), "main-secret".to_string())]);
        let event = "carrier:context-menu";
        let message = "[]";
        let timestamp = timestamp_now();
        let nonce = "0123456789abcdef0123456789abcdef";
        let signed = signed_action("main-secret", event, message, nonce, timestamp);
        let stale = Instant::now() - SIGNED_ACTION_MAX_AGE - Duration::from_secs(1);
        let mut used = HashMap::from([(
            "main".to_string(),
            HashMap::from([(nonce.to_string(), stale)]),
        )]);
        assert_eq!(
            authorize_signed_action(&tokens, &mut used, event, &signed).as_deref(),
            Some("main")
        );

        let expired_timestamp = timestamp - SIGNED_ACTION_MAX_AGE.as_millis() as u64 - 1;
        let expired = signed_action(
            "main-secret",
            event,
            message,
            "fedcba9876543210fedcba9876543210",
            expired_timestamp,
        );
        assert_eq!(
            authorize_signed_action(&tokens, &mut used, event, &expired),
            None
        );

        let full = (0..SIGNED_ACTION_NONCE_CAP)
            .map(|index| (format!("{index:032x}"), Instant::now()))
            .collect();
        let mut used = HashMap::from([("main".to_string(), full)]);
        let overflow = signed_action(
            "main-secret",
            event,
            message,
            "ffffffffffffffffffffffffffffffff",
            timestamp,
        );
        assert_eq!(
            authorize_signed_action(&tokens, &mut used, event, &overflow),
            None
        );
        assert_eq!(used["main"].len(), SIGNED_ACTION_NONCE_CAP);
    }

    #[test]
    fn stale_context_actions_are_pruned_without_invalidating_selected_actions() {
        let now = Instant::now();
        assert!(context_menu_activation_is_current(
            ContextMenuActivation::Selected(now),
            now
        ));
        assert!(!context_menu_activation_is_current(
            ContextMenuActivation::Pending,
            now
        ));
        assert!(!context_menu_activation_is_current(
            ContextMenuActivation::Selected(
                now - CONTEXT_MENU_ACTIVATION_TTL - Duration::from_secs(1)
            ),
            now,
        ));
        assert!(context_menu_activation_is_current(
            ContextMenuActivation::Claimed {
                download_id: None,
                claimed_at: now,
            },
            now + CONTEXT_MENU_CLAIM_TTL
        ));
        assert!(!context_menu_activation_is_current(
            ContextMenuActivation::Claimed {
                download_id: None,
                claimed_at: now,
            },
            now + CONTEXT_MENU_CLAIM_TTL + Duration::from_secs(1)
        ));
        assert!(!context_menu_activation_can_be_claimed(
            ContextMenuActivation::Claimed {
                download_id: None,
                claimed_at: now,
            },
            now
        ));
    }

    fn activation_key() -> (String, String) {
        ("main".to_string(), "abc123".to_string())
    }

    #[test]
    fn share_activation_walks_selected_claim_bind_consume() {
        let now = Instant::now();
        let key = activation_key();
        let mut activations = HashMap::from([(key.clone(), ContextMenuActivation::Selected(now))]);

        assert!(claim_activation(&mut activations, &key, now));
        assert!(bind_activation_download(&mut activations, &key, 100));
        // The binding is the action token; a mismatched ID must not consume.
        assert!(!consume_activation(
            &mut activations,
            &key,
            Some("other-id"),
            now
        ));
        // The mismatch spent the activation: nothing is left to consume.
        assert!(!consume_activation(
            &mut activations,
            &key,
            Some("abc123"),
            now
        ));
    }

    #[test]
    fn share_activation_consumes_with_the_bound_download_id() {
        let now = Instant::now();
        let key = activation_key();
        let mut activations = HashMap::from([(key.clone(), ContextMenuActivation::Selected(now))]);

        assert!(claim_activation(&mut activations, &key, now));
        assert!(bind_activation_download(&mut activations, &key, 100));
        assert!(consume_activation(
            &mut activations,
            &key,
            Some("abc123"),
            now
        ));
        assert!(activations.is_empty());
    }

    #[test]
    fn copy_image_consumes_a_selected_activation_without_a_claim() {
        // Copy image never claims a download, so consume must accept a fresh
        // Selected directly — rejecting it broke the native copy-image flow.
        let now = Instant::now();
        let key = activation_key();
        let mut activations = HashMap::from([(key.clone(), ContextMenuActivation::Selected(now))]);

        assert!(consume_activation(&mut activations, &key, None, now));
        assert!(activations.is_empty());
    }

    #[test]
    fn selected_activation_never_satisfies_a_download_bound_consume() {
        let now = Instant::now();
        let key = activation_key();
        let mut activations = HashMap::from([(key.clone(), ContextMenuActivation::Selected(now))]);

        assert!(!consume_activation(
            &mut activations,
            &key,
            Some("abc123"),
            now
        ));
    }

    #[test]
    fn pending_and_stale_activations_cannot_be_claimed_or_consumed() {
        let now = Instant::now();
        let key = activation_key();

        let mut pending = HashMap::from([(key.clone(), ContextMenuActivation::Pending)]);
        assert!(!claim_activation(&mut pending, &key, now));
        assert!(!consume_activation(&mut pending, &key, None, now));

        let stale_at = now - CONTEXT_MENU_ACTIVATION_TTL - Duration::from_secs(1);
        let mut stale = HashMap::from([(key.clone(), ContextMenuActivation::Selected(stale_at))]);
        assert!(!consume_activation(&mut stale, &key, None, now));
        // A stale entry is pruned on the failed consume.
        assert!(stale.is_empty());
    }

    #[test]
    fn bind_requires_an_unbound_claim_and_a_plausible_url() {
        let now = Instant::now();
        let key = activation_key();

        let mut selected = HashMap::from([(key.clone(), ContextMenuActivation::Selected(now))]);
        assert!(!bind_activation_download(&mut selected, &key, 100));

        let mut claimed = HashMap::from([(key.clone(), ContextMenuActivation::Selected(now))]);
        assert!(claim_activation(&mut claimed, &key, now));
        assert!(!bind_activation_download(&mut claimed, &key, 5000));
        assert!(bind_activation_download(&mut claimed, &key, 100));
        // Already bound: a second bind must refuse.
        assert!(!bind_activation_download(&mut claimed, &key, 100));
    }
}
