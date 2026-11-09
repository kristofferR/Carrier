//! Window construction: the Messenger windows (with navigation/download
//! policies and the injected init script), the Settings dialog, theme helpers,
//! and the theme-change window rebuild.

use tauri::{
    Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
    utils::config::BackgroundThrottlingPolicy,
    webview::{Color, DownloadEvent},
};
use tauri_plugin_notification::NotificationExt;
use url::Url;

use crate::custom_css::apply_custom_css;
use crate::download::{
    complete_download, downloads_dir, filename_from_url, forget_download, is_allowed_download,
    is_allowed_download_path, is_folder_access_denied, is_unsafe_download, remember_download,
    sanitize_filename, unique_path,
};
#[cfg(target_os = "macos")]
use crate::macos::theme::make_webview_transparent;
use crate::render_recovery::RenderRecoveryBudget;
use crate::settings::{
    AppState, SaveOutcome, Settings, ZOOM_MAX, ZOOM_MIN, apply_page_zoom, load_settings,
    save_settings,
};
use crate::url_rules::{Route, is_messenger_web_url, popup_route, route};
use crate::webview_watchdog::WebviewWatchdog;
use crate::{
    APP_TITLE, INJECT_CSS, INJECT_JS, INJECT_MCP_BRIDGE, INJECT_PANEL, INJECT_WEB_AUDIO_IDLE,
};

fn notify_download_finished(
    app: &tauri::AppHandle,
    webview: &tauri::Webview,
    id: &str,
    url: &Url,
    success: bool,
    denied: bool,
) {
    let signature = app
        .state::<AppState>()
        .download_reveal_tokens
        .lock()
        .unwrap()
        .get(webview.label())
        .and_then(|secret| {
            crate::download_finished_signature(secret, id, url.as_str(), success, denied)
        });
    let Some(signature) = signature else {
        return;
    };
    let detail = serde_json::json!({
        "id": id,
        "url": url.as_str(),
        "success": success,
        "denied": denied,
        "signature": signature,
    });
    let script = format!(
        "window.dispatchEvent(new CustomEvent('chatpane:download-finished', {{ detail: {detail} }}));"
    );
    let _ = webview.eval(script);
}

/// The window/chrome theme to apply for a given preference: an explicit
/// light/dark, or `None` to follow the system.
pub(crate) fn theme_for(s: &Settings) -> Option<tauri::Theme> {
    match s.theme.as_str() {
        "dark" => Some(tauri::Theme::Dark),
        "light" => Some(tauri::Theme::Light),
        _ => None,
    }
}

/// True when the window should render dark (forced dark, or system-dark).
pub(crate) fn is_dark(s: &Settings) -> bool {
    match s.theme.as_str() {
        "dark" => true,
        "light" => false,
        _ => system_prefers_dark(),
    }
}

/// Point-in-time read of the OS dark-mode preference. Linux asks the settings
/// portal directly (see linux.rs); other platforms go through `dark-light`.
#[cfg(not(target_os = "linux"))]
fn system_prefers_dark() -> bool {
    matches!(dark_light::detect(), Ok(dark_light::Mode::Dark))
}
#[cfg(target_os = "linux")]
use crate::linux::system_prefers_dark;

/// Linux: whether windows keep their title bar. "show"/"hide" are explicit;
/// "auto" hides it under a tiling window manager (where the compositor
/// moves/closes windows and the GTK header bar is dead weight) and keeps it
/// on floating desktops.
#[cfg(target_os = "linux")]
pub(crate) fn show_title_bar(s: &Settings) -> bool {
    match s.title_bar.as_str() {
        "show" => true,
        "hide" => false,
        _ => !crate::linux::is_tiling_wm(),
    }
}

/// Linux: whether a Messenger or Settings window keeps the GTK header bar. Only "show"
/// does: "auto" draws Chatpane's own controls instead, in windows the
/// compositor doesn't tile (crate::title_bar).
#[cfg(target_os = "linux")]
pub(crate) fn native_decorations(s: &Settings) -> bool {
    show_title_bar(s) && crate::title_bar::controls(s).is_none()
}

/// A theme-appropriate window background so there's no white flash before the
/// remote page paints (Facebook glares white in dark mode while loading).
pub(crate) fn splash_background(s: &Settings) -> Color {
    if is_dark(s) {
        Color(24, 25, 26, 255) // Facebook dark
    } else {
        Color(255, 255, 255, 255)
    }
}

/// The Messenger windows, as opposed to Settings and the windows Messenger
/// opens itself (calls).
pub(crate) fn is_messenger_window_label(label: &str) -> bool {
    label == "main" || label.starts_with("win-")
}

pub(crate) const POPUP_LABEL_PREFIX: &str = "popup-";

/// Messenger and call windows load Messenger in the app and open other web
/// pages in the browser.
fn allow_navigation(url: &Url) -> bool {
    match route(url) {
        Route::InApp => true,
        Route::Browser(url) => {
            let _ = open::that(url);
            false
        }
        Route::Blocked => false,
    }
}

/// A window a page opened with `window.open`. Messenger starts a call this way
/// (Ref #335): it opens a blank window, then loads the call page into it, and
/// does nothing when no window comes back. The window shares its opener's web
/// session, so the call runs signed in. Chatpane's own features stay out of it
/// (see `init_script`).
fn open_popup(
    app: &tauri::AppHandle,
    opener: &str,
    url: &Url,
    features: tauri::webview::NewWindowFeatures,
) -> tauri::webview::NewWindowResponse<tauri::Wry> {
    use tauri::webview::NewWindowResponse;

    match popup_route(url) {
        Route::InApp => {}
        Route::Browser(url) => {
            let _ = open::that(url);
            return NewWindowResponse::Deny;
        }
        Route::Blocked => return NewWindowResponse::Deny,
    }
    static NEXT_POPUP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let label = format!(
        "{POPUP_LABEL_PREFIX}{}",
        NEXT_POPUP.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    // The engine loads the requested page itself once the window exists.
    let blank = WebviewUrl::External("about:blank".parse().expect("about:blank parses"));
    let builder = WebviewWindowBuilder::new(app, &label, blank)
        .title(APP_TITLE)
        .window_features(features)
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        })
        .on_navigation(allow_navigation)
        // Deny popup downloads on per-view engines. WebKitGTK's shared-context
        // handler applies the main window's download policy.
        .on_download(|_, _| false)
        .on_new_window({
            let app = app.clone();
            let opener = label.clone();
            move |url, features| open_popup(&app, &opener, &url, features)
        });
    // Messenger positions the window from window.screenX/Y, which WKWebView
    // reports wrongly (the call window landed below the screen) and Wayland
    // not at all. Centre it on the opener's screen instead.
    let opener_position = app.get_webview_window(opener).and_then(|window| {
        let scale = window.scale_factor().ok()?;
        Some(window.outer_position().ok()?.to_logical::<f64>(scale))
    });
    let builder = match opener_position {
        Some(position) => builder.position(position.x, position.y),
        None => builder.position(0.0, 0.0),
    }
    .center();
    #[cfg(target_os = "linux")]
    let builder = builder.on_permission_request(crate::linux::media_permission);
    let builder = match crate::user_agent::messenger_user_agent() {
        Some(user_agent) => builder.user_agent(user_agent),
        None => builder,
    };
    match builder.build() {
        Ok(window) => {
            #[cfg(target_os = "macos")]
            crate::macos::popup::close_on_page_request(&window);
            #[cfg(target_os = "linux")]
            {
                crate::linux::enable_calls(&window);
                crate::linux::close_on_page_request(&window);
            }
            log::info!("opened {label} for a page");
            NewWindowResponse::Create { window }
        }
        Err(error) => {
            log::warn!("failed to open a window for a page: {error}");
            NewWindowResponse::Deny
        }
    }
}

/// Which encrypted engine Messenger windows run on macOS. Chatpane normally
/// keeps one engine per window (#295): macOS discards the shared engine's
/// separate process under memory pressure. Facebook lets only one per-window
/// engine hold the session, and a newly loaded window takes it over, so two
/// windows would keep reloading each other. Once a session has a second
/// window, every window uses Facebook's shared engine until Chatpane restarts.
#[cfg(target_os = "macos")]
static SHARED_MESSENGER_ENGINE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Whether opening another window first rebuilds the open ones.
#[cfg(target_os = "macos")]
pub(crate) fn opening_window_reloads_others() -> bool {
    !SHARED_MESSENGER_ENGINE.load(std::sync::atomic::Ordering::SeqCst)
}

/// Open another Messenger window (File > New Window).
pub(crate) async fn open_messenger_window(app: tauri::AppHandle) {
    // Serialize so a second request cannot build its window while the first
    // is still moving the open windows to the shared engine.
    static OPENING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _opening = OPENING.lock().await;
    #[cfg(target_os = "macos")]
    if opening_window_reloads_others() && !move_windows_to_shared_engine(&app).await {
        return;
    }
    let settings = app.state::<AppState>().settings.lock().unwrap().clone();
    let n = app
        .state::<AppState>()
        .next_window
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    if let Err(error) = build_app_window(&app, &format!("win-{n}"), &settings) {
        log::warn!("failed to open a new Messenger window: {error}");
    }
}

