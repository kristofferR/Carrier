//! GTK/WebKit environment defaults, applied before either library starts.

use std::ffi::OsString;

/// Keep decisions independent of the process environment so tests can cover
/// desktop combinations without racing GTK or other tests' environment reads.
fn environment_defaults(
    env: impl Fn(&str) -> Option<OsString>,
) -> Vec<(&'static str, &'static str)> {
    let nonempty = |key| env(key).is_some_and(|value| !value.is_empty());
    let wayland = nonempty("WAYLAND_DISPLAY");
    let niri = nonempty("NIRI_SOCKET")
        || [
            "XDG_CURRENT_DESKTOP",
            "XDG_SESSION_DESKTOP",
            "DESKTOP_SESSION",
        ]
        .iter()
        .filter_map(|key| env(key))
        .any(|value| {
            value.to_str().is_some_and(|value| {
                value
                    .split(':')
                    .any(|desktop| desktop.trim().eq_ignore_ascii_case("niri"))
            })
        });
    let safe_mode = match env("CARRIER_LINUX_WEBKIT_SAFE_MODE").as_deref() {
        Some(value) if value == "1" => true,
        Some(value) if value == "0" => false,
        _ => wayland && niri,
    };

    let mut defaults = Vec::new();
    if wayland && !nonempty("DISPLAY") && !nonempty("GDK_BACKEND") {
        defaults.push(("GDK_BACKEND", "wayland"));
    }
    // Retain the existing Wayland DMABUF workaround, including when the user
    // opts out of the additional compositing fallback with SAFE_MODE=0.
    if (wayland || safe_mode) && env("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        defaults.push(("WEBKIT_DISABLE_DMABUF_RENDERER", "1"));
    }
    if safe_mode && env("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
        defaults.push(("WEBKIT_DISABLE_COMPOSITING_MODE", "1"));
    }
    defaults
}

#[cfg(target_os = "linux")]
pub(crate) fn configure() {
    // Called first in run(), before Tauri, GTK, WebKit, or worker threads start.
    for (key, value) in environment_defaults(|key| std::env::var_os(key)) {
        std::env::set_var(key, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defaults(values: &[(&str, &str)]) -> Vec<(&'static str, &'static str)> {
        environment_defaults(|key| {
            values
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| OsString::from(value))
        })
    }

    const DMABUF: (&str, &str) = ("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    const COMPOSITING: (&str, &str) = ("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    const WAYLAND: (&str, &str) = ("WAYLAND_DISPLAY", "wayland-0");

    #[test]
    fn pure_wayland_selects_gtk_backend_before_renderer_defaults() {
        assert_eq!(defaults(&[WAYLAND]), [("GDK_BACKEND", "wayland"), DMABUF]);
        assert_eq!(
            defaults(&[WAYLAND, ("DISPLAY", ""), ("GDK_BACKEND", "")]),
            [("GDK_BACKEND", "wayland"), DMABUF]
        );
    }

    #[test]
    fn backend_defaults_leave_x11_xwayland_and_explicit_choices_alone() {
        assert!(defaults(&[]).is_empty());
        assert!(defaults(&[("DISPLAY", ":0")]).is_empty());
        assert!(defaults(&[("WAYLAND_DISPLAY", "")]).is_empty());
        assert!(defaults(&[("DISPLAY", ":0"), ("XDG_CURRENT_DESKTOP", "niri")]).is_empty());
        assert_eq!(defaults(&[WAYLAND, ("DISPLAY", ":0")]), [DMABUF]);
        for backend in ["x11", "wayland", "wayland,x11,*"] {
            assert_eq!(defaults(&[WAYLAND, ("GDK_BACKEND", backend)]), [DMABUF]);
        }
    }

    #[test]
    fn niri_socket_and_desktop_identifiers_enable_safe_mode() {
        for identity in [
            ("NIRI_SOCKET", "/run/user/1000/niri.sock"),
            ("XDG_CURRENT_DESKTOP", "niri"),
            ("XDG_CURRENT_DESKTOP", "GNOME: Niri :Wayland"),
            ("XDG_SESSION_DESKTOP", "niri"),
            ("DESKTOP_SESSION", "niri"),
        ] {
            assert_eq!(
                defaults(&[WAYLAND, identity]),
                [("GDK_BACKEND", "wayland"), DMABUF, COMPOSITING],
                "{identity:?}"
            );
        }
    }

    #[test]
    fn other_desktops_keep_only_the_existing_wayland_workaround() {
        for desktop in ["GNOME", "KDE", "Hyprland", "sway", "niri-like", ""] {
            assert_eq!(
                defaults(&[
                    WAYLAND,
                    ("DISPLAY", ":0"),
                    ("NIRI_SOCKET", ""),
                    ("XDG_CURRENT_DESKTOP", desktop)
                ]),
                [DMABUF],
                "{desktop}"
            );
        }
    }

    #[test]
    fn safe_mode_can_be_forced_on_or_disabled_independently_of_backend_selection() {
        assert_eq!(
            defaults(&[("DISPLAY", ":0"), ("CARRIER_LINUX_WEBKIT_SAFE_MODE", "1")]),
            [DMABUF, COMPOSITING]
        );
        assert_eq!(
            defaults(&[
                WAYLAND,
                ("XDG_CURRENT_DESKTOP", "niri"),
                ("CARRIER_LINUX_WEBKIT_SAFE_MODE", "0")
            ]),
            [("GDK_BACKEND", "wayland"), DMABUF]
        );
        assert!(defaults(&[("CARRIER_LINUX_WEBKIT_SAFE_MODE", "0")]).is_empty());
    }

    #[test]
    fn empty_auto_and_unrecognized_safe_mode_values_use_desktop_detection() {
        for value in ["", "auto", "invalid"] {
            assert_eq!(
                defaults(&[
                    WAYLAND,
                    ("DISPLAY", ":0"),
                    ("XDG_CURRENT_DESKTOP", "niri"),
                    ("CARRIER_LINUX_WEBKIT_SAFE_MODE", value)
                ]),
                [DMABUF, COMPOSITING]
            );
            assert!(defaults(&[("CARRIER_LINUX_WEBKIT_SAFE_MODE", value)]).is_empty());
        }
    }

    #[test]
    fn explicit_webkit_overrides_win_even_over_forced_safe_mode() {
        for value in ["0", "1", ""] {
            assert!(defaults(&[
                ("CARRIER_LINUX_WEBKIT_SAFE_MODE", "1"),
                ("WEBKIT_DISABLE_DMABUF_RENDERER", value),
                ("WEBKIT_DISABLE_COMPOSITING_MODE", value)
            ])
            .is_empty());
        }
        assert_eq!(
            defaults(&[
                ("CARRIER_LINUX_WEBKIT_SAFE_MODE", "1"),
                ("WEBKIT_DISABLE_DMABUF_RENDERER", "0")
            ]),
            [COMPOSITING]
        );
        assert_eq!(
            defaults(&[
                ("CARRIER_LINUX_WEBKIT_SAFE_MODE", "1"),
                ("WEBKIT_DISABLE_COMPOSITING_MODE", "0")
            ]),
            [DMABUF]
        );
    }
}
