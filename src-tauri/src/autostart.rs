//! Start on System Startup (Ref #443). Chatpane registers itself with the OS and
//! reads the registration back, so the setting shows whether Chatpane will
//! really start at login, including after the user switched it off in the OS:
//!
//! - macOS 13+: an "Open at Login" item through `SMAppService.mainApp`. The
//!   LaunchAgent plist earlier versions wrote is migrated away. macOS 10.15 to
//!   12 keep the LaunchAgent.
//! - Windows: the per-user `Run` value, unless Task Manager or Settings → Apps →
//!   Startup marked it disabled under `StartupApproved\Run`. Turning it on in
//!   Chatpane clears that mark.
//! - Linux: an XDG autostart entry that isn't `Hidden=true` and launches this
//!   install.
//!
//! Every registration uses the product name ("Chatpane") as its file or value
//! name, as tauri-plugin-autostart did. Chatpane was called Carrier, so an entry
//! under that name moves to the new one on the first launch after the rename.

use tauri::Manager;

use crate::install_environment::is_snap;
use crate::settings::{AppState, save_settings};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Status {
    On,
    Off,
    /// macOS: registered, but the user must allow it in Login Items first.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    NeedsApproval,
}

/// The stored setting after reading the OS: the OS wins, and an unreadable
/// state keeps what was stored. Waiting for approval counts as off: macOS
/// won't open Chatpane at login until the user allows it, and switching it off
/// in Login Items reports the same state. Settings shows the way to approve.
fn reconciled(stored: bool, observed: Option<Status>) -> bool {
    observed.map_or(stored, |status| status == Status::On)
}

/// Read the OS registration (migrating an old macOS LaunchAgent first) and
/// store it as the Start on System Startup setting. Returns what it read.
/// Runs on the settings worker, so a save in flight can't be overwritten by a
/// reading taken before it.
pub(crate) async fn reconcile(app: tauri::AppHandle) -> Option<Status> {
    if is_snap() {
        return None;
    }
    let state = app.state::<AppState>();
    let _settings_worker = state.settings_worker.lock().await;
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || reconcile_blocking(&worker_app))
        .await
        .inspect_err(|e| log::warn!("Start on System Startup check failed: {e}"))
        .ok()
        .flatten()
}

fn reconcile_blocking(app: &tauri::AppHandle) -> Option<Status> {
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    platform::migrate_previous_entry(app);
    #[cfg(target_os = "macos")]
    platform::repoint_after_rename(app);
    #[cfg(target_os = "macos")]
    platform::migrate_legacy_agent(app);
    let observed = status(app)
        .inspect_err(|e| log::warn!("couldn't read Start on System Startup: {e}"))
        .ok();
    let changed = {
        let state = app.state::<AppState>();
        let mut settings = state.settings.lock().unwrap();
        let autostart = reconciled(settings.autostart, observed);
        (autostart != settings.autostart).then(|| {
            settings.autostart = autostart;
            settings.clone()
        })
    };
    if let Some(settings) = changed {
        log::info!(
            "Start on System Startup is {} in the OS; updating the setting",
            if settings.autostart { "on" } else { "off" }
        );
        if let Err(e) = save_settings(app, &settings) {
            log::warn!("couldn't save the Start on System Startup state: {e}");
        }
    }
    observed
}

pub(crate) fn status(app: &tauri::AppHandle) -> Result<Status, String> {
    platform::status(app)
}

pub(crate) fn set(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    platform::set(app, enabled)
}

/// macOS 13+: open System Settings → General → Login Items.
pub(crate) fn open_login_items() {
    #[cfg(target_os = "macos")]
    platform::open_login_items();
}

/// The registration's file or value name.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn entry_name(app: &tauri::AppHandle) -> String {
    app.package_info().name.clone()
}

/// The name registrations had before the app was renamed to Chatpane.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const PREVIOUS_ENTRY_NAME: &str = "Carrier";

