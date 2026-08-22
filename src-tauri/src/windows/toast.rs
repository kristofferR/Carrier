//! Windows toast notifications built directly on WinRT.
//!
//! notify-rust's Windows backend (tauri-winrt-notification) can show buttons but
//! not text input, toast `tag`/`group`, or Action Center history removal —
//! everything grouping, clear-on-read, and inline reply need. This module drives
//! `Windows.UI.Notifications` itself:
//!
//! - build toast XML → `CreateToastNotifier(aumid)` → attach `Activated` /
//!   `Dismissed` / `Failed` handlers capturing the [`tauri::AppHandle`] → `Show`;
//! - keep each `ToastNotification` in a capped map keyed by its hex id so an
//!   Action Center click *after* the banner times out still fires (notify-rust
//!   dropped those);
//! - group per conversation with `SetTag(hex id)` + `SetGroup(thread digits)` and
//!   clear a whole conversation with `ToastNotificationHistory.RemoveGroupWithId`.
//!
//! The pure helpers (XML building/escaping, activation-arg parsing, id/group
//! derivation, keep-alive eviction) are unit-tested on any OS; the WinRT glue is
//! `cfg(target_os = "windows")`.

#[cfg(target_os = "windows")]
use std::collections::VecDeque;
#[cfg(target_os = "windows")]
use std::sync::Mutex;

#[cfg(target_os = "windows")]
use ::windows::core::{Interface, Ref, Result as WinResult, HSTRING};
#[cfg(target_os = "windows")]
use ::windows::Data::Xml::Dom::XmlDocument;
#[cfg(target_os = "windows")]
use ::windows::Foundation::TypedEventHandler;
#[cfg(target_os = "windows")]
use ::windows::UI::Notifications::{
    NotificationSetting, ToastActivatedEventArgs, ToastDismissedEventArgs, ToastFailedEventArgs,
    ToastNotification, ToastNotificationManager, ToastNotifier,
};

/// The page-controlled parts of a toast, already reduced to what the XML needs.
/// `hex_id` is the 16-hex-char toast tag (also embedded in the launch args), so
/// it is safe to interpolate without escaping; the free-text fields are not.
pub(crate) struct ToastSpec {
    pub title: String,
    pub body: String,
    /// Absolute path to the sender-avatar PNG, if one was attached.
    pub avatar: Option<String>,
    pub hex_id: String,
    pub sound: bool,
    /// Eligible message toasts gain a reply input plus Reply/Open actions.
    pub reply_eligible: bool,
    /// Sync alerts never get actions or grouping.
    pub is_sync_alert: bool,
}

/// The 16-hex-char toast id. Staying ≤16 chars keeps `tag`/`group` valid even on
/// pre-1903 Windows, and hex avoids any character the launch query string or XML
/// would need escaped.
pub(crate) fn hex_id(id: u64) -> String {
    format!("{id:016x}")
}

/// The digits of a validated `/t/<id>/` thread path — the Action Center group id
/// for clear-on-read. `None` for anything that is not that canonical shape.
pub(crate) fn thread_digits(thread_path: &str) -> Option<String> {
    let digits = thread_path.strip_prefix("/t/")?.strip_suffix('/')?;
    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then(|| digits.to_string())
}

/// XML-escape a page-controlled string. Load-bearing: the title/body/avatar path
/// all originate from the remote Messenger page.
fn escape_xml(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for character in input.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(character),
        }
    }
    out
}

