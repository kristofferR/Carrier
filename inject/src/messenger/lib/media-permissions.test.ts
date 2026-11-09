import { expect, test } from "bun:test";
import {
  canActivateMediaPrivacy,
  captureFailure,
  captureFailureMessage,
  requestedMediaDevices,
} from "./media-permissions";

test.each([
  [undefined, []],
  [{ audio: true }, ["microphone"]],
  [{ video: {} }, ["camera"]],
  [{ audio: {}, video: true }, ["camera", "microphone"]],
  [{ audio: false, video: false }, []],
] as const)("constraints %j request %j", (constraints, devices) => {
  expect(requestedMediaDevices(constraints)).toEqual([...devices]);
});

test.each([
  [["microphone"], "Access was denied for the requested microphone."],
  [["camera"], "Access was denied for the requested camera."],
  [["camera", "microphone"], "Access was denied for the requested camera and microphone."],
] as const)("%j is named in a whole sentence", (devices, message) => {
  expect(captureFailureMessage("denied", devices)).toBe(message);
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
