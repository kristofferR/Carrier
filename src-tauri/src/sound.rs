//! The notification sound (Settings → Notifications, Ref #363 and #446): the
//! stored choice, the sounds each OS ships, sounds added with Choose file…,
//! and playing a sound where a notification can't carry it.
//!
//! - macOS lists `~/Library/Sounds` and `/System/Library/Sounds` and delivers
//!   the name with `UNNotificationSound`. Choose file… copies the file into
//!   `~/Library/Sounds`, so it becomes one more named sound.
//! - Windows lists the built-in `ms-winsoundevent` toast sounds. A toast from
//!   an app installed without a package can't play a file of its own, so a
//!   chosen file means a silent toast while Chatpane plays the file.
//! - Linux lists message-like names from the freedesktop sound theme. A
//!   notification server that advertises the `sound` capability plays the
//!   hint; for any other, Chatpane sends `suppress-sound` and plays the file.
//!
//! The Messenger page never picks a sound. Its only say is `chatpane:notify`'s
//! `silent` flag, which can take the sound away ([`message_sound`]). Stored
//! names resolve only against the listed folders and tables, so a setting
//! never becomes an arbitrary path.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::i18n::{t, tf};

/// The platform a [`NotificationSound::System`] name belongs to.
const PLATFORM: &str = if cfg!(target_os = "macos") {
    "macos"
} else if cfg!(target_os = "windows") {
    "windows"
} else {
    "linux"
};

/// What Choose file… accepts: what each platform's notification or Chatpane's
/// own playback can play.
#[cfg(target_os = "macos")]
const EXTENSIONS: &[&str] = &["aiff", "aif", "caf", "wav"];
#[cfg(target_os = "windows")]
const EXTENSIONS: &[&str] = &["wav"];
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const EXTENSIONS: &[&str] = &["wav", "ogg", "oga"];

/// Choose file… copies the sound, so keep that copy small.
const MAX_SOUND_BYTES: u64 = 10 * 1024 * 1024;

/// The built-in toast sounds besides `Notification.Default` (System default):
/// name, toast sound event, label's UI string key. The looping alarm and call
/// sounds are left out: a message should not ring for 30 seconds.
#[cfg(any(target_os = "windows", test))]
const WINDOWS_SOUNDS: &[(&str, &str, &str)] = &[
    ("IM", "Notification.IM", "sound.windows.instant_message"),
    ("Mail", "Notification.Mail", "sound.windows.mail"),
    (
        "Reminder",
        "Notification.Reminder",
        "sound.windows.reminder",
    ),
    ("SMS", "Notification.SMS", "sound.windows.text_message"),
];

/// The freedesktop sound-theme name Chatpane's Linux notifications use by default.
#[cfg(any(target_os = "linux", test))]
pub(crate) const LINUX_DEFAULT_SOUND: &str = "message-new-instant";

/// Message-like names from the freedesktop sound naming spec, offered when the
/// active sound theme (or one it inherits) has them, with their labels' UI
/// string keys.
#[cfg(any(target_os = "linux", test))]
const LINUX_SOUNDS: &[(&str, &str)] = &[
    ("message", "sound.linux.message"),
    ("message-new-email", "sound.linux.new_email"),
    ("bell", "sound.linux.bell"),
    ("complete", "sound.linux.complete"),
    ("dialog-information", "sound.linux.information"),
    ("window-attention", "sound.linux.attention"),
];

/// The notification sound Settings stores (`notification_sound_choice`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum NotificationSound {
    Off,
    /// The platform's default notification sound.
    Default,
    /// One of the OS's own sounds, by name, on the platform that listed it.
    System {
        platform: String,
        name: String,
    },
    /// A sound added with Choose file… on Windows or Linux, by its name in
    /// Chatpane's sounds folder.
    File(String),
}

impl NotificationSound {
    fn system(name: &str) -> Self {
        Self::System {
            platform: PLATFORM.into(),
            name: name.into(),
        }
    }
}

/// An unreadable `notification_sound_choice` falls back to the old on/off
/// switch instead of failing the whole settings file.
pub(crate) fn deserialize_choice<'de, D>(
    deserializer: D,
) -> Result<Option<NotificationSound>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

impl crate::settings::Settings {
    /// The chosen notification sound. Settings from before the picker have
    /// only the switch: on is the system default, off is Off.
    pub(crate) fn sound_choice(&self) -> NotificationSound {
        self.notification_sound_choice
            .clone()
            .unwrap_or(if self.notification_sound {
                NotificationSound::Default
            } else {
                NotificationSound::Off
            })
    }
}