/// Whether a startup entry under the old name launches this app, judged by the
/// program it starts: the old executable (`carrier`, `Carrier.exe`) or an
/// AppImage named after the app. It no longer points at this install when the
/// installer moved the app to a new folder.
#[cfg(any(test, target_os = "windows", target_os = "linux"))]
fn previous_entry_is_ours(program: &str) -> bool {
    // Split on both separators: the tests run Windows paths on every platform.
    let name = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .to_lowercase();
    name == "carrier"
        || name == "carrier.exe"
        || ((name.starts_with("carrier") || name.starts_with("chatpane"))
            && name.ends_with(".appimage"))
}

/// Whether two paths name the same program, after resolving symlinks.
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn same_program(a: &std::path::Path, b: &std::path::Path) -> bool {
    let resolve = |p: &std::path::Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.into());
    let (a, b) = (resolve(a), resolve(b));
    if cfg!(windows) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

// ---------------------------------------------------------------- macOS ---

/// The LaunchAgent plist an older Carrier wrote.
#[cfg(any(test, target_os = "macos"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LegacyAgent {
    Missing,
    /// It starts Chatpane at login.
    Enabled,
    /// macOS 13+: the user switched it off under "Allow in the Background";
    /// the plist stays but doesn't run.
    Disabled,
}

/// macOS 13+: what to do with a LaunchAgent an older Carrier installed.
#[cfg(any(test, target_os = "macos"))]
#[derive(Debug, PartialEq, Eq)]
enum LegacyAgentPlan {
    Nothing,
    /// The login item already starts Chatpane, or the user switched the agent
    /// off and removing it keeps it off.
    Remove,
    /// Register the login item, and remove the agent once the login item is
    /// enabled. Until then the agent keeps starting Chatpane.
    Register,
}

#[cfg(any(test, target_os = "macos"))]
fn legacy_agent_plan(agent: LegacyAgent, service: Status) -> LegacyAgentPlan {
    match (agent, service) {
        (LegacyAgent::Missing, _) => LegacyAgentPlan::Nothing,
        (LegacyAgent::Disabled, _) | (LegacyAgent::Enabled, Status::On) => LegacyAgentPlan::Remove,
        (LegacyAgent::Enabled, Status::Off) => LegacyAgentPlan::Register,
        // A registered login item waiting for approval: the agent still works.
        (LegacyAgent::Enabled, Status::NeedsApproval) => LegacyAgentPlan::Nothing,
    }
}

