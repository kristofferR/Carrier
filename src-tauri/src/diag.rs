//! Page diagnostics: the `carrier:diag` payload from the injected script,
//! its sanitisation, and the per-session/log-size caps.

use serde::Deserialize;

/// A diagnostic report from the injected page script (`carrier:diag`): which
/// feature broke and a short description. The page only ever sends Carrier's
/// own strings (selector names, failure kinds) — never page content.
#[derive(Deserialize)]
pub(crate) struct DiagMsg {
    pub(crate) key: String,
    pub(crate) msg: String,
}

pub(crate) fn parse_diag_payload(payload: &str) -> Option<DiagMsg> {
    if payload.len() > DIAG_RAW_PAYLOAD_MAX_LEN {
        return None;
    }
    serde_json::from_str::<DiagMsg>(payload).ok()
}

/// Reports come from the remote Facebook origin, so treat them as untrusted:
/// keep printable characters only and cap the length before logging.
pub(crate) fn sanitize_diag(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .filter(|c| !c.is_control())
        .take(DIAG_MAX_LEN)
        .collect();
    cleaned.trim().to_string()
}

/// Longest diagnostic string that makes it into the log.
const DIAG_MAX_LEN: usize = 160;

/// Longest raw JSON payload accepted before deserialization.
const DIAG_RAW_PAYLOAD_MAX_LEN: usize = DIAG_MAX_LEN * 8;

/// Cap page diagnostics per session so a misbehaving (or malicious) page
/// script can't grow the log without bound. The page already rate-limits to
/// one report per key per minute; this is the backstop.
pub(crate) const DIAG_SESSION_CAP: u32 = 200;

/// Keep the app log bounded even if page diagnostics keep reporting over time.
pub(crate) const LOG_FILE_MAX_BYTES: u128 = 5 * 1024 * 1024;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_diag_strips_control_characters() {
        assert_eq!(sanitize_diag("a\nb\tc\x07d"), "abcd");
    }

    #[test]
    fn sanitize_diag_truncates_to_cap() {
        let long = "x".repeat(DIAG_MAX_LEN + 50);
        assert_eq!(sanitize_diag(&long).chars().count(), DIAG_MAX_LEN);
    }

    #[test]
    fn sanitize_diag_trims_and_handles_empty() {
        assert_eq!(sanitize_diag("  spaced  "), "spaced");
        assert_eq!(sanitize_diag(""), "");
        assert_eq!(sanitize_diag("\n\r\t"), "");
    }

    #[test]
    fn parse_diag_payload_accepts_small_reports() {
        let diag = parse_diag_payload(r#"{"key":"selector","msg":"missing"}"#).unwrap();
        assert_eq!(diag.key, "selector");
        assert_eq!(diag.msg, "missing");
    }

    #[test]
    fn parse_diag_payload_rejects_oversized_reports() {
        let payload = format!(
            r#"{{"key":"selector","msg":"{}"}}"#,
            "x".repeat(DIAG_RAW_PAYLOAD_MAX_LEN)
        );
        assert!(parse_diag_payload(&payload).is_none());
    }
}
