//! Tray icon creation and showing or reopening the main window. Linux uses
//! StatusNotifierItem directly because Tauri's AppIndicator backend cannot
//! provide tooltips or click events there.

use tauri::{Manager, WebviewWindow};

#[cfg(not(target_os = "linux"))]
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
};

#[cfg(target_os = "linux")]
use crate::menu::open_recent_thread;
#[cfg(not(target_os = "linux"))]
use crate::menu::recent_menu_id;
use crate::menu::recent_threads_for_menu;
#[cfg(target_os = "macos")]
use crate::menu::target_window;
use crate::settings::{AppState, Settings};
#[cfg(target_os = "linux")]
use crate::tray_badge::{draw_unread_badge, UnreadBucket};
use crate::window::{build_app_window, install_main_close_handler};
use crate::APP_TITLE;

#[cfg(not(target_os = "linux"))]
pub(crate) type PlatformTrayIcon = TrayIcon;

#[cfg(target_os = "linux")]
pub(crate) struct PlatformTrayIcon {
    handle: ksni::blocking::Handle<LinuxTray>,
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum TrayIconStyle {
    #[default]
    Color,
    Symbolic,
}

#[cfg(target_os = "linux")]
impl TrayIconStyle {
    fn from_setting(value: &str) -> Self {
        if value == "symbolic" {
            Self::Symbolic
        } else {
            Self::Color
        }
    }
}

#[cfg(target_os = "linux")]
impl PlatformTrayIcon {
    pub(crate) fn set_tooltip<S: AsRef<str>>(&self, tooltip: Option<S>) -> tauri::Result<()> {
        let tooltip = tooltip
            .as_ref()
            .map(AsRef::as_ref)
            .unwrap_or_default()
            .to_string();
        self.handle
            .update(move |tray| tray.tooltip = tooltip)
            .ok_or_else(tray_service_closed)
    }

    pub(crate) fn set_menu(&self, _menu: Option<()>) -> tauri::Result<()> {
        // Recent conversations live in AppState and LinuxTray::menu reads them
        // fresh. An empty update asks KSNI to diff that newly built menu and
        // notify the desktop shell.
        self.handle.update(|_| ()).ok_or_else(tray_service_closed)
    }

    pub(crate) fn set_unread(&self, count: i64) -> tauri::Result<()> {
        let bucket = UnreadBucket::from_count(count);
        self.handle
            .update(move |tray| {
                if tray.unread == bucket {
                    return;
                }
                tray.unread = bucket;
                tray.rebuild_badge();
            })
            .ok_or_else(tray_service_closed)
    }

    pub(crate) fn set_icon_style(&self, style: &str, dark_panel: bool) -> tauri::Result<()> {
        let style = TrayIconStyle::from_setting(style);
        self.handle
            .update(move |tray| {
                if tray.style == style && tray.symbolic_dark == dark_panel {
                    return;
                }
                tray.style = style;
                tray.symbolic_dark = dark_panel;
                tray.rebuild_base();
            })
            .ok_or_else(tray_service_closed)
    }

    pub(crate) fn set_symbolic_dark(&self, dark_panel: bool) -> tauri::Result<()> {
        self.handle
            .update(move |tray| {
                if tray.symbolic_dark == dark_panel {
                    return;
                }
                tray.symbolic_dark = dark_panel;
                if tray.style == TrayIconStyle::Symbolic {
                    tray.rebuild_base();
                }
            })
            .ok_or_else(tray_service_closed)
    }
}

#[cfg(target_os = "linux")]
impl Drop for PlatformTrayIcon {
    fn drop(&mut self) {
        self.handle.shutdown().wait();
    }
}

#[cfg(target_os = "linux")]
fn tray_service_closed() -> tauri::Error {
    tauri::Error::Io(std::io::Error::new(
        std::io::ErrorKind::BrokenPipe,
        "Linux tray service is no longer running",
    ))
}

#[cfg(target_os = "linux")]
struct LinuxTray {
    app: tauri::AppHandle,
    icon: ksni::Icon,
    base_rgba: Vec<u8>,
    color_icon: ksni::Icon,
    color_rgba: Vec<u8>,
    symbolic_alpha: Vec<u8>,
    style: TrayIconStyle,
    symbolic_dark: bool,
    badged_icon: Option<ksni::Icon>,
    unread: UnreadBucket,
    tooltip: String,
}

#[cfg(target_os = "linux")]
impl LinuxTray {
    fn rebuild_base(&mut self) {
        match self.style {
            TrayIconStyle::Color => {
                self.icon = self.color_icon.clone();
                self.base_rgba.clone_from(&self.color_rgba);
            }
            TrayIconStyle::Symbolic => {
                self.base_rgba = tint_symbolic_rgba(&self.symbolic_alpha, self.symbolic_dark);
                self.icon = linux_tray_icon_from_rgba(128, 128, self.base_rgba.clone());
            }
        }
        self.rebuild_badge();
    }

