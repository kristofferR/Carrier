import { describe, expect, test } from "bun:test";
import { engineSupportsCalls } from "./calls";

function PeerConnection() {}
function ScriptTransform() {}

describe("engineSupportsCalls", () => {
  test("WebKitGTK without WebRTC cannot call", () => {
    expect(engineSupportsCalls({})).toBe(false);
  });

  test("WebRTC without a media transform cannot call in encrypted chats", () => {
    expect(
      engineSupportsCalls({
        RTCPeerConnection: PeerConnection,
        RTCRtpSender: { prototype: {} },
      }),
    ).toBe(false);
  });

  test("Safari's script transforms and Chromium's encoded streams both work", () => {
    expect(
      engineSupportsCalls({
        RTCPeerConnection: PeerConnection,
        RTCRtpScriptTransform: ScriptTransform,
        RTCRtpSender: { prototype: { transform: null } },
      }),
    ).toBe(true);
    expect(
      engineSupportsCalls({
        RTCPeerConnection: PeerConnection,
        RTCRtpSender: { prototype: { createEncodedStreams() {} } },
      }),
    ).toBe(true);
  });
});
