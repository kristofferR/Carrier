import { t } from "../../i18n";

export type MediaDevice = "camera" | "microphone";
export type MediaPlatform = "macos" | "windows" | "linux";

export function requestedMediaDevices(constraints?: MediaStreamConstraints): MediaDevice[] {
  const devices: MediaDevice[] = [];
  if (constraints?.video) devices.push("camera");
  if (constraints?.audio) devices.push("microphone");
  return devices;
}

/** The text for this set of devices. Each form is a whole sentence, so a
 * translation never splices a device name into one. */
export function forDevices(
  devices: readonly MediaDevice[],
  text: { camera: string; microphone: string; both: string },
): string {
  const camera = devices.includes("camera");
  if (camera && devices.includes("microphone")) return text.both;
  return camera ? text.camera : text.microphone;
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
      return t("page.media.guidance.macos");
    case "windows":
      return t("page.media.guidance.windows");
    case "linux":
      return t("page.media.guidance.linux");
  }
}

export function captureFailureMessage(
  failure: ReturnType<typeof captureFailure>,
  devices: readonly MediaDevice[],
) {
  switch (failure) {
    case "denied":
      return forDevices(devices, {
        camera: t("page.media.denied.camera"),
        microphone: t("page.media.denied.microphone"),
        both: t("page.media.denied.both"),
      });
    case "missing":
      return forDevices(devices, {
        camera: t("page.media.missing.camera"),
        microphone: t("page.media.missing.microphone"),
        both: t("page.media.missing.both"),
      });
    case "unavailable":
      return forDevices(devices, {
        camera: t("page.media.unavailable.camera"),
        microphone: t("page.media.unavailable.microphone"),
        both: t("page.media.unavailable.both"),
      });
    case "constraints":
      return forDevices(devices, {
        camera: t("page.media.constraints.camera"),
        microphone: t("page.media.constraints.microphone"),
        both: t("page.media.constraints.both"),
      });
    case "other":
      return forDevices(devices, {
        camera: t("page.media.other.camera"),
        microphone: t("page.media.other.microphone"),
        both: t("page.media.other.both"),
      });
  }
}

// A trusted button click is the synchronous input fallback on older WebKit.
export function canActivateMediaPrivacy(isTrusted: boolean, isActive: boolean | undefined) {
  return isTrusted && (isActive ?? true);
}