    fn rebuild_badge(&mut self) {
        self.badged_icon = (self.unread != UnreadBucket::None).then(|| {
            linux_tray_icon_from_rgba(
                self.icon.width as u32,
                self.icon.height as u32,
                draw_unread_badge(
                    &self.base_rgba,
                    self.icon.width as u32,
                    self.icon.height as u32,
                    self.unread,
                ),
            )
        });
    }
}

#[cfg(target_os = "linux")]
impl ksni::Tray for LinuxTray {
    fn id(&self) -> String {
        "carrier".into()
    }

    fn category(&self) -> ksni::Category {
        ksni::Category::Communications
    }

    fn title(&self) -> String {
        APP_TITLE.into()
    }

    fn status(&self) -> ksni::Status {
        if self.unread == UnreadBucket::None {
            ksni::Status::Active
        } else {
            ksni::Status::NeedsAttention
        }
    }

    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        vec![self.badged_icon.as_ref().unwrap_or(&self.icon).clone()]
    }

    fn attention_icon_pixmap(&self) -> Vec<ksni::Icon> {
        self.icon_pixmap()
    }

    fn tool_tip(&self) -> ksni::ToolTip {
        ksni::ToolTip {
            icon_pixmap: self.icon_pixmap(),
            title: self.tooltip.clone(),
            ..Default::default()
        }
    }

    fn activate(&mut self, _x: i32, _y: i32) {
        toggle_main(&self.app);
    }

    fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
        use ksni::menu::StandardItem;

        let threads = recent_threads_for_menu(&self.app);
        let mut menu = Vec::with_capacity(threads.len() + 2);
        for thread in threads {
            let href = thread.href;
            menu.push(
                StandardItem {
                    label: thread.name,
                    activate: Box::new(move |tray: &mut Self| {
                        open_recent_thread(&tray.app, &href);
                    }),
                    ..Default::default()
                }
                .into(),
            );
        }
        if !menu.is_empty() {
            menu.push(ksni::MenuItem::Separator);
        }
        menu.push(
            StandardItem {
                label: "Quit Carrier".into(),
                activate: Box::new(|tray: &mut Self| tray.app.exit(0)),
                ..Default::default()
            }
            .into(),
        );
        menu
    }
}

#[cfg(any(target_os = "linux", test))]
fn rgba_to_argb(mut pixels: Vec<u8>) -> Vec<u8> {
    assert_eq!(
        pixels.len() % 4,
        0,
        "bundled tray icon must contain complete RGBA pixels"
    );
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.rotate_right(1);
    }
    pixels
}

#[cfg(target_os = "linux")]
fn linux_tray_icon(image: &tauri::image::Image<'_>) -> ksni::Icon {
    linux_tray_icon_from_rgba(image.width(), image.height(), image.rgba().to_vec())
}

#[cfg(target_os = "linux")]
fn linux_tray_icon_from_rgba(width: u32, height: u32, rgba: Vec<u8>) -> ksni::Icon {
    ksni::Icon {
        width: i32::try_from(width).expect("bundled icon width fits i32"),
        height: i32::try_from(height).expect("bundled icon height fits i32"),
        data: rgba_to_argb(rgba),
    }
}

#[cfg(any(target_os = "linux", test))]
fn tint_symbolic_rgba(source: &[u8], dark_panel: bool) -> Vec<u8> {
    assert_eq!(source.len() % 4, 0);
    let tint = if dark_panel {
        [245, 245, 245]
    } else {
        [55, 58, 64]
    };
    let mut pixels = source.to_vec();
    for pixel in pixels.chunks_exact_mut(4) {
        pixel[..3].copy_from_slice(&tint);
    }
    pixels
}

