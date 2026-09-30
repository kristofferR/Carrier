/** How long one document waits for the conversation's row before loading it. */
export const THREAD_RESTORE_WAIT_MS = 30_000;

export type ThreadRestoreStep = "done" | "click" | "wait" | "load";

/**
 * One attempt at reopening a recycled window's conversation. Facebook's home
 * can replace itself with another full load, so every document retries until
 * the thread shows; `done` records that once per window. Clicking the row
 * keeps the switch inside the page; a direct load is the last resort, also
 * when clicking never lands on the thread.
 */
export function threadRestoreStep(input: {
  done: boolean;
  onThread: boolean;
  rowFound: boolean;
  waitedMs: number;
}): ThreadRestoreStep {
  if (input.done || input.onThread) return "done";
  if (input.waitedMs >= THREAD_RESTORE_WAIT_MS) return "load";
  return input.rowFound ? "click" : "wait";
}
