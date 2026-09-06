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