/// Rebuild every open Messenger window on Facebook's shared engine. Each is
/// destroyed first, and its per-window engine with it, so the two kinds never
/// run against the same encrypted store at once. Returns false, leaving the
/// session on per-window engines, when a window could not be destroyed.
#[cfg(target_os = "macos")]
async fn move_windows_to_shared_engine(app: &tauri::AppHandle) -> bool {
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    // Theme changes and recovery rebuild windows too: never overlap them, and
    // keep the app running while no window exists.
    let mut claimed = false;
    for _ in 0..100 {
        if !app
            .state::<AppState>()
            .recreating
            .swap(true, Ordering::SeqCst)
        {
            claimed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if !claimed {
        log::warn!("another window rebuild is still running; not opening a new window");
        return false;
    }

    struct Snapshot {
        label: String,
        geometry: Option<(tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>)>,
        visible: bool,
        minimized: bool,
        maximized: bool,
        fullscreen: bool,
        focused: bool,
        thread: Option<String>,
    }
    let mut destroyed = Vec::new();
    let mut failed = false;
    for (label, window) in app.webview_windows() {
        if !is_messenger_window_label(&label) {
            continue;
        }
        let visible = window.is_visible().unwrap_or(true);
        let visible = if label == "main" {
            crate::macos::background_render::user_visible(&window).unwrap_or(visible)
        } else {
            visible
        };
        let snapshot = Snapshot {
            geometry: window.outer_position().ok().zip(window.inner_size().ok()),
            visible,
            minimized: window.is_minimized().unwrap_or(false),
            maximized: window.is_maximized().unwrap_or(false),
            fullscreen: window.is_fullscreen().unwrap_or(false),
            focused: window.is_focused().unwrap_or(false),
            thread: window
                .url()
                .ok()
                .and_then(|url| crate::messenger_url_thread_id(&url)),
            label,
        };
        crate::webview_watchdog::realtime_window_replacing(&snapshot.label);
        match window.destroy() {
            Ok(()) => destroyed.push(snapshot),
            Err(error) => {
                crate::webview_watchdog::realtime_window_replacement_failed(&snapshot.label);
                log::warn!(
                    "failed to destroy Messenger webview {} for the shared engine: {error}",
                    snapshot.label
                );
                failed = true;
            }
        }
    }
    // Tauri frees a label only once the native window reports it destroyed.
    // Give a slow close time to finish, so that window still comes back.
    for _ in 0..600 {
        if destroyed
            .iter()
            .all(|snapshot| app.get_webview_window(&snapshot.label).is_none())
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // `destroy` only queues the close. A window still present may still run
    // its engine, so the session stays on per-window engines and no new window
    // opens. It is still rebuilt below if it finishes closing meanwhile.
    for snapshot in &destroyed {
        if app.get_webview_window(&snapshot.label).is_some() {
            log::warn!(
                "Messenger webview {} did not close in time for the shared engine",
                snapshot.label
            );
            failed = true;
        }
    }
    if !failed {
        SHARED_MESSENGER_ENGINE.store(true, Ordering::SeqCst);
    }
    let settings = app.state::<AppState>().settings.lock().unwrap().clone();
    const MAX_BUILD_ATTEMPTS: u64 = 3;
    for snapshot in destroyed {
        let mut rebuilt = None;
        for attempt in 1..=MAX_BUILD_ATTEMPTS {
            match build_app_window_with_render_budget(
                app,
                &snapshot.label,
                &settings,
                RenderRecoveryBudget::default(),
                snapshot.focused,
                snapshot.thread.clone(),
            ) {
                Ok(window) => {
                    rebuilt = Some(window);
                    break;
                }
                Err(error) => {
                    log::warn!(
                        "failed to rebuild Messenger window {} \
                         (attempt {attempt}/{MAX_BUILD_ATTEMPTS}): {error}",
                        snapshot.label
                    );
                    if attempt < MAX_BUILD_ATTEMPTS {
                        tokio::time::sleep(Duration::from_millis(250 * attempt)).await;
                    }
                }
            }
        }
        let Some(window) = rebuilt else {
            crate::webview_watchdog::realtime_window_rebuild_failed(&snapshot.label);
            continue;
        };
        if snapshot.label == "main" {
            install_main_close_handler(app, &window);
        }
        if let Some((position, size)) = snapshot.geometry {
            let _ = window.set_position(tauri::Position::Physical(position));
            let _ = window.set_size(tauri::Size::Physical(size));
        }
        if snapshot.maximized {
            let _ = window.maximize();
        }
        if snapshot.fullscreen {
            let _ = window.set_fullscreen(true);
        }
        if snapshot.visible {
            let _ = window.show();
        } else {
            let _ = window.hide();
        }
        if snapshot.minimized {
            let _ = window.minimize();
        } else if snapshot.focused {
            let _ = window.set_focus();
        }
    }
    app.state::<AppState>()
        .recreating
        .store(false, Ordering::SeqCst);
    !failed
}

/// Build a Chatpane window (used for the main window and any extra windows).
pub(crate) fn build_app_window(
    app: &tauri::AppHandle,
    label: &str,
    settings: &Settings,
) -> tauri::Result<WebviewWindow> {
    build_app_window_with_render_budget(
        app,
        label,
        settings,
        RenderRecoveryBudget::default(),
        true,
        None,
    )
}

fn build_app_window_with_render_budget(
    app: &tauri::AppHandle,
    label: &str,
    settings: &Settings,
    render_budget: RenderRecoveryBudget,
    focused: bool,
    // Conversation a recycled window reopens once Messenger has loaded.
    restore_thread: Option<String>,
) -> tauri::Result<WebviewWindow> {
    if label == "main" {
        let state = app.state::<AppState>();
        let _pending = state.pending_action.lock().unwrap();
        state
            .messenger_loaded
            .store(false, std::sync::atomic::Ordering::Release);
    }
    let watchdog = WebviewWatchdog::new(render_budget);
    let watchdog_id = watchdog.id();
    let page_load_watchdog = watchdog.clone();
    let download_reveal_token = uuid::Uuid::new_v4().simple().to_string();
    let download_handle = app.clone();
    let download_label = label.to_string();
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(APP_TITLE)
        .focused(focused)
        .inner_size(1200.0, 780.0)
        .min_inner_size(420.0, 520.0)
        .theme(theme_for(settings))
        .background_color(splash_background(settings))
        // Messenger keeps a running AudioContext, so WebKit treats the page as
        // holding an audio session. With the default `.suspend` scheduling
        // policy (macOS 14+), WebKit deactivates that session whenever the
        // window is hidden or fully occluded and reactivates it on every native
        // eval into the page (watchdog ping, IPC responses) — a flip every few
        // seconds that makes audioaccessoryd re-evaluate Bluetooth routing and
        // silences AirPods system-wide (#232). Chatpane wants the page alive in
        // the background anyway (sync, notifications, badge), so opt out.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        // Tauri's drag-drop handler consumes OS file drops before the page sees
        // them, so files dragged from Finder/Explorer never reached Messenger's
        // composer. Chatpane has no native drop handling; let the page have them.
        .disable_drag_drop_handler()
        // Messenger owns Web Audio contexts in child frames, including a
        // cross-origin fbsbx.com frame. Keep this origin-scoped audio script
        // separate so privileged Chatpane code remains main-frame-only.
        .initialization_script_for_all_frames(audio_init_script())
        .initialization_script(init_script(
            settings,
            watchdog_id,
            &download_reveal_token,
            app.state::<AppState>().scheduled_send_available,
        ))
        .on_page_load(move |window, payload| match payload.event() {
            tauri::webview::PageLoadEvent::Started => {
                page_load_watchdog.navigation_started();
                crate::actions::messenger_page_started(&window);
            }
            tauri::webview::PageLoadEvent::Finished => {
                if !is_messenger_web_url(payload.url()) {
                    page_load_watchdog.disarm();
                }
                if is_messenger_web_url(payload.url()) {
                    crate::actions::messenger_page_finished(&window);
                    // Re-assert the zoom in case the engine keys it per origin
                    // (the first load hops from the bundled page to Facebook).
                    let zoom = window.state::<AppState>().settings.lock().unwrap().zoom;
                    apply_page_zoom(&window, zoom);
                }
                #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
                if window.label() == "main" && is_messenger_web_url(payload.url()) {
                    crate::notifications::resume_pending_page_replies(&window);
                }
                // A share handed over while the page was still loading (cold
                // start) is re-delivered once the page can receive it.
                #[cfg(target_os = "macos")]
                if window.label() != "settings" && is_messenger_web_url(payload.url()) {
                    crate::macos::share_intake::deliver_pending(
                        window.app_handle(),
                        Some(window.clone()),
                    );
                }
                if is_messenger_web_url(payload.url()) {
                    let settings = window
                        .app_handle()
                        .state::<AppState>()
                        .settings
                        .lock()
                        .unwrap()
                        .clone();
                    crate::themes::apply_appearance(&window, &settings);
                    // The init script's settings snapshot may predate a drag.
                    crate::pane_widths::push(&window, settings.pane_widths);
                }
                apply_custom_css(&window, payload.url());
                // A reload starts from the initial state; restate the current one.
                crate::title_bar::page_loaded(&window);
            }
        })
        .on_navigation(allow_navigation)
        .on_new_window({
            let app = app.clone();
            let opener = label.to_string();
            move |url, features| open_popup(&app, &opener, &url, features)
        })
        .on_download(move |webview, event| match event {
            DownloadEvent::Requested { url, destination } => {
                #[cfg(target_os = "macos")]
                let reserved_download_id = crate::take_download_reservation(
                    &download_handle,
                    &download_label,
                    url.as_str(),
                );
                #[cfg(target_os = "macos")]
                let download_id = reserved_download_id
                    .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
                #[cfg(not(target_os = "macos"))]
                let download_id = uuid::Uuid::new_v4().simple().to_string();
                // Only accept Messenger media and file attachments from its own
                // hosts or page-generated blob:/data: content; refuse anything else
                // a remote page might try to write to the user's Downloads folder.
                // Prefer the WebView's suggested filename — it carries the real
                // extension (e.g. a blob the page named via `download="photo.png"`);
                // fall back to the URL's last path segment.
                let suggested = destination
                    .file_name()
                    .and_then(|n| n.to_str())
                    .filter(|n| !n.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| filename_from_url(&url));
                let name = sanitize_filename(&suggested);
                if !is_allowed_download(&url, &name) {
                    notify_download_finished(
                        &download_handle,
                        &webview,
                        &download_id,
                        &url,
                        false,
                        false,
                    );
                    return false;
                }
                // Don't silently save an executable a page might push to Downloads.
                if is_unsafe_download(&name) {
                    notify_download_finished(
                        &download_handle,
                        &webview,
                        &download_id,
                        &url,
                        false,
                        false,
                    );
                    return false;
                }
                if let Some(chosen) =
                    crate::take_prompted_download(&download_handle, &download_label, url.as_str())
                {
                    if !is_allowed_download_path(&url, &chosen) {
                        notify_download_finished(
                            &download_handle,
                            &webview,
                            &download_id,
                            &url,
                            false,
                            false,
                        );
                        return false;
                    }
                    // The path came from Chatpane's native save dialog and never
                    // crossed the remote-origin page. Honor it exactly, including
                    // the user's overwrite decision.
                    *destination = chosen;
                } else {
                    let asks = download_handle
                        .state::<AppState>()
                        .settings
                        .lock()
                        .unwrap()
                        .download_behavior
                        == "ask";
                    if asks {
                        // Ask mode accepts only downloads pre-authorized by the
                        // native picker. This also prevents a page-initiated
                        // download from bypassing the prompt.
                        notify_download_finished(
                            &download_handle,
                            &webview,
                            &download_id,
                            &url,
                            false,
                            false,
                        );
                        return false;
                    }
                    // Fail closed: if we can't resolve/create the Downloads folder
                    // we can't enforce where the file lands, so refuse rather than
                    // let the WebView write to its own chosen destination.
                    let Some(dir) = downloads_dir() else {
                        notify_download_finished(
                            &download_handle,
                            &webview,
                            &download_id,
                            &url,
                            false,
                            false,
                        );
                        return false;
                    };
                    if let Err(error) = std::fs::create_dir_all(&dir) {
                        notify_download_finished(
                            &download_handle,
                            &webview,
                            &download_id,
                            &url,
                            false,
                            error.kind() == std::io::ErrorKind::PermissionDenied,
                        );
                        return false;
                    }
                    *destination = unique_path(dir.join(name));
                }
                remember_download(&url, download_id.clone(), destination.clone());
                true
            }
            DownloadEvent::Finished { url, success, .. } => {
                let new_id = || uuid::Uuid::new_v4().simple().to_string();
                if success {
                    let download_id = complete_download(&url).unwrap_or_else(new_id);
                    notify_download_finished(
                        &download_handle,
                        &webview,
                        &download_id,
                        &url,
                        true,
                        false,
                    );
                    return true;
                }
                let (download_id, folder) = match forget_download(&url) {
                    Some((id, path)) => (id, path.parent().map(std::path::Path::to_path_buf)),
                    None => (new_id(), None),
                };
                // Say when the OS blocked the folder (macOS Files & Folders
                // permission) so the page can show how to fix it.
                let handle = download_handle.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let denied = folder.is_some_and(|folder| is_folder_access_denied(&folder));
                    if denied {
                        log::warn!("a download failed because Chatpane may not access its folder");
                    }
                    notify_download_finished(&handle, &webview, &download_id, &url, false, denied);
                });
                true
            }
            _ => true,
        });
    // macOS: no separate title bar, like the old Messenger app; the window
    // buttons float over the page (see macos::title_bar).
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    // Windows: Chatpane draws the window controls (see crate::title_bar).
    #[cfg(target_os = "windows")]
    let builder = builder.decorations(false);
    // Linux: drop the GTK header bar on tiling WMs (or by explicit setting).
    #[cfg(target_os = "linux")]
    let builder = builder
        .decorations(native_decorations(settings))
        .on_permission_request(crate::linux::media_permission);
    let builder = match crate::user_agent::messenger_user_agent() {
        Some(user_agent) => builder.user_agent(user_agent),
        None => builder,
    };
    let builder = match restore_thread {
        Some(id) => builder.initialization_script(format!(
            "window.__CHATPANE_RESTORE_THREAD__ = {};",
            serde_json::to_string(&id).expect("thread id serialises")
        )),
        None => builder,
    };
    // Read when Facebook defines its modules, after every init script has run.
    #[cfg(target_os = "macos")]
    let builder = if SHARED_MESSENGER_ENGINE.load(std::sync::atomic::Ordering::SeqCst) {
        builder.initialization_script("window.__CHATPANE_SHARED_ENGINE__ = true;")
    } else {
        builder
    };
    let window = builder.build().inspect(|window| {
        crate::app_icon::apply_window_icon(window, settings);
        #[cfg(target_os = "linux")]
        {
            crate::linux::configure_messenger_webview_memory(window);
            crate::linux::enable_calls(window);
            crate::linux::install_webview_diagnostics(window);
        }
        // New windows inherit the current always-on-top preference and zoom.
        let _ = window.set_always_on_top(settings.always_on_top);
        apply_page_zoom(window, settings.zoom);
        #[cfg(not(target_os = "macos"))]
        if settings.hide_menu_bar {
            let _ = window.hide_menu();
        }
        // macOS: let the themed window background show through the title bar.
        #[cfg(target_os = "macos")]
        {
            make_webview_transparent(window);
            crate::macos::title_bar::install(window);
        }
        crate::title_bar::watch(window);
        // Lets the page's strip drag the window natively (app-region).
        #[cfg(target_os = "windows")]
        crate::windows::webview2::enable_app_region(window);
    })?;
    let token_cleanup_value = download_reveal_token.clone();
    {
        let state = app.state::<AppState>();
        state
            .download_reveal_tokens
            .lock()
            .unwrap()
            .insert(label.to_string(), download_reveal_token);
        state.signed_action_nonces.lock().unwrap().remove(label);
    }
    let token_cleanup_handle = app.clone();
    let token_cleanup_label = label.to_string();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            crate::title_bar::forget(&token_cleanup_label);
            let state = token_cleanup_handle.state::<AppState>();
            let mut tokens = state.download_reveal_tokens.lock().unwrap();
            if tokens.get(&token_cleanup_label) == Some(&token_cleanup_value) {
                tokens.remove(&token_cleanup_label);
                state
                    .signed_action_nonces
                    .lock()
                    .unwrap()
                    .remove(&token_cleanup_label);
                state
                    .context_menu_copy_values
                    .lock()
                    .unwrap()
                    .retain(|(window, _), _| window != &token_cleanup_label);
                state
                    .prompted_downloads
                    .lock()
                    .unwrap()
                    .retain(|(window, _), _| window != &token_cleanup_label);
                #[cfg(target_os = "macos")]
                {
                    state
                        .context_menu_activations
                        .lock()
                        .unwrap()
                        .retain(|(window, _), _| window != &token_cleanup_label);
                    state
                        .download_reservations
                        .lock()
                        .unwrap()
                        .retain(|(window, _), _| window != &token_cleanup_label);
                }
            }
        }
    });
    install_app_window_runtime_handler(app, &window);
    watchdog.install(&window);
    Ok(window)
}

