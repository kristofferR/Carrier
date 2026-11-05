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

/// WebKit release families (`<major>.<minor>` after the OS prefix of
/// `CFBundleVersion`) and the Safari release each shipped as, oldest first.
/// Starts at Safari 16, the oldest Messenger accepts for calls.
const SAFARI_RELEASES: &[((u32, u32), &str)] = &[
    ((614, 1), "16.0"),
    ((614, 2), "16.1"),
    ((614, 3), "16.2"),
    ((614, 4), "16.3"),
    ((615, 1), "16.4"),
    ((615, 2), "16.5"),
    ((615, 3), "16.6"),
    ((616, 1), "17.0"),
    ((616, 2), "17.1"),
    ((617, 1), "17.2"),
    ((617, 2), "17.3"),
    ((618, 1), "17.4"),
    ((618, 2), "17.5"),
    ((618, 3), "17.6"),
    ((619, 1), "18.0"),
    ((619, 2), "18.1"),
    ((620, 1), "18.2"),
    ((620, 2), "18.3"),
    ((621, 1), "18.4"),
    ((621, 2), "18.5"),
    ((621, 3), "18.6"),
    ((622, 1), "26.0"),
    ((622, 2), "26.1"),
    ((623, 1), "26.2"),
    ((623, 2), "26.3"),
    ((624, 1), "26.4"),
    ((624, 2), "26.5"),
    ((624, 4), "26.6"),
    ((625, 1), "27.0"),
    ((625, 2), "27.2"),
];

/// The WebKit that provides `WKWebView` in this process, and the system Safari.
struct WebKitBuilds {
    /// The engine's `CFBundleVersion`, e.g. `20621.3.11.11.3`.
    engine: String,
    /// Safari's `CFBundleVersion` and `CFBundleShortVersionString`.
    safari: Option<(String, String)>,
}

/// The Messenger user agent for this machine, resolved once. `None` leaves
/// the builder's user agent unset, not an empty UA string.
pub(crate) fn messenger_user_agent() -> Option<&'static str> {
    static USER_AGENT: OnceLock<Option<String>> = OnceLock::new();
    USER_AGENT
        .get_or_init(|| {
            let builds = webkit_builds();
            let version = builds.as_ref().and_then(engine_safari_version);
            let user_agent = override_for(std::env::consts::OS, version);
            if std::env::consts::OS == "macos" {
                let engine = builds.as_ref().map_or("unreadable", |b| &b.engine);
                let safari = builds
                    .as_ref()
                    .and_then(|b| b.safari.as_ref())
                    .map_or("unreadable", |(build, _)| build);
                match user_agent.as_ref().and(version) {
                    Some(version) => log::info!(
                        "Messenger identifies as Safari {version} (WebKit {engine}, system Safari {safari})"
                    ),
                    None => log::warn!(
                        "no Safari release matches WebKit {engine}; keeping WKWebView's native user agent"
                    ),
                }
            }
            user_agent
        })
        .as_deref()
}

/// macOS identifies as the Safari release of the WebKit it runs, so the
/// version describes this engine's actual capabilities. Everything else,
/// including an engine with no known Safari release, keeps its native identity.
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

/// Safari's own version when it runs this process's WebKit build. On older
/// macOS a newer Safari brings a staged WebKit only Safari can load, and apps
/// keep the system one: on macOS 15.7 with Safari 27.2, WKWebView runs WebKit
/// 621.3 (Safari 18.6). The version then comes from the engine's own build.
fn engine_safari_version(builds: &WebKitBuilds) -> Option<&str> {
    match &builds.safari {
        Some((build, version)) if *build == builds.engine => Some(version),
        _ => safari_release(&builds.engine),
    }
}

/// The newest Safari release at or below this engine build, so a build
/// between or past the table's entries never claims a newer Safari.
fn safari_release(engine_build: &str) -> Option<&'static str> {
    let mut parts = engine_build.split('.');
    // The first part is an OS prefix followed by a three-digit major.
    let major = parts.next()?.parse::<u32>().ok()? % 1000;
    let minor = parts.next()?.parse::<u32>().ok()?;
    SAFARI_RELEASES
        .iter()
        .rev()
        .find(|(family, _)| *family <= (major, minor))
        .map(|(_, version)| *version)
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
/// another volume.
#[cfg(target_os = "macos")]
fn webkit_builds() -> Option<WebKitBuilds> {
    use objc2::runtime::AnyClass;
    use objc2_foundation::{NSBundle, NSString, ns_string};

    let string = |bundle: &NSBundle, key: &NSString| {
        Some(
            bundle
                .objectForInfoDictionaryKey(key)?
                .downcast::<NSString>()
                .ok()?
                .to_string(),
        )
    };
    let build = ns_string!("CFBundleVersion");
    let web_view = AnyClass::get(c"WKWebView")?;
    // SAFETY: `WKWebView` is a registered Objective-C class.
    let webkit = unsafe { NSBundle::bundleForClass(web_view) };
    let safari =
        NSBundle::bundleWithPath(ns_string!("/Applications/Safari.app")).and_then(|safari| {
            Some((
                string(&safari, build)?,
                string(&safari, ns_string!("CFBundleShortVersionString"))?,
            ))
        });
    Some(WebKitBuilds {
        engine: string(&webkit, build)?,
        safari,
    })
}

#[cfg(not(target_os = "macos"))]
fn webkit_builds() -> Option<WebKitBuilds> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn builds(engine: &str, safari: Option<(&str, &str)>) -> WebKitBuilds {
        WebKitBuilds {
            engine: engine.into(),
            safari: safari.map(|(build, version)| (build.into(), version.into())),
        }
    }

    #[test]
    fn macos_identifies_as_safari() {
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
    fn macos_without_a_plain_version_keeps_its_native_identity() {
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

    #[test]
    fn safari_sharing_the_engine_gives_its_own_version() {
        let current = builds("22625.2.8.11.9", Some(("22625.2.8.11.9", "27.2")));
        assert_eq!(engine_safari_version(&current), Some("27.2"));
    }

    #[test]
    fn a_staged_safari_gives_the_engine_release_instead() {
        // macOS 15.7 with Safari 27.2: Safari runs its own staged WebKit.
        let staged = builds("20621.3.11.11.3", Some(("20625.2.8.18.4", "27.2")));
        assert_eq!(engine_safari_version(&staged), Some("18.6"));
        assert_eq!(
            engine_safari_version(&builds("19618.3.11.11.5", None)),
            Some("17.6")
        );
    }

    #[test]
    fn unlisted_engines_take_the_newest_release_not_above_them() {
        assert_eq!(safari_release("20624.3.1.1.1"), Some("26.5"));
        assert_eq!(safari_release("22630.1.2"), Some("27.2"));
        assert_eq!(safari_release("614.1.25"), Some("16.0"));
    }

    #[test]
    fn engines_older_than_safari_16_or_unreadable_have_no_release() {
        for build in ["17613.3.9.1.5", "", "20621", "abc.1", "20621.x.1"] {
            assert_eq!(safari_release(build), None, "{build:?}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reads_the_system_webkit() {
        let builds = webkit_builds().expect("WebKit is loaded");
        let version = engine_safari_version(&builds).expect("a known Safari release");
        assert!(is_plain_version(version), "{version}");
    }
}
