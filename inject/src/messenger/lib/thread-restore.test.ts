import { describe, expect, test } from "bun:test";
import { THREAD_RESTORE_WAIT_MS, threadRestoreStep } from "./thread-restore";

describe("recycled thread restore", () => {
  const step = (overrides: Partial<Parameters<typeof threadRestoreStep>[0]>) =>
    threadRestoreStep({ done: false, onThread: false, rowFound: false, waitedMs: 0, ...overrides });

  test("stops once the thread shows or was already restored", () => {
    expect(step({ onThread: true, rowFound: true })).toBe("done");
    expect(step({ done: true, waitedMs: THREAD_RESTORE_WAIT_MS })).toBe("done");
  });

  test("clicks the row when rendered and waits for the list otherwise", () => {
    expect(step({ rowFound: true })).toBe("click");
    expect(step({ waitedMs: THREAD_RESTORE_WAIT_MS - 1 })).toBe("wait");
  });

  test("loads the thread directly once the wait runs out, even with a row", () => {
    expect(step({ waitedMs: THREAD_RESTORE_WAIT_MS })).toBe("load");
    expect(step({ rowFound: true, waitedMs: THREAD_RESTORE_WAIT_MS })).toBe("load");
  });
});