#[cfg(target_os = "windows")]
fn should_auto_hide_windows_main(
    settings: &Settings,
    has_tray: bool,
    revealing: bool,
    focus_lost: bool,
    minimized: bool,
) -> bool {
    has_tray
        && !revealing
        && ((focus_lost && settings.hide_on_focus_loss) || (minimized && settings.hide_on_minimize))
}

/// Reassert runtime-only window preferences after native state transitions.
///
/// Windows can restore an app-wide native menu while activating/resizing a
/// window, so hiding the top menu only when settings are first applied is not
/// durable enough. This handler also implements the Windows tray-oriented
/// minimize/focus-loss options, but only for `main` and only while a tray icon
/// actually exists; secondary windows would otherwise be impossible to reopen.
#[cfg(target_os = "macos")]
fn install_app_window_runtime_handler(_app: &tauri::AppHandle, _window: &WebviewWindow) {}

#[cfg(not(target_os = "macos"))]
fn install_app_window_runtime_handler(app: &tauri::AppHandle, window: &WebviewWindow) {
    let handle = app.clone();
    let event_window = window.clone();
    #[cfg(target_os = "windows")]
    let is_main = window.label() == "main";
    window.on_window_event(move |event| {
        let repair_hidden_menu =
            matches!(event, WindowEvent::Focused(true) | WindowEvent::Resized(_));

        #[cfg(target_os = "windows")]
        let evaluate_auto_hide =
            is_main && matches!(event, WindowEvent::Focused(false) | WindowEvent::Resized(_));
        #[cfg(not(target_os = "windows"))]
        let evaluate_auto_hide = false;

        if !repair_hidden_menu && !evaluate_auto_hide {
            return;
        }

        let settings = handle.state::<AppState>().settings.lock().unwrap().clone();
        if repair_hidden_menu && settings.hide_menu_bar {
            let _ = event_window.hide_menu();
        }

        #[cfg(target_os = "windows")]
        if evaluate_auto_hide {
            let state = handle.state::<AppState>();
            let has_tray = state.tray.lock().unwrap().is_some();
            let revealing = state
                .revealing_main
                .load(std::sync::atomic::Ordering::Acquire)
                != 0;
            let focus_lost = matches!(event, WindowEvent::Focused(false));
            let minimized = matches!(event, WindowEvent::Resized(_))
                && event_window.is_minimized().unwrap_or(false);
            if should_auto_hide_windows_main(&settings, has_tray, revealing, focus_lost, minimized)
            {
                let _ = event_window.hide();
            }
        }
    });
}

