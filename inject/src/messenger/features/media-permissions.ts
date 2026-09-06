/* ------------------ Camera/mic permission recovery -------------------- */
import { diag } from "../bridge";
import {
  canActivateMediaPrivacy,
  captureFailure,
  captureFailureMessage,
  type MediaDevice,
  mediaPrivacyGuidance,
  requestedMediaDevices,
} from "../lib/media-permissions";
import { LiveMediaTrackCounter } from "../lib/media-tracks";

export function initMediaPermissionWarning() {
  const md = navigator.mediaDevices;
  if (!md?.getUserMedia) return;
  const original = md.getUserMedia.bind(md);
  let banner: HTMLElement | undefined;
  let failedDevices: MediaDevice[] = [];
  let requestSerial = 0;
  let clearedThrough = 0;
  const hide = () => {
    banner?.remove();
    banner = undefined;
    failedDevices = [];
  };
  const dismissWarning = () => {
    // A dismissed warning must not return when an already pending request fails.
    clearedThrough = requestSerial;
    hide();
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
          banner?.remove();
          failedDevices = [...devices];
          banner = document.createElement("div");
          banner.id = "carrier-media-permission-banner";
          // Shadow styles keep Messenger's button/reset rules out of recovery UI.
          const root = banner.attachShadow({ mode: "closed" });
          const style = document.createElement("style");
          style.textContent = `
            :host { all: initial; position: fixed; bottom: 24px; left: 50%;
              transform: translateX(-50%); z-index: 2147483646;
              width: max-content; max-width: calc(100vw - 32px); }
            section { box-sizing: border-box; max-width: 560px; padding: 14px 16px;
              border-radius: 12px; background: #ffba00; color: #1c1e21;
              box-shadow: 0 4px 16px #0005; font: 13px/1.5 system-ui, sans-serif; }
            p { margin: 0 0 10px; } strong { font-weight: 650; }
            nav { display: flex; flex-wrap: wrap; gap: 8px; }
            button { font: 600 12px/1.5 system-ui, sans-serif; cursor: pointer;
              color: #1c1e21; background: #fff9; border: 1px solid #1c1e2160;
              border-radius: 6px; padding: 6px 10px; }
            button:focus-visible { outline: 2px solid #1c1e21; outline-offset: 2px; }
            button:disabled { cursor: wait; opacity: .65; }
          `;
          const section = document.createElement("section");
          section.setAttribute("aria-label", "Call device recovery");
          const message = document.createElement("p");
          message.setAttribute("role", "alert");
          const failure = captureFailure(error);
          message.textContent = captureFailureMessage(failure, devices);
          const guidance = document.createElement("p");
          if (failure === "denied")
            guidance.textContent = mediaPrivacyGuidance(carrierMediaPlatform);
          const actions = document.createElement("nav");
          actions.setAttribute("aria-label", "Call recovery actions");
          if (failure === "denied" && carrierMediaPlatform !== "linux") {
            for (const device of devices) {
              const button = document.createElement("button");
              button.type = "button";
              button.textContent = `${device === "camera" ? "Camera" : "Microphone"} settings`;
              button.addEventListener("click", async (event) => {
                if (
                  !canActivateMediaPrivacy(event.isTrusted, navigator.userActivation?.isActive) ||
                  button.disabled
                )
                  return;
                button.disabled = true;
                try {
                  await carrierOpenMediaPrivacy(device);
                } catch {
                  guidance.textContent = `Settings could not open. ${mediaPrivacyGuidance(carrierMediaPlatform)}`;
                  guidance.setAttribute("role", "alert");
                } finally {
                  button.disabled = false;
                }
              });
              actions.append(button);
            }
          }
          const dismiss = document.createElement("button");
          dismiss.type = "button";
          dismiss.textContent = "Dismiss";
          dismiss.addEventListener("click", dismissWarning);
          actions.append(dismiss);
          section.append(message);
          if (guidance.textContent) section.append(guidance);
          section.append(actions);
          root.append(style, section);
          (document.body ?? document.documentElement).append(banner);
        } catch {
          diag("media-recovery", "could not display call recovery guidance");
        }
      }
      throw error;
    }
    // Track the call so the auto-refresh doesn't reload mid-call.
    stream.getTracks().forEach((track) => liveTracks.add(track));
    failedDevices = failedDevices.filter((device) => !devices.includes(device));
    if (!failedDevices.length) hide();
    return stream;
  };
}
