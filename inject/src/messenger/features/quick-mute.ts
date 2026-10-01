/* ------------------- Notification "Mute" action ---------------------- */
// Mutes a conversation from its notification without raising the window, by
// driving Messenger's own info-pane controls and duration dialog. One
// Messenger variant offers "Mute notifications" directly; another nests Mute
// inside "Chat notifications". Success is read from an Unmute label, the
// confirmed dialog closing, or Carrier's own muted-thread tracking.
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

/** The "Chat notifications" control of the variant that nests Mute. */
function chatNotificationsControl(stale: Set<Element>): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(
    '[role="main"] [role="button"][aria-label="Chat notifications"]',
  ))
    if (!stale.has(el) && isShown(el)) return el;
  return null;
}

const visibleButtons = (root: Element) =>
  [...root.querySelectorAll<HTMLElement>('[role="button"], button')].filter(
    (button) =>
      isShown(button) &&
      getComputedStyle(button).visibility !== "hidden" &&
      button.getAttribute("aria-disabled") !== "true",
  );

/** The 8-hour choice: a radio carrying its duration in milliseconds, or in
 * the "Chat notifications" variant one labelled only by English text. */
function durationRadio(dialog: Element): HTMLElement | null {
  const input = dialog.querySelector<HTMLInputElement>(
    `input[type="radio"][value="${QUICK_MUTE_DURATION_MS}"]`,
  );
  if (input) return input;
  for (const radio of dialog.querySelectorAll<HTMLElement>('[role="radio"]'))
    if (isShown(radio) && /^for 8 hours$/i.test((radio.textContent || "").trim())) return radio;
  return null;
}

/** "Notifications for this chat": a dialog offering Mute, or Unmute when muted. */
function chooserDialog(stale: Set<Element>) {
  for (const dialog of document.querySelectorAll<HTMLElement>('[role="dialog"]')) {
    if (stale.has(dialog) || durationRadio(dialog)) continue;
    for (const button of visibleButtons(dialog)) {
      const muted = conversationMuteFromLabel(label(button));
      if (muted !== null) return { dialog, button, muted };
    }
  }
  return null;
}

function muteDialog(stale: Set<Element>) {
  for (const dialog of document.querySelectorAll<HTMLElement>('[role="dialog"]')) {
    if (stale.has(dialog)) continue;
    const radio = durationRadio(dialog);
    if (!radio) continue;
    // Messenger renders a second, hidden and disabled copy of the buttons. The
    // confirm button reads "Mute", or "Confirm" in the other variant.
    const confirm = visibleButtons(dialog).find(
      (button) =>
        muteStateAfterExplicitAction(label(button)) === true ||
        /^confirm$/i.test(label(button).trim()),
    );
    if (confirm) return { radio, confirm };
  }
  return null;
}

// Messenger reflects the choice in aria-checked; the DOM `checked` stays false.
const radioSelected = (radio: HTMLElement) =>
  (radio instanceof HTMLInputElement && radio.checked) ||
  radio.getAttribute("aria-checked") === "true";

async function mute(path: string, deadline: number): Promise<boolean> {
  // Expired while queued: the native side has already given up on it.
  if (Date.now() >= deadline) return false;
  const wantedThread = threadPathId(path);
  // Controls rendered before navigating belong to the previous conversation.
  const stale = new Set<Element>(
    threadIdFromHref(location.pathname) === wantedThread
      ? []
      : document.querySelectorAll('[role="main"] [role="button"], [role="main"] button'),
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
  // The exact header button this flow opened, so cleanup never closes a pane
  // the user opened on another conversation meanwhile.
  let openedInfo: HTMLElement | null = null;
  // The chooser this flow opened (closed again afterwards) and the confirm
  // button it pressed (its dialog closing is the evidence the mute applied).
  let openedChooser: HTMLElement | null = null;
  let confirmed: HTMLElement | null = null;
  try {
    while (true) {
      const control = threadMuteControl(stale);
      const chooser = phase === "chooser" ? chooserDialog(staleDialogs) : null;
      if (chooser) openedChooser = chooser.dialog;
      const dialog = phase === "dialog" ? muteDialog(staleDialogs) : null;
      const snapshot: QuickMuteSnapshot = {
        threadMatches: paneReady(),
        muted: control.muted,
        chatNotifications: chatNotificationsControl(stale) !== null,
        chooser: !chooser ? "none" : chooser.muted ? "unmute" : "mute",
        infoRequested,
        dialog: !dialog ? "none" : radioSelected(dialog.radio) ? "ready" : "unselected",
        confirmed:
          confirmed !== null &&
          (!confirmed.isConnected ||
            !isShown(confirmed) ||
            getComputedStyle(confirmed).visibility === "hidden" ||
            mutedThreads.isMuted(wantedThread)),
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
            openedInfo = info;
          }
          break;
        }
        case "open-dialog":
          control.trigger?.click();
          break;
        case "open-chooser":
          chatNotificationsControl(stale)?.click();
          break;
        case "choose-mute":
          chooser?.button.click();
          break;
        case "select":
          dialog?.radio.click();
          break;
        case "confirm":
          confirmed = dialog?.confirm ?? null;
          dialog?.confirm.click();
          break;
        case "success":
          mutedThreads.observe(wantedThread, true);
          // The mute lasts 8 hours; don't keep suppressing past it if the row
          // is not mounted to observe the change.
          setTimeout(
            () => mutedThreads.invalidateMute(wantedThread),
            Number(QUICK_MUTE_DURATION_MS),
          );
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
    // The variant's chooser can stay open behind the duration dialog.
    const chooser = openedChooser?.isConnected ? openedChooser : null;
    const close = chooser
      ? visibleButtons(chooser).find((button) => /^(close|done)$/i.test(label(button).trim()))
      : null;
    close?.click();
    if (
      openedInfo?.isConnected &&
      openedInfo.getAttribute("aria-expanded") === "true" &&
      paneReady()
    )
      openedInfo.click();
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
