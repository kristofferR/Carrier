/* ------------------ Camera/mic permission warning --------------------- */
// If a call can't get the camera or mic because the OS blocked it, tell the
// user and offer to open the OS privacy settings.
import { openUrl, toast } from "../bridge";

export function initMediaPermissionWarning() {
  const md = navigator.mediaDevices;
  if (!md?.getUserMedia) return;
  const original = md.getUserMedia.bind(md);
  md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
    try {
      const stream = await original(constraints);
      // Track the call so the auto-refresh doesn't reload mid-call.
      window.__carrierInCall = true;
      const tracks = stream.getTracks();
      let live = tracks.length;
      tracks.forEach((t) => {
        t.addEventListener("ended", () => {
          if (--live <= 0) window.__carrierInCall = false;
        });
      });
      return stream;
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (err && (name === "NotAllowedError" || name === "NotFoundError")) {
        const kind = constraints?.video ? "camera" : "microphone";
        toast(`Carrier needs ${kind} access — check System Settings → Privacy & Security`);
        // macOS deep link to the relevant privacy pane (no-op elsewhere).
        const pane = kind === "camera" ? "Privacy_Camera" : "Privacy_Microphone";
        openUrl(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
      }
      throw err;
    }
  };
}
