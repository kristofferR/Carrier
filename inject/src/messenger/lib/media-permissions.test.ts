import { expect, test } from "bun:test";
import {
  canActivateMediaPrivacy,
  captureFailure,
  captureFailureMessage,
  mediaDeviceLabel,
  requestedMediaDevices,
} from "./media-permissions";

test.each([
  [undefined, "media device"],
  [{ audio: true }, "microphone"],
  [{ video: {} }, "camera"],
  [{ audio: {}, video: true }, "camera and microphone"],
  [{ audio: false, video: false }, "media device"],
] as const)("requested devices %j are labelled %s", (constraints, label) => {
  expect(mediaDeviceLabel(requestedMediaDevices(constraints))).toBe(label);
});

test.each([
  ["NotAllowedError", "denied"],
  ["PermissionDeniedError", "denied"],
  ["NotFoundError", "missing"],
  ["DevicesNotFoundError", "missing"],
  ["NotReadableError", "unavailable"],
  ["TrackStartError", "unavailable"],
  ["OverconstrainedError", "constraints"],
  ["SecurityError", "other"],
  ["AbortError", "other"],
  ["TypeError", "other"],
] as const)("%s is classified as %s", (name, expected) => {
  expect(captureFailure(new DOMException("private device details", name))).toBe(expected);
});

test("unknown errors stay generic and never expose raw error details", () => {
  for (const error of [null, undefined, "private", {}, { name: "unknown", message: "private" }]) {
    expect(captureFailure(error)).toBe("other");
    expect(captureFailureMessage(captureFailure(error), ["camera"])).not.toContain("private");
  }
});

test("privacy actions require trusted input and activation where available", () => {
  for (const activation of [true, false, undefined]) {
    expect(canActivateMediaPrivacy(false, activation)).toBe(false);
  }
  expect(canActivateMediaPrivacy(true, false)).toBe(false);
  expect(canActivateMediaPrivacy(true, true)).toBe(true);
  expect(canActivateMediaPrivacy(true, undefined)).toBe(true);
});