/// macOS 13+: an agent kept while the login item can't run still starts
/// Chatpane.
#[cfg(any(test, target_os = "macos"))]
fn macos_status(service: Status, agent: LegacyAgent) -> Status {
    if agent == LegacyAgent::Enabled {
        Status::On
    } else {
        service
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::path::PathBuf;

    use objc2_service_management::{SMAppService, SMAppServiceStatus};

    use objc2_foundation::NSURL;

    use super::{
        LegacyAgent, LegacyAgentPlan, PREVIOUS_ENTRY_NAME, Status, entry_name, legacy_agent_plan,
        macos_status,
    };

    fn has_login_items() -> bool {
        objc2::available!(macos = 13.0)
    }

    /// Callers check [`has_login_items`] first.
    fn service_status() -> Status {
        // SAFETY: SMAppService exists on macOS 13+, which callers check.
        let status = unsafe { SMAppService::mainAppService().status() };
        match status {
            SMAppServiceStatus::Enabled => Status::On,
            SMAppServiceStatus::RequiresApproval => Status::NeedsApproval,
            _ => Status::Off,
        }
    }

    fn register(enabled: bool) -> Result<(), String> {
        // SAFETY: SMAppService exists on macOS 13+, which callers check.
        let result = unsafe {
            let service = SMAppService::mainAppService();
            if enabled {
                service.registerAndReturnError()
            } else {
                service.unregisterAndReturnError()
            }
        };
        result.map_err(|e| e.localizedDescription().to_string())
    }

    fn agent_path(name: &str) -> Option<PathBuf> {
        let home = std::env::var_os("HOME")?;
        Some(
            PathBuf::from(home)
                .join("Library/LaunchAgents")
                .join(format!("{name}.plist")),
        )
    }

    /// The agent under the current name, else one still named after Carrier.
    fn legacy_agent(app: &tauri::AppHandle) -> Option<PathBuf> {
        let current = agent_path(&entry_name(app))?;
        if current.exists() {
            return Some(current);
        }
        agent_path(PREVIOUS_ENTRY_NAME)
            .filter(|path| path.exists())
            .or(Some(current))
    }

    fn remove_legacy_agent(app: &tauri::AppHandle) -> Result<(), String> {
        for path in [entry_name(app).as_str(), PREVIOUS_ENTRY_NAME]
            .into_iter()
            .filter_map(agent_path)
        {
            match std::fs::remove_file(&path) {
                Ok(()) => log::info!("removed the old Start on System Startup LaunchAgent"),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("couldn't remove {}: {e}", path.display())),
            }
        }
        Ok(())
    }

    /// Whether the agent exists and, on macOS 13+, whether the user allows it.
    /// Only an explicit "requires approval" counts as switched off, so an
    /// unclear answer never removes an agent that still works.
    fn legacy_agent_state(app: &tauri::AppHandle) -> LegacyAgent {
        let Some(path) = legacy_agent(app).filter(|path| path.exists()) else {
            return LegacyAgent::Missing;
        };
        if !has_login_items() {
            return LegacyAgent::Enabled;
        }
        let url = NSURL::from_file_path(&path);
        // SAFETY: SMAppService exists on macOS 13+, checked above.
        let status = url.map(|url| unsafe { SMAppService::statusForLegacyURL(&url) });
        if status == Some(SMAppServiceStatus::RequiresApproval) {
            LegacyAgent::Disabled
        } else {
            LegacyAgent::Enabled
        }
    }

    /// The first launch after `Carrier.app` became `Chatpane.app`, or after
    /// Carrier's data moved to Chatpane's identifier: the login item or agent
    /// still opens the old path or app, so register this one instead, if Start
    /// on System Startup was on.
    pub(super) fn repoint_after_rename(app: &tauri::AppHandle) {
        use tauri::Manager;
        // Both, so neither stays set for a later call.
        let renamed = crate::bundle_rename::take_launched_after_rename();
        let moved = crate::identity::take_moved();
        if !(renamed || moved)
            || !app
                .state::<crate::settings::AppState>()
                .settings
                .lock()
                .unwrap()
                .autostart
        {
            return;
        }
        let result = if has_login_items() {
            // Unregistering forgets the old path; failing it is harmless.
            let _ = register(false);
            register(true)
        } else if legacy_agent(app).is_some_and(|path| path.exists()) {
            write_legacy_agent(app)
        } else {
            Ok(())
        };
        match result {
            Ok(()) => log::info!("Start on System Startup now opens Chatpane"),
            Err(e) => log::warn!("couldn't move Start on System Startup to Chatpane: {e}"),
        }
    }

    pub(super) fn migrate_legacy_agent(app: &tauri::AppHandle) {
        if !has_login_items() {
            // macOS 10.15 to 12 keep the agent: rewrite one named after Carrier
            // under the current name, pointing at this app.
            if let Some(previous) = agent_path(PREVIOUS_ENTRY_NAME).filter(|path| path.exists())
                && let Err(e) = write_legacy_agent(app).and_then(|()| {
                    std::fs::remove_file(&previous)
                        .map_err(|e| format!("couldn't remove {}: {e}", previous.display()))
                })
            {
                log::warn!("couldn't rename the Start on System Startup LaunchAgent: {e}");
            }
            return;
        }
        let remove = match legacy_agent_plan(legacy_agent_state(app), service_status()) {
            LegacyAgentPlan::Nothing => false,
            LegacyAgentPlan::Remove => true,
            LegacyAgentPlan::Register => match register(true) {
                Ok(()) => service_status() == Status::On,
                Err(e) => {
                    log::warn!("couldn't move Start on System Startup to Login Items: {e}");
                    false
                }
            },
        };
        if remove && let Err(e) = remove_legacy_agent(app) {
            log::warn!("{e}");
        }
    }

    pub(super) fn status(app: &tauri::AppHandle) -> Result<Status, String> {
        let agent = legacy_agent_state(app);
        Ok(if has_login_items() {
            macos_status(service_status(), agent)
        } else if agent == LegacyAgent::Enabled {
            Status::On
        } else {
            Status::Off
        })
    }

    pub(super) fn set(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
        if !has_login_items() {
            return if enabled {
                write_legacy_agent(app)
            } else {
                remove_legacy_agent(app)
            };
        }
        let service = service_status();
        if !enabled {
            // Unregistering what isn't registered fails.
            if service != Status::Off {
                register(false)?;
            }
            return remove_legacy_agent(app);
        }
        if service == Status::Off {
            register(true)?;
        }
        match service_status() {
            Status::On => remove_legacy_agent(app),
            Status::NeedsApproval => Err(crate::i18n::t("autostart.error.needs_approval").into()),
            Status::Off => Err(crate::i18n::t("autostart.error.not_added").into()),
        }
    }

    /// macOS 10.15 to 12: a LaunchAgent that runs Chatpane once at login.
    fn write_legacy_agent(app: &tauri::AppHandle) -> Result<(), String> {
        let path = agent_path(&entry_name(app)).ok_or("HOME is not set")?;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let escape = |s: &str| {
            s.replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
        };
        let plist = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
             <plist version=\"1.0\">\n<dict>\n\
             \t<key>Label</key>\n\t<string>{}</string>\n\
             \t<key>ProgramArguments</key>\n\t<array><string>{}</string></array>\n\
             \t<key>RunAtLoad</key>\n\t<true/>\n\
             </dict>\n</plist>\n",
            escape(&entry_name(app)),
            escape(&exe.to_string_lossy()),
        );
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, plist).map_err(|e| format!("couldn't write {}: {e}", path.display()))
    }

    pub(super) fn open_login_items() {
        if has_login_items() {
            // SAFETY: SMAppService exists on macOS 13+, checked above.
            unsafe { SMAppService::openSystemSettingsLoginItems() };
        }
    }
}