/// The sound for one message notification. The page's `silent` flag
/// (Messenger's own sound just rang) can take the sound away, never add one.
pub(crate) fn message_sound(choice: &NotificationSound, page_silent: bool) -> NotificationSound {
    if page_silent {
        NotificationSound::Off
    } else {
        choice.clone()
    }
}

/// What a notification plays, once the choice is checked against what exists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Sound {
    Silent,
    Default,
    /// macOS: a file name in a Sounds folder. Windows: a name from
    /// [`WINDOWS_SOUNDS`]. Linux: a sound-theme name from [`LINUX_SOUNDS`].
    Named(String),
    /// A file Chatpane plays itself (Windows and Linux).
    File(PathBuf),
}

/// Resolve the stored choice. A sound that has disappeared, or one stored on
/// another platform, plays the default instead.
pub(crate) fn resolve(app: &tauri::AppHandle, choice: &NotificationSound) -> Sound {
    match choice {
        NotificationSound::Off => Sound::Silent,
        NotificationSound::Default => Sound::Default,
        NotificationSound::System { platform, name } if platform == PLATFORM => {
            system_sound(name).unwrap_or(Sound::Default)
        }
        NotificationSound::System { .. } => Sound::Default,
        NotificationSound::File(name) => added_sound(app, name)
            .map(Sound::File)
            .unwrap_or(Sound::Default),
    }
}

#[cfg(target_os = "macos")]
fn system_sound(name: &str) -> Option<Sound> {
    let path = find_sound(&macos_sound_dirs(), EXTENSIONS, name)?;
    Some(Sound::Named(path.file_name()?.to_str()?.into()))
}

#[cfg(target_os = "windows")]
fn system_sound(name: &str) -> Option<Sound> {
    WINDOWS_SOUNDS
        .iter()
        .find(|(known, _, _)| *known == name)
        .map(|(known, _, _)| Sound::Named((*known).into()))
}

/// Whether the sound theme still has the name is checked at delivery
/// ([`linux_sound`]), where the theme is read anyway.
#[cfg(target_os = "linux")]
fn system_sound(name: &str) -> Option<Sound> {
    LINUX_SOUNDS
        .iter()
        .any(|(known, _)| *known == name)
        .then(|| Sound::Named(name.into()))
}

/// macOS keeps added sounds in `~/Library/Sounds` as named sounds instead.
#[cfg(target_os = "macos")]
fn added_sound(_app: &tauri::AppHandle, _name: &str) -> Option<PathBuf> {
    None
}

#[cfg(not(target_os = "macos"))]
fn added_sound(app: &tauri::AppHandle, name: &str) -> Option<PathBuf> {
    find_sound(&[import_dir(app).ok()?], EXTENSIONS, name)
}

#[cfg(target_os = "macos")]
fn macos_sound_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join("Library/Sounds"));
    }
    dirs.push(PathBuf::from("/System/Library/Sounds"));
    dirs
}

/// Where Choose file… keeps its copy.
#[cfg(target_os = "macos")]
fn import_dir(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library/Sounds"))
        .ok_or_else(|| t("sound.error.no_home").into())
}

#[cfg(not(target_os = "macos"))]
fn import_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("sounds"))
        .map_err(|error| tf("error.config_folder", &[("error", &error)]))
}

/// The folders a chosen file may already be in, so it is used where it is.
#[cfg(target_os = "macos")]
fn listed_dirs(_import_dir: &Path) -> Vec<PathBuf> {
    macos_sound_dirs()
}

#[cfg(not(target_os = "macos"))]
fn listed_dirs(import_dir: &Path) -> Vec<PathBuf> {
    vec![import_dir.to_path_buf()]
}

/// A sound file's name: the file name without its extension. None for other
/// files and hidden ones.
fn sound_name(path: &Path, extensions: &[&str]) -> Option<String> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if !extensions.contains(&extension.as_str()) {
        return None;
    }
    let name = path.file_stem()?.to_str()?;
    (!name.is_empty() && !name.starts_with('.')).then(|| name.to_string())
}

/// The sound files in `dirs` by name, sorted. A name in an earlier folder
/// hides the same name in a later one.
fn sounds_in(dirs: &[PathBuf], extensions: &[&str]) -> Vec<(String, PathBuf)> {
    let mut found: Vec<(String, PathBuf)> = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        let mut here: Vec<(String, PathBuf)> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_file())
            .filter_map(|path| sound_name(&path, extensions).map(|name| (name, path)))
            .collect();
        // Two extensions with one name: pick the same file every time.
        here.sort();
        for (name, path) in here {
            if !found.iter().any(|(known, _)| *known == name) {
                found.push((name, path));
            }
        }
    }
    found.sort_by_key(|(name, _)| name.to_lowercase());
    found
}

