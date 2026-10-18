type ModuleLoader = (name: string) => unknown;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Messenger only restarts shared workers in place. A dedicated worker is meant
 * to live as long as its page, so a second one created after the first served
 * the page leaves the page's message state unproven: on 2026-10-18 the
 * replacement's encrypted connection verified as healthy while the page never
 * showed new messages again. Only a reload restored it.
 */
export class DedicatedWorkerReplacement {
  private readonly wrapped = new WeakSet<object>();
  private current: object | undefined;
  /** Some worker in this document completed backend setup. */
  private served = false;
  private replacedWorker = false;

  constructor(private readonly load: ModuleLoader) {}

  private setupSucceeded(): boolean {
    try {
      const state = record(this.load("MAWWaitForBackendSetup"));
      const successful = state?.isBackendSetupSuccessful;
      return typeof successful === "function" && successful.call(state) === true;
    } catch (_) {
      return false;
    }
  }

  observeLifecycleExports(value: unknown): void {
    const exports = record(value);
    const create = exports?.createWorkerIfNone;
    if (!exports || typeof create !== "function" || this.wrapped.has(create)) return;
    const owner = this;
    const wrapped = new Proxy(create, {
      apply(target, receiver, args: unknown[]) {
        const result = Reflect.apply(target, receiver, args);
        try {
          owner.created(result);
        } catch (_) {}
        return result;
      },
    });
    try {
      exports.createWorkerIfNone = wrapped;
      this.wrapped.add(wrapped);
    } catch (_) {
      // Frozen or changed exports must never prevent Messenger from booting.
    }
  }

  private created(result: unknown): void {
    const creation = record(result);
    // Messenger hands every caller the same promise while a worker exists.
    if (!creation || typeof creation.then !== "function" || creation === this.current) return;
    if (this.current && !this.served && this.setupSucceeded()) this.served = true;
    this.current = creation;
    if (!this.served) return;
    (creation as unknown as PromiseLike<unknown>).then(
      (value) => {
        if (record(value)?.workerID === "dedicated") this.replacedWorker = true;
      },
      () => {},
    );
  }

  /**
   * Sample periodically. A worker serves the page once its backend setup
   * succeeds, so failed startup retries never count as a replacement.
   */
  replaced(): boolean {
    if (this.current && !this.served && this.setupSucceeded()) this.served = true;
    return this.replacedWorker;
  }
}
