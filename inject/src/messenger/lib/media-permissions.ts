export type MediaDevice = "camera" | "microphone";
export type MediaPlatform = "macos" | "windows" | "linux";

export function requestedMediaDevices(constraints?: MediaStreamConstraints): MediaDevice[] {
  const devices: MediaDevice[] = [];
  if (constraints?.video) devices.push("camera");
  if (constraints?.audio) devices.push("microphone");
  return devices;
}

export function mediaDeviceLabel(devices: readonly MediaDevice[]): string {
  return devices.join(" and ") || "media device";
}

export function captureFailure(error: unknown) {
  const name = error && typeof error === "object" && "name" in error ? error.name : undefined;
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "missing";
    case "NotReadableError":
    case "TrackStartError":
      return "unavailable";
    case "OverconstrainedError":
      return "constraints";
    default:
      return "other";
  }
}

export function mediaPrivacyGuidance(platform: MediaPlatform): string {
  switch (platform) {
    case "macos":
      return "Check System Settings → Privacy & Security and allow Carrier access. Then try the call again.";
    case "windows":
      return "Check Settings → Privacy & security and allow desktop apps access. Then try the call again.";
    case "linux":
      return "Check your desktop’s privacy and sound input settings, hardware privacy switches, and any sandbox permissions for Carrier. Then try the call again.";
  }
}

export function captureFailureMessage(
  failure: ReturnType<typeof captureFailure>,
  devices: readonly MediaDevice[],
) {
  const label = mediaDeviceLabel(devices);
  switch (failure) {
    case "denied":
      return `Access was denied for the requested ${label}.`;
    case "missing":
      return `No matching device was found for the requested ${label}. Check that the devices are connected and enabled, then try again.`;
    case "unavailable":
      return `The requested ${label} could not start. Close other apps using these devices, check the connection, and try again.`;
    case "constraints":
      return `The requested ${label} settings are not supported. Choose another device or call setting in Messenger and try again.`;
    case "other":
      return `Capture failed for the requested ${label}. Check Messenger’s call settings and try again.`;
  }
}
