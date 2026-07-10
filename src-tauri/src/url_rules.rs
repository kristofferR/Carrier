//! URL classification: which links stay inside the app, which tracking
//! redirects get unwrapped, and the percent-decoding helper shared with the
//! download filename logic.

use url::Url;

/// Facebook wraps external links in tracking redirects
/// (`l.facebook.com/l.php?u=…`, `lm.facebook.com/l.php?u=…`, `facebook.com/l.php`).
/// Return the real destination if `url` is such a redirect.
pub(crate) fn unwrap_tracking(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    let host = host.strip_prefix("www.").unwrap_or(host);
    let is_redirect = host == "l.facebook.com"
        || host == "lm.facebook.com"
        || (host == "facebook.com" && url.path() == "/l.php");
    if !is_redirect {
        return None;
    }
    url.query_pairs()
        .find(|(k, _)| k == "u")
        .map(|(_, v)| v.into_owned())
        // Only unwrap to a real web URL — never a javascript:/file:/data: target
        // smuggled through the `u=` parameter.
        .filter(|target| {
            Url::parse(target)
                .map(|u| matches!(u.scheme(), "http" | "https"))
                .unwrap_or(false)
        })
}

/// OAuth/login URLs that must stay *inside* the app, so Facebook's "continue
/// with Google/Apple/Microsoft" social logins work as an in-app popup instead of
/// bouncing to the browser. Restricted to the dedicated auth hosts (which serve
/// nothing but auth) — matching on OAuth *paths* across arbitrary hosts is both
/// unnecessary (Facebook doesn't offer those providers) and error-prone.
fn is_auth_url(url: &Url) -> bool {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    const AUTH_HOSTS: &[&str] = &["login.microsoftonline.com", "appleid.apple.com"];
    if AUTH_HOSTS
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")))
    {
        return true;
    }
    // Google federates "Sign in with Google" across many of its own domains in a
    // single flow: the sign-in/consent UI on accounts.google.com (and country
    // domains like accounts.google.no), plus a session-cookie sync
    // ("CheckConnection"/"SetSID"/"SetOSID") that bounces through
    // accounts.youtube.com, myaccount.google.com, … — always under an
    // `/accounts/` path. Keep these in-app so none spawn a default-browser
    // window, while ordinary Google/YouTube content still opens externally.
    is_google_owned_host(&host)
        && (host.starts_with("accounts.") || url.path().starts_with("/accounts/"))
}

