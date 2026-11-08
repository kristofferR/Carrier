//! Linux: whether the compositor tiles each window, so Carrier's own window
//! controls (crate::title_bar) show on floating windows only.
//!
//! Floating desktops tile nothing. Under a tiling window manager a window
//! counts as tiled until the compositor says it floats:
//! - Hyprland tells every window it is tiled, floating or not, so its event
//!   socket says which ones float.
//! - Other Wayland compositors (sway, river, niri, ...) send xdg-shell's tiled
//!   states, which GTK reports. They count once any window has reported one:
//!   a compositor that never sends them leaves every window tiled.
//! - X11 has no such state, so X11 tilers keep every window tiled.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use gtk::gdk::WindowState;
use gtk::glib::Propagation;
use gtk::prelude::WidgetExt;
use serde::Deserialize;
use tauri::{AppHandle, Manager, WebviewWindow};

/// What the compositor last said about each window, by label: true when tiled.
fn tiled_windows() -> &'static Mutex<HashMap<String, bool>> {
    static TILED: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    TILED.get_or_init(Default::default)
}

/// Set once any window reports an xdg-shell tiled state.
static REPORTS_TILING: AtomicBool = AtomicBool::new(false);

/// Whether the compositor tiles the window: its controls and strip go.
pub(crate) fn is_tiled(label: &str) -> bool {
    if !crate::linux::is_tiling_wm() {
        return false;
    }
    if hyprland().is_none() && !REPORTS_TILING.load(Ordering::Relaxed) {
        return true;
    }
    tiled_windows()
        .lock()
        .unwrap()
        .get(label)
        .copied()
        .unwrap_or(true)
}

fn record(window: &WebviewWindow, tiled: bool) {
    tiled_windows()
        .lock()
        .unwrap()
        .insert(window.label().to_string(), tiled);
    crate::title_bar::sync(window);
}

pub(crate) fn forget(label: &str) {
    tiled_windows().lock().unwrap().remove(label);
}

/// Follow a window's xdg-shell tiled state (not on Hyprland, see above).
pub(crate) fn watch(window: &WebviewWindow) {
    if !crate::linux::is_tiling_wm() || hyprland().is_some() {
        return;
    }
    let Ok(gtk_window) = window.gtk_window() else {
        return;
    };
    let watched = window.clone();
    gtk_window.connect_window_state_event(move |_, event| {
        let tiled = event.new_window_state().contains(WindowState::TILED);
        let first_report = tiled && !REPORTS_TILING.swap(true, Ordering::Relaxed);
        record(&watched, tiled);
        if first_report {
            // Every other window counted as tiled until now; recheck them.
            crate::title_bar::sync_all(watched.app_handle());
        }
        Propagation::Proceed
    });
}

/// The running Hyprland's socket directory.
fn hyprland() -> Option<&'static Path> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        let signature = std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE")?;
        let runtime = std::env::var_os("XDG_RUNTIME_DIR")?;
        let dir = PathBuf::from(runtime).join("hypr").join(signature);
        dir.join(".socket2.sock").exists().then_some(dir)
    })
    .as_deref()
}

/// Hyprland: follow its window events for the life of the app.
pub(crate) fn start(app: &AppHandle) {
    let Some(dir) = hyprland().filter(|_| crate::linux::is_tiling_wm()) else {
        return;
    };
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("hyprland-events".into())
        .spawn(move || {
            loop {
                match UnixStream::connect(dir.join(".socket2.sock")) {
                    Ok(events) => {
                        refresh(&app, dir);
                        for line in BufReader::new(events).lines() {
                            let Ok(line) = line else { break };
                            if is_floating_event(&line) {
                                refresh(&app, dir);
                            }
                        }
                        log::info!("Hyprland event socket closed; reconnecting");
                    }
                    Err(error) => log::debug!("Hyprland event socket: {error}"),
                }
                std::thread::sleep(Duration::from_secs(5));
            }
        });
    if let Err(error) = spawned {
        log::warn!("failed to follow Hyprland window events: {error}");
    }
}

/// Events after which a window may float or tile differently: a window opens
/// (showing a hidden one opens it again), or its floating mode changes.
fn is_floating_event(line: &str) -> bool {
    line.starts_with("openwindow>>") || line.starts_with("changefloatingmode>>")
}

#[derive(Deserialize)]
struct HyprClient {
    pid: i64,
    title: String,
    floating: bool,
}

/// Ask Hyprland which of Carrier's windows float. Its windows are matched by
/// process and title; same-titled windows that disagree keep their last state.
fn refresh(app: &AppHandle, dir: &Path) {
    let clients = match request(dir, "j/clients")
        .and_then(|reply| serde_json::from_slice::<Vec<HyprClient>>(&reply).map_err(Into::into))
    {
        Ok(clients) => clients,
        Err(error) => {
            log::warn!("Hyprland window list: {error}");
            return;
        }
    };
    let pid = i64::from(std::process::id());
    for (label, window) in app.webview_windows() {
        if !crate::title_bar::has_title_bar(&label) {
            continue;
        }
        let Ok(title) = window.title() else { continue };
        if let Some(floating) = agreed_floating(&clients, pid, &title) {
            record(&window, !floating);
        }
    }
}

fn agreed_floating(clients: &[HyprClient], pid: i64, title: &str) -> Option<bool> {
    let mut floating = clients
        .iter()
        .filter(|client| client.pid == pid && client.title == title)
        .map(|client| client.floating);
    let first = floating.next()?;
    floating.all(|other| other == first).then_some(first)
}

fn request(dir: &Path, command: &str) -> std::io::Result<Vec<u8>> {
    let mut socket = UnixStream::connect(dir.join(".socket.sock"))?;
    socket.set_read_timeout(Some(Duration::from_secs(2)))?;
    socket.write_all(command.as_bytes())?;
    let mut reply = Vec::new();
    socket.read_to_end(&mut reply)?;
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(pid: i64, title: &str, floating: bool) -> HyprClient {
        HyprClient {
            pid,
            title: title.into(),
            floating,
        }
    }

    #[test]
    fn a_window_is_matched_by_process_and_title() {
        let clients = [
            client(1, "Carrier", true),
            client(2, "Carrier", false),
            client(1, "Carrier Settings", false),
        ];
        assert_eq!(agreed_floating(&clients, 1, "Carrier"), Some(true));
        assert_eq!(
            agreed_floating(&clients, 1, "Carrier Settings"),
            Some(false)
        );
        assert_eq!(agreed_floating(&clients, 1, "Export"), None);
    }

    #[test]
    fn same_titled_windows_must_agree() {
        let clients = [client(1, "Carrier", true), client(1, "Carrier", false)];
        assert_eq!(agreed_floating(&clients, 1, "Carrier"), None);
    }
}
