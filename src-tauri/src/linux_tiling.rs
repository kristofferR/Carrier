//! Linux: whether the compositor handles a window's controls, so Carrier draws
//! its own (crate::title_bar) only where nothing else does.
//!
//! Floating desktops leave every window to Carrier. Under a tiling window
//! manager the compositor handles a window until it says the window floats:
//! - Hyprland tells every window it is tiled, floating or not, so its event
//!   socket says which ones float. A floating window can still get the
//!   compositor's own title bar from hyprbars (Omarchy's floating workspaces
//!   use a fork of it), which has window buttons of its own.
//! - Other Wayland compositors (sway, river, niri, ...) send xdg-shell's tiled
//!   states, which GTK reports. They count once any window has reported one:
//!   a compositor that never sends them keeps every window handled.
//! - X11 has no such state, so X11 tilers keep every window handled.

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

/// What the compositor last said about a window.
#[derive(Clone, PartialEq, Debug)]
struct Chrome {
    /// It handles the window's controls.
    handled: bool,
    /// Hyprland only: it has the window maximized.
    maximized: bool,
    /// Hyprland only: its address for the window.
    address: Option<String>,
}

/// Each window's [`Chrome`], by label.
fn windows() -> &'static Mutex<HashMap<String, Chrome>> {
    static WINDOWS: OnceLock<Mutex<HashMap<String, Chrome>>> = OnceLock::new();
    WINDOWS.get_or_init(Default::default)
}

/// Set once any window reports an xdg-shell tiled state.
static REPORTS_TILING: AtomicBool = AtomicBool::new(false);

/// Whether the compositor handles the window's controls (it tiles the window,
/// or draws a title bar on it): Carrier's controls and strip go.
pub(crate) fn compositor_handles(label: &str) -> bool {
    if !crate::linux::is_tiling_wm() {
        return false;
    }
    if hyprland().is_none() && !REPORTS_TILING.load(Ordering::Relaxed) {
        return true;
    }
    windows()
        .lock()
        .unwrap()
        .get(label)
        .is_none_or(|chrome| chrome.handled)
}

/// Which of minimize and maximize Carrier's controls offer under a tiling
/// window manager. None of them minimize; Hyprland maximizes on request
/// ([`toggle_maximized`]), the others ignore it.
pub(crate) fn buttons() -> (bool, bool) {
    (false, hyprland().is_some())
}

/// Hyprland: whether it has the window maximized. GTK can't tell, as Hyprland
/// reports every window maximized.
pub(crate) fn hyprland_maximized(label: &str) -> Option<bool> {
    hyprland()?;
    windows()
        .lock()
        .unwrap()
        .get(label)
        .map(|chrome| chrome.maximized)
}

/// Hyprland: maximize or restore the window, as Omarchy suppresses the
/// clients' own requests. False elsewhere.
pub(crate) fn toggle_maximized(label: &str) -> bool {
    let Some(dir) = hyprland() else {
        return false;
    };
    let address = windows()
        .lock()
        .unwrap()
        .get(label)
        .and_then(|chrome| chrome.address.clone());
    let Some(address) = address else {
        log::warn!("Hyprland window for {label} unknown; can't maximize it");
        return true;
    };
    // The Lua config (Hyprland 0.55 and later), then the older one, whose
    // `fullscreen` acts on the focused window.
    let toggled = [
        format!(
            r#"dispatch hl.dsp.window.fullscreen({{ mode = "maximized", action = "toggle", window = "address:{address}" }})"#
        ),
        format!("[[BATCH]]dispatch focuswindow address:{address}; dispatch fullscreen 1"),
    ]
    .iter()
    .any(|command| request(dir, command).is_ok_and(|reply| reply.starts_with(b"ok")));
    if !toggled {
        log::warn!("Hyprland refused to maximize the window");
    }
    true
}

fn record(window: &WebviewWindow, chrome: Chrome) {
    windows()
        .lock()
        .unwrap()
        .insert(window.label().to_string(), chrome);
    crate::title_bar::sync(window);
}

pub(crate) fn forget(label: &str) {
    windows().lock().unwrap().remove(label);
    focused_addresses().lock().unwrap().remove(label);
}

/// Hyprland: each window's address by label, learnt as the window takes focus
/// ([`learn_address`]): Messenger windows share one title.
fn focused_addresses() -> &'static Mutex<HashMap<String, String>> {
    static ADDRESSES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    ADDRESSES.get_or_init(Default::default)
}

