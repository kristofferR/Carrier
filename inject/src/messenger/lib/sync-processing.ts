const STALL_MS = 120_000;
const MAX_SAMPLE_GAP_MS = 15_000;
const MAX_PENDING = 128;

/** Observe transaction boundaries only. Never retain events, errors, or message IDs. */
export class SyncProcessingProgress {
  private readonly pending = new Map<number, number>();
  private readonly wrapped = new WeakSet<object>();
  private activeMs = 0;
  private lastSample: { at: number; active: boolean } | undefined;
  private scope: string | undefined;
  private epoch = 0;
  private observed = false;
  private completed = 0;
  private failed = 0;
  private omitted = 0;

  constructor(private readonly accountScope: () => string | undefined) {}

  private syncScope(): boolean {
    const scope = this.accountScope();
    if (scope !== this.scope) {
      this.scope = scope;
      this.epoch++;
      this.pending.clear();
      this.completed = this.failed = this.omitted = 0;
      this.observed = false;
      this.lastSample = undefined;
      this.activeMs = 0;
    }
    return scope !== undefined;
  }

  observeLogger(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const exports = value as Record<string, unknown>;
    const keys = ["start", "endSuccess", "endFailure"] as const;
    // Do not partially patch an unfamiliar/frozen logger or invoke its getters.
    if (
      !keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(exports, key);
        return descriptor?.writable === true && typeof descriptor.value === "function";
      })
    ) {
      return;
    }
    for (const key of keys) {
      const original = exports[key];
      if (typeof original !== "function" || this.wrapped.has(original)) continue;
      const wrapper = new Proxy(original, {
        apply: (target, receiver, args: unknown[]) => {
          const result = Reflect.apply(target, receiver, args);
          try {
            if (this.syncScope()) this.record(key, args[0]);
          } catch (_) {
            // Diagnostics cannot change the transaction's result or exception.
          }
          return result;
        },
      });
      try {
        exports[key] = wrapper;
        this.wrapped.add(wrapper);
      } catch (_) {}
    }
  }

  private record(kind: "start" | "endSuccess" | "endFailure", instance: unknown): void {
    if (typeof instance !== "number" || !Number.isSafeInteger(instance)) return;
    this.observed = true;
    if (kind === "start") {
      if (this.pending.has(instance)) return;
      if (this.pending.size >= MAX_PENDING) {
        this.omitted++;
        return;
      }
      this.pending.set(instance, this.activeMs);
    } else if (this.pending.delete(instance)) {
      if (kind === "endSuccess") this.completed++;
      else this.failed++;
    }
  }

  sample(at: number, active: boolean) {
    this.syncScope();
    const previous = this.lastSample;
    const delta = previous ? at - previous.at : 0;
    // Hidden/offline time and suspended timers do not establish a DB stall.
    if (active && previous?.active && delta > 0 && delta <= MAX_SAMPLE_GAP_MS) {
      this.activeMs += delta;
    }
    this.lastSample = { at, active };
    let oldestActiveMs = 0;
    for (const startedAt of this.pending.values()) {
      oldestActiveMs = Math.max(oldestActiveMs, this.activeMs - startedAt);
    }
    return {
      epoch: this.epoch,
      observed: this.observed,
      pending: this.pending.size,
      completed: this.completed,
      failed: this.failed,
      omitted: this.omitted,
      oldestActiveMs: Math.round(oldestActiveMs),
      stalled: oldestActiveMs >= STALL_MS,
    };
  }
}