/// Build the toast XML. `appLogoOverride` with `hint-crop="circle"` shows the
/// avatar as a round badge; the audio element is explicit either way (Windows is
/// silent unless a sound is named). Reply actions are added only for an eligible
/// message toast (never a redacted or sync one) so a redacted banner can never
/// carry a blind reply field.
pub(crate) fn build_toast_xml(spec: &ToastSpec) -> String {
    let mut xml = format!(
        "<toast launch=\"action=open&amp;id={}\" activationType=\"foreground\"><visual><binding template=\"ToastGeneric\"><text>{}</text>",
        spec.hex_id,
        escape_xml(&spec.title),
    );
    if !spec.body.is_empty() {
        xml.push_str(&format!("<text>{}</text>", escape_xml(&spec.body)));
    }
    if let Some(avatar) = &spec.avatar {
        xml.push_str(&format!(
            "<image placement=\"appLogoOverride\" hint-crop=\"circle\" src=\"{}\"/>",
            escape_xml(avatar),
        ));
    }
    xml.push_str("</binding></visual>");

    if spec.reply_eligible && !spec.is_sync_alert {
        xml.push_str(
            "<actions><input id=\"reply\" type=\"text\" placeHolderContent=\"Message…\"/>",
        );
        xml.push_str(&format!(
            "<action content=\"Reply\" arguments=\"action=reply&amp;id={id}\" hint-inputId=\"reply\" activationType=\"background\"/><action content=\"Open\" arguments=\"action=open&amp;id={id}\" activationType=\"foreground\"/>",
            id = spec.hex_id,
        ));
        xml.push_str("</actions>");
    }

    if spec.sound {
        xml.push_str("<audio src=\"ms-winsoundevent:Notification.Default\"/>");
    } else {
        xml.push_str("<audio silent=\"true\"/>");
    }
    xml.push_str("</toast>");
    xml
}

/// What a toast activation asked for. The numeric id is captured in the handler
/// closure, so only the verb needs parsing back out of the launch args.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ToastActivation {
    Open,
    Reply,
}

/// Parse the `action=<verb>&id=<hex>` launch/argument string WinRT hands the
/// activation handler. Unknown verbs return `None` (treated as a plain open).
pub(crate) fn parse_activation_args(args: &str) -> Option<ToastActivation> {
    let action = args
        .split('&')
        .find_map(|pair| pair.strip_prefix("action="))?;
    match action {
        "open" => Some(ToastActivation::Open),
        "reply" => Some(ToastActivation::Reply),
        _ => None,
    }
}

/// Everything [`deliver_notification_windows`] needs. Owned so the WinRT handlers
/// (which outlive the call) can capture what they need.
#[cfg(target_os = "windows")]
pub(crate) struct WindowsToastOptions {
    pub app_id: String,
    pub title: String,
    pub body: String,
    pub avatar: Option<String>,
    pub sound: bool,
    pub native_id: u64,
    /// The page's own notification handle, echoed back on a route-less click.
    pub page_id: Option<u64>,
    /// Validated `/t/<id>/` route, when known.
    pub thread_path: Option<String>,
    pub reply_eligible: bool,
    pub is_sync_alert: bool,
}

// -- keep-alive map: hold each shown ToastNotification so its captured handlers
// stay live for Action Center clicks after the banner times out. Capped so a
// long session cannot grow it without bound.

#[cfg(target_os = "windows")]
struct KeepAlive {
    hex: String,
    group: Option<String>,
    // Held only to keep the notification (and its event handlers) alive.
    _toast: ToastNotification,
}

#[cfg(target_os = "windows")]
static KEEP_ALIVE: Mutex<VecDeque<KeepAlive>> = Mutex::new(VecDeque::new());
#[cfg(target_os = "windows")]
const KEEP_ALIVE_CAP: usize = 256;

#[cfg(target_os = "windows")]
fn remember_keep_alive(hex: String, group: Option<String>, toast: ToastNotification) {
    let mut map = KEEP_ALIVE.lock().unwrap();
    map.retain(|entry| entry.hex != hex);
    map.push_back(KeepAlive {
        hex,
        group,
        _toast: toast,
    });
    while map.len() > KEEP_ALIVE_CAP {
        map.pop_front();
    }
}

#[cfg(target_os = "windows")]
fn forget_keep_alive(hex: &str) {
    KEEP_ALIVE.lock().unwrap().retain(|entry| entry.hex != hex);
}

