//! Messenger user-agent policy. Prefer the engine's native, runtime-maintained
//! identity: WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux.
//! See docs/user-agent-policy.md for compatibility evidence and verification.

// No verified compatibility exceptions. Add one only with observed Messenger
// behavior and evidence that the value matches the platform's supported engine
// capabilities. Never substitute Chrome for WebKit or guess a Safari version.
const COMPATIBILITY_OVERRIDES: &[(&str, &str)] = &[];

/// `None` means leave the builder's user agent unset, not an empty UA string.
/// Unrecognized platforms also retain their native identity. A failed load is
/// not evidence of a UA mismatch and must not trigger browser spoofing/reloads.
pub(crate) fn override_for(platform: &str) -> Option<&'static str> {
    COMPATIBILITY_OVERRIDES
        .iter()
        .find_map(|(target, user_agent)| (*target == platform).then_some(*user_agent))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_webviews_keep_their_native_identity() {
        for platform in ["macos", "windows", "linux"] {
            assert_eq!(override_for(platform), None, "{platform}");
        }
    }

    #[test]
    fn unknown_platforms_fall_back_to_native() {
        for platform in ["", "unknown", "freebsd"] {
            assert_eq!(override_for(platform), None, "{platform}");
        }
    }
}