fn find_sound(dirs: &[PathBuf], extensions: &[&str], name: &str) -> Option<PathBuf> {
    sounds_in(dirs, extensions)
        .into_iter()
        .find(|(known, _)| known == name)
        .map(|(_, path)| path)
}

/// Copy `source` into `dir` for Choose file… and return its name. A file
/// already in one of `listed` is used where it is. A different sound that
/// already has the name makes this one "name 2", "name 3"…
fn import_sound(
    dir: &Path,
    listed: &[PathBuf],
    source: &Path,
    extensions: &[&str],
) -> Result<String, String> {
    let file_name = source
        .file_name()
        .unwrap_or(source.as_os_str())
        .to_string_lossy()
        .into_owned();
    let io =
        |error: std::io::Error| tf("sound.error.io", &[("file", &file_name), ("error", &error)]);
    let name = sound_name(source, extensions).ok_or_else(|| {
        tf(
            "sound.error.wrong_type",
            &[
                ("file", &file_name),
                ("types", &extensions.join(", ").to_uppercase()),
            ],
        )
    })?;
    if source
        .parent()
        .is_some_and(|parent| listed.iter().any(|dir| dir == parent))
    {
        return Ok(name);
    }
    let metadata = std::fs::metadata(source).map_err(io)?;
    if !metadata.is_file() {
        return Err(tf("sound.error.not_a_file", &[("file", &file_name)]));
    }
    if metadata.len() > MAX_SOUND_BYTES {
        return Err(tf("sound.error.too_large", &[("file", &file_name)]));
    }
    let bytes = std::fs::read(source).map_err(io)?;
    let extension = source
        .extension()
        .map(|extension| extension.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    std::fs::create_dir_all(dir).map_err(io)?;
    let mut searched = listed.to_vec();
    if !searched.iter().any(|listed| listed == dir) {
        searched.insert(0, dir.to_path_buf());
    }
    for n in 1..=100 {
        let candidate = if n == 1 {
            name.clone()
        } else {
            format!("{name} {n}")
        };
        match find_sound(&searched, extensions, &candidate) {
            None => {
                // Create the file exclusively: on a case-insensitive disk a
                // differently cased sound can hold the name, and a dangling
                // link there must not redirect the write.
                let path = dir.join(format!("{candidate}.{extension}"));
                match std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
                {
                    Ok(mut file) => {
                        return std::io::Write::write_all(&mut file, &bytes)
                            .map(|()| candidate)
                            .map_err(|error| {
                                let _ = std::fs::remove_file(&path);
                                io(error)
                            });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(io(error)),
                }
            }
            // Adding the same sound again picks the copy already there.
            Some(existing) if std::fs::read(&existing).is_ok_and(|other| other == bytes) => {
                return Ok(candidate);
            }
            Some(_) => {}
        }
    }
    Err(tf("sound.error.name_taken", &[("file", &file_name)]))
}

/// One entry in the Settings sound list, after Off and System default.
#[derive(Debug, Serialize)]
pub(crate) struct SoundOption {
    label: String,
    sound: NotificationSound,
}

#[cfg(any(target_os = "linux", test))]
fn linux_system_sounds(theme_has: impl Fn(&str) -> bool) -> Vec<SoundOption> {
    LINUX_SOUNDS
        .iter()
        .filter(|(name, _)| theme_has(name))
        .map(|(name, label)| SoundOption {
            label: t(label).into(),
            sound: NotificationSound::system(name),
        })
        .collect()
}

fn available(app: &tauri::AppHandle) -> Vec<SoundOption> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        sounds_in(&macos_sound_dirs(), EXTENSIONS)
            .into_iter()
            .map(|(name, _)| SoundOption {
                sound: NotificationSound::system(&name),
                label: name,
            })
            .collect()
    }
    #[cfg(not(target_os = "macos"))]
    {
        #[cfg(target_os = "windows")]
        let system = WINDOWS_SOUNDS
            .iter()
            .map(|(name, _, label)| SoundOption {
                label: t(label).into(),
                sound: NotificationSound::system(name),
            })
            .collect::<Vec<_>>();
        #[cfg(target_os = "linux")]
        let system = {
            let theme_sound = theme_sounds(app);
            linux_system_sounds(|name| theme_sound(name).is_some())
        };
        let added = import_dir(app)
            .map(|dir| sounds_in(&[dir], EXTENSIONS))
            .unwrap_or_default()
            .into_iter()
            .map(|(name, _)| SoundOption {
                sound: NotificationSound::File(name.clone()),
                label: name,
            });
        system.into_iter().chain(added).collect()
    }
}