/// Follow a window's state: on Hyprland, learn its address as it takes focus;
/// elsewhere, its xdg-shell tiled state.
pub(crate) fn watch(window: &WebviewWindow) {
    if !crate::linux::is_tiling_wm() {
        return;
    }
    let Ok(gtk_window) = window.gtk_window() else {
        return;
    };
    let watched = window.clone();
    if let Some(dir) = hyprland() {
        gtk_window.connect_focus_in_event(move |_, _| {
            let window = watched.clone();
            std::thread::spawn(move || learn_address(&window, dir));
            Propagation::Proceed
        });
        return;
    }
    gtk_window.connect_window_state_event(move |_, event| {
        let tiled = event.new_window_state().contains(WindowState::TILED);
        let first_report = tiled && !REPORTS_TILING.swap(true, Ordering::Relaxed);
        record(
            &watched,
            Chrome {
                handled: tiled,
                maximized: false,
                address: None,
            },
        );
        if first_report {
            // Every other window counted as handled until now; recheck them.
            crate::title_bar::sync_all(watched.app_handle());
        }
        Propagation::Proceed
    });
}

/// The window that just took focus is Hyprland's active one: remember its
/// address, and reread its state by it.
fn learn_address(window: &WebviewWindow, dir: &Path) {
    let Some(active) = request(dir, "j/activewindow")
        .ok()
        .and_then(|reply| serde_json::from_slice::<HyprClient>(&reply).ok())
    else {
        return;
    };
    let ours = active.pid == i64::from(std::process::id());
    if !ours || window.title().ok().as_deref() != Some(active.title.as_str()) {
        return;
    }
    {
        // A window can take keyboard focus without becoming the active one
        // (Hyprland's send_shortcut), so never take another window's address.
        let mut addresses = focused_addresses().lock().unwrap();
        let label = window.label();
        if addresses
            .iter()
            .any(|(other, address)| other != label && *address == active.address)
        {
            return;
        }
        addresses.insert(label.to_string(), active.address);
    }
    refresh(window.app_handle(), dir);
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
                            if let Some(address) = line.strip_prefix("closewindow>>") {
                                // Closed (or hidden): Hyprland may reuse the address.
                                let address = format!("0x{address}");
                                focused_addresses()
                                    .lock()
                                    .unwrap()
                                    .retain(|_, learnt| *learnt != address);
                            }
                            if changes_window_chrome(&line) {
                                if line.starts_with("movewindowv2>>") {
                                    // Omarchy rearranges a moved window once
                                    // the move has landed, on a timer.
                                    std::thread::sleep(MOVE_SETTLE);
                                }
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

/// How long a moved window's workspace takes to rearrange it.
const MOVE_SETTLE: Duration = Duration::from_millis(100);

/// Events after which a window may float, tile, maximize or get a title bar
/// differently: a window opens (showing a hidden one opens it again), floats
/// or tiles, maximizes or restores, moves to another workspace (Omarchy's
/// floating workspaces give their windows title bars), or the config reloads
/// (title bars on or off).
fn changes_window_chrome(line: &str) -> bool {
    [
        "openwindow>>",
        "changefloatingmode>>",
        "fullscreen>>",
        "movewindowv2>>",
        "configreloaded>>",
    ]
    .iter()
    .any(|event| line.starts_with(event))
}

#[derive(Deserialize)]
struct HyprClient {
    address: String,
    pid: i64,
    title: String,
    floating: bool,
    /// 1 when maximized, 2 in full screen (a bool before Hyprland 0.42).
    #[serde(default)]
    fullscreen: serde_json::Value,
    #[serde(default)]
    tags: Vec<String>,
}

/// Ask Hyprland which of Carrier's windows float without a title bar of its
/// own. Its windows are matched by process and title; same-titled windows that
/// disagree keep their last state.
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
    let ours: Vec<&HyprClient> = clients.iter().filter(|client| client.pid == pid).collect();
    let addresses = focused_addresses().lock().unwrap().clone();
    let bars = TitleBars::query(dir);
    for (label, window) in app.webview_windows() {
        if !crate::title_bar::has_title_bar(&label) {
            continue;
        }
        let Ok(title) = window.title() else { continue };
        let chrome: Vec<Chrome> = candidates(&ours, &title, &label, &addresses)
            .into_iter()
            .map(|client| Chrome {
                handled: !client.floating || bars.drawn_on(dir, client),
                maximized: client.fullscreen.as_i64() == Some(1),
                address: Some(client.address.clone()),
            })
            .collect();
        if let Some(chrome) = agreed(chrome) {
            record(&window, chrome);
        }
    }
}

/// Hyprland's windows that may be the one labelled `label`: the one at its
/// learnt address, or else those with its title, leaving out the windows
/// learnt to be others.
fn candidates<'a>(
    ours: &[&'a HyprClient],
    title: &str,
    label: &str,
    addresses: &HashMap<String, String>,
) -> Vec<&'a HyprClient> {
    let learnt = addresses.get(label);
    if let Some(client) = ours.iter().find(|client| Some(&client.address) == learnt) {
        return vec![*client];
    }
    ours.iter()
        .filter(|client| client.title == title && !addresses.values().any(|a| *a == client.address))
        .copied()
        .collect()
}