fn persist_tray_notice_shown(app: &tauri::AppHandle) {
    const MAX_ATTEMPTS: usize = 3;
    let state = app.state::<AppState>();

    for attempt in 1..=MAX_ATTEMPTS {
        // Merge the internal flag into the newest snapshot on disk rather than
        // overwriting a concurrent Settings-window change with an older clone.
        let mut latest = load_settings(app);
        latest.tray_notice_shown = true;
        match save_settings(app, &latest) {
            Ok(SaveOutcome::Written) => {
                state.settings.lock().unwrap().tray_notice_shown = true;
                return;
            }
            Ok(SaveOutcome::Superseded) if attempt < MAX_ATTEMPTS => continue,
            Ok(SaveOutcome::Superseded) => {
                log::warn!("first tray notice state was repeatedly superseded");
                return;
            }
            Err(error) => {
                log::warn!("failed to persist first tray notice state: {error}");
                return;
            }
        }
    }
}

/// Whether closing the main window should hide it instead of quitting.
///
/// On Windows/Linux a tray is required so the app stays reachable. On macOS the
/// Dock (and `RunEvent::Reopen`) is enough even if tray creation failed.
pub(crate) fn should_hide_on_close(hide_on_close: bool, has_tray: bool) -> bool {
    hide_on_close && (has_tray || cfg!(target_os = "macos"))
}

/// Whether a last-window `ExitRequested` should keep the process alive.
///
/// tauri-runtime-wry emits this event in two cases only:
/// - `code: None` — the last window was destroyed (traffic-light / Cmd+W after
///   the window actually goes away, or a themed rebuild's zero-window gap).
/// - `code: Some(n)` — `AppHandle::exit(n)` (tray Quit, updater relaunch).
///
/// Native Chatpane menu Quit / Cmd+Q do **not** hit this predicate. They use
/// muda's predefined `.quit()`, which on macOS is `[NSApp terminate:]` and
/// never emits `ExitRequested` (tauri#9198, tauri#13778).
pub(crate) fn should_prevent_app_exit(
    recreating: bool,
    hide_on_close: bool,
    has_tray: bool,
    exit_code: Option<i32>,
) -> bool {
    exit_code.is_none() && (recreating || should_hide_on_close(hide_on_close, has_tray))
}

/// Install the `main` window's close behaviour: hide instead of quitting when
/// [`should_hide_on_close`] says so, otherwise quit. Reinstalled on every `main`
/// window the app creates (startup and after a themed rebuild) so the behaviour
/// survives `recreate_themed_windows`.
pub(crate) fn install_main_close_handler(app: &tauri::AppHandle, window: &WebviewWindow) {
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let state = handle.state::<AppState>();
            let has_tray = state.tray.lock().unwrap().is_some();
            let (hide, first_tray_notice) = {
                let settings = state.settings.lock().unwrap();
                let hide = settings.hide_on_close;
                let notice = hide
                    && has_tray
                    && !settings.tray_notice_shown
                    && !state
                        .tray_notice_delivered
                        .load(std::sync::atomic::Ordering::Acquire);
                (hide, notice)
            };
            // Only hide if a tray exists (or macOS, where the Dock remains).
            // Otherwise closing the main window quits the app (don't let an
            // open Settings dialog keep it running with no way back).
            if should_hide_on_close(hide, has_tray) {
                api.prevent_close();
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.hide();
                }
                if first_tray_notice {
                    match handle
                        .notification()
                        .builder()
                        .title("Chatpane is still running")
                        .body("Use the tray icon to reopen or quit Chatpane.")
                        .show()
                    {
                        Ok(()) => {
                            state
                                .tray_notice_delivered
                                .store(true, std::sync::atomic::Ordering::Release);
                            let handle = handle.clone();
                            tauri::async_runtime::spawn(async move {
                                let worker_handle = handle.clone();
                                let state = handle.state::<AppState>();
                                let _settings_worker = state.settings_worker.lock().await;
                                if let Err(error) =
                                    tauri::async_runtime::spawn_blocking(move || {
                                        persist_tray_notice_shown(&worker_handle);
                                    })
                                    .await
                                {
                                    log::error!("tray notice settings worker failed: {error}");
                                }
                            });
                        }
                        Err(error) => {
                            log::warn!("failed to show first tray notice: {error}");
                        }
                    }
                }
            } else {
                handle.exit(0);
            }
        }
    });
}