/// Settings: the OS's sounds and the added ones, read fresh each time so a
/// sound added since shows up.
#[tauri::command]
pub(crate) async fn notification_sounds(app: tauri::AppHandle) -> Result<Vec<SoundOption>, String> {
    tauri::async_runtime::spawn_blocking(move || available(&app))
        .await
        .map_err(|error| error.to_string())
}

/// Settings → Choose file…: pick a sound and keep a copy where notifications
/// can play it. Returns the choice to store, or None when cancelled.
#[tauri::command]
pub(crate) async fn choose_notification_sound(
    app: tauri::AppHandle,
) -> Result<Option<NotificationSound>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut picker = app
        .dialog()
        .file()
        .set_title(t("sound.picker.title"))
        .add_filter(t("sound.picker.filter"), EXTENSIONS);
    if let Some(settings) = app.get_webview_window("settings") {
        picker = picker.set_parent(&settings);
    }
    let Some(picked) = picker.blocking_pick_file() else {
        return Ok(None);
    };
    let source = picked.into_path().map_err(|error| error.to_string())?;
    let dir = import_dir(&app)?;
    let name = import_sound(&dir, &listed_dirs(&dir), &source, EXTENSIONS)?;
    Ok(Some(if cfg!(target_os = "macos") {
        NotificationSound::system(&name)
    } else {
        NotificationSound::File(name)
    }))
}

/// Settings → Preview: play a sound now, resolved the way a notification
/// would resolve it.
#[tauri::command]
pub(crate) async fn preview_notification_sound(
    app: tauri::AppHandle,
    sound: NotificationSound,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || preview(&app, &resolve(&app, &sound)))
        .await
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn preview(_app: &tauri::AppHandle, sound: &Sound) {
    use objc2_foundation::NSString;
    match sound {
        Sound::Silent => {}
        Sound::Named(file) => {
            let name = Path::new(file)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or(file);
            // NSSound keeps named sounds registered, so it outlives this call.
            match objc2_app_kit::NSSound::soundNamed(&NSString::from_str(name)) {
                Some(sound) => {
                    sound.play();
                }
                None => objc2_app_kit::NSBeep(),
            }
        }
        // The alert sound chosen in System Settings → Sound.
        Sound::Default | Sound::File(_) => objc2_app_kit::NSBeep(),
    }
}

#[cfg(target_os = "windows")]
fn preview(_app: &tauri::AppHandle, sound: &Sound) {
    use windows_sys::Win32::Media::Audio::SND_ALIAS;
    match sound {
        Sound::File(path) => play_file(path),
        other => {
            // Toast sound events are also registered system sound aliases.
            if let Some(event) = windows_toast_audio(other) {
                play_windows(std::ffi::OsStr::new(event), SND_ALIAS);
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn preview(app: &tauri::AppHandle, sound: &Sound) {
    if let Some(file) =
        linux_sound(sound.clone(), SoundServer::IgnoresSound, &theme_sounds(app)).play
    {
        play_file(&file);
    }
}

/// The toast's `ms-winsoundevent` sound, or None for a silent toast (Off, or a
/// file Chatpane plays itself). Only names from [`WINDOWS_SOUNDS`] get through.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn windows_toast_audio(sound: &Sound) -> Option<&'static str> {
    match sound {
        Sound::Default => Some("Notification.Default"),
        Sound::Named(name) => WINDOWS_SOUNDS
            .iter()
            .find(|(known, _, _)| known == name)
            .map(|(_, event, _)| *event),
        Sound::Silent | Sound::File(_) => None,
    }
}

#[cfg(target_os = "windows")]
fn play_windows(sound: &std::ffi::OsStr, kind: u32) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_NODEFAULT};
    let wide: Vec<u16> = sound.encode_wide().chain(Some(0)).collect();
    // SAFETY: a NUL-terminated UTF-16 string that lives through the call;
    // PlaySound opens the sound before an SND_ASYNC call returns.
    let played = unsafe {
        PlaySoundW(
            wide.as_ptr(),
            std::ptr::null_mut(),
            kind | SND_ASYNC | SND_NODEFAULT,
        )
    };
    if played == 0 {
        log::warn!("couldn't play the notification sound");
    }
}

/// Play a sound file once, without blocking. Windows plays WAV through
/// `PlaySound`, which needs no extra component.
#[cfg(target_os = "windows")]
pub(crate) fn play_file(path: &Path) {
    use windows_sys::Win32::Media::Audio::SND_FILENAME;
    play_windows(path.as_os_str(), SND_FILENAME);
}

/// Play a sound file once, without blocking, through the GStreamer that
/// WebKitGTK already loads.
#[cfg(target_os = "linux")]
pub(crate) fn play_file(path: &Path) {
    let Ok(uri) = url::Url::from_file_path(path) else {
        return;
    };
    std::thread::spawn(move || {
        use gstreamer::prelude::*;
        if let Err(error) = gstreamer::init() {
            log::warn!("couldn't play the notification sound: {error}");
            return;
        }
        let playbin = match gstreamer::ElementFactory::make("playbin")
            .property("uri", uri.as_str())
            .build()
        {
            Ok(playbin) => playbin,
            Err(error) => {
                log::warn!("couldn't play the notification sound: {error}");
                return;
            }
        };
        if playbin.set_state(gstreamer::State::Playing).is_ok()
            && let Some(bus) = playbin.bus()
        {
            let end = bus.timed_pop_filtered(
                gstreamer::ClockTime::from_seconds(30),
                &[gstreamer::MessageType::Eos, gstreamer::MessageType::Error],
            );
            if let Some(gstreamer::MessageView::Error(error)) = end.as_ref().map(|m| m.view()) {
                log::warn!("couldn't play the notification sound: {}", error.error());
            }
        } else {
            log::warn!("couldn't play the notification sound");
        }
        let _ = playbin.set_state(gstreamer::State::Null);
    });
}

/// How a Linux notification server handles sound.
#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SoundServer {
    /// Advertises the `sound` capability: it plays `sound-name` and
    /// `sound-file` hints.
    PlaysHints,
    /// The Snap notification portal: its default sound, or none.
    PlaysDefault,
    /// Ignores sound hints, as many notification daemons do.
    IgnoresSound,
}