/// Captcha frames Facebook embeds during login checkpoints. Facebook wraps
/// Google reCAPTCHA in an `fbsbx.com` iframe (already internal), which itself
/// frames `google.com/recaptcha/…` (or `recaptcha.net`, Google's alternative
/// captcha domain for networks where google.com is unreachable). wry feeds
/// *subframe* navigations through `on_navigation` too, so without this the
/// reCAPTCHA iframe is cancelled in-app and shunted to the default browser,
/// where the verification token can never reach the login page (Ref #78).
fn is_captcha_url(url: &Url) -> bool {
    let path = url.path();
    if !(path.starts_with("/recaptcha/") || path == "/recaptcha") {
        return false;
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    is_google_owned_host(&host) || host == "recaptcha.net" || host.ends_with(".recaptcha.net")
}

/// A host whose registrable domain is Google's: `youtube.com` or `google.<tld>`
/// for a plausible country/gTLD (each label 2–3 ASCII letters, e.g. `com`, `no`,
/// `co.uk`). The boundary + TLD checks reject lookalikes like
/// `accounts.google.evil.com`.
fn is_google_owned_host(host: &str) -> bool {
    if host == "youtube.com" || host.ends_with(".youtube.com") {
        return true;
    }
    let is_tld = |tld: &str| {
        !tld.is_empty()
            && tld.len() <= 6
            && tld
                .split('.')
                .all(|p| (2..=3).contains(&p.len()) && p.chars().all(|c| c.is_ascii_alphabetic()))
    };
    host.match_indices("google.").any(|(i, _)| {
        // Must start a label: at the host start or right after a dot.
        (i == 0 || host.as_bytes()[i - 1] == b'.') && is_tld(&host[i + "google.".len()..])
    })
}

/// Domains kept *inside* the app (Messenger plus the Facebook/Meta auth and
/// media surfaces needed to log in and load content).
pub(crate) fn is_internal(url: &Url) -> bool {
    if is_local_app_url(url) {
        return true;
    }
    match url.scheme() {
        "about" => return true,
        // Resolve a blob: URL to its inner origin and judge that.
        "blob" => {
            return url
                .as_str()
                .strip_prefix("blob:")
                .and_then(|inner| Url::parse(inner).ok())
                .is_some_and(|inner| is_internal(&inner));
        }
        // data: / javascript: (and anything else) are never "internal".
        "http" | "https" => {}
        _ => return false,
    }
    if is_auth_url(url) || is_captcha_url(url) {
        return true;
    }
    // Reject hostless HTTP(S) rather than treating it as internal.
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.strip_prefix("www.").unwrap_or(host);
    const INTERNAL_SUFFIXES: &[&str] = &[
        "facebook.com",
        "messenger.com",
        "fbcdn.net",
        "fbsbx.com",
        "meta.com",
        "oculus.com",
    ];
    INTERNAL_SUFFIXES
        .iter()
        .any(|s| host == *s || host.ends_with(&format!(".{s}")))
}

fn is_local_app_url(url: &Url) -> bool {
    matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    )
}