// -------------------------------------------------------------- Windows ---

/// Task Manager and Settings → Apps → Startup switch an entry off without
/// touching its `Run` value. They record the switch under
/// `StartupApproved\Run`: the first byte is even (02, 06) when enabled and
/// odd (03, 07) when disabled, followed by when it changed. A missing or
/// empty value counts as enabled.
#[cfg(any(test, target_os = "windows"))]
fn startup_approved(value: Option<&[u8]>) -> bool {
    value
        .and_then(|bytes| bytes.first())
        .is_none_or(|flag| flag & 1 == 0)
}

/// The program a `Run` command starts: the quoted path, or the whole command
/// when unquoted (tauri-plugin-autostart wrote `C:\…\Carrier.exe ` unquoted).
#[cfg(any(test, target_os = "windows"))]
fn run_command_program(command: &str) -> &str {
    let command = command.trim();
    match command.strip_prefix('"') {
        Some(rest) => rest.split('"').next().unwrap_or(rest),
        None => command,
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use windows_sys::Win32::System::Registry::{
        HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_BINARY, RRF_RT_REG_SZ, RegDeleteKeyValueW,
        RegGetValueW, RegSetKeyValueW,
    };

    use super::{
        PREVIOUS_ENTRY_NAME, Status, entry_name, previous_entry_is_ours, run_command_program,
        same_program, startup_approved,
    };

    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const STARTUP_APPROVED: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    const ERROR_FILE_NOT_FOUND: u32 = 2;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// A per-user registry value's bytes, or `None` when it or its key is missing.
    fn read(subkey: &str, name: &str, flags: u32) -> Result<Option<Vec<u8>>, String> {
        let (subkey, name) = (wide(subkey), wide(name));
        let mut size = 0u32;
        let mut buffer = Vec::new();
        // The first call asks for the size, the second reads; retry if the
        // value grew in between.
        for _ in 0..3 {
            buffer.resize(size as usize, 0);
            // SAFETY: `flags` restricts the value type; RegGetValueW writes at
            // most `size` bytes into `buffer` and updates `size`. A null buffer
            // only queries the size.
            let status = unsafe {
                RegGetValueW(
                    HKEY_CURRENT_USER,
                    subkey.as_ptr(),
                    name.as_ptr(),
                    flags,
                    std::ptr::null_mut(),
                    if buffer.is_empty() {
                        std::ptr::null_mut()
                    } else {
                        buffer.as_mut_ptr().cast()
                    },
                    &mut size,
                )
            };
            match status {
                0 if !buffer.is_empty() || size == 0 => {
                    buffer.truncate(size as usize);
                    return Ok(Some(buffer));
                }
                // ERROR_MORE_DATA, or the size query: read again at `size`.
                0 | 234 => continue,
                ERROR_FILE_NOT_FOUND => return Ok(None),
                code => return Err(format!("registry read failed ({code})")),
            }
        }
        Err("registry value kept changing size".into())
    }

    fn delete(subkey: &str, name: &str) -> Result<(), String> {
        let (subkey, name) = (wide(subkey), wide(name));
        // SAFETY: both strings are NUL-terminated UTF-16.
        match unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, subkey.as_ptr(), name.as_ptr()) } {
            0 | ERROR_FILE_NOT_FOUND => Ok(()),
            code => Err(format!("registry delete failed ({code})")),
        }
    }

    /// A `Run` value's command, or `None` when it is missing.
    fn run_command(name: &str) -> Result<Option<String>, String> {
        Ok(read(RUN, name, RRF_RT_REG_SZ)?.map(|bytes| {
            let units: Vec<u16> = bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u16::from_le_bytes(*pair))
                .take_while(|unit| *unit != 0)
                .collect();
            String::from_utf16_lossy(&units)
        }))
    }

    /// Move a startup entry still named "Carrier" to the current name, keeping
    /// it off when Task Manager or Settings had switched it off.
    pub(super) fn migrate_previous_entry(app: &tauri::AppHandle) {
        let result = (|| {
            let Some(command) = run_command(PREVIOUS_ENTRY_NAME)? else {
                return Ok(());
            };
            if !previous_entry_is_ours(run_command_program(&command)) {
                return Ok(());
            }
            let approved = read(STARTUP_APPROVED, PREVIOUS_ENTRY_NAME, RRF_RT_REG_BINARY)?;
            if startup_approved(approved.as_deref()) {
                set(app, true)?;
            }
            delete(RUN, PREVIOUS_ENTRY_NAME)?;
            delete(STARTUP_APPROVED, PREVIOUS_ENTRY_NAME)?;
            log::info!("moved the Start on System Startup entry to the new app name");
            Ok::<(), String>(())
        })();
        if let Err(e) = result {
            log::warn!("couldn't move the Start on System Startup entry: {e}");
        }
    }

    pub(super) fn status(app: &tauri::AppHandle) -> Result<Status, String> {
        let name = entry_name(app);
        let Some(command) = run_command(&name)? else {
            return Ok(Status::Off);
        };
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        if !same_program(run_command_program(&command).as_ref(), &exe) {
            return Ok(Status::Off);
        }
        let approved = read(STARTUP_APPROVED, &name, RRF_RT_REG_BINARY)?;
        Ok(if startup_approved(approved.as_deref()) {
            Status::On
        } else {
            Status::Off
        })
    }

    pub(super) fn set(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
        let name = entry_name(app);
        if !enabled {
            return delete(RUN, &name);
        }
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let command = wide(&format!("\"{}\"", exe.display()));
        let (subkey, value) = (wide(RUN), wide(&name));
        // SAFETY: NUL-terminated UTF-16 strings; the data length includes the
        // terminator, as REG_SZ requires. The key is created when missing.
        let status = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                value.as_ptr(),
                REG_SZ,
                command.as_ptr().cast(),
                (command.len() * 2) as u32,
            )
        };
        if status != 0 {
            return Err(format!("registry write failed ({status})"));
        }
        // Clear a Task Manager disable; with no entry Windows treats it as on.
        delete(STARTUP_APPROVED, &name)
    }
}

