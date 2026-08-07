import { expect, test } from "bun:test";

type ResultDetail = {
  request: string;
  shown: boolean;
  signature: string;
};

type ResultListener = (event: { detail: ResultDetail }) => void;

class FakeWindow {
  readonly listeners = new Map<string, Set<ResultListener>>();

  addEventListener(type: string, listener: ResultListener) {
    const listeners = this.listeners.get(type) ?? new Set<ResultListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: ResultListener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, detail: ResultDetail) {
    for (const listener of this.listeners.get(type) ?? []) listener({ detail });
  }
}

type NativeCall = (
  requestEvent: string,
  field: string,
  failedMessage: string,
  timedOutMessage: string,
  payload: Record<string, unknown> & { request?: string },
  acknowledgesBeforeFinal?: boolean,
) => Promise<void>;

const nativeCallFactory = async () => {
  const source = await Bun.file(
    new URL("../../../../src-tauri/src/window.rs", import.meta.url),
  ).text();
  const start = source.indexOf("  var carrierNativeCall = function");
  const end = source.indexOf("\n\n  var carrierRevealDownload", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const exactFactory = source.slice(start, end).replaceAll("{{", "{").replaceAll("}}", "}");

  const window = new FakeWindow();
  let emittedPayload: (Record<string, unknown> & { request?: string }) | undefined;
  const buildFactory = new Function(
    "carrierAuthorizedEmit",
    "carrierVerifyResult",
    "NativePromise",
    "nativeSetTimeout",
    "nativeClearTimeout",
    "nativeReflectApply",
    "nativeWindowAddEventListener",
    "nativeWindowRemoveEventListener",
    "window",
    "carrierNativeRequest",
    `${exactFactory}\nreturn carrierNativeCall;`,
  ) as (
    emit: (event: string, payload: Record<string, unknown> & { request?: string }) => Promise<void>,
    verify: () => Promise<boolean>,
    promise: PromiseConstructor,
    setTimer: typeof setTimeout,
    clearTimer: typeof clearTimeout,
    reflectApply: typeof Reflect.apply,
    addEventListener: FakeWindow["addEventListener"],
    removeEventListener: FakeWindow["removeEventListener"],
    target: FakeWindow,
    request: () => string,
  ) => NativeCall;
  const call = buildFactory(
    async (_event, payload) => {
      emittedPayload = payload;
    },
    async () => true,
    Promise,
    setTimeout,
    clearTimeout,
    Reflect.apply,
    FakeWindow.prototype.addEventListener,
    FakeWindow.prototype.removeEventListener,
    window,
    () => "0123456789abcdef0123456789abcdef",
  );

  return {
    call,
    dispatch(shown: boolean) {
      const request = emittedPayload?.request;
      expect(request).toBeString();
      window.dispatch("carrier:context-menu-result", {
        request: request ?? "",
        shown,
        signature: "valid",
      });
    },
  };
};

const flushVerification = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("native context calls wait for the result after their presentation acknowledgement", async () => {
  const success = await nativeCallFactory();
  let successState = "pending";
  const successCall = success
    .call("carrier:context-menu", "shown", "failed", "timed out", { items: [] }, true)
    .then(
      () => {
        successState = "resolved";
      },
      () => {
        successState = "rejected";
      },
    );
  success.dispatch(true);
  await flushVerification();
  expect(successState).toBe("pending");
  success.dispatch(true);
  await successCall;
  expect(successState).toBe("resolved");

  const failure = await nativeCallFactory();
  const failureCall = failure.call(
    "carrier:context-menu",
    "shown",
    "failed",
    "timed out",
    { items: [] },
    true,
  );
  failure.dispatch(true);
  await flushVerification();
  failure.dispatch(false);
  await expect(failureCall).rejects.toThrow("failed");
});
