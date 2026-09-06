#[derive(serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MediaDevice {
    Camera,
    Microphone,
}

// Accept a device, never a page-supplied URI or command.
pub(crate) fn privacy_url(platform: &str, device: MediaDevice) -> Option<&'static str> {
    match (platform, device) {
        ("macos", MediaDevice::Camera) => {
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Camera")
        }
        ("macos", MediaDevice::Microphone) => {
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        }
        ("windows", MediaDevice::Camera) => Some("ms-settings:privacy-webcam"),
        ("windows", MediaDevice::Microphone) => Some("ms-settings:privacy-microphone"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_privacy_pages_are_available() {
        assert_eq!(
            privacy_url("windows", MediaDevice::Camera),
            Some("ms-settings:privacy-webcam")
        );
        assert_eq!(
            privacy_url("windows", MediaDevice::Microphone),
            Some("ms-settings:privacy-microphone")
        );
        assert!(privacy_url("macos", MediaDevice::Camera)
            .unwrap()
            .ends_with("?Privacy_Camera"));
        assert!(privacy_url("macos", MediaDevice::Microphone)
            .unwrap()
            .ends_with("?Privacy_Microphone"));
        assert_eq!(privacy_url("linux", MediaDevice::Camera), None);
        assert_eq!(privacy_url("linux", MediaDevice::Microphone), None);
        assert!(serde_json::from_str::<MediaDevice>("\"ms-settings:privacy-webcam\"").is_err());
    }
}

#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
// Only macOS currently supplies the known states in this shared wire format.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) enum PermissionStatus {
    Unknown,
    NotDetermined,
    Restricted,
    Denied,
    Allowed,
}

#[derive(serde::Serialize)]
pub(crate) struct PermissionSnapshot {
    pub camera: PermissionStatus,
    pub microphone: PermissionStatus,
}

pub(crate) fn snapshot() -> PermissionSnapshot {
    PermissionSnapshot {
        camera: status(MediaDevice::Camera),
        microphone: status(MediaDevice::Microphone),
    }
}

#[cfg(any(target_os = "macos", test))]
fn apple_status(value: isize) -> PermissionStatus {
    match value {
        0 => PermissionStatus::NotDetermined,
        1 => PermissionStatus::Restricted,
        2 => PermissionStatus::Denied,
        3 => PermissionStatus::Allowed,
        _ => PermissionStatus::Unknown,
    }
}

#[cfg(not(target_os = "macos"))]
fn status(_device: MediaDevice) -> PermissionStatus {
    // Web capture results do not establish the OS permission state.
    PermissionStatus::Unknown
}

#[cfg(target_os = "macos")]
fn status(device: MediaDevice) -> PermissionStatus {
    use objc2::{class, msg_send};
    let value: isize = unsafe {
        msg_send![class!(AVCaptureDevice), authorizationStatusForMediaType: media_type(device)]
    };
    apple_status(value)
}

#[cfg(target_os = "macos")]
fn media_type(device: MediaDevice) -> &'static objc2_foundation::NSString {
    use objc2_foundation::NSString;
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {
        static AVMediaTypeVideo: *const NSString;
        static AVMediaTypeAudio: *const NSString;
    }
    // AVFoundation exports process-lifetime NSString constants.
    unsafe {
        &*match device {
            MediaDevice::Camera => AVMediaTypeVideo,
            MediaDevice::Microphone => AVMediaTypeAudio,
        }
    }
}

pub(crate) fn request_access(device: MediaDevice, complete: impl Fn() + Send + Sync + 'static) {
    #[cfg(target_os = "macos")]
    if status(device) == PermissionStatus::NotDetermined {
        use objc2::{class, msg_send, runtime::Bool};
        let callback = block2::RcBlock::new(move |_: Bool| complete());
        // AVFoundation copies this completion block until the user answers.
        let _: () = unsafe {
            msg_send![class!(AVCaptureDevice), requestAccessForMediaType: media_type(device), completionHandler: &*callback]
        };
        return;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = device;
    complete();
}

#[cfg(test)]
mod status_tests {
    use super::*;

    #[test]
    fn apple_authorization_states_remain_distinct() {
        for (value, expected) in [
            (0, "not-determined"),
            (1, "restricted"),
            (2, "denied"),
            (3, "allowed"),
            (99, "unknown"),
        ] {
            assert_eq!(serde_json::to_value(apple_status(value)).unwrap(), expected);
        }
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn unsupported_platforms_never_claim_permission_is_allowed() {
        let value = serde_json::to_value(snapshot()).unwrap();
        assert_eq!(value["camera"], "unknown");
        assert_eq!(value["microphone"], "unknown");
    }
}
