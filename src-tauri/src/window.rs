//! Window construction: the Messenger windows (with navigation/download
//! policies and the injected init script), the Settings dialog, theme helpers,
//! and the theme-change window rebuild.

use tauri::{
    webview::{Color, DownloadEvent},
    Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;
use url::Url;

use crate::custom_css::apply_custom_css;
use crate::download::{
    downloads_dir, filename_from_url, is_allowed_download, is_unsafe_download, sanitize_filename,
    unique_path,
};
#[cfg(target_os = "macos")]
use crate::macos::theme::make_webview_transparent;
use crate::settings::{
    load_settings, save_settings, AppState, SaveOutcome, Settings, ZOOM_MAX, ZOOM_MIN,
};
use crate::url_rules::{is_internal, unwrap_tracking};
use crate::webview_watchdog::WebviewWatchdog;
use crate::{user_agent, APP_TITLE, INJECT_CSS, INJECT_JS, INJECT_MCP_BRIDGE, INJECT_PANEL};

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
        _ => matches!(dark_light::detect(), Ok(dark_light::Mode::Dark)),
    }
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

/// Build a Carrier window (used for the main window and any extra windows).
pub(crate) fn build_app_window(
    app: &tauri::AppHandle,
    label: &str,
    settings: &Settings,
) -> tauri::Result<WebviewWindow> {
    let watchdog = WebviewWatchdog::new();
    let watchdog_id = watchdog.id();
    let page_load_watchdog = watchdog.clone();
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(APP_TITLE)
        .inner_size(1200.0, 780.0)
        .min_inner_size(420.0, 520.0)
        .theme(theme_for(settings))
        .background_color(splash_background(settings))
        .user_agent(user_agent())
        .initialization_script(init_script(settings, watchdog_id))
        .on_page_load(move |window, payload| match payload.event() {
            tauri::webview::PageLoadEvent::Started => page_load_watchdog.disarm(),
            tauri::webview::PageLoadEvent::Finished => apply_custom_css(&window, payload.url()),
        })
        .on_navigation(|url| {
            // External tracking redirect -> open the real (web-only) destination.
            if let Some(real) = unwrap_tracking(url) {
                if Url::parse(&real).is_ok_and(|r| matches!(r.scheme(), "http" | "https")) {
                    let _ = open::that(real);
                }
                return false;
            }
            if is_internal(url) {
                return true;
            }
            // Open ordinary web links in the browser; block anything else
            // (data:, javascript:, file:, custom schemes).
            if matches!(url.scheme(), "http" | "https") {
                let _ = open::that(url.as_str());
            }
            false
        })
        .on_download(|_webview, event| {
            if let DownloadEvent::Requested { url, destination } = event {
                // Only accept downloads of Messenger's own media or page-generated
                // blob:/data: content; refuse anything else a remote page might try
                // to write to the user's Downloads folder.
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
                    return false;
                }
                // Don't silently save an executable a page might push to Downloads.
                if is_unsafe_download(&name) {
                    return false;
                }
                // Fail closed: if we can't resolve/create the Downloads folder we
                // can't enforce where the file lands, so refuse rather than let the
                // WebView write to its own chosen destination.
                let Some(dir) = downloads_dir() else {
                    return false;
                };
                if std::fs::create_dir_all(&dir).is_err() {
                    return false;
                }
                *destination = unique_path(dir.join(name));
            }
            true
        })
        .build()
        .inspect(|window| {
            // New windows inherit the current always-on-top preference.
            let _ = window.set_always_on_top(settings.always_on_top);
            #[cfg(not(target_os = "macos"))]
            if settings.hide_menu_bar {
                let _ = window.hide_menu();
            }
            // macOS: let the themed window background show through the title bar.
            #[cfg(target_os = "macos")]
            make_webview_transparent(window);
        })?;
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

