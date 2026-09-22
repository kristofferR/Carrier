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
      return hasSoleMessengerWindow(await invoke("plugin:window|get_all_windows"));
    } catch (_) {
      return false;
    }
  },
);