#[cfg(target_os = "windows")]
fn forget_keep_alive_group(group: &str) {
    KEEP_ALIVE
        .lock()
        .unwrap()
        .retain(|entry| entry.group.as_deref() != Some(group));
}

/// Whether the OS supports toast `tag`/`group`. They silently break toasts on
/// pre-1903 (build 18362) Windows when over 16 chars — and a thread group id can
/// exceed that — so gate the whole tag/group step on the build number.
#[cfg(target_os = "windows")]
fn supports_tag_group() -> bool {
    windows_build_number().is_none_or(|build| build >= 18362)
}

/// Read `HKLM\...\CurrentVersion\CurrentBuildNumber` (a REG_SZ). `None` on any
/// error, which [`supports_tag_group`] treats as "assume modern".
#[cfg(target_os = "windows")]
fn windows_build_number() -> Option<u32> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    let subkey: Vec<u16> = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let value: Vec<u16> = "CurrentBuildNumber"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut buffer = [0u16; 32];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    // SAFETY: RRF_RT_REG_SZ restricts the value type; RegGetValueW writes at most
    // `size` bytes into `buffer` and updates `size` with the byte count written.
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != 0 {
        return None;
    }
    let chars = (size as usize / 2).saturating_sub(1); // drop the trailing NUL
    String::from_utf16_lossy(&buffer[..chars.min(buffer.len())])
        .trim()
        .parse()
        .ok()
}

/// Show a Windows toast for a message or sync alert. Best-effort: a WinRT failure
/// is logged, not surfaced.
#[cfg(target_os = "windows")]
pub(crate) fn deliver_notification_windows(app: &tauri::AppHandle, opts: WindowsToastOptions) {
    if let Err(error) = show_toast(app, &opts) {
        log::warn!(
            "failed to present a Windows toast (id {}): {error}",
            opts.native_id
        );
    }
}

#[cfg(target_os = "windows")]
fn show_toast(app: &tauri::AppHandle, opts: &WindowsToastOptions) -> WinResult<()> {
    let hex = hex_id(opts.native_id);
    let group = opts.thread_path.as_deref().and_then(thread_digits);
    let spec = ToastSpec {
        title: opts.title.clone(),
        body: opts.body.clone(),
        avatar: opts.avatar.clone(),
        hex_id: hex.clone(),
        sound: opts.sound,
        reply_eligible: opts.reply_eligible,
        is_sync_alert: opts.is_sync_alert,
    };

    let document = XmlDocument::new()?;
    document.LoadXml(&HSTRING::from(build_toast_xml(&spec)))?;
    let toast = ToastNotification::CreateToastNotification(&document)?;

    // Sync alerts are plain — no tag/group so they never join a conversation.
    if !opts.is_sync_alert && supports_tag_group() {
        toast.SetTag(&HSTRING::from(&hex))?;
        if let Some(group) = &group {
            toast.SetGroup(&HSTRING::from(group))?;
        }
    }

    let activated_app = app.clone();
    let native_id = opts.native_id;
    let page_id = opts.page_id;
    let route = opts.thread_path.clone();
    let hex_activated = hex.clone();
    toast.Activated(&TypedEventHandler::new(
        move |_sender: Ref<'_, ToastNotification>, args: Ref<'_, ::windows::core::IInspectable>| {
            handle_activation(
                &activated_app,
                native_id,
                page_id,
                &route,
                &hex_activated,
                args,
            );
            Ok(())
        },
    ))?;

    let hex_dismissed = hex.clone();
    toast.Dismissed(&TypedEventHandler::new(
        move |_sender: Ref<'_, ToastNotification>, _args: Ref<'_, ToastDismissedEventArgs>| {
            forget_keep_alive(&hex_dismissed);
            Ok(())
        },
    ))?;
    let hex_failed = hex.clone();
    toast.Failed(&TypedEventHandler::new(
        move |_sender: Ref<'_, ToastNotification>, _args: Ref<'_, ToastFailedEventArgs>| {
            forget_keep_alive(&hex_failed);
            Ok(())
        },
    ))?;

    let notifier =
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(&opts.app_id))?;
    log_notifications_disabled_once(&notifier);
    notifier.Show(&toast)?;
    remember_keep_alive(hex, group, toast);
    Ok(())
}

