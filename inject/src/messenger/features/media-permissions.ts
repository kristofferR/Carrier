/* ------------------ Camera/mic permission recovery -------------------- */
import { diag } from "../bridge";
import { captureFailure, type MediaDevice, requestedMediaDevices } from "../lib/media-permissions";
import { LiveMediaTrackCounter } from "../lib/media-tracks";
import { showMediaPermissionCard } from "./media-permission-card";

export function initMediaPermissionWarning() {
  const md = navigator.mediaDevices;
  if (!md?.getUserMedia) return;
  const original = md.getUserMedia.bind(md);
  let removeCard: (() => void) | undefined;
  const failures = new Map<MediaDevice, ReturnType<typeof captureFailure>>();
  let requestSerial = 0;
  let clearedThrough = 0;
  const remove = () => {
    removeCard?.();
    removeCard = undefined;
  };
  const hide = () => {
    remove();
    failures.clear();
  };
  const dismissWarning = () => {
    clearedThrough = requestSerial;
    hide();
  };
  const render = () => {
    remove();
    if (failures.size)
      removeCard = showMediaPermissionCard(new Map(failures), dismissWarning, hide);
  };
  const liveTracks = new LiveMediaTrackCounter<MediaStreamTrack>((inCall) => {
    window.__carrierInCall = inCall;
    window.dispatchEvent(new Event("carrier:protection-change"));
  });
  md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
    const serial = ++requestSerial;
    const devices = requestedMediaDevices(constraints);
    let stream: MediaStream;
    try {
      stream = await original(constraints);
    } catch (error) {
      if (devices.length && serial > clearedThrough) {
        try {
          for (const device of devices) failures.set(device, captureFailure(error));
          render();
        } catch {
          diag("media-recovery", "could not display call recovery guidance");
        }
      }
      throw error;
    }
    stream.getTracks().forEach((track) => liveTracks.add(track));
    for (const device of devices) failures.delete(device);
    try {
      render();
    } catch {
      diag("media-recovery", "could not update call recovery guidance");
    }
    return stream;
  };
}
