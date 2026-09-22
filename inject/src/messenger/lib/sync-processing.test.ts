import { describe, expect, test } from "bun:test";
import { createFacebookModuleDefineInterceptor } from "./facebook-modules";
import { SyncProcessingProgress } from "./sync-processing";

function fixture() {
  let account: string | undefined = "account-a";
  const progress = new SyncProcessingProgress(() => account);
  const logger = {
    start: (_instance: unknown, _payload?: unknown) => "started",
    endSuccess: (_instance: unknown) => "success",
    endFailure: (_instance: unknown, _error?: unknown) => "failure",
  };
  progress.observeLogger(logger);
  progress.sample(0, true);
  return { progress, logger, account: (value: string | undefined) => (account = value) };
}

describe("sync processing diagnostics", () => {
  test("an unrelated completion cannot hide an older pending transaction", () => {
    const { progress, logger } = fixture();
    logger.start(1);
    for (let now = 5_000; now <= 120_000; now += 5_000) {
      logger.start(now);
      logger.endSuccess(now);
      progress.sample(now, true);
    }
    expect(progress.sample(120_000, true)).toMatchObject({
      stalled: true,
      pending: 1,
      completed: 24,
    });
    logger.endSuccess(1);
    expect(progress.sample(125_000, true)).toMatchObject({ stalled: false, pending: 0 });
  });

  test("idle, hidden, offline, and suspended time do not establish a stall", () => {
    const { progress, logger } = fixture();
    expect(progress.sample(500_000, true)).toMatchObject({ observed: false, stalled: false });
    logger.start(1);
    progress.sample(505_000, false);
    progress.sample(605_000, false);
    progress.sample(610_000, true);
    progress.sample(900_000, true);
    expect(progress.sample(905_000, true)).toMatchObject({ oldestActiveMs: 5_000, stalled: false });
  });

  test("preserves results, ignores payloads, and counts each completion once", () => {
    const { progress, logger } = fixture();
    const privatePayload = new Proxy(
      {},
      {
        get: () => {
          throw new Error("must not read");
        },
      },
    );
    progress.observeLogger(logger);
    expect(logger.start(1, privatePayload)).toBe("started");
    expect(logger.endFailure(1, privatePayload)).toBe("failure");
    logger.endFailure(1);
    logger.start("changed-abi", privatePayload);
    expect(progress.sample(0, true)).toEqual({
      observed: true,
      pending: 0,
      completed: 0,
      failed: 1,
      omitted: 0,
      oldestActiveMs: 0,
      stalled: false,
    });
  });

  test("does not change receivers, thrown errors, or frozen exports", () => {
    const progress = new SyncProcessingProgress(() => "account");
    const error = new Error("original");
    const logger = {
      start(this: unknown, _instance: number) {
        expect(this).toBe(logger);
        throw error;
      },
      endSuccess() {},
      endFailure() {},
    };
    progress.observeLogger(logger);
    expect(() => logger.start(1)).toThrow(error);
    expect(progress.sample(0, true).pending).toBe(0);
    const frozen = Object.freeze({ start() {}, endSuccess() {}, endFailure() {} });
    expect(() => progress.observeLogger(frozen)).not.toThrow();
  });

  test("bounds retained instance keys and resets on account changes", () => {
    const f = fixture();
    for (let id = 0; id < 200; id++) f.logger.start(id);
    expect(f.progress.sample(0, true)).toMatchObject({ pending: 128, omitted: 72 });
    f.account("account-b");
    expect(f.progress.sample(5_000, true)).toMatchObject({
      observed: false,
      pending: 0,
      omitted: 0,
    });
    f.logger.endFailure(1);
    expect(f.progress.sample(5_000, true).failed).toBe(0);
    f.account(undefined);
    f.logger.start(2);
    expect(f.progress.sample(10_000, true).pending).toBe(0);
  });

  test("observes the registered logger before its first transaction", () => {
    const progress = new SyncProcessingProgress(() => "account");
    const logger = {
      start: (_id: number) => {},
      endSuccess: (_id: number) => {},
      endFailure: (_id: number) => {},
    };
    const define = createFacebookModuleDefineInterceptor(
      (_name: unknown, _deps: unknown, factory: unknown) => {
        (factory as (...args: unknown[]) => unknown)(
          null,
          null,
          null,
          null,
          {},
          { exports: logger },
          logger,
        );
      },
      () => false,
      undefined,
      undefined,
      undefined,
      (exports) => progress.observeLogger(exports),
    );
    define("MAWBridgeUIEventQueueQPLLogger", [], () => undefined);
    logger.start(1);
    logger.endSuccess(1);
    expect(progress.sample(0, true).completed).toBe(1);
  });
});
