import { diag } from "../bridge";
import { SyncProcessingProgress } from "../lib/sync-processing";
import { accountScopedStorageKey } from "../lib/threads";

export const syncProcessing = new SyncProcessingProgress(
  () => accountScopedStorageKey("carrier-sync-processing", document.cookie) ?? undefined,
);

export let syncProcessingStalled = false;
let failures = 0;
let epoch = 0;

/** Evidence for diagnosis, not a reason to replay batches or reset the database. */
export function sampleSyncProcessing(active: boolean) {
  const snapshot = syncProcessing.sample(performance.now(), active);
  if (snapshot.epoch !== epoch) {
    epoch = snapshot.epoch;
    failures = 0;
    syncProcessingStalled = false;
  }
  if (snapshot.failed > failures) {
    diag("sync.processing-failed", `failed=${snapshot.failed} pending=${snapshot.pending}`);
  }
  failures = snapshot.failed;
  if (snapshot.stalled !== syncProcessingStalled) {
    syncProcessingStalled = snapshot.stalled;
    diag(
      syncProcessingStalled ? "sync.processing-stalled" : "sync.processing-cleared",
      `pending=${snapshot.pending} active_ms=${snapshot.oldestActiveMs} omitted=${snapshot.omitted}`,
    );
  }
  return snapshot;
}
