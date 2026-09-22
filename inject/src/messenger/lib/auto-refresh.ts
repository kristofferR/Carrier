export type ScheduledRefreshReason = "rate-limit" | "rate-limit-manual" | "manual";

export interface PowerSnapshot {
  sleeping: boolean;
  resume_generation: number;
  last_resume_at_ms?: number | null;
}

/** Repeated native snapshots repair missed events without rearming a reload. */
export class PowerStateTracker {
  private previous: PowerSnapshot | undefined;

  constructor(private readonly documentCreatedAt: number) {}

  update(snapshot: PowerSnapshot): boolean {
    const previous = this.previous;
    this.previous = snapshot;
    // A document can predate the wake even if every earlier snapshot was
    // dropped. Compare native wall time with the document's time origin to
    // distinguish it from a fresh post-wake document on the first delivery.
    return (
      !snapshot.sleeping &&
      (previous
        ? previous.sleeping || previous.resume_generation !== snapshot.resume_generation
        : (snapshot.last_resume_at_ms ?? 0) > this.documentCreatedAt)
    );
  }
}

export const canReplacePendingRefresh = (
  pending: ScheduledRefreshReason | null,
  next: ScheduledRefreshReason,
) => {
  if (pending === "rate-limit-manual") return false;
  return next === "rate-limit-manual" || pending !== "manual" || next === "manual";
};
