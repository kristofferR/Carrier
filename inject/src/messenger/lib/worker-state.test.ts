import { expect, test } from "bun:test";
import { isMissingWorkerStateRoute, observeWorkerConnection } from "./worker-state";

test("cached subscription values cannot verify a request; repeated fresh values can", async () => {
  const listeners = new Set<(value: unknown) => void>();
  const observation = observeWorkerConnection({
    onSet: (listener) => {
      listener(true);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  })!;
  let completed = false;
  void observation.value.then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  observation.start();
  for (const listener of listeners) listener(true);
  expect(await observation.value).toBe(true);
  observation.dispose();
  observation.dispose();
  expect(listeners.size).toBe(0);
});

test("disposing a timed-out observation releases waiters and ignores late notifications", async () => {
  let notify: ((value: unknown) => void) | undefined;
  const observation = observeWorkerConnection({
    onSet: (listener) => {
      notify = listener;
      return () => {};
    },
  })!;
  observation.start();
  observation.dispose();
  observation.start();
  notify?.(true);
  expect(await observation.value).toBeUndefined();
});

test("unknown state values do not certify a connection", async () => {
  let notify: ((value: unknown) => void) | undefined;
  const observation = observeWorkerConnection({
    onSet: (listener) => {
      notify = listener;
      return () => {};
    },
  })!;
  observation.start();
  notify?.("true");
  expect(await observation.value).toBeUndefined();
  observation.dispose();
});

test("incompatible cleanup cannot cause repeated listener registration", () => {
  let subscriptions = 0;
  const state = {
    onSet: () => {
      subscriptions++;
      return undefined;
    },
  };
  expect(observeWorkerConnection(state)).toBeUndefined();
  expect(observeWorkerConnection(state)).toBeUndefined();
  expect(subscriptions).toBe(1);
});

test("only the known missing-route error enables the heartbeat fallback", () => {
  expect(
    isMissingWorkerStateRoute(
      new Error("resendWorkerStateManagerValuesToMainThread is not defined for backend"),
    ),
  ).toBe(true);
  expect(isMissingWorkerStateRoute(new Error("Worker lock timeout"))).toBe(false);
  expect(isMissingWorkerStateRoute(new Error("backend initialization failed"))).toBe(false);
  expect(isMissingWorkerStateRoute(undefined)).toBe(false);
});
