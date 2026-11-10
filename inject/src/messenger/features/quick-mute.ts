/* ------------------- Notification "Mute" action ---------------------- */
// Mutes a conversation for 8 hours from its notification, through the
// procedure behind Messenger's own mute (see lib/notification-actions.ts). It
// opens nothing and reads no labels, so it works hidden and in every language.

import { diag } from "../bridge";
import { actionTargetFor } from "../lib/action-target";
import { noteExplicitAction } from "../lib/composer-focus";
import { loadFacebookModules, pageRequire } from "../lib/facebook-loader";
import { mutedThreads } from "../lib/mute";
import { muteThread } from "../lib/notification-actions";
import { threadPathId } from "../lib/threads";

export const QUICK_MUTE_MS = 8 * 60 * 60 * 1000;
const MUTE_BUDGET_MS = 12_000;
// One expiry per thread: re-muting replaces the earlier mute's timer.
const muteExpiries = new Map<string, ReturnType<typeof setTimeout>>();

/** Messenger's clock, which mute times are measured against. */
function serverNow(): number {
  try {
    const time = pageRequire()?.("ServerTime") as { getMillis?(): number } | undefined;
    const now = time?.getMillis?.();
    if (typeof now === "number" && Number.isFinite(now)) return now;
  } catch {}
  return Date.now();
}

async function mute(path: string, deadline: number): Promise<boolean> {
  const thread = threadPathId(path);
  // Expired while queued: the native side has already given up on it.
  if (!thread || Date.now() >= deadline) return false;
  const load = pageRequire();
  if (!load) return false;
  const procedure = "LSOptimisticMuteThreadStoredProcedure";
  try {
    load(procedure);
  } catch {
    // It comes with the code of the chat list's conversation menu, which
    // loads when one is first opened.
    await loadFacebookModules(load, ["MWThreadListHoverButtonDropdownMenu.react"], 5000).catch(
      () => {},
    );
  }
  await loadFacebookModules(load, ["LSFactory", "LSIntEnum", procedure], 5000);
  const outcome = await muteThread(load, thread, serverNow() + QUICK_MUTE_MS, deadline);
  if (outcome !== "ok" && outcome !== "kept") {
    diag("quick-mute.delivery", `mute stopped: ${outcome}`);
    return false;
  }
  mutedThreads.observe(thread, true);
  // Dispatched first so the listener does not retire the expiry set next.
  window.dispatchEvent(
    new CustomEvent("chatpane:thread-mute", { detail: { id: thread, muted: true } }),
  );
  // A mute kept from before keeps its own end, and any expiry set for it.
  if (outcome === "kept") return true;
  // Don't keep suppressing past the 8 hours if the row isn't mounted to
  // observe the change.
  muteExpiries.set(
    thread,
    setTimeout(() => {
      muteExpiries.delete(thread);
      mutedThreads.invalidateMute(thread);
      // The unread badge keeps its own muted set; tell it too.
      window.dispatchEvent(
        new CustomEvent("chatpane:thread-mute", { detail: { id: thread, muted: false } }),
      );
    }, QUICK_MUTE_MS),
  );
  return true;
}

export function initQuickMute() {
  // Any later mute change (a manual unmute or re-mute, or another quick mute)
  // replaces the state a pending quick-mute expiry would clear.
  window.addEventListener("chatpane:thread-mute", (event) => {
    const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
    if (typeof id !== "string") return;
    clearTimeout(muteExpiries.get(id));
    muteExpiries.delete(id);
  });
  window.__chatpaneQuickMute = (path, target, id, attempt, budgetMs) => {
    noteExplicitAction();
    const report = (ok: boolean) =>
      chatpaneReplyResult(id, attempt, ok).catch(() =>
        diag("quick-mute.ack", "mute acknowledgement emit failed"),
      );
    // Act only under the account the notification arrived for.
    if (
      threadPathId(path) === null ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      !actionTargetFor(target, document.cookie)
    ) {
      void report(false);
      return;
    }
    // Native passes what is left of its acknowledgement wait: a mute never
    // lands after native has reported failure.
    const deadline = Date.now() + Math.min(Number(budgetMs) || 0, MUTE_BUDGET_MS);
    void mute(path, deadline)
      .then((ok) => report(ok))
      .catch(() => {
        diag("quick-mute.exception", "mute flow raised an exception");
        void report(false);
      });
  };
}