#[cfg(target_os = "linux")]
fn linux_tray_base_image(app: &tauri::AppHandle) -> tauri::Result<(ksni::Icon, Vec<u8>)> {
    let default = app.default_window_icon().expect("bundled icon");
    if default.width() >= 128 && default.height() >= 128 {
        return Ok((linux_tray_icon(default), default.rgba().to_vec()));
    }

    // Tauri commonly selects the first (32 px) configured window icon. KSNI
    // panels can request a much larger pixmap, so keep a high-resolution source
    // for both the normal icon and its unread badge.
    let image = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png"))?;
    let rgba = image.rgba().to_vec();
    Ok((linux_tray_icon(&image), rgba))
}

fn clear_reveal_guard_if_current(
    active_generation: &std::sync::atomic::AtomicUsize,
    generation: usize,
) -> bool {
    active_generation
        .compare_exchange(
            generation,
            0,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_ok()
}

fn reveal_window(window: &WebviewWindow, activation_token: Option<&str>) {
    #[cfg(target_os = "linux")]
    if let Some(token) = activation_token {
        crate::linux::apply_activation_token(window, token);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = activation_token;

    let is_main = window.label() == "main";
    let reveal_generation = is_main.then(|| {
        let state = window.app_handle().state::<AppState>();
        let generation = state
            .next_reveal_generation
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel)
            .wrapping_add(1)
            .max(1);
        state
            .revealing_main
            .store(generation, std::sync::atomic::Ordering::Release);
        generation
    });
    // Windows ignores a restore request for some hidden minimized HWNDs, so
    // show once, restore, then show again. The guard above prevents the
    // intermediate minimized resize from feeding back into hide-on-minimize.
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    if let Some(generation) = reveal_generation {
        let app = window.app_handle().clone();
        tauri::async_runtime::spawn(async move {
            // Native resize/focus events arrive after the calls above. Keep the
            // reveal guard through that short burst so auto-hide cannot undo a
            // tray click or second-instance activation.
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            // Only the newest reveal may lower the guard. An older timer that
            // wakes during an overlapping reveal must leave its newer token in
            // place until that reveal's own event burst has finished.
            clear_reveal_guard_if_current(&app.state::<AppState>().revealing_main, generation);
        });
    }
}

fn show_main_with_activation_token(app: &tauri::AppHandle, activation_token: Option<&str>) {
    if let Some(window) = app.get_webview_window("main") {
        reveal_window(&window, activation_token);
        return;
    }

    if app
        .state::<AppState>()
        .recreating
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return;
    }

    let settings = app.state::<AppState>().settings.lock().unwrap().clone();
    if let Ok(window) = build_app_window(app, "main", &settings) {
        install_main_close_handler(app, &window);
        reveal_window(&window, activation_token);
    }
}

pub(crate) fn show_main(app: &tauri::AppHandle) {
    show_main_with_activation_token(app, None);
}

#[cfg(target_os = "macos")]
fn should_hide_main(visible: bool, minimized: bool, focused: bool) -> bool {
    visible && !minimized && focused
}

#[cfg(not(target_os = "macos"))]
fn should_hide_main(visible: bool, minimized: bool, _focused: bool) -> bool {
    // Clicking a Windows/Linux notification-area icon moves focus away before
    // Tauri delivers the event, so focus cannot distinguish an already-shown
    // window there. Visibility + minimized state provides a stable toggle.
    visible && !minimized
}

/// Show the main window if it's hidden/minimized, or hide it if the current
/// platform considers it already shown — so a tray click toggles the app.
fn toggle_main_with_token(app: &tauri::AppHandle, activation_token: Option<&str>) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        let minimized = window.is_minimized().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        if should_hide_main(visible, minimized, focused) {
            let _ = window.hide();
        } else {
            reveal_window(&window, activation_token);
        }
    } else {
        show_main_with_activation_token(app, activation_token);
    }
}

pub(crate) fn toggle_main(app: &tauri::AppHandle) {
    toggle_main_with_token(app, None);
}

/// Toggle Carrier from an XDG portal activation. This must run on GTK's main
/// thread; the portal worker dispatches it there before calling this function.
#[cfg(target_os = "linux")]
pub(crate) fn toggle_main_with_activation_token(app: &tauri::AppHandle, token: Option<&str>) {
    toggle_main_with_token(app, token);
}

#[cfg(target_os = "macos")]
fn has_visible_messenger_window(app: &tauri::AppHandle) -> bool {
    app.webview_windows().into_iter().any(|(label, window)| {
        label != "settings"
            && window.is_visible().unwrap_or(false)
            && !window.is_minimized().unwrap_or(false)
    })
}

