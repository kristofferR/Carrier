/*
 * Runs before Messenger's document exists, in every frame that can own its
 * audio. Keeping this entry independent from messenger.js lets the Rust host
 * include it in fbsbx.com frames without exposing Carrier's privileged bridge.
 */
import { initWebAudioIdle } from "./messenger/features/web-audio-idle";
import { formatWebAudioDiagnostic, type WebAudioDiagnostic } from "./messenger/lib/web-audio-idle";

const normalizeHost = (host: string) => host.toLowerCase().replace(/^www\./, "");
const isMessengerHost = (host: string) =>
  host === "facebook.com" ||
  host.endsWith(".facebook.com") ||
  host === "messenger.com" ||
  host.endsWith(".messenger.com");
const isFbsbxHost = (host: string) => host === "fbsbx.com" || host.endsWith(".fbsbx.com");

const carrierHost = normalizeHost(location.hostname);
let carrierParentHost = "";
try {
  if (window.parent !== window) carrierParentHost = normalizeHost(window.parent.location.hostname);
} catch (_) {}

const isMessengerFrame =
  isMessengerHost(carrierHost) || (!carrierHost && isMessengerHost(carrierParentHost));
const isAudioOnlyFrame =
  isFbsbxHost(carrierHost) || (!carrierHost && isFbsbxHost(carrierParentHost));

if (isMessengerFrame || isAudioOnlyFrame) {
  const report = (() => {
    if (window.top !== window.self) return (_diagnostic: WebAudioDiagnostic) => {};

    const lastSent = new Map<string, number>();
    return (diagnostic: WebAudioDiagnostic) => {
      try {
        const { key, message } = formatWebAudioDiagnostic(diagnostic);
        const now = Date.now();
        if (now - (lastSent.get(key) ?? 0) < 30_000) return;
        lastSent.set(key, now);
        window.__TAURI_INTERNALS__
          ?.invoke("plugin:event|emit", {
            event: "carrier:diag",
            payload: { key, msg: message },
          })
          ?.catch?.(() => {});
      } catch (_) {}
    };
  })();

  try {
    initWebAudioIdle(report);
  } catch (_) {
    report({ type: "initialization-failed" });
  }
}
