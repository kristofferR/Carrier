export interface FacebookWorkerLike {
  postMessage(message: unknown, transferOrOptions?: unknown): void;
  terminate(): void;
}

export function isResponsivenessWorkerMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  return (message as Record<string, unknown>).type === "responsiveness";
}

export function isResponsivenessProfilerHandshake(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  return (message as Record<string, unknown>).type === "endpoint_started";
}

/**
 * Stops Facebook's dedicated responsiveness profiler on its first sample.
 * Facebook uses a generic worker bootstrap, so the stable identity is its
 * endpoint_started → responsiveness protocol rather than a hashed script URL.
 */
export function optimizeFacebookWorker(
  worker: FacebookWorkerLike,
  shouldBlockTelemetry: () => boolean,
  onStopped: () => void = () => {},
): FacebookWorkerLike {
  const nativePostMessage = worker.postMessage;
  let profilerHandshakeSeen = false;
  let stopped = false;

  worker.postMessage = function (this: FacebookWorkerLike, ...args: unknown[]) {
    if (stopped) return;
    const message = args[0];
    if (isResponsivenessProfilerHandshake(message)) profilerHandshakeSeen = true;
    if (profilerHandshakeSeen && shouldBlockTelemetry() && isResponsivenessWorkerMessage(message)) {
      stopped = true;
      try {
        worker.terminate();
      } catch (_) {}
      onStopped();
      return;
    }
    Reflect.apply(nativePostMessage, this, args);
  };

  return worker;
}
