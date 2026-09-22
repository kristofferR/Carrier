import { accountScopedStorageKey } from "../lib/threads";
import { FacebookWorkerRecovery } from "../lib/worker-recovery";

export const workerRecovery = new FacebookWorkerRecovery(
  (name) => {
    const page = window as unknown as { require?: (name: string) => unknown };
    return page.require?.(name);
  },
  () => accountScopedStorageKey("carrier-worker-recovery", document.cookie) ?? undefined,
);
