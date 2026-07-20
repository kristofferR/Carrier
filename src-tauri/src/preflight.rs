//! Messenger connectivity preflight: resolve the Messenger host before
//! navigating so a DNS blocker / offline network gets a clear message instead
//! of a blank webview.

use std::io::ErrorKind;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};

use serde::Serialize;

use crate::{HOME_HOST, HOME_PORT};

#[derive(Debug, Serialize)]
pub(crate) struct MessengerLoadStatus {
    state: String,
    title: String,
    message: String,
    detail: Option<String>,
}

impl MessengerLoadStatus {
    fn new(state: &str, title: &str, message: &str, detail: Option<String>) -> Self {
        Self {
            state: state.into(),
            title: title.into(),
            message: message.into(),
            detail,
        }
    }

    pub(crate) fn loading() -> Self {
        Self::new(
            "loading",
            "Loading Messenger",
            "Messenger is reachable. Carrier is opening it now.",
            None,
        )
    }

    pub(crate) fn unexpected(title: &str, detail: String) -> Self {
        Self::new(
            "error",
            title,
            "Carrier could not finish the Messenger reachability check.",
            Some(detail),
        )
    }
}

#[derive(Debug)]
pub(crate) enum MessengerPreflightError {
    Blocked {
        host: &'static str,
        ips: Vec<IpAddr>,
    },
    DnsFailed {
        host: &'static str,
        kind: ErrorKind,
        resolver_status: Option<i32>,
        retryable: bool,
        error: String,
    },
}

impl MessengerPreflightError {
    pub(crate) fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::DnsFailed {
                retryable: true,
                ..
            }
        )
    }
}

impl From<MessengerPreflightError> for MessengerLoadStatus {
    fn from(error: MessengerPreflightError) -> Self {
        match error {
            MessengerPreflightError::Blocked { host, ips } => Self::new(
                "blocked",
                "Messenger appears blocked",
                "Carrier cannot load Messenger because Facebook is resolving to a local blocking address. This commonly happens when a productivity blocker, DNS filter, or hosts-file rule is active.",
                Some(format!("{host} -> {}", format_ips(&ips))),
            ),
            MessengerPreflightError::DnsFailed {
                host,
                kind,
                resolver_status,
                retryable: _,
                error,
            } => Self::new(
                "unreachable",
                "Cannot resolve Messenger",
                "Carrier could not resolve Facebook's Messenger host. Check your internet connection, DNS settings, VPN, or firewall.",
                Some(match resolver_status {
                    Some(status) => {
                        format!("{host}: {error} ({kind:?}, resolver status {status})")
                    }
                    None => format!("{host}: {error} ({kind:?})"),
                }),
            ),
        }
    }
}

fn is_blocker_sinkhole_ip(ip: IpAddr) -> bool {
    ip.is_unspecified() || ip.is_loopback()
}

fn unique_ips(addrs: &[SocketAddr]) -> Vec<IpAddr> {
    let mut ips = Vec::new();
    for addr in addrs {
        let ip = addr.ip();
        if !ips.contains(&ip) {
            ips.push(ip);
        }
    }
    ips
}

fn format_ips(ips: &[IpAddr]) -> String {
    if ips.is_empty() {
        "no addresses".into()
    } else {
        ips.iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    }
}

fn is_transient_dns_error_kind(kind: ErrorKind) -> bool {
    matches!(
        kind,
        ErrorKind::Interrupted
            | ErrorKind::NotConnected
            | ErrorKind::TimedOut
            | ErrorKind::WouldBlock
    )
}

fn is_transient_dns_error(kind: ErrorKind, resolver_status: Option<i32>) -> bool {
    // Keep this conservative: unknown resolver errors include permanent
    // failures such as NXDOMAIN and should surface the recovery screen.
    if is_transient_dns_error_kind(kind) {
        return true;
    }

    #[cfg(unix)]
    if matches!(resolver_status, Some(0) | Some(libc::EAI_AGAIN)) {
        // A successful immediate recheck also proves the original resolver
        // error was transient.
        return true;
    }

    #[cfg(windows)]
    if resolver_status == Some(windows_sys::Win32::Networking::WinSock::WSATRY_AGAIN) {
        return true;
    }

    false
}

#[cfg(unix)]
fn resolver_status_after_failure(_error: &std::io::Error) -> Option<i32> {
    let host = std::ffi::CString::new(HOME_HOST).ok()?;
    let mut hints = unsafe { std::mem::zeroed::<libc::addrinfo>() };
    hints.ai_socktype = libc::SOCK_STREAM;
    let mut result = std::ptr::null_mut();

    // SAFETY: `host` is a valid C string, `hints` and `result` remain alive for
    // the call, and any returned list is released exactly once below.
    let status = unsafe { libc::getaddrinfo(host.as_ptr(), std::ptr::null(), &hints, &mut result) };
    if !result.is_null() {
        // SAFETY: a non-null result was allocated by getaddrinfo above.
        unsafe { libc::freeaddrinfo(result) };
    }
    Some(status)
}