/// The sound a Linux notification itself asks for.
#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SoundHint {
    /// `suppress-sound`, or the portal's `silent`.
    Silent,
    /// `sound-name` [`LINUX_DEFAULT_SOUND`], or the portal's `default`.
    Default,
    /// `sound-name`.
    Name(String),
    /// `sound-file`.
    File(PathBuf),
}

/// A Linux notification's sound: what the notification asks the server for,
/// and the file Chatpane plays once it is shown.
#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LinuxSound {
    pub(crate) hint: SoundHint,
    pub(crate) play: Option<PathBuf>,
}

#[cfg(any(target_os = "linux", test))]
impl LinuxSound {
    pub(crate) const SILENT: Self = Self {
        hint: SoundHint::Silent,
        play: None,
    };
}

/// Split a sound between the notification and Chatpane: a server that plays
/// hints gets the hint; otherwise the notification is silent and Chatpane
/// plays the file. The portal plays its own default. `theme_sound` finds a
/// sound-theme name's file; a name the theme no longer has plays the default.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn linux_sound(
    sound: Sound,
    server: SoundServer,
    theme_sound: &dyn Fn(&str) -> Option<PathBuf>,
) -> LinuxSound {
    let chatpane_plays = |file: Option<PathBuf>| LinuxSound {
        hint: SoundHint::Silent,
        play: file,
    };
    match (sound, server) {
        (Sound::Silent, _) => LinuxSound::SILENT,
        (Sound::Named(name), _) if theme_sound(&name).is_none() => {
            linux_sound(Sound::Default, server, theme_sound)
        }
        (Sound::Default, SoundServer::PlaysHints | SoundServer::PlaysDefault) => LinuxSound {
            hint: SoundHint::Default,
            play: None,
        },
        (Sound::Default, SoundServer::IgnoresSound) => {
            chatpane_plays(theme_sound(LINUX_DEFAULT_SOUND))
        }
        (Sound::Named(name), SoundServer::PlaysHints) => LinuxSound {
            hint: SoundHint::Name(name),
            play: None,
        },
        (Sound::Named(name), _) => chatpane_plays(theme_sound(&name)),
        (Sound::File(path), SoundServer::PlaysHints) => LinuxSound {
            hint: SoundHint::File(path),
            play: None,
        },
        (Sound::File(path), _) => chatpane_plays(Some(path)),
    }
}

/// Finds a sound-theme name's file in the user's sound theme. The theme is
/// read on first use, once.
#[cfg(target_os = "linux")]
pub(crate) fn theme_sounds(app: &tauri::AppHandle) -> impl Fn(&str) -> Option<PathBuf> + '_ {
    let (dirs, theme) = (data_dirs(), std::cell::OnceCell::new());
    move |name: &str| theme_sound_in(&dirs, theme.get_or_init(|| sound_theme(app)), name)
}

