//! Messenger user-agent policy. Prefer the engine's native, runtime-maintained
//! identity: WebView2 on Windows and WebKitGTK on Linux. macOS is the one
//! exception: WKWebView's native UA names no browser, so Messenger's calling
//! stack treats it as unsupported (Ref #335).
//! See docs/user-agent-policy.md for compatibility evidence and verification.

use std::sync::OnceLock;

/// WebKit's frozen macOS identity. WKWebView reports exactly this, and Safari
/// appends `Version/<Safari version> Safari/605.1.15`.
const MACOS_WEBKIT_IDENTITY: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

/// The Messenger user agent for this machine, resolved once. `None` leaves
/// the builder's user agent unset, not an empty UA string.
pub(crate) fn messenger_user_agent() -> Option<&'static str> {
    static USER_AGENT: OnceLock<Option<String>> = OnceLock::new();
    USER_AGENT
        .get_or_init(|| {
            let safari_version = installed_safari_version();
            let user_agent = override_for(std::env::consts::OS, safari_version.as_deref());
            if std::env::consts::OS == "macos" {
                match &user_agent {
                    Some(_) => log::info!(
                        "Messenger identifies as Safari {}",
                        safari_version.as_deref().unwrap_or_default()
                    ),
                    None => log::warn!(
                        "system Safari version unavailable; keeping WKWebView's native user agent"
                    ),
                }
            }
            user_agent
        })
        .as_deref()
}

/// macOS identifies as the system Safari, whose version is read from the
/// installed app rather than guessed: Safari and WKWebView share the system
/// WebKit, so the version describes this engine's actual capabilities.
/// Everything else, including an unreadable Safari, keeps its native identity.
/// A failed load is not evidence of a UA mismatch and must not trigger browser
/// spoofing/reloads.
fn override_for(platform: &str, safari_version: Option<&str>) -> Option<String> {
    match platform {
        "macos" => safari_version
            .filter(|version| is_plain_version(version))
            .map(|version| format!("{MACOS_WEBKIT_IDENTITY} Version/{version} Safari/605.1.15")),
        _ => None,
    }
}

/// `27`, `27.2` or `27.2.1`: dotted numbers only, so a malformed plist value
/// can never inject other tokens into the user agent.
fn is_plain_version(version: &str) -> bool {
    let parts: Vec<_> = version.split('.').collect();
    (1..=3).contains(&parts.len())
        && parts
            .iter()
            .all(|part| (1..=4).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit()))
}

/// `/Applications/Safari.app` is the system Safari (a link into the system
/// cryptex on macOS 13+). A LaunchServices lookup could instead pick a copy on
/// another volume that doesn't match this system's WebKit.
#[cfg(target_os = "macos")]
fn installed_safari_version() -> Option<String> {
    use objc2_foundation::{NSBundle, NSString, ns_string};

    let bundle = NSBundle::bundleWithPath(ns_string!("/Applications/Safari.app"))?;
    let version = bundle.objectForInfoDictionaryKey(ns_string!("CFBundleShortVersionString"))?;
    Some(version.downcast::<NSString>().ok()?.to_string())
}

#[cfg(not(target_os = "macos"))]
fn installed_safari_version() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_identifies_as_the_installed_safari() {
        assert_eq!(
            override_for("macos", Some("27.2")).as_deref(),
            Some(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
                 (KHTML, like Gecko) Version/27.2 Safari/605.1.15"
            )
        );
        assert!(
            override_for("macos", Some("18.6.2"))
                .is_some_and(|ua| ua.ends_with(" Version/18.6.2 Safari/605.1.15"))
        );
    }

    #[test]
    fn macos_without_a_readable_safari_keeps_its_native_identity() {
        for version in [
            None,
            Some(""),
            Some("27.x"),
            Some("27.2 Chrome/140"),
            Some("1.2.3.4"),
        ] {
            assert_eq!(override_for("macos", version), None, "{version:?}");
        }
    }

    #[test]
    fn other_platforms_keep_their_native_identity() {
        for platform in ["windows", "linux", "", "unknown", "freebsd"] {
            assert_eq!(override_for(platform, Some("27.2")), None, "{platform}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reads_the_system_safari_version() {
        let version = installed_safari_version().expect("system Safari is installed");
        assert!(is_plain_version(&version), "{version}");
    }
}
