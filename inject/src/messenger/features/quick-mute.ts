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
import { conversationInfoButton } from "./thread-nav";

const POLL_MS = 250;
const MUTE_BUDGET_MS = 12_000;

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
const label = (el: Element) => el.getAttribute("aria-label") || el.textContent || "";

/** The open thread's Mute / Unmute control, if the info pane has rendered it. */
function threadMuteControl(): { muted: boolean | null; trigger: HTMLElement | null } {
  let trigger: HTMLElement | null = null;
  for (const el of document.querySelectorAll<HTMLElement>(
    '[role="main"] [role="button"][aria-label], [role="main"] button[aria-label]',
  )) {
    if (!isShown(el)) continue;
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

async function mute(path: string): Promise<boolean> {
  const wantedThread = threadPathId(path);
  if (
    !wantedThread ||
    (threadIdFromHref(location.pathname) !== wantedThread &&
      window.__carrierOpenThread?.(path) !== true)
  ) {
    diag("quick-mute.open", "validated thread could not be opened");
    return false;
  }

  // A dialog left mounted by an earlier hidden-window mute must not be reused.
  const stale = new Set<Element>(document.querySelectorAll('[role="dialog"]'));
  const deadline = Date.now() + MUTE_BUDGET_MS;
  let phase: QuickMutePhase = "waiting";
  let infoRequested = false;
  let openedInfo = false;
  try {
    while (true) {
      const control = threadMuteControl();
      const dialog = phase === "waiting" ? null : muteDialog(stale);
      const snapshot: QuickMuteSnapshot = {
        threadMatches: threadIdFromHref(location.pathname) === wantedThread,
        muted: control.muted,
        infoRequested,
        dialog: !dialog ? "none" : radioSelected(dialog.radio) ? "ready" : "unselected",
      };
      const decision = decideQuickMute(phase, snapshot, Date.now() >= deadline);
      phase = decision.phase;

      switch (decision.action) {
        case "open-info": {
          infoRequested = true;
          const info = conversationInfoButton();
          if (info && info.getAttribute("aria-expanded") !== "true") {
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
  window.__carrierQuickMute = (path, id, attempt) => {
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
    void withComposerDeliveryWhenAvailable(() => mute(path))
      .then((ok) => report(ok))
      .catch(() => {
        diag("quick-mute.exception", "mute flow raised an exception");
        void report(false);
      });
  };
}
