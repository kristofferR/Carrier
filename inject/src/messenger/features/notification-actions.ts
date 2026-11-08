/* ---------------- Notification React and Mark as Read ----------------- */
// Native evals these when a notification's React or Mark as Read button is
// pressed. Both call Messenger's own modules (see lib/notification-actions.ts),
// so they never navigate the page or raise the window.

import { diag } from "../bridge";
import { actionTargetFor } from "../lib/action-target";
import {
  type ActionOutcome,
  type Load,
  markThreadRead,
  reactToMessage,
} from "../lib/notification-actions";
import { threadPathId } from "../lib/threads";

const BUDGET_MS = 12_000;

type Run = (
  load: Load,
  thread: string,
  target: NonNullable<ReturnType<typeof actionTargetFor>>,
  deadline: number,
) => Promise<ActionOutcome>;

function pageAction(name: string, run: Run) {
  return (path: string, target: unknown, id: number, attempt: number, budgetMs: number) => {
    const report = (ok: boolean) =>
      chatpaneReplyResult(id, attempt, ok).catch(() =>
        diag(`${name}.ack`, `${name} acknowledgement emit failed`),
      );
    const thread = threadPathId(path);
    // Act only under the account the notification arrived for.
    const notified = actionTargetFor(target, document.cookie);
    const load = (window as unknown as { require?: unknown }).require;
    if (
      !thread ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      !notified ||
      typeof load !== "function"
    ) {
      void report(false);
      return;
    }
    // Native passes what is left of its acknowledgement wait: never finish
    // after it has reported failure.
    const budget = Math.min(Number(budgetMs) || 0, BUDGET_MS);
    if (budget <= 0) {
      void report(false);
      return;
    }
    const deadline = Date.now() + budget;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void Promise.race([
      run(load as Load, thread, notified, deadline),
      new Promise<ActionOutcome>((resolve) => {
        timer = setTimeout(() => resolve("timed-out"), budget);
      }),
    ])
      .catch(() => "exception")
      .then((outcome) => {
        clearTimeout(timer);
        if (outcome !== "ok") diag(`${name}.failed`, `${name} stopped: ${outcome}`);
        void report(outcome === "ok");
      });
  };
}

export function initNotificationActions() {
  window.__chatpaneMarkRead = pageAction("mark-read", (load, thread, _target, deadline) =>
    markThreadRead(load, thread, deadline),
  );
  window.__chatpaneQuickReact = pageAction("react", async (load, thread, target, deadline) =>
    target.message && target.reaction
      ? reactToMessage(load, {
          threadId: thread,
          messageId: target.message,
          account: target.account,
          reaction: target.reaction,
          deadline,
        })
      : "no-message",
  );
}