/// The sound theme GTK reports (XSETTINGS, GSettings or settings.ini). GTK
/// lives on the main thread; never call this from it.
#[cfg(target_os = "linux")]
fn sound_theme(app: &tauri::AppHandle) -> String {
    let (sender, receiver) = std::sync::mpsc::channel();
    let dispatched = app.run_on_main_thread(move || {
        use gtk::prelude::GtkSettingsExt;
        let theme = gtk::Settings::default()
            .and_then(|settings| settings.gtk_sound_theme_name())
            .map(String::from);
        let _ = sender.send(theme);
    });
    dispatched
        .ok()
        .and_then(|()| {
            receiver
                .recv_timeout(std::time::Duration::from_secs(1))
                .ok()
        })
        .flatten()
        .filter(|theme| plain_name(theme))
        .unwrap_or_else(|| "freedesktop".into())
}

/// `$XDG_DATA_HOME` and `$XDG_DATA_DIRS`, where sound themes live.
#[cfg(target_os = "linux")]
fn data_dirs() -> Vec<PathBuf> {
    let home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")));
    let system = std::env::var("XDG_DATA_DIRS")
        .ok()
        .filter(|dirs| !dirs.is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    home.into_iter()
        .chain(
            system
                .split(':')
                .map(PathBuf::from)
                .filter(|dir| dir.is_absolute()),
        )
        .collect()
}

/// A single path component, safe to join onto a folder.
#[cfg(any(target_os = "linux", test))]
fn plain_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\'])
}

/// A theme's sound folder: relative, and never climbing out of the theme.
#[cfg(any(target_os = "linux", test))]
fn theme_subdir(directory: &str) -> bool {
    use std::path::Component;
    !directory.is_empty()
        && Path::new(directory)
            .components()
            .all(|part| matches!(part, Component::Normal(_) | Component::CurDir))
}

/// Find a sound in a theme, the themes it inherits, and finally the
/// `freedesktop` fallback theme (the freedesktop sound theme spec).
#[cfg(any(target_os = "linux", test))]
fn theme_sound_in(data_dirs: &[PathBuf], theme: &str, name: &str) -> Option<PathBuf> {
    if !plain_name(name) {
        return None;
    }
    let mut seen = Vec::new();
    find_in_theme(data_dirs, theme, name, &mut seen)
        .or_else(|| find_in_theme(data_dirs, "freedesktop", name, &mut seen))
}

#[cfg(any(target_os = "linux", test))]
fn find_in_theme(
    data_dirs: &[PathBuf],
    theme: &str,
    name: &str,
    seen: &mut Vec<String>,
) -> Option<PathBuf> {
    // `seen` stops inheritance loops and keeps the fallback from searching twice.
    if !plain_name(theme) || seen.iter().any(|known| known == theme) || seen.len() >= 16 {
        return None;
    }
    seen.push(theme.into());
    let mut parents = Vec::new();
    for base in data_dirs {
        let root = base.join("sounds").join(theme);
        let index = std::fs::read_to_string(root.join("index.theme")).unwrap_or_default();
        let (directories, inherits) = parse_theme_index(&index);
        for directory in directories
            .iter()
            .filter(|directory| theme_subdir(directory))
        {
            for extension in ["oga", "ogg", "wav"] {
                let file = root.join(directory).join(format!("{name}.{extension}"));
                if file.is_file() {
                    return Some(file);
                }
            }
        }
        parents.extend(inherits);
    }
    parents
        .iter()
        .find_map(|parent| find_in_theme(data_dirs, parent, name, seen))
}

