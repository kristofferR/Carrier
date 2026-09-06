import { expect, test } from "bun:test";

test("permission snapshots require matching requests, known states and a native signature", async () => {
  const source = await Bun.file(
    new URL("../../../../src-tauri/src/window.rs", import.meta.url),
  ).text();
  const start = source.indexOf("  var carrierMediaPermissionStatus = function");
  const end = source.indexOf("  var carrierOpenMediaPrivacy", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const factory = source.slice(start, end).replaceAll("{{", "{").replaceAll("}}", "}");
  const target = new EventTarget();
  const emitted: Record<string, unknown>[] = [];
  const verified: unknown[] = [];
  const make = new Function(
    "carrierAuthorizedEmit",
    "carrierVerifyResult",
    "carrierNativeRequest",
    "NativePromise",
    "nativeSetTimeout",
    "nativeClearTimeout",
    "nativeReflectApply",
    "nativeWindowAddEventListener",
    "nativeWindowRemoveEventListener",
    "window",
    `${factory}; return carrierMediaPermissionStatus;`,
  );
  const query = make(
    async (_event: string, payload: Record<string, unknown>) => {
      emitted.push(payload);
    },
    async (_event: string, value: unknown, signature: string) => {
      verified.push(value);
      return signature === "valid";
    },
    () => "request",
    Promise,
    setTimeout,
    clearTimeout,
    Reflect.apply,
    EventTarget.prototype.addEventListener,
    EventTarget.prototype.removeEventListener,
    target,
  ) as (device?: "camera" | "microphone") => Promise<{ camera: string; microphone: string }>;
  const dispatch = (request: string, camera: string, signature: string) =>
    target.dispatchEvent(
      new CustomEvent("carrier:media-permission-status-result", {
        detail: { request, camera, microphone: "allowed", signature },
      }),
    );
  let resolved = false;
  const pending = query().then((snapshot) => {
    resolved = true;
    return snapshot;
  });
  expect(emitted).toEqual([{ request: "request" }]);
  dispatch("another-request", "denied", "valid");
  dispatch("request", "made-up-state", "valid");
  dispatch("request", "denied", "forged");
  await Promise.resolve();
  expect(resolved).toBe(false);
  dispatch("request", "denied", "valid");
  expect(await pending).toEqual({ camera: "denied", microphone: "allowed" });
  expect(verified).toEqual([
    { request: "request", camera: "denied", microphone: "allowed" },
    { request: "request", camera: "denied", microphone: "allowed" },
  ]);
  const allow = query("camera");
  expect(emitted.at(-1)).toEqual({ request: "request", device: "camera" });
  dispatch("request", "allowed", "valid");
  expect(await allow).toEqual({ camera: "allowed", microphone: "allowed" });
});
