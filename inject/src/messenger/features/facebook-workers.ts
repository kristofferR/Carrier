import { optimizeFacebookWorker } from "../lib/facebook-workers";

export function initFacebookWorkerOptimization() {
  if (typeof window.Worker !== "function" || typeof Proxy !== "function") return;

  const state = { responsivenessWorkersStopped: 0 };
  window.__CHATPANE_WORKER_OPTIMIZATION__ = state;
  const NativeWorker = window.Worker;
  window.Worker = new Proxy(NativeWorker, {
    construct(Target, args, NewTarget) {
      const worker = Reflect.construct(Target, args, NewTarget) as Worker;
      return optimizeFacebookWorker(
        worker,
        () => window.__CHATPANE_SETTINGS__?.block_telemetry === true,
        () => {
          state.responsivenessWorkersStopped++;
        },
      ) as Worker;
    },
  });
}