#[cfg(target_os = "macos")]
fn should_reopen_main(has_visible_windows: bool, has_visible_messenger_window: bool) -> bool {
    !has_visible_windows || !has_visible_messenger_window
}

#[cfg(target_os = "macos")]
pub(crate) fn reopen_main_if_needed(app: &tauri::AppHandle, has_visible_windows: bool) {
    if should_reopen_main(has_visible_windows, has_visible_messenger_window(app)) {
        show_main(app);
    }
}

/// Whether a tray icon should exist: when the user asked for one, when
/// menu-bar-only mode is on (the only way back to a Dock-less app), or when a
/// Windows behavior can automatically remove the main window from normal UI.
pub(crate) fn wants_tray(s: &Settings) -> bool {
    s.show_tray
        || s.menu_bar_only
        || (cfg!(target_os = "windows")
            && (s.hide_on_minimize || s.hide_on_focus_loss || s.hide_taskbar_icon))
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn build_tray_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    // Most recent conversations first (mirrors the macOS Dock menu); clicking
    // one opens that thread. Empty until the page has pushed a list.
    let threads = recent_threads_for_menu(app);
    for t in &threads {
        menu.append(&MenuItem::with_id(
            app,
            recent_menu_id(t),
            &t.name,
            true,
            None::<&str>,
        )?)?;
    }
    if !threads.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        "Quit Carrier",
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

#[cfg(target_os = "linux")]
pub(crate) fn build_tray_menu(_app: &tauri::AppHandle) -> tauri::Result<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn show_tray_menu(app: &tauri::AppHandle) {
    let Some(window) = target_window(app).or_else(|| app.get_webview_window("main")) else {
        return;
    };
    if let Ok(menu) = build_tray_menu(app) {
        let _ = window.popup_menu(&menu);
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn tray_unread_title(s: &Settings, unread: i64) -> Option<String> {
    if s.unread_badge && unread > 0 {
        Some(unread.to_string())
    } else {
        // tray-icon's macOS backend ignores None, so clear with an empty title.
        Some(String::new())
    }
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn build_tray_with_menu(
    app: &tauri::AppHandle,
    menu: Menu<tauri::Wry>,
) -> tauri::Result<PlatformTrayIcon> {
    let builder = TrayIconBuilder::with_id("carrier-tray")
        .tooltip(APP_TITLE)
        .icon(app.default_window_icon().expect("bundled icon").clone())
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "quit" {
                app.exit(0);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button,
                button_state,
                ..
            } = event
            {
                match (button, button_state) {
                    (MouseButton::Left, MouseButtonState::Up) => toggle_main(tray.app_handle()),
                    #[cfg(target_os = "macos")]
                    (MouseButton::Right, MouseButtonState::Down) => {
                        show_tray_menu(tray.app_handle());
                    }
                    _ => {}
                }
            }
        });

    #[cfg(not(target_os = "macos"))]
    let builder = builder.menu(&menu);
    #[cfg(target_os = "macos")]
    let _ = &menu;

    builder.build(app)
}

#[cfg(target_os = "linux")]
pub(crate) fn build_tray_with_menu(
    app: &tauri::AppHandle,
    _menu: (),
) -> tauri::Result<PlatformTrayIcon> {
    use ksni::blocking::TrayMethods;

    let (icon, base_rgba) = linux_tray_base_image(app)?;
    let symbolic =
        tauri::image::Image::from_bytes(include_bytes!("../icons/tray/carrier-symbolic.png"))?;
    debug_assert_eq!((symbolic.width(), symbolic.height()), (128, 128));
    let symbolic_alpha = symbolic.rgba().to_vec();
    let tray = LinuxTray {
        app: app.clone(),
        icon: icon.clone(),
        base_rgba: base_rgba.clone(),
        color_icon: icon,
        color_rgba: base_rgba,
        symbolic_alpha,
        style: TrayIconStyle::Color,
        symbolic_dark: false,
        badged_icon: None,
        unread: UnreadBucket::None,
        tooltip: APP_TITLE.into(),
    };
    // Autostart can run before the desktop's StatusNotifierWatcher exists.
    // Keep the service alive so KSNI registers the icon when the watcher appears.
    // Flatpak cannot safely whitelist KSNI's PID-derived well-known name, so
    // register the sandbox's unique connection name with the watcher instead.
    let handle = tray
        .disable_dbus_name(crate::install_environment::is_flatpak())
        .assume_sni_available(true)
        .spawn()
        .map_err(|error| tauri::Error::Io(std::io::Error::other(error)))?;
    Ok(PlatformTrayIcon { handle })
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // want_tray logic  (new in this PR: show_tray || menu_bar_only)
    // -----------------------------------------------------------------------

    #[test]
    fn wants_tray_true_when_show_tray_set() {
        // show_tray defaults to true.
        assert!(wants_tray(&Settings::default()));
    }

    #[test]
    fn linux_tray_icon_pixels_are_argb() {
        assert_eq!(
            rgba_to_argb(vec![0x11, 0x22, 0x33, 0x44, 0xaa, 0xbb, 0xcc, 0xdd]),
            vec![0x44, 0x11, 0x22, 0x33, 0xdd, 0xaa, 0xbb, 0xcc]
        );
    }

    #[test]
    fn symbolic_tint_preserves_alpha_and_follows_panel_contrast() {
        let source = vec![255, 255, 255, 0, 255, 255, 255, 128];
        assert_eq!(
            tint_symbolic_rgba(&source, true),
            vec![245, 245, 245, 0, 245, 245, 245, 128]
        );
        assert_eq!(
            tint_symbolic_rgba(&source, false),
            vec![55, 58, 64, 0, 55, 58, 64, 128]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn symbolic_asset_is_a_high_resolution_rgba_pixmap() {
        let image =
            tauri::image::Image::from_bytes(include_bytes!("../icons/tray/carrier-symbolic.png"))
                .unwrap();
        assert_eq!((image.width(), image.height()), (128, 128));
        assert!(image.rgba().chunks_exact(4).any(|pixel| pixel[3] == 0));
        assert!(image.rgba().chunks_exact(4).any(|pixel| pixel[3] == 255));
    }

    #[test]
    fn wants_tray_menu_bar_only_forces_it_even_without_show_tray() {
        let s = Settings {
            show_tray: false,
            menu_bar_only: true,
            ..Default::default()
        };
        assert!(wants_tray(&s), "menu_bar_only must force the tray on");
    }

    #[test]
    fn wants_tray_false_when_both_off() {
        let s = Settings {
            show_tray: false,
            menu_bar_only: false,
            ..Default::default()
        };
        assert!(!wants_tray(&s), "no tray when both are off");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_auto_hide_behaviors_force_a_tray_escape_hatch() {
        for s in [
            Settings {
                show_tray: false,
                hide_on_minimize: true,
                ..Default::default()
            },
            Settings {
                show_tray: false,
                hide_on_focus_loss: true,
                ..Default::default()
            },
            Settings {
                show_tray: false,
                hide_taskbar_icon: true,
                ..Default::default()
            },
        ] {
            assert!(wants_tray(&s));
        }
    }

    #[test]
    fn hidden_or_minimized_main_window_is_revealed() {
        assert!(!should_hide_main(false, false, false));
        assert!(!should_hide_main(true, true, true));
    }

    #[test]
    fn only_the_latest_reveal_can_clear_the_auto_hide_guard() {
        let active = std::sync::atomic::AtomicUsize::new(2);
        assert!(!clear_reveal_guard_if_current(&active, 1));
        assert_eq!(
            active.load(std::sync::atomic::Ordering::Acquire),
            2,
            "an older timer must preserve the newer reveal"
        );
        assert!(clear_reveal_guard_if_current(&active, 2));
        assert_eq!(active.load(std::sync::atomic::Ordering::Acquire), 0);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn visible_unfocused_main_window_is_hidden_off_macos() {
        assert!(should_hide_main(true, false, false));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn visible_unfocused_main_window_is_revealed_on_macos() {
        assert!(!should_hide_main(true, false, false));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dock_reopen_shows_main_when_no_windows_are_visible() {
        assert!(should_reopen_main(false, false));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dock_reopen_shows_main_when_only_settings_is_visible() {
        assert!(should_reopen_main(true, false));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dock_reopen_does_not_reload_when_messenger_window_is_visible() {
        assert!(!should_reopen_main(true, true));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn tray_unread_title_shows_positive_counts_when_badges_enabled() {
        assert_eq!(
            tray_unread_title(&Settings::default(), 7),
            Some("7".to_string())
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn tray_unread_title_clears_zero_and_disabled_badges() {
        assert_eq!(
            tray_unread_title(&Settings::default(), 0),
            Some(String::new())
        );
        let s = Settings {
            unread_badge: false,
            ..Default::default()
        };
        assert_eq!(tray_unread_title(&s, 7), Some(String::new()));
    }
}
