/** The engine features Messenger's calls depend on. */
export interface CallEngine {
  RTCPeerConnection?: unknown;
  RTCRtpScriptTransform?: unknown;
  RTCRtpSender?: { prototype: object };
}

/**
 * Whether this engine can run Messenger calls: WebRTC, plus a way to transform
 * call media, which Messenger requires before it offers calls in encrypted
 * chats (Safari's script transforms or Chromium's encoded streams). WebKitGTK
 * builds without WebRTC have neither (#345).
 */
export function engineSupportsCalls(engine: CallEngine): boolean {
  const sender = engine.RTCRtpSender?.prototype;
  if (typeof engine.RTCPeerConnection !== "function" || !sender) return false;
  const scriptTransform =
    "transform" in sender && typeof engine.RTCRtpScriptTransform === "function";
  const encodedStreams =
    typeof (sender as { createEncodedStreams?: unknown }).createEncodedStreams === "function";
  return scriptTransform || encodedStreams;
}
