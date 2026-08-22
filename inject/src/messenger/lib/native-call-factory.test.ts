import { expect, test } from "bun:test";

type ResultDetail = {
  request: string;
  shown: boolean;
  phase: "presented" | "complete";
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

type VerifiedResult = {
  request: string;
  shown: boolean;
  phase?: ResultDetail["phase"];
};

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
  const verifiedPhases: ResultDetail["phase"][] = [];
  let timeoutClears = 0;
  const trackedClearTimeout = (timeout: ReturnType<typeof setTimeout>) => {
    timeoutClears += 1;
    clearTimeout(timeout);
  };
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
    verify: (event: string, result: VerifiedResult) => Promise<boolean>,
    promise: PromiseConstructor,
    setTimer: typeof setTimeout,
    clearTimer: (timeout: ReturnType<typeof setTimeout>) => void,
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
    async (_event, result) => {
      if (result.phase) verifiedPhases.push(result.phase);
      return true;
    },
    Promise,
    setTimeout,
    trackedClearTimeout,
    Reflect.apply,
    FakeWindow.prototype.addEventListener,
    FakeWindow.prototype.removeEventListener,
    window,
    () => "0123456789abcdef0123456789abcdef",
  );

  return {
    call,
    verifiedPhases,
    get timeoutClears() {
      return timeoutClears;
    },
    dispatch(shown: boolean, phase: ResultDetail["phase"]) {
      const request = emittedPayload?.request;
      expect(request).toBeString();
      window.dispatch("carrier:context-menu-result", {
        request: request ?? "",
        shown,
        phase,
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
  success.dispatch(true, "presented");
  await flushVerification();
  expect(successState).toBe("pending");
  expect(success.timeoutClears).toBe(1);
  success.dispatch(true, "presented");
  await flushVerification();
  expect(successState).toBe("pending");
  expect(success.timeoutClears).toBe(1);
  success.dispatch(true, "complete");
  await successCall;
  expect(successState).toBe("resolved");
  expect(success.timeoutClears).toBe(2);
  expect(success.verifiedPhases).toEqual(["presented", "presented", "complete"]);

  const failure = await nativeCallFactory();
  const failureCall = failure.call(
    "carrier:context-menu",
    "shown",
    "failed",
    "timed out",
    { items: [] },
    true,
  );
  failure.dispatch(true, "presented");
  await flushVerification();
  failure.dispatch(false, "complete");
  await expect(failureCall).rejects.toThrow("failed");
  expect(failure.verifiedPhases).toEqual(["presented", "complete"]);
});

type ReplyResult = (id: number, attempt: number, ok: boolean) => Promise<unknown>;

const replyResultFactory = async (
  authorizedEmit: ((event: string, payload: Record<string, unknown>) => Promise<string>) | null,
) => {
  const source = await Bun.file(
    new URL("../../../../src-tauri/src/window.rs", import.meta.url),
  ).text();
  const start = source.indexOf("  var carrierReplyResult = function");
  const end = source.indexOf("\n\n", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const exact = source.slice(start, end).replaceAll("{{", "{").replaceAll("}}", "}");
  return new Function(
    "carrierAuthorizedEmit",
    "NativePromise",
    `${exact}\nreturn carrierReplyResult;`,
  )(authorizedEmit, Promise) as ReplyResult;
};

test("quick-reply results carry the id, attempt and outcome over the authenticated bridge", async () => {
  const emitted: { event: string; payload: Record<string, unknown> }[] = [];
  const replyResult = await replyResultFactory(async (event, payload) => {
    emitted.push({ event, payload });
    return "sent";
  });

  await expect(replyResult(7, 2, false)).resolves.toBe("sent");
  expect(emitted).toEqual([
    { event: "carrier:reply-result", payload: { id: 7, attempt: 2, ok: false } },
  ]);
});

test("quick-reply results reject when the authenticated bridge is unavailable", async () => {
  const replyResult = await replyResultFactory(null);

  await expect(replyResult(1, 1, true)).rejects.toThrow("native bridge unavailable");
});