/// On macOS the window/title-bar theme is fixed at creation, so a live theme
/// change needs a full window rebuild; other platforms re-theme the chrome live
/// in `apply_settings`, so this is a no-op there (rebuilding would needlessly
/// reload Messenger and drop in-progress UI state).
#[cfg(target_os = "macos")]
pub(crate) fn recreate_on_theme_change(app: &tauri::AppHandle, prev: &str, next: &str) {
    if prev != next {
        recreate_themed_windows(app);
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn recreate_on_theme_change(_app: &tauri::AppHandle, _prev: &str, _next: &str) {}

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

/// Install the `main` window's close behaviour: hide to the tray when
/// `hide_on_close` is set and a tray exists, otherwise quit. Reinstalled on every
/// `main` window the app creates (startup and after a themed rebuild) so the
/// behaviour survives `recreate_themed_windows`.
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
            // Only hide to the tray if one was actually created (tray creation can
            // fail, e.g. on a Linux session without an AppIndicator); otherwise
            // closing the main window quits the app (don't let an open Settings
            // dialog keep it running).
            if hide && has_tray {
                api.prevent_close();
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.hide();
                }
                if first_tray_notice {
                    match handle
                        .notification()
                        .builder()
                        .title("Carrier is still running")
                        .body("Use the tray icon to reopen or quit Carrier.")
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

/// Rebuild every Messenger window (not the Settings dialog) with the current
/// settings. The macOS title bar's theme is fixed at window creation — no
/// runtime call repaints it — so a live theme switch is reflected by recreating
/// the window. Each rebuilt window keeps its place and size; the page reloads
/// (the login session is preserved by the persisted cookies). Runs off the
/// event-loop handler and destroys before rebuilding so the label is free.
#[cfg(target_os = "macos")]
pub(crate) fn recreate_themed_windows(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    // Claim the "recreating" flag synchronously: if a rebuild is already in
    // flight, skip this one. Setting it inside the spawned task would let two
    // rapid theme switches overlap, and the second could clear the flag mid-way
    // through the first's zero-window window — letting the app exit.
    if app
        .state::<AppState>()
        .recreating
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Snapshot label + geometry, then destroy (not close — close would just
        // hide it), so we can rebuild each window where it was.
        let targets: Vec<(String, _)> = app
            .webview_windows()
            .into_iter()
            .filter(|(label, _)| label != "settings")
            .map(|(label, window)| {
                let geometry = window.outer_position().ok().zip(window.inner_size().ok());
                let _ = window.destroy();
                (label, geometry)
            })
            .collect();
        if !targets.is_empty() {
            // Let the event loop finish destroying so the labels are free again.
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            // Read settings after the wait so a theme change during it is honoured.
            let settings = app.state::<AppState>().settings.lock().unwrap().clone();
            for (label, geometry) in targets {
                if let Ok(window) = build_app_window(&app, &label, &settings) {
                    // The rebuilt main window must re-acquire the close-to-tray
                    // handler startup installed on the original.
                    if label == "main" {
                        install_main_close_handler(&app, &window);
                    }
                    if let Some((pos, size)) = geometry {
                        let _ = window.set_position(tauri::Position::Physical(pos));
                        let _ = window.set_size(tauri::Size::Physical(size));
                    }
                }
            }
        }
        app.state::<AppState>()
            .recreating
            .store(false, Ordering::SeqCst);
    });
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
    match WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title(format!("{APP_TITLE} Settings"))
        .inner_size(680.0, 720.0)
        .min_inner_size(560.0, 620.0)
        .resizable(true)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(aot)
        .theme(theme)
        .build()
    {
        Ok(window) => {
            #[cfg(target_os = "macos")]
            drop(window);

            #[cfg(not(target_os = "macos"))]
            let _ = window.remove_menu();

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

fn init_script(settings: &Settings, watchdog_id: u64) -> String {
    let css_literal = serde_json::to_string(INJECT_CSS).expect("CSS serialises");
    let settings_literal = serde_json::to_string(settings).expect("settings serialise");
    format!(
        r#"(function () {{
  var carrierHost = String(location.hostname || '').toLowerCase().replace(/^www\./, '');
  var carrierInjectable =
    carrierHost === 'facebook.com' ||
    carrierHost.endsWith('.facebook.com') ||
    carrierHost === 'messenger.com' ||
    carrierHost.endsWith('.messenger.com');
  if (!carrierInjectable) {{
    // Keep normal feature injection off Carrier's trusted local pages. Debug
    // builds still need their MCP responder there so the connectivity screen
    // can be exercised when Messenger itself is unreachable.
    if (carrierHost === 'tauri.localhost') {{
{INJECT_MCP_BRIDGE}
    }}
    return;
  }}

  window.__CARRIER_HEARTBEAT_ID__ = {watchdog_id};

  // Prefer settings cached in localStorage (written by apply_settings on every
  // change) over this baked-in snapshot, so an in-session settings change
  // survives Facebook reloading the page (which re-runs this script). Falls back
  // to the snapshot on first load / if storage was cleared.
  var baked = {settings_literal};
  try {{
    // Merge the cache onto the baked defaults (rather than replacing) so a stale
    // or partial cached object can't drop fields the current build expects, and
    // sanitise enum-like settings.
    var stored = JSON.parse(localStorage.getItem('__carrier_settings') || 'null');
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {{
      var merged = Object.assign({{}}, baked, stored);
      if (merged.badge_mode !== 'messages' && merged.badge_mode !== 'conversations') {{
        merged.badge_mode = baked.badge_mode;
      }}
      var mz = Math.round(Number(merged.zoom));
      merged.zoom = isFinite(mz) ? Math.min({ZOOM_MAX}, Math.max({ZOOM_MIN}, mz)) : baked.zoom;
      window.__CARRIER_SETTINGS__ = merged;
    }} else {{
      window.__CARRIER_SETTINGS__ = baked;
    }}
  }} catch (e) {{
    window.__CARRIER_SETTINGS__ = baked;
  }}
  var css = {css_literal};
  function inject() {{
    if (!document.head) return false;
    if (document.head.querySelector('style[data-carrier]')) return true;
    var s = document.createElement('style');
    s.setAttribute('data-carrier', '');
    s.textContent = css;
    document.head.appendChild(s);
    return true;
  }}
  var carrierStarted = false;
  function startCarrier() {{
    // WebView2 runs document-created scripts before the HTML document is
    // parsed. In that phase documentElement and head are both null; observing
    // documentElement would throw and abort the entire injected bundle.
    if (!document.documentElement) return false;
    if (carrierStarted) return true;
    carrierStarted = true;
    if (!inject()) {{
      new MutationObserver(function (_, obs) {{ if (inject()) obs.disconnect(); }})
        .observe(document.documentElement, {{ childList: true, subtree: true }});
    }}
{INJECT_JS}
{INJECT_PANEL}
{INJECT_MCP_BRIDGE}
    return true;
  }}
  if (!startCarrier()) {{
    // Document itself already exists in WebView2's pre-parse phase and is a
    // valid MutationObserver target. Start the bundle as soon as <html> lands.
    new MutationObserver(function (_, obs) {{
      if (startCarrier()) obs.disconnect();
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

    // "system" calls dark_light::detect() (OS-dependent), so only the
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
        let script = init_script(&Settings::default(), 42);
        assert!(script.contains("window.__CARRIER_HEARTBEAT_ID__ = 42;"));
        assert!(script.contains("if (!document.documentElement) return false;"));
        assert!(script.contains(").observe(document, { childList: true, subtree: true });"));

        let start = script.find("function startCarrier() {").unwrap();
        let messenger = script.find("GENERATED FILE — DO NOT EDIT.").unwrap();
        let fallback = script
            .find("if (!startCarrier()) {\n    // Document itself")
            .unwrap();
        assert!(start < messenger);
        assert!(messenger < fallback);
    }

    #[cfg(feature = "mcp")]
    #[test]
    fn mcp_init_script_can_inspect_the_local_connectivity_screen() {
        let script = init_script(&Settings::default(), 42);
        let local_branch = script
            .find("if (carrierHost === 'tauri.localhost')")
            .unwrap();
        let first_bridge = script.find("tauri-mcp guest bridge").unwrap();
        let injectable_return = script
            .find("    return;\n  }\n\n  // Prefer settings")
            .unwrap();

        assert!(local_branch < first_bridge);
        assert!(first_bridge < injectable_return);
        assert_eq!(
            script
                .matches("if (window.__CARRIER_MCP_BRIDGE__) return;")
                .count(),
            2
        );
    }
}
