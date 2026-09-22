import { diag } from "../bridge";
import { SyncProcessingProgress } from "../lib/sync-processing";
import { accountScopedStorageKey } from "../lib/threads";

export const syncProcessing = new SyncProcessingProgress(() =>
  accountScopedStorageKey("carrier-sync-processing", document.cookie) ?? undefined,
);

let stalled = false;
let failures = 0;

/** Evidence for diagnosis, not a reason to replay batches or reset the database. */
export function sampleSyncProcessing(active: boolean) {
  const snapshot = syncProcessing.sample(performance.now(), active);
  if (snapshot.failed > failures) {
    diag("sync.processing-failed", `failed=${snapshot.failed} pending=${snapshot.pending}`);
  }
  failures = snapshot.failed;
  if (snapshot.stalled !== stalled) {
    stalled = snapshot.stalled;
    diag(
      stalled ? "sync.processing-stalled" : "sync.processing-resumed",
      `pending=${snapshot.pending} active_ms=${snapshot.oldestActiveMs} omitted=${snapshot.omitted}`,
    );
  }
  return snapshot;
}