/// Minimal percent-decoder for filenames.
pub(crate) fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn internal_allows_messenger_blocks_dangerous() {
        assert!(is_internal(&u("https://www.facebook.com/messages")));
        assert!(is_internal(&u("https://web.facebook.com/x")));
        assert!(is_internal(&u("https://accounts.google.com/o/oauth2/auth")));
        assert!(is_internal(&u("about:blank")));
        assert!(is_internal(&u("tauri://localhost/")));
        assert!(is_internal(&u("http://tauri.localhost/")));
        assert!(!is_internal(&u("https://example.com/")));
        assert!(!is_internal(&u("tauri://example.com/")));
        assert!(!is_internal(&u("https://not-tauri.localhost/")));
        assert!(!is_internal(&u("foo://tauri.localhost/")));
        assert!(!is_internal(&u("ftp://tauri.localhost/")));
        assert!(!is_internal(&u("data:text/html,<script>1</script>")));
        assert!(!is_internal(&u("javascript:alert(1)")));
    }

    #[test]
    fn auth_is_dedicated_hosts_only() {
        assert!(is_auth_url(&u("https://accounts.google.com/anything")));
        assert!(is_auth_url(&u("https://appleid.apple.com/auth/authorize")));
        assert!(is_auth_url(&u(
            "https://login.microsoftonline.com/common/oauth2"
        )));
        assert!(is_auth_url(&u("https://accounts.google.com/o/oauth2/auth")));
        // Google SSO federates across YouTube, country-coded domains and other
        // Google products mid-flow — sign-in subdomains and /accounts/ cookie sync.
        assert!(is_auth_url(&u(
            "https://accounts.youtube.com/accounts/CheckConnection?pmpo=https%3A%2F%2Faccounts.google.com"
        )));
        assert!(is_auth_url(&u(
            "https://accounts.google.no/accounts/SetSID"
        )));
        assert!(is_auth_url(&u(
            "https://accounts.google.co.uk/ServiceLogin"
        )));
        assert!(is_auth_url(&u(
            "https://myaccount.google.com/accounts/SetOSID"
        )));
        // code hosts and arbitrary /oauth paths are external, not in-app auth
        assert!(!is_auth_url(&u("https://github.com/login/oauth/authorize")));
        assert!(!is_auth_url(&u("https://github.com/user/repo")));
        assert!(!is_auth_url(&u("https://example.com/oauth/authorize")));
        // Ordinary Google/YouTube content stays external: Google-owned but neither
        // an `accounts.` subdomain nor an `/accounts/` cookie-sync path.
        assert!(!is_auth_url(&u("https://www.youtube.com/watch?v=abc")));
        assert!(!is_auth_url(&u("https://www.google.com/search?q=x")));
        assert!(!is_auth_url(&u("https://mail.google.com/mail/u/0")));
        // Lookalike / invalid Google TLDs don't match.
        assert!(!is_auth_url(&u("https://accounts.google.evil.com/SetSID")));
        assert!(!is_auth_url(&u("https://accounts.google.example/SetSID")));
        assert!(!is_auth_url(&u("https://accounts.googleX.com/SetSID")));
    }

    #[test]
    fn captcha_frames_stay_in_app() {
        // The reCAPTCHA anchor/challenge iframes Facebook's login checkpoint
        // embeds (Ref #78) — anchor renders the checkbox, bframe the challenge.
        assert!(is_internal(&u(
            "https://www.google.com/recaptcha/api2/anchor?ar=1&k=sitekey&co=aHR0cHM"
        )));
        assert!(is_internal(&u(
            "https://www.google.com/recaptcha/api2/bframe?hl=en&v=abc&k=sitekey"
        )));
        assert!(is_internal(&u(
            "https://www.google.com/recaptcha/enterprise/anchor?ar=1&k=sitekey"
        )));
        assert!(is_internal(&u(
            "https://www.recaptcha.net/recaptcha/api2/anchor?k=sitekey"
        )));
        // The rest of Google / lookalikes stay external.
        assert!(!is_internal(&u(
            "https://www.google.com/search?q=recaptcha"
        )));
        assert!(!is_internal(&u(
            "https://www.google.evil.com/recaptcha/api2/anchor"
        )));
        assert!(!is_internal(&u("https://evil.com/recaptcha/api2/anchor")));
        assert!(!is_internal(&u(
            "https://notrecaptcha.net/recaptcha/api2/anchor"
        )));
    }

    #[test]
    fn tracking_redirect_is_unwrapped() {
        let url = u("https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Fa&h=AT0");
        assert_eq!(
            unwrap_tracking(&url).as_deref(),
            Some("https://example.com/a")
        );
        assert_eq!(
            unwrap_tracking(&u("https://www.facebook.com/messages")),
            None
        );
        // A tracking redirect whose `u=` target is a non-HTTP(S) scheme must not
        // be unwrapped (defense-in-depth against javascript:/file:/data:).
        assert_eq!(
            unwrap_tracking(&u(
                "https://l.facebook.com/l.php?u=javascript%3Aalert%281%29&h=AT0"
            )),
            None
        );
        assert_eq!(
            unwrap_tracking(&u(
                "https://l.facebook.com/l.php?u=file%3A%2F%2F%2Fetc%2Fpasswd"
            )),
            None
        );
    }

    // -----------------------------------------------------------------------
    // percent_decode  (used by filename_from_url; boundary cases)
    // -----------------------------------------------------------------------

    #[test]
    fn percent_decode_handles_encoded_chars() {
        assert_eq!(percent_decode("hello%20world"), "hello world");
        assert_eq!(percent_decode("photo%2Fname.jpg"), "photo/name.jpg");
        assert_eq!(percent_decode("%2F%00"), "/\0");
    }

    #[test]
    fn percent_decode_leaves_plain_text_unchanged() {
        assert_eq!(percent_decode("photo.png"), "photo.png");
        assert_eq!(percent_decode(""), "");
    }

    #[test]
    fn percent_decode_incomplete_sequence_is_kept_literally() {
        // A trailing lone '%' or short sequence must not panic.
        assert_eq!(percent_decode("abc%"), "abc%");
        assert_eq!(percent_decode("abc%2"), "abc%2");
    }
}