#[cfg(not(unix))]
fn resolver_status_after_failure(error: &std::io::Error) -> Option<i32> {
    error.raw_os_error()
}

fn dns_failure_with_status(
    error: std::io::Error,
    resolver_status: Option<i32>,
) -> MessengerPreflightError {
    let kind = error.kind();
    MessengerPreflightError::DnsFailed {
        host: HOME_HOST,
        kind,
        resolver_status,
        retryable: is_transient_dns_error(kind, resolver_status),
        error: error.to_string(),
    }
}

fn dns_failure(error: std::io::Error) -> MessengerPreflightError {
    let resolver_status = if is_transient_dns_error_kind(error.kind()) {
        None
    } else {
        resolver_status_after_failure(&error)
    };
    dns_failure_with_status(error, resolver_status)
}

fn classify_messenger_resolution(addrs: &[SocketAddr]) -> Option<MessengerPreflightError> {
    let ips = unique_ips(addrs);
    if ips.is_empty() {
        return Some(MessengerPreflightError::DnsFailed {
            host: HOME_HOST,
            kind: ErrorKind::NotFound,
            resolver_status: None,
            retryable: false,
            error: "no addresses returned".into(),
        });
    }
    if ips.iter().all(|ip| is_blocker_sinkhole_ip(*ip)) {
        return Some(MessengerPreflightError::Blocked {
            host: HOME_HOST,
            ips,
        });
    }
    None
}

pub(crate) fn messenger_dns_preflight() -> Result<(), MessengerPreflightError> {
    let addrs = (HOME_HOST, HOME_PORT)
        .to_socket_addrs()
        .map(|iter| iter.collect::<Vec<_>>())
        .map_err(dns_failure)?;

    if let Some(error) = classify_messenger_resolution(&addrs) {
        return Err(error);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocker_sinkhole_ips_are_detected() {
        assert!(is_blocker_sinkhole_ip(IpAddr::from([0, 0, 0, 0])));
        assert!(is_blocker_sinkhole_ip(IpAddr::from([127, 0, 0, 1])));
        assert!(is_blocker_sinkhole_ip("::".parse().unwrap()));
        assert!(is_blocker_sinkhole_ip("::1".parse().unwrap()));
        assert!(!is_blocker_sinkhole_ip(IpAddr::from([31, 13, 72, 8])));
    }

    #[test]
    fn messenger_resolution_all_sinkholes_is_blocked() {
        let addrs = [
            SocketAddr::from(([0, 0, 0, 0], 443)),
            SocketAddr::from(([127, 0, 0, 1], 443)),
        ];
        assert!(matches!(
            classify_messenger_resolution(&addrs),
            Some(MessengerPreflightError::Blocked { .. })
        ));
    }

    #[test]
    fn messenger_resolution_with_public_ip_is_not_blocked() {
        let addrs = [
            SocketAddr::from(([0, 0, 0, 0], 443)),
            SocketAddr::from(([31, 13, 72, 8], 443)),
        ];
        assert!(classify_messenger_resolution(&addrs).is_none());
    }

    #[test]
    fn dns_failure_retryability_is_typed_and_conservative() {
        let transient = dns_failure_with_status(
            std::io::Error::new(ErrorKind::TimedOut, "temporary resolver timeout"),
            None,
        );
        let permanent = dns_failure_with_status(
            std::io::Error::new(ErrorKind::NotFound, "name does not exist"),
            None,
        );
        let unknown =
            dns_failure_with_status(std::io::Error::other("unclassified resolver failure"), None);

        assert!(transient.is_retryable());
        assert!(!permanent.is_retryable());
        assert!(!unknown.is_retryable());
        assert!(matches!(
            permanent,
            MessengerPreflightError::DnsFailed {
                kind: ErrorKind::NotFound,
                resolver_status: None,
                retryable: false,
                ..
            }
        ));
    }

    #[cfg(unix)]
    #[test]
    fn unix_temporary_resolver_status_is_retryable() {
        let failure = dns_failure_with_status(
            std::io::Error::other("failed to lookup address information"),
            Some(libc::EAI_AGAIN),
        );

        assert!(failure.is_retryable());
        assert!(matches!(
            failure,
            MessengerPreflightError::DnsFailed {
                resolver_status: Some(libc::EAI_AGAIN),
                retryable: true,
                ..
            }
        ));
    }
}
