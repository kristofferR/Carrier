//! Messenger connectivity preflight: resolve the Messenger host before
//! navigating so a DNS blocker / offline network gets a clear message instead
//! of a blank webview.

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
        error: String,
    },
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
            MessengerPreflightError::DnsFailed { host, error } => Self::new(
                "unreachable",
                "Cannot resolve Messenger",
                "Carrier could not resolve Facebook's Messenger host. Check your internet connection, DNS settings, VPN, or firewall.",
                Some(format!("{host}: {error}")),
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

fn classify_messenger_resolution(addrs: &[SocketAddr]) -> Option<MessengerPreflightError> {
    let ips = unique_ips(addrs);
    if ips.is_empty() {
        return Some(MessengerPreflightError::DnsFailed {
            host: HOME_HOST,
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
        .map_err(|e| MessengerPreflightError::DnsFailed {
            host: HOME_HOST,
            error: e.to_string(),
        })?;

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
}