#[cfg(target_os = "windows")]
fn handle_activation(
    app: &tauri::AppHandle,
    native_id: u64,
    page_id: Option<u64>,
    route: &Option<String>,
    hex: &str,
    args: Ref<'_, ::windows::core::IInspectable>,
) {
    let activation = args
        .ok()
        .ok()
        .and_then(|inspectable| inspectable.cast::<ToastActivatedEventArgs>().ok());
    let verb = activation
        .as_ref()
        .and_then(|activation| activation.Arguments().ok())
        .and_then(|arguments| parse_activation_args(&arguments.to_string()));

    if verb == Some(ToastActivation::Reply) {
        let text = activation
            .as_ref()
            .and_then(reply_text_from_activation)
            .unwrap_or_default();
        // The shared reply machinery evals into the hidden window, waits for the
        // ack, and on success clears the conversation's toast group.
        crate::notifications::on_notification_reply(
            app.clone(),
            native_id,
            page_id,
            route.clone(),
            text,
        );
        return;
    }

    // Open (or an unrecognized verb): drop the keep-alive entry and route the
    // click through the shared handler.
    forget_keep_alive(hex);
    crate::notifications::on_notification_click_with_path(
        app.clone(),
        native_id,
        page_id,
        route.clone(),
    );
}

#[cfg(target_os = "windows")]
fn reply_text_from_activation(activation: &ToastActivatedEventArgs) -> Option<String> {
    use ::windows::Foundation::IPropertyValue;
    let value = activation
        .UserInput()
        .ok()?
        .Lookup(&HSTRING::from("reply"))
        .ok()?;
    let property = value.cast::<IPropertyValue>().ok()?;
    Some(property.GetString().ok()?.to_string())
}

#[cfg(target_os = "windows")]
fn log_notifications_disabled_once(notifier: &ToastNotifier) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static LOGGED: AtomicBool = AtomicBool::new(false);
    if let Ok(setting) = notifier.Setting() {
        if setting != NotificationSetting::Enabled && !LOGGED.swap(true, Ordering::Relaxed) {
            log::warn!("Windows notifications appear disabled for Carrier (setting {setting:?})");
        }
    }
}

/// Clear every toast in a conversation's Action Center group. Called on
/// clear-on-read and after a successful inline reply. The removal is OS-side, so
/// it also clears toasts left from a previous run.
#[cfg(target_os = "windows")]
pub(crate) fn clear_thread_group(app_id: &str, thread_id: &str) {
    match ToastNotificationManager::History() {
        Ok(history) => {
            if let Err(error) =
                history.RemoveGroupWithId(&HSTRING::from(thread_id), &HSTRING::from(app_id))
            {
                log::warn!("failed to clear a toast group: {error}");
            }
        }
        Err(error) => log::warn!("failed to reach toast history: {error}"),
    }
    forget_keep_alive_group(thread_id);
}

/// Register the AppUserModelID in `HKCU\Software\Classes\AppUserModelId\<aumid>`
/// with a display name. NSIS installs already stamp the AUMID onto their
/// shortcut, but the portable zip has no shortcut — without this its toasts show
/// no app name. Idempotent, per-user, no admin.
#[cfg(target_os = "windows")]
pub(crate) fn init(app: &tauri::AppHandle) {
    let app_id = app.config().identifier.clone();
    if let Err(error) = register_aumid(&app_id, "Carrier") {
        log::warn!("failed to register the toast AppUserModelID: {error}");
    }
}

