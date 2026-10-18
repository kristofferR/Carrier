import { invoke } from "../bridge";
import { accountScopedStorageKey } from "../lib/threads";
import { FacebookWorkerRecovery, hasSoleMessengerWindow } from "../lib/worker-recovery";
import { DedicatedWorkerReplacement } from "../lib/worker-replacement";

const loadFacebookModule = (name: string) => {
  const page = window as unknown as { require?: (name: string) => unknown };
  return page.require?.(name);
};

export const workerReplacement = new DedicatedWorkerReplacement(loadFacebookModule);

export const workerRecovery = new FacebookWorkerRecovery(
  loadFacebookModule,
  () => accountScopedStorageKey("carrier-worker-recovery", document.cookie) ?? undefined,
  async () => {
    if (
      window.__CARRIER_SETTINGS__?.multi_instance !== false ||
      typeof window.BroadcastChannel !== "function"
    ) {
      return false;
    }
    try {
      const windows = await invoke("plugin:window|get_all_windows");
      return (
        window.__CARRIER_SETTINGS__?.multi_instance === false &&
        typeof window.BroadcastChannel === "function" &&
        hasSoleMessengerWindow(windows)
      );
    } catch (_) {
      return false;
    }
  },
);
