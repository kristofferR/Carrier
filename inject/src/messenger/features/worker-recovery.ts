import { invoke } from "../bridge";
import { accountScopedStorageKey } from "../lib/threads";
import { FacebookWorkerRecovery, hasSoleMessengerWindow } from "../lib/worker-recovery";

export const workerRecovery = new FacebookWorkerRecovery(
  (name) => {
    const page = window as unknown as { require?: (name: string) => unknown };
    return page.require?.(name);
  },
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