/// `Directories` and `Inherits` from a sound theme's `index.theme`. A theme
/// that names no folders keeps its sounds in `stereo`.
#[cfg(any(target_os = "linux", test))]
fn parse_theme_index(index: &str) -> (Vec<String>, Vec<String>) {
    let list = |value: &str| -> Vec<String> {
        value
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(String::from)
            .collect()
    };
    let (mut directories, mut inherits) = (Vec::new(), Vec::new());
    let mut in_header = false;
    for line in index.lines().map(str::trim) {
        if line.starts_with('[') {
            in_header = line == "[Sound Theme]";
        } else if in_header {
            if let Some(value) = line.strip_prefix("Directories=") {
                directories = list(value);
            } else if let Some(value) = line.strip_prefix("Inherits=") {
                inherits = list(value);
            }
        }
    }
    if directories.is_empty() {
        directories.push("stereo".into());
    }
    (directories, inherits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Settings;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "chatpane-sound-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn the_old_switch_migrates_to_default_or_off() {
        let on: Settings = serde_json::from_str(r#"{"notification_sound": true}"#).unwrap();
        assert_eq!(on.sanitized().sound_choice(), NotificationSound::Default);
        let off: Settings = serde_json::from_str(r#"{"notification_sound": false}"#).unwrap();
        let off = off.sanitized();
        assert_eq!(off.sound_choice(), NotificationSound::Off);
        assert!(!off.notification_sound);
        let fresh: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(fresh.sanitized().sound_choice(), NotificationSound::Default);
    }

    #[test]
    fn the_choice_round_trips_and_keeps_the_switch_in_step() {
        for choice in [
            NotificationSound::Off,
            NotificationSound::Default,
            NotificationSound::system("Glass"),
            NotificationSound::File("ding".into()),
        ] {
            let settings = Settings {
                notification_sound: true,
                notification_sound_choice: Some(choice.clone()),
                ..Settings::default()
            }
            .sanitized();
            // The page and older builds read only the switch.
            assert_eq!(
                settings.notification_sound,
                choice != NotificationSound::Off
            );
            let saved = serde_json::to_string(&settings).unwrap();
            let loaded: Settings = serde_json::from_str(&saved).unwrap();
            assert_eq!(loaded.sound_choice(), choice);
        }
    }

    #[test]
    fn an_unreadable_choice_falls_back_to_the_switch() {
        for choice in [r#""loud""#, "42", "null", r#"{"system":{"name":"Glass"}}"#] {
            let json = format!(
                r#"{{"notification_sound_choice":{choice},"notification_sound":false,"zoom":140}}"#
            );
            let loaded: Settings = serde_json::from_str(&json).unwrap();
            assert_eq!(loaded.notification_sound_choice, None);
            assert_eq!(loaded.sound_choice(), NotificationSound::Off);
            assert_eq!(loaded.zoom, 140);
        }
    }

    #[test]
    fn the_page_can_only_take_the_sound_away() {
        for choice in [
            NotificationSound::Off,
            NotificationSound::Default,
            NotificationSound::system("bell"),
            NotificationSound::File("ding".into()),
        ] {
            assert_eq!(message_sound(&choice, true), NotificationSound::Off);
            assert_eq!(message_sound(&choice, false), choice);
        }
    }

    #[test]
    fn sound_folders_list_by_name_and_skip_other_files() {
        let (user, system) = (temp_dir("user"), temp_dir("system"));
        touch(&user.join("Glass.aiff"), b"mine");
        touch(&user.join("notes.txt"), b"");
        touch(&user.join(".hidden.wav"), b"");
        touch(&system.join("Glass.aiff"), b"apple");
        touch(&system.join("basso.AIFF"), b"apple");
        std::fs::create_dir_all(system.join("folder.wav")).unwrap();
        let dirs = [user.clone(), system.clone()];
        let names: Vec<String> = sounds_in(&dirs, &["aiff", "wav"])
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(names, ["basso", "Glass"]);
        // The earlier folder's file wins the shared name.
        assert_eq!(
            find_sound(&dirs, &["aiff"], "Glass"),
            Some(user.join("Glass.aiff"))
        );
        assert_eq!(find_sound(&dirs, &["aiff"], "Missing"), None);
        std::fs::remove_dir_all(user).unwrap();
        std::fs::remove_dir_all(system).unwrap();
    }

    #[test]
    fn choose_file_copies_once_and_never_overwrites_another_sound() {
        let (dir, outside) = (temp_dir("added"), temp_dir("outside"));
        let source = outside.join("Ding.WAV");
        touch(&source, b"one");
        let listed = [dir.clone()];
        assert_eq!(
            import_sound(&dir, &listed, &source, &["wav"]).unwrap(),
            "Ding"
        );
        assert_eq!(std::fs::read(dir.join("Ding.wav")).unwrap(), b"one");
        // The same sound again reuses the copy.
        assert_eq!(
            import_sound(&dir, &listed, &source, &["wav"]).unwrap(),
            "Ding"
        );
        // A different sound with the same name gets its own.
        let other = outside.join("nested").join("Ding.wav");
        touch(&other, b"two");
        assert_eq!(
            import_sound(&dir, &listed, &other, &["wav"]).unwrap(),
            "Ding 2"
        );
        // A file already in a listed folder stays where it is.
        assert_eq!(
            import_sound(&dir, &listed, &dir.join("Ding.wav"), &["wav"]).unwrap(),
            "Ding"
        );
        assert!(import_sound(&dir, &listed, &outside.join("song.mp3"), &["wav"]).is_err());
        assert_eq!(sounds_in(&listed, &["wav"]).len(), 2);
        // A dangling link holding the name is skipped, not written through.
        #[cfg(unix)]
        {
            let target = outside.join("target.wav");
            std::os::unix::fs::symlink(&target, dir.join("Chime.wav")).unwrap();
            let chime = outside.join("Chime.wav");
            touch(&chime, b"three");
            assert_eq!(
                import_sound(&dir, &listed, &chime, &["wav"]).unwrap(),
                "Chime 2"
            );
            assert!(!target.exists());
        }
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn windows_toasts_only_name_known_sound_events() {
        assert_eq!(
            windows_toast_audio(&Sound::Default),
            Some("Notification.Default")
        );
        assert_eq!(
            windows_toast_audio(&Sound::Named("IM".into())),
            Some("Notification.IM")
        );
        assert_eq!(windows_toast_audio(&Sound::Named("\"/><x".into())), None);
        assert_eq!(windows_toast_audio(&Sound::Silent), None);
        assert_eq!(windows_toast_audio(&Sound::File("a.wav".into())), None);
    }

    #[test]
    fn sound_themes_inherit_and_fall_back_to_freedesktop() {
        let data = temp_dir("themes");
        let sounds = data.join("sounds");
        touch(
            &sounds.join("ocean/index.theme"),
            b"[Sound Theme]\nName=Ocean\nInherits=base\nDirectories=stereo,5.1\n\n[stereo]\nOutputProfile=stereo\n",
        );
        touch(&sounds.join("ocean/5.1/bell.oga"), b"");
        touch(
            &sounds.join("base/index.theme"),
            b"[Sound Theme]\nInherits=ocean\n",
        );
        touch(&sounds.join("base/stereo/complete.ogg"), b"");
        touch(&sounds.join("freedesktop/stereo/message.oga"), b"");
        let dirs = [PathBuf::from("/nonexistent"), data.clone()];
        let find = |name: &str| theme_sound_in(&dirs, "ocean", name);
        assert_eq!(find("bell"), Some(sounds.join("ocean/5.1/bell.oga")));
        assert_eq!(
            find("complete"),
            Some(sounds.join("base/stereo/complete.ogg"))
        );
        assert_eq!(
            find("message"),
            Some(sounds.join("freedesktop/stereo/message.oga"))
        );
        assert_eq!(find("window-attention"), None);
        assert_eq!(find("../ocean/5.1/bell"), None);
        assert_eq!(theme_sound_in(&dirs, "../sounds", "bell"), None);
        assert!(theme_subdir(".") && theme_subdir("stereo/alerts"));
        assert!(!theme_subdir("../base") && !theme_subdir("/usr") && !theme_subdir(""));
        let listed: Vec<String> = linux_system_sounds(|name| find(name).is_some())
            .into_iter()
            .map(|option| option.label)
            .collect();
        assert_eq!(listed, ["Message", "Bell", "Complete"]);
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn linux_sound_follows_what_the_server_plays() {
        let theme = |name: &str| {
            ["bell", LINUX_DEFAULT_SOUND]
                .contains(&name)
                .then(|| PathBuf::from(format!("/t/{name}.oga")))
        };
        let plays = |file: &str| LinuxSound {
            hint: SoundHint::Silent,
            play: Some(PathBuf::from(file)),
        };
        let bell = || Sound::Named("bell".into());
        let file = || Sound::File("/c/ding.wav".into());
        use SoundServer::*;
        for server in [PlaysHints, PlaysDefault, IgnoresSound] {
            assert_eq!(
                linux_sound(Sound::Silent, server, &theme),
                LinuxSound::SILENT
            );
        }
        assert_eq!(
            linux_sound(Sound::Default, PlaysHints, &theme).hint,
            SoundHint::Default
        );
        assert_eq!(
            linux_sound(Sound::Default, PlaysDefault, &theme).hint,
            SoundHint::Default
        );
        assert_eq!(
            linux_sound(Sound::Default, IgnoresSound, &theme),
            plays("/t/message-new-instant.oga")
        );
        assert_eq!(
            linux_sound(bell(), PlaysHints, &theme).hint,
            SoundHint::Name("bell".into())
        );
        assert_eq!(
            linux_sound(bell(), PlaysDefault, &theme),
            plays("/t/bell.oga")
        );
        assert_eq!(
            linux_sound(bell(), IgnoresSound, &theme),
            plays("/t/bell.oga")
        );
        // A name the theme lost plays the default.
        let gone = Sound::Named("complete".into());
        assert_eq!(
            linux_sound(gone.clone(), PlaysHints, &theme).hint,
            SoundHint::Default
        );
        assert_eq!(
            linux_sound(gone, IgnoresSound, &theme),
            plays("/t/message-new-instant.oga")
        );
        assert_eq!(
            linux_sound(file(), PlaysHints, &theme).hint,
            SoundHint::File("/c/ding.wav".into())
        );
        assert_eq!(
            linux_sound(file(), IgnoresSound, &theme),
            plays("/c/ding.wav")
        );
        assert_eq!(
            linux_sound(file(), PlaysDefault, &theme),
            plays("/c/ding.wav")
        );
    }
}
