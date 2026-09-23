export type WorkerConnectionState = {
  isConnected?: () => unknown;
  onSet?: (listener: (value: unknown) => void) => unknown;
};

const unsupportedSubscriptions = new WeakSet<WorkerConnectionState>();

/** Observe a newly delivered value, including a repeated true/false value. */
export function observeWorkerConnection(
  state: WorkerConnectionState | undefined,
  now: () => number = () => performance.now(),
) {
  if (!state || unsupportedSubscriptions.has(state)) return;
  let listening = false;
  let disposed = false;
  let receivedAt: number | undefined;
  let resolve: ((value: boolean | undefined) => void) | undefined;
  const value = new Promise<boolean | undefined>((complete) => {
    resolve = complete;
  });
  let unsubscribe: unknown;
  try {
    const subscribe = state.onSet;
    if (typeof subscribe !== "function") return;
    unsubscribe = subscribe.call(state, (next) => {
      // A subscription API that immediately reports its cached value must not
      // satisfy a request we have not sent yet. Unknown values prove no state.
      if (listening && receivedAt === undefined) {
        receivedAt = now();
        resolve?.(typeof next === "boolean" ? next : undefined);
      }
    });
  } catch (_) {
    unsupportedSubscriptions.add(state);
    return;
  }
  if (typeof unsubscribe !== "function") {
    // Do not repeatedly register listeners if a changed API cannot remove them.
    unsupportedSubscriptions.add(state);
    return;
  }
  const stop = unsubscribe;
  return {
    value,
    get receivedAt() {
      return receivedAt;
    },
    start: () => {
      if (!disposed) listening = true;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      listening = false;
      resolve?.(undefined);
      try {
        stop();
      } catch (_) {
        unsupportedSubscriptions.add(state);
      }
    },
  };
}

export function isMissingWorkerStateRoute(error: unknown): boolean {
  const message = error && typeof error === "object" && "message" in error ? error.message : error;
  return (
    typeof message === "string" &&
    message.includes("resendWorkerStateManagerValuesToMainThread is not defined for backend")
  );
}