/// Replace one Messenger webview after its document stays content-free even
/// through a native reload. A fresh webview process recovers failures that
/// `WKWebView.reload()` / WebView2 reload cannot, while keeping cookies,
/// settings, window geometry, and the rest of the app process intact.
///
/// Returns whether a rebuild was scheduled. Theme changes and other recovery
/// attempts share the `recreating` guard so two destroy/build cycles cannot
/// overlap.
/// Returns whether a rebuild was scheduled. `on_abandoned` runs only when a
/// scheduled rebuild is later abandoned without destroying the window (the
/// destroy call failed, so the old window and its watchdog live on) — callers
/// budgeting rebuilds refund there. A `false` return never invokes it; the
/// caller still owns that case.
pub(crate) fn recreate_messenger_window(
    app: &tauri::AppHandle,
    label: &str,
    render_budget: RenderRecoveryBudget,
    on_abandoned: Option<Box<dyn FnOnce() + Send>>,
    recycle: Option<crate::webview_watchdog::RendererRecycle>,
) -> bool {
    use std::sync::atomic::Ordering;

    if label == "settings" {
        return false;
    }
    let Some(window) = app.get_webview_window(label) else {
        return false;
    };
    if app
        .state::<AppState>()
        .recreating
        .swap(true, Ordering::SeqCst)
    {
        return false;
    }

    let app = app.clone();
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        let geometry = window.outer_position().ok().zip(window.inner_size().ok());
        let was_visible = window.is_visible().unwrap_or(true);
        // A notification action may hold a closed window in, transparently;
        // that is not the user's window being open.
        #[cfg(target_os = "macos")]
        let was_visible = if label == "main" {
            crate::macos::background_render::user_visible(&window).unwrap_or(was_visible)
        } else {
            was_visible
        };
        let was_minimized = window.is_minimized().unwrap_or(false);
        let was_maximized = window.is_maximized().unwrap_or(false);
        let was_fullscreen = window.is_fullscreen().unwrap_or(false);
        let was_focused = window.is_focused().unwrap_or(false);

        // The old page is about to go away with `messenger_loaded` still set:
        // an app action dispatched into that gap would eval successfully and
        // then be lost with the webview. Take readiness away under the same
        // lock `dispatch_or_retain_page_action` uses, so it retains instead.
        let was_loaded = (label == "main" && recycle.is_none()).then(|| {
            let state = app.state::<AppState>();
            let _pending = state.pending_action.lock().unwrap();
            state.messenger_loaded.swap(false, Ordering::AcqRel)
        });

        crate::webview_watchdog::realtime_window_replacing(&label);
        let memory_recycle = recycle.is_some();
        let (destroy_result, recycle_was_loaded, restore_thread) = if let Some(recycle) = recycle {
            let (sender, receiver) = tokio::sync::oneshot::channel();
            let target = window.clone();
            let scheduled = app.run_on_main_thread(move || {
                let result = recycle.run(&target, true, || {
                    let was_loaded = (target.label() == "main").then(|| {
                        let state = target.state::<AppState>();
                        let _pending = state.pending_action.lock().unwrap();
                        state.messenger_loaded.swap(false, Ordering::AcqRel)
                    });
                    let thread = target
                        .url()
                        .ok()
                        .and_then(|url| crate::messenger_url_thread_id(&url));
                    (target.destroy(), was_loaded, thread)
                });
                let _ = sender.send(result);
            });
            let result = if scheduled.is_ok() {
                receiver.await.ok().flatten()
            } else {
                None
            };
            result.map_or((None, None, None), |(result, was_loaded, thread)| {
                (Some(result), was_loaded, thread)
            })
        } else {
            (Some(window.destroy()), None, None)
        };
        let was_loaded = was_loaded.or(recycle_was_loaded);
        if !matches!(destroy_result, Some(Ok(()))) {
            crate::webview_watchdog::realtime_window_replacement_failed(&label);
            if let Some(Err(error)) = destroy_result {
                log::warn!("failed to destroy Messenger webview {label}: {error}");
            }
            let state = app.state::<AppState>();
            {
                let _pending = state.pending_action.lock().unwrap();
                if let Some(was_loaded) = was_loaded {
                    state.messenger_loaded.store(was_loaded, Ordering::Release);
                }
            }
            state.recreating.store(false, Ordering::SeqCst);
            if let Some(on_abandoned) = on_abandoned {
                on_abandoned();
            }
            return;
        }

        // Rebuild exactly as launch does: visible, through the launch page, to
        // Messenger's home; the page then reopens the thread. On
        // Linux a thread URL as the first document puts Facebook's
        // SharedWorker in a separate ~300 MB web process, and an invisible
        // window is never realized, so blank-page recovery loops.
        // Tauri frees the label only once the native window reports it was
        // destroyed, which on macOS can take longer than a fixed pause.
        const MAX_BUILD_ATTEMPTS: usize = 3;
        for _ in 0..100 {
            if app.get_webview_window(&label).is_none() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let settings = app.state::<AppState>().settings.lock().unwrap().clone();
        for attempt in 1..=MAX_BUILD_ATTEMPTS {
            match build_app_window_with_render_budget(
                &app,
                &label,
                &settings,
                render_budget.clone(),
                was_focused,
                restore_thread.clone(),
            ) {
                Ok(rebuilt) => {
                    if label == "main" {
                        install_main_close_handler(&app, &rebuilt);
                    }
                    if let Some((position, size)) = geometry {
                        let _ = rebuilt.set_position(tauri::Position::Physical(position));
                        let _ = rebuilt.set_size(tauri::Size::Physical(size));
                    }
                    if was_maximized {
                        let _ = rebuilt.maximize();
                    }
                    if was_fullscreen {
                        let _ = rebuilt.set_fullscreen(true);
                    }
                    if was_visible {
                        let _ = rebuilt.show();
                    } else {
                        let _ = rebuilt.hide();
                    }
                    if was_minimized {
                        let _ = rebuilt.minimize();
                    } else if was_focused {
                        let _ = rebuilt.set_focus();
                    }
                    app.state::<AppState>()
                        .recreating
                        .store(false, Ordering::SeqCst);
                    return;
                }
                Err(error) => {
                    log::warn!(
                        "failed to rebuild blank Messenger webview {label} \
                         (attempt {attempt}/{MAX_BUILD_ATTEMPTS}): {error}"
                    );
                    if attempt < MAX_BUILD_ATTEMPTS {
                        tokio::time::sleep(std::time::Duration::from_millis(250 * attempt as u64))
                            .await;
                    }
                }
            }
        }

        if memory_recycle || render_budget.used() {
            // Frame recovery and optional recycling are bounded to this window.
            log::error!(
                "failed to construct replacement Messenger window {label}; reopen Chatpane from the tray or relaunch manually"
            );
            crate::webview_watchdog::realtime_window_rebuild_failed(&label);
            app.state::<AppState>()
                .recreating
                .store(false, Ordering::SeqCst);
            return;
        }

        // The old window is already gone, so there is nothing left for its
        // watchdog to supervise. Restarting is the final recovery path and uses
        // the same persisted cookies/settings as an ordinary app launch.
        log::error!(
            "failed to rebuild blank Messenger webview {label} after \
             {MAX_BUILD_ATTEMPTS} attempts; restarting Chatpane"
        );
        crate::webview_watchdog::realtime_window_rebuild_failed(&label);
        app.restart();
    });
    true
}

/// Open (or focus) the dedicated settings window (a small local page, separate
/// from the Messenger view).
pub(crate) fn show_settings_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    // Match the Messenger windows' topmost state so the dialog isn't trapped
    // behind them when Always on Top is enabled.
    let (aot, theme) = {
        let state = app.state::<AppState>();
        let s = state.settings.lock().unwrap();
        (s.always_on_top, theme_for(&s))
    };
    let builder =
        WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
            .title(format!("{APP_TITLE} Settings"))
            .inner_size(900.0, 720.0)
            .min_inner_size(720.0, 620.0)
            .resizable(true)
            .maximizable(false)
            .minimizable(false)
            .always_on_top(aot)
            .theme(theme);
    // macOS: the window buttons float over the tab bar, as in the Messenger
    // windows (see macos::title_bar), so a theme change needs no rebuild.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    // Windows and Linux: Chatpane's title bar, as in the Messenger windows
    // (crate::title_bar): the page draws the close button.
    let builder = {
        let state = app.state::<AppState>();
        let s = state.settings.lock().unwrap();
        #[cfg(target_os = "linux")]
        let builder = builder.decorations(native_decorations(&s));
        #[cfg(target_os = "windows")]
        let builder = builder.decorations(false);
        builder
            .initialization_script(crate::title_bar::initial_script(&s, false))
            // The page draws the controls once it's loaded: restate them then.
            .on_page_load(|window, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Finished {
                    crate::title_bar::page_loaded(&window);
                }
            })
    };
    match builder.build() {
        Ok(window) => {
            {
                let state = app.state::<AppState>();
                let s = state.settings.lock().unwrap();
                crate::app_icon::apply_window_icon(&window, &s);
            }
            // A reopened Settings window starts from the initial state.
            window.on_window_event(|event| {
                if matches!(event, WindowEvent::Destroyed) {
                    crate::title_bar::forget("settings");
                }
            });
            #[cfg(target_os = "macos")]
            {
                crate::macos::title_bar::install(&window);
                drop(window);
            }

            #[cfg(not(target_os = "macos"))]
            let _ = window.remove_menu();
            #[cfg(target_os = "linux")]
            crate::linux_tiling::watch(&window);

            #[cfg(target_os = "windows")]
            {
                // Keep the local Settings webview alive when its close button is
                // pressed. Rebuilding WebView2 repeatedly retains two unnamed
                // shared-memory section handles per teardown, and reusing the same
                // native window also prevents its removed menu from resurfacing.
                let close_window = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = close_window.hide();
                    }
                });
            }
        }
        Err(error) => log::error!("failed to create Settings window: {error}"),
    }
}

fn audio_init_script() -> &'static str {
    INJECT_WEB_AUDIO_IDLE
}

