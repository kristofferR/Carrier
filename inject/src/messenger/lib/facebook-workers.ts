export interface FacebookWorkerLike {
  postMessage(message: unknown, transferOrOptions?: unknown): void;
  terminate(): void;
}

export function isResponsivenessWorkerMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  return (message as Record<string, unknown>).type === "responsiveness";
}

/**
 * Stops Facebook's dedicated responsiveness profiler on its first sample.
 * Other workers and every non-profiler message retain their native behavior.
 */
export function optimizeFacebookWorker(
  worker: FacebookWorkerLike,
  shouldBlockTelemetry: () => boolean,
  onStopped: () => void = () => {},
): FacebookWorkerLike {
  const nativePostMessage = worker.postMessage;
  let stopped = false;

  worker.postMessage = function (this: FacebookWorkerLike, ...args: unknown[]) {
    if (stopped) return;
    if (shouldBlockTelemetry() && isResponsivenessWorkerMessage(args[0])) {
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