// ---------------------------------------------------------------- Linux ---

/// Quote `program` for a desktop entry's `Exec` key: an argument in double
/// quotes with `"`, `` ` ``, `$` and `\` escaped, `%` doubled, and the
/// backslashes escaped again because `Exec` is itself a string value.
#[cfg(any(test, target_os = "linux"))]
fn exec_quote(program: &str) -> String {
    let mut arg = String::from("\"");
    for c in program.chars() {
        match c {
            '"' | '`' | '$' | '\\' => {
                arg.push('\\');
                arg.push(c);
            }
            '%' => arg.push_str("%%"),
            _ => arg.push(c),
        }
    }
    arg.push('"');
    arg.replace('\\', "\\\\")
}

/// The program an `Exec` value runs: its first argument, unescaped.
#[cfg(any(test, target_os = "linux"))]
fn exec_program(exec: &str) -> Option<String> {
    // Undo the string-value escapes first, then the argument quoting.
    let mut value = String::new();
    let mut chars = exec.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            value.push(c);
            continue;
        }
        match chars.next() {
            Some('s') => value.push(' '),
            Some('n') => value.push('\n'),
            Some('t') => value.push('\t'),
            Some('r') => value.push('\r'),
            Some(other) => value.push(other),
            None => value.push('\\'),
        }
    }
    let value = value.trim_start();
    let mut program = String::new();
    if let Some(quoted) = value.strip_prefix('"') {
        let mut chars = quoted.chars();
        loop {
            match chars.next()? {
                '"' => break,
                '\\' => program.push(chars.next()?),
                c => program.push(c),
            }
        }
    } else {
        program = value.split_whitespace().next()?.to_string();
    }
    let program = program.replace("%%", "%");
    (!program.is_empty()).then_some(program)
}

