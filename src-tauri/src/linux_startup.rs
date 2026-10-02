//! GTK/WebKit environment defaults, applied before either library starts.

use std::ffi::OsString;

fn should_default_to_http1(force_http1: Option<OsString>, allow_http2: Option<OsString>) -> bool {
    force_http1.is_none() && allow_http2.as_deref() != Some(std::ffi::OsStr::new("1"))
}

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

/// Demote only codecs with a usable software replacement, including the
/// stateless factory names used before GStreamer 1.24.
fn nvdec_demotion(mut software_decoder_usable: impl FnMut(&str) -> bool) -> String {
    let codecs: &[(&str, &[&str])] = &[
        ("avdec_h264", &["nvh264dec", "nvh264sldec"]),
        ("avdec_h265", &["nvh265dec", "nvh265sldec"]),
        ("avdec_av1", &["nvav1dec"]),
        ("avdec_vp8", &["nvvp8dec", "nvvp8sldec"]),
        ("avdec_vp9", &["nvvp9dec", "nvvp9sldec"]),
        ("avdec_mjpeg", &["nvjpegdec"]),
        ("avdec_mpegvideo", &["nvmpegvideodec"]),
        ("avdec_mpeg2video", &["nvmpeg2videodec"]),
        ("avdec_mpeg4", &["nvmpeg4videodec"]),
    ];
    codecs
        .iter()
        .filter(|(software, _)| software_decoder_usable(software))
        .flat_map(|(_, hardware)| hardware.iter().map(|name| format!("{name}:NONE")))
        .collect::<Vec<_>>()
        .join(",")
}

#[cfg(target_os = "linux")]
pub(crate) fn configure() {
    // Apply GTK/WebKit defaults before GStreamer or worker threads start.
    // SAFETY (every `set_var` here): `run()` calls this before Tauri, GTK, or
    // any worker starts. The only live thread is the debug native-log pump,
    // which never touches the environment.
    for (key, value) in environment_defaults(|key| std::env::var_os(key)) {
        unsafe { std::env::set_var(key, value) };
    }
    // libsoup 3.6.6's HTTP/2 pool stalled on Messenger with all six connections
    // in CLOSE-WAIT, blocking worker startup too. HTTP/1.1 avoids that failure.
    // Keep an opt-out for testing newer system libraries; see docs/sync-recovery.md.
    if should_default_to_http1(
        std::env::var_os("SOUP_FORCE_HTTP1"),
        std::env::var_os("CARRIER_LINUX_HTTP2"),
    ) {
        unsafe { std::env::set_var("SOUP_FORCE_HTTP1", "1") };
    }
    // Any NVDEC decoder WebKit can autoplug makes the web process load CUDA
    // for Messenger clips, even paused offscreen ones: about 100 MB RAM and
    // 400 MiB VRAM. Only NONE avoids it, which removes NVDEC entirely, so do it
    // only when the corresponding libav decoder can be created instead.
    // GStreamer's registry handles user, system, and AppImage plugin paths.
    // Any explicit GST_PLUGIN_FEATURE_RANK, even empty, opts out.
    if std::env::var_os("GST_PLUGIN_FEATURE_RANK").is_none() && gstreamer::init().is_ok() {
        use gstreamer::prelude::*;
        // The registry lists only features of plugins that loaded when scanned.
        // Creating an element would load libav into this process for good
        // (about 35 MB), so a registry lookup is enough.
        let ranks = nvdec_demotion(|name| {
            gstreamer::ElementFactory::find(name)
                .is_some_and(|factory| factory.rank() > gstreamer::Rank::None)
        });
        // WebKit's separate web process reads these ranks during its own init.
        if !ranks.is_empty() {
            unsafe { std::env::set_var("GST_PLUGIN_FEATURE_RANK", ranks) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http1_workaround_respects_explicit_environment_and_http2_opt_in() {
        assert!(should_default_to_http1(None, None));
        assert!(should_default_to_http1(None, Some("0".into())));
        assert!(!should_default_to_http1(None, Some("1".into())));
        // libsoup treats presence as enabled, including an empty value or "0".
        for value in ["", "0", "1"] {
            assert!(!should_default_to_http1(Some(value.into()), None));
        }
    }

    #[test]
    fn nvdec_ranks_require_a_usable_replacement_for_each_codec() {
        assert!(nvdec_demotion(|_| false).is_empty());
        assert_eq!(
            nvdec_demotion(|name| matches!(name, "avdec_h264" | "avdec_vp9")),
            "nvh264dec:NONE,nvh264sldec:NONE,nvvp9dec:NONE,nvvp9sldec:NONE"
        );
    }

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
            assert!(
                defaults(&[
                    ("CARRIER_LINUX_WEBKIT_SAFE_MODE", "1"),
                    ("WEBKIT_DISABLE_DMABUF_RENDERER", value),
                    ("WEBKIT_DISABLE_COMPOSITING_MODE", value)
                ])
                .is_empty()
            );
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