/// One window's state, or that of several same-titled ones when they agree
/// (without an address, which would be ambiguous).
fn agreed(mut chromes: Vec<Chrome>) -> Option<Chrome> {
    let first = chromes.pop()?;
    if chromes.is_empty() {
        return Some(first);
    }
    chromes
        .iter()
        .all(|other| other.handled == first.handled && other.maximized == first.maximized)
        .then_some(Chrome {
            address: None,
            ..first
        })
}

/// hyprbars' settings: whether it draws, and the window tag it is limited to
/// (Omarchy's fork draws only on windows tagged as on a floating workspace).
struct TitleBars {
    enabled: bool,
    tag: Option<String>,
}

impl TitleBars {
    fn query(dir: &Path) -> Self {
        let option = |name: &str| {
            request(dir, &format!("j/getoption plugin:hyprbars:{name}"))
                .ok()
                .and_then(|reply| serde_json::from_slice::<serde_json::Value>(&reply).ok())
        };
        // Older hyprbars has no `enabled` option and always draws.
        let enabled = option("enabled").is_none_or(|value| {
            value["bool"].as_bool().unwrap_or(true) && value["int"].as_i64() != Some(0)
        });
        let tag = option("workspace_tag")
            .and_then(|value| value["str"].as_str().map(str::to_owned))
            .filter(|tag| !tag.is_empty());
        Self { enabled, tag }
    }

    fn drawn_on(&self, dir: &Path, client: &HyprClient) -> bool {
        self.enabled
            && self.tag.as_deref().is_none_or(|tag| has_tag(client, tag))
            && request(dir, &format!("j/decorations address:{}", client.address))
                .is_ok_and(|reply| has_title_bar_decoration(&reply))
    }
}

/// Hyprland lists dynamic tags (set by rules) with a trailing `*`.
fn has_tag(client: &HyprClient, tag: &str) -> bool {
    client
        .tags
        .iter()
        .any(|have| have.trim_end_matches('*') == tag)
}

fn has_title_bar_decoration(reply: &[u8]) -> bool {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Decoration {
        decoration_name: String,
    }
    serde_json::from_slice::<Vec<Decoration>>(reply)
        .is_ok_and(|list| list.iter().any(|d| d.decoration_name == "Hyprbar"))
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

    #[test]
    fn same_titled_windows_must_agree() {
        let chrome = |handled, address: &str| Chrome {
            handled,
            maximized: false,
            address: Some(address.into()),
        };
        assert_eq!(agreed(vec![chrome(true, "0x1")]), Some(chrome(true, "0x1")));
        let both = agreed(vec![chrome(true, "0x1"), chrome(true, "0x2")]).unwrap();
        assert!(both.handled && both.address.is_none());
        assert_eq!(
            agreed(vec![chrome(true, "0x1"), chrome(false, "0x2")]),
            None
        );
        assert_eq!(agreed(Vec::new()), None);
    }

    #[test]
    fn windows_are_found_by_learnt_address_before_title() {
        let client = |address: &str| HyprClient {
            address: address.into(),
            pid: 1,
            title: "Chatpane".into(),
            floating: false,
            fullscreen: serde_json::Value::Null,
            tags: Vec::new(),
        };
        let (one, two) = (client("0x1"), client("0x2"));
        let ours = [&one, &two];
        let found = |label, addresses: &HashMap<String, String>| {
            candidates(&ours, "Chatpane", label, addresses)
                .iter()
                .map(|client| client.address.as_str())
                .collect::<Vec<_>>()
        };
        let none = HashMap::new();
        assert_eq!(found("main", &none), ["0x1", "0x2"]);
        let learnt = HashMap::from([("win-2".to_string(), "0x2".to_string())]);
        assert_eq!(found("win-2", &learnt), ["0x2"]);
        assert_eq!(found("main", &learnt), ["0x1"]);
    }

    #[test]
    fn title_bars_follow_the_tag_they_are_limited_to() {
        let client = HyprClient {
            address: "0x1".into(),
            pid: 1,
            title: "Chatpane".into(),
            floating: true,
            fullscreen: serde_json::Value::Null,
            tags: vec!["omarchy-floating-workspace".into(), "opened*".into()],
        };
        assert!(has_tag(&client, "omarchy-floating-workspace"));
        assert!(has_tag(&client, "opened"));
        assert!(!has_tag(&client, "other"));
    }

    #[test]
    fn hyprbars_is_recognised_among_the_decorations() {
        let with = br#"[{"decorationName":"Border","priority":10000},{"decorationName":"Hyprbar","priority":10005}]"#;
        let without = br#"[{"decorationName":"Border","priority":10000}]"#;
        assert!(has_title_bar_decoration(with));
        assert!(!has_title_bar_decoration(without));
        assert!(!has_title_bar_decoration(b"no such window"));
    }
}