fn init_script(
    settings: &Settings,
    watchdog_id: u64,
    download_reveal_token: &str,
    scheduled_send_available: bool,
) -> String {
    let platform = match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    };
    let platform_literal = serde_json::to_string(platform).expect("platform serialises");
    let css_literal = serde_json::to_string(INJECT_CSS).expect("CSS serialises");
    let settings_literal = serde_json::to_string(settings).expect("settings serialise");
    let reveal_token_literal =
        serde_json::to_string(download_reveal_token).expect("reveal token serialises");
    // The strip for the window controls, set before the features run.
    let title_bar_inset = crate::title_bar::initial_script(settings, true);
    format!(
        r#"(function () {{
  var chatpaneHost = String(location.hostname || '').toLowerCase().replace(/^www\./, '');
  // WebView2 currently ignores Tauri's main-frame-only flag. Enforce it here
  // too so native bridges never initialize in child frames.
  if (window.top !== window.self) return;
  // A window Messenger opened (a call). On macOS it shares its opener's
  // scripts, but Chatpane's features and bridges belong to its own windows.
  if (window.opener) return;
  var chatpaneInjectable =
    chatpaneHost === 'facebook.com' ||
    chatpaneHost.endsWith('.facebook.com') ||
    chatpaneHost === 'messenger.com' ||
    chatpaneHost.endsWith('.messenger.com');
{title_bar_inset}
  if (!chatpaneInjectable) {{
    // Keep normal feature injection off Chatpane's trusted local pages. Debug
    // builds still need their MCP responder there so the connectivity screen
    // can be exercised when Messenger itself is unreachable.
    if (chatpaneHost === 'tauri.localhost') {{
{INJECT_MCP_BRIDGE}
    }}
    return;
  }}

  window.__CHATPANE_HEARTBEAT_ID__ = {watchdog_id};
  window.__CHATPANE_SCHEDULED_SEND_AVAILABLE__ = {scheduled_send_available};

  // Import the per-window secret as a non-extractable key. Only signed request
  // data crosses Tauri's page-visible serializer, so a hostile inherited
  // toJSON hook can observe or corrupt a request but cannot recover the key or
  // create a different valid request. One-time nonces prevent replay.
  var chatpaneAuthorizedEmit = (function (invoke, secret) {{
    if (!invoke || !crypto.subtle) return;
    var nativeArrayIsArray = Array.isArray.bind(Array);
    var nativeDefineProperty = Object.defineProperty;
    var nativeObjectCreate = Object.create;
    var nativeObjectKeys = Object.keys;
    var nativeSetPrototypeOf = Object.setPrototypeOf;
    var nativeStringify = JSON.stringify;
    var nativeReflectApply = Reflect.apply;
    var nativeStringCharCodeAt = String.prototype.charCodeAt;
    var NativeUint8Array = Uint8Array;
    var encoder = new TextEncoder();
    var nativeEncode = encoder.encode.bind(encoder);
    var nativeGetRandomValues = crypto.getRandomValues.bind(crypto);
    var nativeImportKey = crypto.subtle.importKey.bind(crypto.subtle);
    var nativeSign = crypto.subtle.sign.bind(crypto.subtle);
    var nativeVerify = crypto.subtle.verify.bind(crypto.subtle);
    var key = nativeImportKey(
      'raw', nativeEncode(secret), {{ name: 'HMAC', hash: 'SHA-256' }}, false, ['sign', 'verify']
    );
    function inertClone(value) {{
      if (value === null || typeof value !== 'object') return value;
      var clone = nativeArrayIsArray(value) ? [] : nativeObjectCreate(null);
      if (nativeArrayIsArray(value)) nativeSetPrototypeOf(clone, null);
      var keys = nativeObjectKeys(value);
      for (var index = 0; index < keys.length; index += 1) {{
        var name = keys[index];
        nativeDefineProperty(clone, name, {{
          value: inertClone(value[name]), enumerable: true, configurable: true
        }});
      }}
      return clone;
    }}
    function hex(bytes) {{
      var alphabet = '0123456789abcdef';
      var output = '';
      for (var index = 0; index < bytes.length; index += 1) {{
        output += alphabet[bytes[index] >> 4] + alphabet[bytes[index] & 15];
      }}
      return output;
    }}
    function unhex(value) {{
      if (typeof value !== 'string' || value.length !== 64) return;
      var bytes = new NativeUint8Array(32);
      for (var index = 0; index < bytes.length; index += 1) {{
        var high = nativeReflectApply(nativeStringCharCodeAt, value, [index * 2]);
        var low = nativeReflectApply(nativeStringCharCodeAt, value, [index * 2 + 1]);
        high = high >= 48 && high <= 57 ? high - 48 : high >= 97 && high <= 102 ? high - 87 : -1;
        low = low >= 48 && low <= 57 ? low - 48 : low >= 97 && low <= 102 ? low - 87 : -1;
        if (high < 0 || low < 0) return;
        bytes[index] = (high << 4) | low;
      }}
      return bytes;
    }}
    var emit = async function (event, value) {{
      var nonceBytes = new NativeUint8Array(16);
      nativeGetRandomValues(nonceBytes);
      var nonce = hex(nonceBytes);
      var timestamp = Date.now();
      var message = nativeStringify(inertClone(value));
      var authenticated = event + '\n' + timestamp + '\n' + nonce + '\n' + message;
      var signature = hex(new NativeUint8Array(
        await nativeSign('HMAC', await key, nativeEncode(authenticated))
      ));
      return invoke('plugin:event|emit', {{
        event: event,
        payload: {{ message: message, nonce: nonce, timestamp: timestamp, signature: signature }}
      }});
    }};
    nativeDefineProperty(emit, 'verifyResult', {{
      value: async function (event, value, signature) {{
        var signatureBytes = unhex(signature);
        if (!signatureBytes) return false;
        var message = nativeStringify(inertClone(value));
        return nativeVerify(
          'HMAC', await key, signatureBytes, nativeEncode(event + '\n' + message)
        );
      }}
    }});
    return emit;
  }})(
    window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke
      ? window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__)
      : undefined,
    {reveal_token_literal}
  );
  var chatpaneVerifyResult = chatpaneAuthorizedEmit && chatpaneAuthorizedEmit.verifyResult;

  var nativeWindowAddEventListener = EventTarget.prototype.addEventListener;
  var nativeWindowRemoveEventListener = EventTarget.prototype.removeEventListener;
  var nativeObjectDefineProperty = Object.defineProperty;
  var nativeSetTimeout = window.setTimeout.bind(window);
  var nativeClearTimeout = window.clearTimeout.bind(window);
  var NativePromise = Promise;
  var nativeGetRandomValues = crypto.getRandomValues.bind(crypto);
  var NativeUint8Array = Uint8Array;
  var nativeReflectApply = Reflect.apply;
  var chatpaneNativeRequest = function () {{
    var bytes = new NativeUint8Array(16);
    nativeGetRandomValues(bytes);
    var alphabet = '0123456789abcdef';
    var request = '';
    for (var index = 0; index < bytes.length; index += 1) {{
      request += alphabet[bytes[index] >> 4] + alphabet[bytes[index] & 15];
    }}
    return request;
  }};

  // One request/response lifecycle for every result-bearing native call: sign
  // and emit the request with a fresh correlation token, then settle only on a
  // '<event>-result' CustomEvent that carries that token, a boolean under
  // `field`, and a signature that verifies against this window's secret. A
  // result can optionally authenticate a second boolean that selects a more
  // specific failure message.
  // Blocking native UI can acknowledge presentation first, clearing the
  // timeout, then send its final result after the blocking call returns.
  var chatpaneNativeCall = function (
    requestEvent, field, failedMessage, timedOutMessage, payload, acknowledgesBeforeFinal,
    failureField, alternateFailedMessage
  ) {{
    if (!chatpaneAuthorizedEmit || !chatpaneVerifyResult) {{
      return NativePromise.reject(new Error('native bridge unavailable'));
    }}
    var resultEvent = requestEvent + '-result';
    var request = chatpaneNativeRequest();
    return new NativePromise(function (resolve, reject) {{
      var acknowledged = false;
      var finish = async function (event) {{
        var detail = event && event.detail;
        if (!detail || detail.request !== request) return;
        var value = detail[field];
        if (value !== true && value !== false) return;
        var phase;
        if (acknowledgesBeforeFinal) {{
          phase = detail.phase;
          if (phase !== 'presented' && phase !== 'complete') return;
          if (phase === 'presented' && value !== true) return;
        }}
        var failureValue;
        if (failureField) {{
          failureValue = detail[failureField];
          if (failureValue !== true && failureValue !== false) return;
        }}
        // Field order matters. Phased calls append `phase` after the result field.
        var result = {{ request: request }};
        result[field] = value;
        if (acknowledgesBeforeFinal) result.phase = phase;
        if (failureField) result[failureField] = failureValue;
        var authenticated = await chatpaneVerifyResult(resultEvent, result, detail.signature);
        if (!authenticated) return;
        if (acknowledgesBeforeFinal && phase === 'presented') {{
          if (!acknowledged) {{
            acknowledged = true;
            nativeClearTimeout(timeout);
          }}
          return;
        }}
        cleanup();
        if (value) resolve();
        else reject(new Error(failureValue === false ? alternateFailedMessage : failedMessage));
      }};
      var timeout = nativeSetTimeout(function () {{
        cleanup();
        reject(new Error(timedOutMessage));
      }}, 15000);
      var cleanup = function () {{
        nativeClearTimeout(timeout);
        nativeReflectApply(nativeWindowRemoveEventListener, window, [resultEvent, finish]);
      }};
      nativeReflectApply(nativeWindowAddEventListener, window, [resultEvent, finish]);
      payload.request = request;
      chatpaneAuthorizedEmit(requestEvent, payload).catch(function (error) {{
        cleanup();
        reject(error);
      }});
    }});
  }};

  var chatpaneRevealDownload = function (url) {{
    if (!chatpaneAuthorizedEmit) {{
      return NativePromise.reject(new Error('native bridge unavailable'));
    }}
    return chatpaneAuthorizedEmit('chatpane:reveal-download', {{ url: url }});
  }};
  var chatpaneOpenDownloadPrivacy = function () {{
    if (!chatpaneAuthorizedEmit) {{
      return NativePromise.reject(new Error('native bridge unavailable'));
    }}
    return chatpaneAuthorizedEmit('chatpane:open-download-privacy', {{}});
  }};
  // The star toast (growth.rs): 'shown' ends the prompt, 'star' opens GitHub.
  var chatpaneStarPrompt = function (action) {{
    if (!chatpaneAuthorizedEmit) {{
      return NativePromise.reject(new Error('native bridge unavailable'));
    }}
    return chatpaneAuthorizedEmit('chatpane:star-prompt', {{ action: action }});
  }};
  // Chatpane's title bar (title_bar.rs): signed, so a page can only act on its
  // own window.
  var chatpaneWindowControl = function (action) {{
    if (!chatpaneAuthorizedEmit) {{
      return NativePromise.reject(new Error('native bridge unavailable'));
    }}
    return chatpaneAuthorizedEmit('chatpane:window-control', {{ action: action }});
  }};
  var chatpaneMediaViewer = function (open) {{
    if (!chatpaneAuthorizedEmit) {{
      return NativePromise.reject(new Error('native bridge unavailable'));
    }}
    return chatpaneAuthorizedEmit('chatpane:media-viewer', {{ open: open }});
  }};
  var chatpaneClaimContextAction = function (action) {{
    if (!chatpaneAuthorizedEmit) {{
      return NativePromise.reject(new Error('native bridge unavailable'));
    }}
    return chatpaneAuthorizedEmit('chatpane:claim-context-action', {{ action: action }});
  }};
  var chatpaneMediaPlatform = {platform_literal};
  var chatpaneMediaPermissionStatus = function (device) {{
    if (!chatpaneAuthorizedEmit || !chatpaneVerifyResult) return NativePromise.reject(new Error('native bridge unavailable'));
    var request = chatpaneNativeRequest();
    var resultEvent = 'chatpane:media-permission-status-result';
    return new NativePromise(function (resolve, reject) {{
      var valid = function (value) {{
        return value === 'unknown' || value === 'not-determined' || value === 'restricted' || value === 'denied' || value === 'allowed';
      }};
      var cleanup = function () {{
        nativeClearTimeout(timeout);
        nativeReflectApply(nativeWindowRemoveEventListener, window, [resultEvent, finish]);
      }};
      var finish = async function (event) {{
        var detail = event && event.detail;
        if (!detail || detail.request !== request || !valid(detail.camera) || !valid(detail.microphone)) return;
        var result = {{ request: request, camera: detail.camera, microphone: detail.microphone }};
        if (!await chatpaneVerifyResult(resultEvent, result, detail.signature)) return;
        cleanup();
        resolve({{ camera: result.camera, microphone: result.microphone }});
      }};
      var timeout = nativeSetTimeout(function () {{ cleanup(); reject(new Error('permission status timed out')); }}, device ? 120000 : 15000);
      nativeReflectApply(nativeWindowAddEventListener, window, [resultEvent, finish]);
      var payload = {{ request: request }};
      if (device) payload.device = device;
      chatpaneAuthorizedEmit('chatpane:media-permission-status', payload).catch(function (error) {{ cleanup(); reject(error); }});
    }});
  }};
  var chatpaneOpenMediaPrivacy = function (device) {{
    return chatpaneNativeCall(
      'chatpane:open-media-privacy', 'opened',
      'privacy settings could not open', 'privacy settings timed out',
      {{ device: device }}
    );
  }};
  var chatpanePrepareDownload = function (action, url) {{
    if (!chatpaneAuthorizedEmit) {{
      return NativePromise.reject(new Error('native bridge unavailable'));
    }}
    return chatpaneAuthorizedEmit('chatpane:prepare-download', {{ action: action, url: url }});
  }};
  var chatpaneChooseDownload = function (url, name) {{
    return chatpaneNativeCall(
      'chatpane:choose-download', 'chosen',
      'download cancelled', 'download picker timed out',
      {{ url: url, name: name }}, true, 'cancelled', 'download rejected'
    );
  }};
  var chatpaneExportConversation = function (payload) {{
    return chatpaneNativeCall(
      'chatpane:export-conversation', 'saved',
      'export cancelled', 'export timed out',
      {{ format: payload.format, conversation: payload.conversation, reveal: payload.reveal }},
      true, 'cancelled', 'export failed'
    );
  }};
  var chatpaneShareDownload = function (downloadId, x, y, action) {{
    return chatpaneNativeCall(
      'chatpane:share-download', 'shown',
      'native share picker failed', 'native share picker timed out',
      {{ download_id: downloadId, x: x, y: y, action: action }}
    );
  }};
  var chatpaneCopyImage = function (dataUrl, action) {{
    return chatpaneNativeCall(
      'chatpane:copy-image', 'copied',
      'native clipboard write failed', 'native clipboard write timed out',
      {{ data_url: dataUrl, action: action }}
    );
  }};
  var chatpaneShowContextMenu = function (items, position) {{
    return chatpaneNativeCall(
      'chatpane:context-menu', 'shown',
      'native context menu was not shown', 'native context menu timed out',
      position ? {{ items: items, position: position }} : {{ items: items }}, true
    );
  }};
  var chatpaneReplyResult = function (id, attempt, ok) {{
    if (!chatpaneAuthorizedEmit) {{
      return NativePromise.reject(new Error('native bridge unavailable'));
    }}
    return chatpaneAuthorizedEmit('chatpane:reply-result', {{ id: id, attempt: attempt, ok: ok }});
  }};
  var chatpaneScheduledSend = function (payload) {{
    if (!chatpaneAuthorizedEmit || !chatpaneVerifyResult) return NativePromise.reject(new Error('native bridge unavailable'));
    var request = chatpaneNativeRequest();
    var resultEvent = 'chatpane:scheduled-send-result';
    return new NativePromise(function (resolve, reject) {{
      var cleanup = function () {{
        nativeClearTimeout(timeout);
        nativeReflectApply(nativeWindowRemoveEventListener, window, [resultEvent, finish]);
      }};
      var finish = async function (event) {{
        var detail = event && event.detail;
        if (!detail || detail.request !== request || typeof detail.data !== 'string') return;
        var result = {{ request: request, data: detail.data }};
        if (!await chatpaneVerifyResult(resultEvent, result, detail.signature)) return;
        cleanup();
        try {{ resolve(JSON.parse(result.data)); }} catch (error) {{ reject(error); }}
      }};
      var timeout = nativeSetTimeout(function () {{ cleanup(); reject(new Error('Scheduled messages did not respond. Restart Chatpane to retry.')); }}, 15000);
      nativeReflectApply(nativeWindowAddEventListener, window, [resultEvent, finish]);
      payload.request = request;
      chatpaneAuthorizedEmit('chatpane:scheduled-send', payload).catch(function (error) {{ cleanup(); reject(error); }});
    }});
  }};

  // Prefer settings cached in localStorage (written by apply_settings on every
  // change) over this baked-in snapshot, so an in-session settings change
  // survives Facebook reloading the page (which re-runs this script). Falls back
  // to the snapshot on first load / if storage was cleared.
  var baked = {settings_literal};
  try {{
    // Merge the cache onto the baked defaults (rather than replacing) so a stale
    // or partial cached object can't drop fields the current build expects, and
    // sanitise enum-like settings.
    var stored = JSON.parse(localStorage.getItem('__chatpane_settings') || 'null');
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {{
      var merged = Object.assign({{}}, baked, stored);
      if (merged.badge_mode !== 'messages' && merged.badge_mode !== 'conversations' && merged.badge_mode !== 'dot') {{
        merged.badge_mode = baked.badge_mode;
      }}
      if (merged.tray_icon_style !== 'color' && merged.tray_icon_style !== 'symbolic') {{
        merged.tray_icon_style = baked.tray_icon_style;
      }}
      if (merged.download_behavior !== 'downloads' && merged.download_behavior !== 'ask') {{
        merged.download_behavior = baked.download_behavior;
      }}
      var mz = Math.round(Number(merged.zoom));
      merged.zoom = isFinite(mz) ? Math.min({ZOOM_MAX}, Math.max({ZOOM_MIN}, mz)) : baked.zoom;
      window.__CHATPANE_SETTINGS__ = merged;
    }} else {{
      window.__CHATPANE_SETTINGS__ = baked;
    }}
  }} catch (e) {{
    window.__CHATPANE_SETTINGS__ = baked;
  }}
  var css = {css_literal};
  function inject() {{
    if (!document.head) return false;
    if (document.head.querySelector('style[data-chatpane]')) return true;
    var s = document.createElement('style');
    s.setAttribute('data-chatpane', '');
    s.textContent = css;
    document.head.appendChild(s);
    return true;
  }}
  var chatpaneStarted = false;
  function startChatpane() {{
    // WebView2 runs document-created scripts before the HTML document is
    // parsed. In that phase documentElement and head are both null; observing
    // documentElement would throw and abort the entire injected bundle.
    if (!document.documentElement) return false;
    if (chatpaneStarted) return true;
    chatpaneStarted = true;
    if (!inject()) {{
      new MutationObserver(function (_, obs) {{ if (inject()) obs.disconnect(); }})
        .observe(document.documentElement, {{ childList: true, subtree: true }});
    }}
{INJECT_JS}
{INJECT_PANEL}
{INJECT_MCP_BRIDGE}
    return true;
  }}
  if (!startChatpane()) {{
    // Document itself already exists in WebView2's pre-parse phase and is a
    // valid MutationObserver target. Start the bundle as soon as <html> lands.
    new MutationObserver(function (_, obs) {{
      if (startChatpane()) obs.disconnect();
    }}).observe(document, {{ childList: true, subtree: true }});
  }}
}})();"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // theme_for / is_dark / splash_background  (new in this PR)
    // -----------------------------------------------------------------------

    fn with_theme(theme: &str) -> Settings {
        Settings {
            theme: theme.into(),
            ..Default::default()
        }
    }

    #[test]
    fn theme_for_dark_returns_dark() {
        assert_eq!(theme_for(&with_theme("dark")), Some(tauri::Theme::Dark));
    }

    #[test]
    fn theme_for_light_returns_light() {
        assert_eq!(theme_for(&with_theme("light")), Some(tauri::Theme::Light));
    }

    #[test]
    fn theme_for_system_returns_none() {
        assert_eq!(theme_for(&with_theme("system")), None);
    }

    #[test]
    fn theme_for_unknown_string_returns_none() {
        assert_eq!(theme_for(&with_theme("auto")), None);
        assert_eq!(theme_for(&with_theme("")), None);
    }

    // "system" calls system_prefers_dark() (OS-dependent), so only the
    // explicitly-forced cases are asserted here.
    #[test]
    fn is_dark_forced_dark() {
        assert!(is_dark(&with_theme("dark")));
    }

    #[test]
    fn is_dark_forced_light() {
        assert!(!is_dark(&with_theme("light")));
    }

    #[test]
    fn splash_background_dark_is_facebook_dark_color() {
        // Facebook's dark background colour, as hard-coded in the function.
        assert_eq!(
            splash_background(&with_theme("dark")),
            Color(24, 25, 26, 255)
        );
    }

    #[test]
    fn splash_background_light_is_white() {
        assert_eq!(
            splash_background(&with_theme("light")),
            Color(255, 255, 255, 255)
        );
    }

    #[test]
    fn hide_on_close_with_a_tray_hides() {
        assert!(should_hide_on_close(true, true));
    }

    #[test]
    fn hide_on_close_off_quits_even_with_a_tray() {
        assert!(!should_hide_on_close(false, true));
        assert!(!should_hide_on_close(false, false));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn hide_on_close_without_a_tray_quits_off_macos() {
        assert!(!should_hide_on_close(true, false));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn hide_on_close_without_a_tray_hides_on_macos() {
        assert!(should_hide_on_close(true, false));
    }

    #[test]
    fn exit_requested_from_window_close_is_prevented_when_hiding() {
        assert!(should_prevent_app_exit(false, true, true, None));
    }

    #[test]
    fn exit_requested_from_window_close_quits_when_hide_on_close_is_off() {
        assert!(!should_prevent_app_exit(false, false, true, None));
    }

    #[test]
    fn app_exit_with_a_code_is_not_prevented() {
        // Tray Quit and other AppHandle::exit(0) callers. Native Cmd+Q does not
        // emit ExitRequested at all (see should_prevent_app_exit).
        assert!(!should_prevent_app_exit(false, true, true, Some(0)));
        assert!(!should_prevent_app_exit(true, true, true, Some(0)));
    }

    #[test]
    fn recreating_windows_prevents_a_window_close_exit() {
        assert!(should_prevent_app_exit(true, false, false, None));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_auto_hide_requires_both_the_matching_option_and_a_tray() {
        let focus = Settings {
            hide_on_focus_loss: true,
            ..Default::default()
        };
        assert!(should_auto_hide_windows_main(
            &focus, true, false, true, false
        ));
        assert!(!should_auto_hide_windows_main(
            &focus, true, false, false, true
        ));
        assert!(!should_auto_hide_windows_main(
            &focus, false, false, true, false
        ));
        assert!(!should_auto_hide_windows_main(
            &focus, true, true, true, false
        ));

        let minimize = Settings {
            hide_on_minimize: true,
            ..Default::default()
        };
        assert!(should_auto_hide_windows_main(
            &minimize, true, false, false, true
        ));
        assert!(!should_auto_hide_windows_main(
            &minimize, true, false, true, false
        ));
        assert!(!should_auto_hide_windows_main(
            &minimize, false, false, false, true
        ));
        assert!(!should_auto_hide_windows_main(
            &minimize, true, true, false, true
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_auto_hide_ignores_unrelated_events_and_disabled_options() {
        assert!(!should_auto_hide_windows_main(
            &Settings::default(),
            true,
            false,
            true,
            true
        ));
        assert!(!should_auto_hide_windows_main(
            &Settings {
                hide_on_focus_loss: true,
                hide_on_minimize: true,
                ..Default::default()
            },
            true,
            false,
            false,
            false
        ));
    }

    #[test]
    fn init_script_waits_for_webview2_document_element() {
        let script = init_script(&Settings::default(), 42, "test-reveal-token", true);
        assert!(script.contains("window.__CHATPANE_HEARTBEAT_ID__ = 42;"));
        assert!(script.contains("window.__CHATPANE_SCHEDULED_SEND_AVAILABLE__ = true;"));
        assert!(
            init_script(&Settings::default(), 42, "test-reveal-token", false)
                .contains("window.__CHATPANE_SCHEDULED_SEND_AVAILABLE__ = false;")
        );
        assert!(script.contains("test-reveal-token"));
        assert!(script.contains("if (window.top !== window.self) return;"));
        assert!(script.contains("if (!document.documentElement) return false;"));
        assert!(script.contains(").observe(document, { childList: true, subtree: true });"));

        let start = script.find("function startChatpane() {").unwrap();
        let messenger = script.find("Source: inject/src/messenger/").unwrap();
        let fallback = script
            .find("if (!startChatpane()) {\n    // Document itself")
            .unwrap();
        assert!(start < messenger);
        assert!(messenger < fallback);
    }

    #[test]
    fn audio_init_script_is_origin_scoped_and_contains_no_privileged_bridge() {
        let script = audio_init_script();

        assert!(script.contains("isMessengerHost"));
        assert!(script.contains("\"fbsbx.com\""));
        assert!(script.contains("chatpane:web-audio-call-state:v1"));
        assert!(script.contains("event.source !== window.parent"));
        assert!(script.contains("Source: inject/src/web-audio-idle.ts"));
        assert!(script.find("\"use strict\";").unwrap() < script.find("isMessengerHost").unwrap());
        assert!(!script.contains("__CHATPANE_HEARTBEAT_ID__"));
        assert!(!script.contains("chatpaneAuthorizedEmit"));
        assert!(!script.contains("test-reveal-token"));
    }

    #[test]
    fn privileged_bridges_emit_signed_payloads_instead_of_raw_tokens() {
        let script = init_script(&Settings::default(), 42, "test-reveal-token", true);

        assert!(script.contains("name: 'HMAC', hash: 'SHA-256'"));
        assert!(script.contains("false, ['sign', 'verify']"));
        assert!(
            script.contains(
                "payload: { message: message, nonce: nonce, timestamp: timestamp, signature: signature }"
            )
        );
        assert!(script.contains("event + '\\n' + timestamp + '\\n' + nonce + '\\n' + message"));
        assert!(!script.contains("authorization: authorization"));
        assert!(!script.contains("__chatpaneDispatchContextAction"));
        assert!(script.contains("chatpaneAuthorizedEmit('chatpane:open-download-privacy', {})"));
    }

    #[test]
    fn native_call_factory_waits_for_the_authenticated_result() {
        let script = init_script(&Settings::default(), 42, "test-reveal-token", true);

        assert!(
            script
                .contains("request += alphabet[bytes[index] >> 4] + alphabet[bytes[index] & 15];")
        );
        assert!(!script.contains("bytes[index].toString(16).padStart(2, '0')"));
        // Every result-bearing bridge goes through the one factory: correlation
        // token, '<event>-result' listener, signature verification, timeout.
        assert!(script.contains("var resultEvent = requestEvent + '-result';"));
        assert!(script.contains("payload.request = request;"));
        assert!(script.contains("chatpaneAuthorizedEmit.verifyResult"));
        assert!(script.contains("detail.signature"));
    }

    #[test]
    fn quick_reply_results_use_the_authenticated_emit_bridge() {
        let script = init_script(&Settings::default(), 42, "test-reveal-token", true);

        assert!(script.contains("return chatpaneAuthorizedEmit('chatpane:reply-result'"));
        assert!(script.contains("chatpaneReplyResult(id, attempt, ok)"));
    }

    #[test]
    fn copy_image_bridge_goes_through_the_native_call_factory() {
        let script = init_script(&Settings::default(), 42, "test-reveal-token", true);

        assert!(script.contains("'chatpane:copy-image', 'copied'"));
        assert!(script.contains("data_url: dataUrl, action: action"));
        assert!(script.contains("native clipboard write failed"));
    }

    #[test]
    fn share_download_bridge_goes_through_the_native_call_factory() {
        let script = init_script(&Settings::default(), 42, "test-reveal-token", true);

        assert!(script.contains("chatpane:claim-context-action"));
        assert!(script.contains("chatpane:prepare-download"));
        // The share result reports presentation, not a completed share.
        assert!(script.contains("'chatpane:share-download', 'shown'"));
        assert!(script.contains("download_id: downloadId, x: x, y: y, action: action"));
        assert!(script.contains("native share picker failed"));
    }

    #[test]
    fn choose_download_bridge_goes_through_the_native_call_factory() {
        let script = init_script(&Settings::default(), 42, "test-reveal-token", true);

        assert!(script.contains("'chatpane:choose-download', 'chosen'"));
        assert!(script.contains("{ url: url, name: name }, true, 'cancelled'"));
        assert!(script.contains("download cancelled"));
        assert!(script.contains("download rejected"));
        assert!(script.contains("download picker timed out"));
    }

    #[test]
    fn context_menu_bridge_goes_through_the_native_call_factory() {
        let script = init_script(&Settings::default(), 42, "test-reveal-token", true);

        assert!(script.contains("'chatpane:context-menu', 'shown'"));
        assert!(script.contains("{ items: items }, true"));
        assert!(script.contains("native context menu was not shown"));
    }

    #[cfg(all(feature = "mcp", debug_assertions))]
    #[test]
    fn mcp_init_script_can_inspect_the_local_connectivity_screen() {
        let script = init_script(&Settings::default(), 42, "test-reveal-token", true);
        let local_branch = script
            .find("if (chatpaneHost === 'tauri.localhost')")
            .unwrap();
        let first_bridge = script.find("tauri-mcp guest bridge").unwrap();
        let injectable_return = script
            .find("    return;\n  }\n\n  window.__CHATPANE_HEARTBEAT_ID__")
            .unwrap();

        assert!(local_branch < first_bridge);
        assert!(first_bridge < injectable_return);
        assert_eq!(
            script
                .matches("if (window.__CHATPANE_MCP_BRIDGE__) return;")
                .count(),
            2
        );
    }
}