/// The program an XDG autostart entry starts at login, or `None` when the
/// user switched it off (`Hidden=true`, or GNOME's
/// `X-GNOME-Autostart-enabled=false`) or it has no `Exec`.
#[cfg(any(test, target_os = "linux"))]
fn autostart_entry_program(contents: &str) -> Option<String> {
    let mut in_entry = false;
    let mut exec = None;
    for line in contents.lines().map(str::trim) {
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        let Some((key, value)) = line.split_once('=').filter(|_| in_entry) else {
            continue;
        };
        match (key.trim(), value.trim()) {
            ("Hidden", "true") | ("X-GNOME-Autostart-enabled", "false") => return None,
            ("Exec", value) => exec = Some(value),
            _ => {}
        }
    }
    exec_program(exec?)
}

#[cfg(target_os = "linux")]
mod platform {
    use std::path::PathBuf;

    use tauri::Manager;

    use super::{
        PREVIOUS_ENTRY_NAME, Status, autostart_entry_program, entry_name, exec_quote,
        previous_entry_is_ours, same_program,
    };

    fn named_entry_path(name: &str) -> Result<PathBuf, String> {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|dir| dir.is_absolute())
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
            .ok_or("HOME is not set")?;
        Ok(config.join("autostart").join(format!("{name}.desktop")))
    }

    fn entry_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        named_entry_path(&entry_name(app))
    }

    /// Move an enabled autostart entry still named "Carrier" to the current
    /// name and program. One the user switched off is left alone, still off.
    pub(super) fn migrate_previous_entry(app: &tauri::AppHandle) {
        let result = (|| {
            let previous = named_entry_path(PREVIOUS_ENTRY_NAME)?;
            let Ok(contents) = std::fs::read_to_string(&previous) else {
                return Ok(());
            };
            let Some(program) = autostart_entry_program(&contents) else {
                return Ok(());
            };
            let ours = previous_entry_is_ours(&program)
                || same_program(program.as_ref(), &self::program(app)?);
            if !ours {
                return Ok(());
            }
            set(app, true)?;
            std::fs::remove_file(&previous)
                .map_err(|e| format!("couldn't remove {}: {e}", previous.display()))?;
            log::info!("moved the Start on System Startup entry to the new app name");
            Ok::<(), String>(())
        })();
        if let Err(e) = result {
            log::warn!("couldn't move the Start on System Startup entry: {e}");
        }
    }

    /// The AppImage when running from one, since its mounted executable is
    /// gone after Chatpane exits.
    fn program(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        match app.env().appimage {
            Some(appimage) => Ok(appimage.into()),
            None => std::env::current_exe().map_err(|e| e.to_string()),
        }
    }

    pub(super) fn status(app: &tauri::AppHandle) -> Result<Status, String> {
        let path = entry_path(app)?;
        let contents = match std::fs::read_to_string(&path) {
            Ok(contents) => contents,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Status::Off),
            Err(e) => return Err(format!("couldn't read {}: {e}", path.display())),
        };
        let this = program(app)?;
        Ok(match autostart_entry_program(&contents) {
            Some(entry) if same_program(entry.as_ref(), &this) => Status::On,
            _ => Status::Off,
        })
    }

    pub(super) fn set(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
        let path = entry_path(app)?;
        if !enabled {
            return match std::fs::remove_file(&path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                    Err(format!("couldn't remove {}: {e}", path.display()))
                }
                _ => Ok(()),
            };
        }
        let name = entry_name(app);
        let program = program(app)?;
        let comment = crate::i18n::tf("autostart.desktop_comment", &[("name", &name)]);
        let entry = format!(
            "[Desktop Entry]\nType=Application\nVersion=1.0\nName={name}\n\
             Comment={comment}\nExec={}\nStartupNotify=false\nTerminal=false\n",
            exec_quote(&program.to_string_lossy()),
        );
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, entry).map_err(|e| format!("couldn't write {}: {e}", path.display()))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod platform {
    use super::Status;

    pub(super) fn status(_: &tauri::AppHandle) -> Result<Status, String> {
        Ok(Status::Off)
    }

    pub(super) fn set(_: &tauri::AppHandle, _: bool) -> Result<(), String> {
        Err("unsupported on this platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_os_state_wins_unless_unreadable() {
        assert!(!reconciled(true, Some(Status::Off)));
        assert!(reconciled(false, Some(Status::On)));
        assert!(!reconciled(true, Some(Status::NeedsApproval)));
        assert!(reconciled(true, None));
        assert!(!reconciled(false, None));
    }

    #[test]
    fn a_legacy_agent_moves_to_login_items_without_a_gap() {
        use LegacyAgent::{Disabled, Enabled, Missing};
        assert_eq!(
            legacy_agent_plan(Missing, Status::Off),
            LegacyAgentPlan::Nothing
        );
        assert_eq!(
            legacy_agent_plan(Enabled, Status::Off),
            LegacyAgentPlan::Register
        );
        assert_eq!(
            legacy_agent_plan(Enabled, Status::On),
            LegacyAgentPlan::Remove
        );
        // The agent keeps working until the login item is allowed.
        assert_eq!(
            legacy_agent_plan(Enabled, Status::NeedsApproval),
            LegacyAgentPlan::Nothing
        );
        // An agent the user switched off is never turned into a login item.
        assert_eq!(
            legacy_agent_plan(Disabled, Status::Off),
            LegacyAgentPlan::Remove
        );

        assert_eq!(macos_status(Status::Off, Enabled), Status::On);
        assert_eq!(macos_status(Status::NeedsApproval, Enabled), Status::On);
        assert_eq!(macos_status(Status::Off, Disabled), Status::Off);
        assert_eq!(
            macos_status(Status::NeedsApproval, Missing),
            Status::NeedsApproval
        );
    }

    #[test]
    fn startup_approved_reads_the_task_manager_flag() {
        let enabled = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let disabled = [3, 0, 0, 0, 0x40, 0x5c, 0x8e, 0x1d, 0x6f, 0x4b, 0xdb, 0x01];
        assert!(startup_approved(None));
        assert!(startup_approved(Some(&[])));
        assert!(startup_approved(Some(&enabled)));
        assert!(startup_approved(Some(&[6, 0, 0, 0])));
        assert!(!startup_approved(Some(&disabled)));
        assert!(!startup_approved(Some(&[7, 0, 0, 0])));
    }

    #[test]
    fn run_commands_name_their_program() {
        let exe = r"C:\Users\A B\AppData\Local\Carrier\Carrier.exe";
        assert_eq!(run_command_program(&format!("\"{exe}\"")), exe);
        assert_eq!(run_command_program(&format!("\"{exe}\" --hidden")), exe);
        // tauri-plugin-autostart's unquoted value with a trailing space.
        assert_eq!(run_command_program(&format!("{exe} ")), exe);
    }

    #[test]
    fn only_the_old_apps_startup_entries_are_moved() {
        for ours in [
            r"C:\Users\A B\AppData\Local\Carrier\carrier.exe",
            r"C:\Users\A B\AppData\Local\Carrier\Carrier.exe",
            "/usr/bin/carrier",
            "/home/a/.local/bin/carrier",
            "/home/a/Apps/Carrier_3.0.1_amd64.AppImage",
            "/home/a/Apps/Chatpane_3.1.0_amd64.AppImage",
        ] {
            assert!(previous_entry_is_ours(ours), "{ours}");
        }
        for theirs in [
            r"C:\Program Files\Carrier Corp\hvac.exe",
            "/usr/bin/carrier-agent",
            "/opt/carrier-hvac/bin/agent",
            "/home/a/Apps/Other.AppImage",
        ] {
            assert!(!previous_entry_is_ours(theirs), "{theirs}");
        }
    }

    #[test]
    fn exec_quoting_round_trips() {
        for path in [
            "/usr/bin/carrier",
            "/home/a b/Carrier.AppImage",
            r#"/odd/"q"/$HOME/`x`/back\slash/100%"#,
        ] {
            let exec = exec_quote(path);
            assert_eq!(exec_program(&exec).as_deref(), Some(path), "{exec}");
        }
    }

    #[test]
    fn autostart_entries_respect_the_users_switch() {
        let entry = |extra: &str| {
            format!(
                "[Desktop Entry]\nType=Application\nName=Carrier\n{extra}Exec=\"/opt/Carrier\"\n"
            )
        };
        assert_eq!(
            autostart_entry_program(&entry("")).as_deref(),
            Some("/opt/Carrier")
        );
        assert_eq!(autostart_entry_program(&entry("Hidden=true\n")), None);
        assert_eq!(
            autostart_entry_program(&entry("Hidden = false\n")).as_deref(),
            Some("/opt/Carrier")
        );
        assert_eq!(
            autostart_entry_program(&entry("X-GNOME-Autostart-enabled=false\n")),
            None
        );
        // Keys in other groups and comments don't count.
        let other_group = format!("{}\n[Desktop Action x]\nHidden=true\n", entry(""));
        assert_eq!(
            autostart_entry_program(&other_group).as_deref(),
            Some("/opt/Carrier")
        );
        assert_eq!(
            autostart_entry_program(&entry("#Hidden=true\n")).as_deref(),
            Some("/opt/Carrier")
        );
        // tauri-plugin-autostart wrote the path unquoted, with a trailing space.
        let legacy = "[Desktop Entry]\nType=Application\nExec=/usr/bin/carrier \nTerminal=false";
        assert_eq!(
            autostart_entry_program(legacy).as_deref(),
            Some("/usr/bin/carrier")
        );
        assert_eq!(
            autostart_entry_program("[Desktop Entry]\nName=Carrier\n"),
            None
        );
    }
}