#[cfg(target_os = "windows")]
fn register_aumid(aumid: &str, display_name: &str) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };
    let subkey: Vec<u16> = format!("Software\\Classes\\AppUserModelId\\{aumid}")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut key: HKEY = std::ptr::null_mut();
    // SAFETY: standard RegCreateKeyExW call; `key` receives an owned handle we
    // close below on every path.
    let status = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            std::ptr::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            std::ptr::null(),
            &mut key,
            std::ptr::null_mut(),
        )
    };
    if status != 0 {
        return Err(format!("RegCreateKeyExW failed ({status})"));
    }
    let name: Vec<u16> = "DisplayName"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let data: Vec<u16> = display_name
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `data` is a NUL-terminated UTF-16 buffer; the byte length includes
    // the terminator, as REG_SZ expects.
    let set = unsafe {
        RegSetValueExW(
            key,
            name.as_ptr(),
            0,
            REG_SZ,
            data.as_ptr().cast(),
            (data.len() * 2) as u32,
        )
    };
    unsafe { RegCloseKey(key) };
    if set != 0 {
        return Err(format!("RegSetValueExW failed ({set})"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(reply_eligible: bool, is_sync_alert: bool) -> ToastSpec {
        ToastSpec {
            title: "Jane".into(),
            body: "hi".into(),
            avatar: None,
            hex_id: hex_id(0x2a),
            sound: true,
            reply_eligible,
            is_sync_alert,
        }
    }

    #[test]
    fn hex_id_is_sixteen_lowercase_hex_chars() {
        assert_eq!(hex_id(0x2a), "000000000000002a");
        assert_eq!(hex_id(u64::MAX).len(), 16);
    }

    #[test]
    fn thread_digits_only_accepts_canonical_paths() {
        assert_eq!(thread_digits("/t/123/").as_deref(), Some("123"));
        assert_eq!(thread_digits("/t/123"), None);
        assert_eq!(thread_digits("/t//"), None);
        assert_eq!(thread_digits("/t/12a/"), None);
    }

    #[test]
    fn xml_escapes_page_controlled_text() {
        let mut s = spec(false, false);
        s.title = "A & B <c> \"d\" 'e'".into();
        s.body = String::new();
        let xml = build_toast_xml(&s);
        assert!(xml.contains("A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos;"));
        // An empty body emits no second <text>.
        assert_eq!(xml.matches("<text>").count(), 1);
    }

    #[test]
    fn eligible_message_gets_reply_and_open_actions() {
        let xml = build_toast_xml(&spec(true, false));
        assert!(xml.contains("<input id=\"reply\" type=\"text\""));
        assert!(xml.contains("action=reply&amp;id=000000000000002a"));
        assert!(xml.contains("hint-inputId=\"reply\" activationType=\"background\""));
        assert!(xml.contains("content=\"Open\""));
    }

    #[test]
    fn ineligible_and_sync_toasts_have_no_actions() {
        assert!(!build_toast_xml(&spec(false, false)).contains("<actions>"));
        // reply_eligible is ignored for a sync alert.
        assert!(!build_toast_xml(&spec(true, true)).contains("<actions>"));
    }

    #[test]
    fn audio_element_reflects_the_sound_setting() {
        let mut loud = spec(false, false);
        loud.sound = true;
        assert!(build_toast_xml(&loud).contains("ms-winsoundevent:Notification.Default"));
        let mut quiet = spec(false, false);
        quiet.sound = false;
        assert!(build_toast_xml(&quiet).contains("<audio silent=\"true\"/>"));
    }

    #[test]
    fn activation_args_parse_open_reply_and_reject_junk() {
        assert_eq!(
            parse_activation_args("action=open&id=abc"),
            Some(ToastActivation::Open)
        );
        assert_eq!(
            parse_activation_args("action=reply&id=abc"),
            Some(ToastActivation::Reply)
        );
        assert_eq!(parse_activation_args("action=frob&id=abc"), None);
        assert_eq!(parse_activation_args("id=abc"), None);
    }
}
