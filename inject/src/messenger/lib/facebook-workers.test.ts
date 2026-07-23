import { describe, expect, mock, test } from "bun:test";
import {
  type FacebookWorkerLike,
  isResponsivenessWorkerMessage,
  optimizeFacebookWorker,
} from "./facebook-workers";

function workerHarness() {
  const postMessage = mock(() => undefined);
  const terminate = mock(() => undefined);
  const worker: FacebookWorkerLike = { postMessage, terminate };
  return { worker, postMessage, terminate };
}

describe("Facebook worker optimization", () => {
  test("recognizes only the dedicated responsiveness samples", () => {
    expect(isResponsivenessWorkerMessage({ type: "responsiveness" })).toBe(true);
    expect(isResponsivenessWorkerMessage({ type: "endpoint_started" })).toBe(false);
    expect(isResponsivenessWorkerMessage("responsiveness")).toBe(false);
  });

  test("terminates the profiler and suppresses all later messages", () => {
    const { worker, postMessage, terminate } = workerHarness();
    const onStopped = mock(() => undefined);
    optimizeFacebookWorker(worker, () => true, onStopped);

    worker.postMessage({ type: "endpoint_started" });
    worker.postMessage({ type: "responsiveness" });
    worker.postMessage({ type: "responsiveness" });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  test("forwards non-profiler messages and transfer options unchanged", () => {
    const { worker, postMessage, terminate } = workerHarness();
    const message = { type: "decode", payload: new ArrayBuffer(4) };
    const transfer = [message.payload];
    optimizeFacebookWorker(worker, () => true);

    worker.postMessage(message, transfer);

    expect(postMessage).toHaveBeenCalledWith(message, transfer);
    expect(terminate).not.toHaveBeenCalled();
  });

  test("leaves the worker untouched when telemetry blocking is disabled", () => {
    const { worker, postMessage, terminate } = workerHarness();
    optimizeFacebookWorker(worker, () => false);

    worker.postMessage({ type: "responsiveness" });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(terminate).not.toHaveBeenCalled();
  });
});
