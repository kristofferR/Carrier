/* ------------------- Notification "Mute" action ---------------------- */
// Mutes a conversation from its notification without raising the window, by
// driving Messenger's own info-pane Mute control and duration dialog. The
// window is usually hidden, so the dialog's exit animation stalls until it is
// shown again; success is read from the thread's control flipping to Unmute.
import { diag } from "../bridge";
import { conversationMuteFromLabel, mutedThreads, muteStateAfterExplicitAction } from "../lib/mute";
import {
  decideQuickMute,
  QUICK_MUTE_DURATION_MS,
  type QuickMutePhase,
  type QuickMuteSnapshot,
} from "../lib/quick-mute";
import { withComposerDeliveryWhenAvailable } from "../lib/scheduled-send";
import { threadIdFromHref, threadPathId } from "../lib/threads";
import { isShown } from "./conversation-actions";
import { conversationInfoButton, openThreadForAction } from "./thread-nav";

const POLL_MS = 250;
const MUTE_BUDGET_MS = 12_000;

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
const label = (el: Element) => el.getAttribute("aria-label") || el.textContent || "";

/** The open thread's Mute / Unmute control, if the info pane has rendered it. */
function threadMuteControl(stale: Set<Element>): {
  muted: boolean | null;
  trigger: HTMLElement | null;
} {
  let trigger: HTMLElement | null = null;
  for (const el of document.querySelectorAll<HTMLElement>(
    '[role="main"] [role="button"][aria-label], [role="main"] button[aria-label]',
  )) {
    if (stale.has(el) || !isShown(el)) continue;
    const muted = conversationMuteFromLabel(el.getAttribute("aria-label") || "");
    if (muted === true) return { muted, trigger: null };
    if (muted === false) trigger ??= el;
  }
  return { muted: trigger ? false : null, trigger };
}

function muteDialog(stale: Set<Element>) {
  for (const dialog of document.querySelectorAll<HTMLElement>('[role="dialog"]')) {
    if (stale.has(dialog)) continue;
    const radio = dialog.querySelector<HTMLInputElement>(
      `input[type="radio"][value="${QUICK_MUTE_DURATION_MS}"]`,
    );
    if (!radio) continue;
    // Messenger renders a second, hidden and disabled copy of the buttons.
    const confirm = [...dialog.querySelectorAll<HTMLElement>('[role="button"], button')].find(
      (button) =>
        isShown(button) &&
        getComputedStyle(button).visibility !== "hidden" &&
        button.getAttribute("aria-disabled") !== "true" &&
        muteStateAfterExplicitAction(label(button)) === true,
    );
    if (confirm) return { radio, confirm };
  }
  return null;
}

// Messenger reflects the choice in aria-checked; the DOM `checked` stays false.
const radioSelected = (radio: HTMLInputElement) =>
  radio.checked || radio.getAttribute("aria-checked") === "true";

async function mute(path: string, deadline: number): Promise<boolean> {
  // Expired while queued: the native side has already given up on it.
  if (Date.now() >= deadline) return false;
  const wantedThread = threadPathId(path);
  // Controls rendered before navigating belong to the previous conversation.
  const stale = new Set<Element>(
    threadIdFromHref(location.pathname) === wantedThread
      ? []
      : document.querySelectorAll('[role="main"] [role="button"]'),
  );
  const paneReady = openThreadForAction(path);
  if (!wantedThread || !paneReady) {
    diag("quick-mute.open", "validated thread could not be opened");
    return false;
  }

  // A dialog left mounted by an earlier hidden-window mute must not be reused.
  const staleDialogs = new Set<Element>(document.querySelectorAll('[role="dialog"]'));
  let phase: QuickMutePhase = "waiting";
  let infoRequested = false;
  let openedInfo = false;
  try {
    while (true) {
      const control = threadMuteControl(stale);
      const dialog = phase === "waiting" ? null : muteDialog(staleDialogs);
      const snapshot: QuickMuteSnapshot = {
        threadMatches: paneReady(),
        muted: control.muted,
        infoRequested,
        dialog: !dialog ? "none" : radioSelected(dialog.radio) ? "ready" : "unselected",
      };
      const decision = decideQuickMute(phase, snapshot, Date.now() >= deadline);
      phase = decision.phase;

      switch (decision.action) {
        case "open-info": {
          // The header can mount after the route changes; keep looking until
          // the info button exists.
          const info = conversationInfoButton();
          if (!info || stale.has(info)) break;
          infoRequested = true;
          if (info.getAttribute("aria-expanded") !== "true") {
            info.click();
            openedInfo = true;
          }
          break;
        }
        case "open-dialog":
          control.trigger?.click();
          break;
        case "select":
          dialog?.radio.click();
          break;
        case "confirm":
          dialog?.confirm.click();
          break;
        case "success":
          mutedThreads.observe(wantedThread, true);
          window.dispatchEvent(
            new CustomEvent("carrier:thread-mute", { detail: { id: wantedThread, muted: true } }),
          );
          return true;
        case "failure":
          diag("quick-mute.delivery", `mute flow stopped in ${phase}`);
          return false;
        case "wait":
          break;
      }
      await pause();
    }
  } finally {
    const info = openedInfo ? conversationInfoButton() : null;
    if (info?.getAttribute("aria-expanded") === "true") info.click();
  }
}

export function initQuickMute() {
  window.__carrierQuickMute = (path, id, attempt, budgetMs) => {
    const report = (ok: boolean) =>
      carrierReplyResult(id, attempt, ok).catch(() =>
        diag("quick-mute.ack", "mute acknowledgement emit failed"),
      );
    if (threadPathId(path) === null || !Number.isSafeInteger(id) || id <= 0) {
      void report(false);
      return;
    }
    // Serialized with notification replies and scheduled sends: all of them
    // navigate the same hidden page.
    // Native passes what is left of its acknowledgement wait, including after a
    // hard-navigation resume, and queue time counts against it: a mute never
    // lands after native has reported failure.
    const deadline = Date.now() + Math.min(Number(budgetMs) || 0, MUTE_BUDGET_MS);
    void withComposerDeliveryWhenAvailable(() => mute(path, deadline))
      .then((ok) => report(ok))
      .catch(() => {
        diag("quick-mute.exception", "mute flow raised an exception");
        void report(false);
      });
  };
}
