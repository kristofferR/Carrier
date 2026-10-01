/* ------------------- Notification 👍 reaction ------------------------ */
// Reacts 👍 to the message a notification announced, like the Messenger iOS
// notification action, without raising the window. The target is the newest
// incoming bubble with the notification's raw text, sent around when it fired;
// a notification with no text (a photo, a sticker), or one from before a page
// reload, can't be matched and fails. Messenger mounts a
// message's toolbar only on hover, so a synthetic hover comes first. Message
// bubbles and the React button are matched by English accessible labels; the
// reaction itself is found by its emoji image, which is locale-independent.
import { diag } from "../bridge";
import { type ActionTarget, actionTargetFor } from "../lib/action-target";
import {
  bubbleIsFresh,
  bubbleMatchesNotification,
  decideQuickLike,
  type QuickLikePhase,
  type QuickLikeSnapshot,
} from "../lib/quick-like";
import { withComposerDeliveryWhenAvailable } from "../lib/scheduled-send";
import { threadPathId } from "../lib/threads";
import { openThreadForAction } from "./thread-nav";

const POLL_MS = 250;
const LIKE_BUDGET_MS = 12_000;
const THUMB = "👍";
const BUBBLE = '[aria-label^="Enter, Message sent"]';
const REACT_BUTTON = '[role="button"][aria-label="React with an emoji"]';

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));

const bubbles = () => [
  ...document.querySelectorAll<HTMLElement>(`[role="main"] [role="article"] ${BUBBLE}`),
];

/** The scroller holding the conversation, or null when it all fits. */
function messageScroller(from: Element): HTMLElement | null {
  for (let el = from.parentElement; el && el !== document.body; el = el.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight)
      return el;
  }
  return null;
}

const atBottom = (scroller: HTMLElement | null) =>
  !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 4;

/** The newest message from someone else with the notification's text, sent
 * around when it fired. */
function announcedBubble(
  notified: ActionTarget,
): { bubble: HTMLElement; scope: HTMLElement } | "ambiguous" | null {
  const matches = bubbles().filter((el) => {
    const label = el.getAttribute("aria-label") || "";
    return (
      !/ by You(?::|$)/.test(label) &&
      bubbleMatchesNotification(label, notified.body) &&
      bubbleIsFresh(label, notified.at)
    );
  });
  // Two fresh messages with the same text: nothing says which was announced.
  if (matches.length > 1) return "ambiguous";
  const bubble = matches[0];
  // The hover toolbar and reaction summary sit beside the article, so widen
  // to the largest ancestor that still holds only this message.
  let scope = bubble?.closest<HTMLElement>('[role="article"]');
  while (scope?.parentElement && scope.parentElement.querySelectorAll(BUBBLE).length === 1)
    scope = scope.parentElement;
  return bubble && scope ? { bubble, scope } : null;
}

/** Reaction-summary labels for one message, excluding the bubble and toolbar. */
function reactionSummary(scope: HTMLElement): string {
  return [...scope.querySelectorAll<HTMLElement>('[role="button"][aria-label]')]
    .filter((el) => !el.matches(BUBBLE) && !el.closest('[role="group"]'))
    .map((el) => el.getAttribute("aria-label"))
    .join("\n");
}

function thumbItem(menu: Element): HTMLElement | null {
  for (const item of menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
    if (item.querySelector("img")?.getAttribute("alt") === THUMB) return item;
  return null;
}

async function like(path: string, notified: ActionTarget, deadline: number): Promise<boolean> {
  // Expired while queued: the native side has already given up on it.
  if (Date.now() >= deadline) return false;
  const paneReady = openThreadForAction(path);
  if (!paneReady) {
    diag("quick-like.open", "validated thread could not be opened");
    return false;
  }

  let phase: QuickLikePhase = "waiting";
  let target: { bubble: HTMLElement; scope: HTMLElement } | null = null;
  let ambiguous = false;
  let reactButton: HTMLElement | null = null;
  // null: 👍 was already ours, so any visible 👍 confirms it.
  let summaryBefore: string | null = "";
  while (true) {
    // Settled: scrolled to the latest message. Only a bubble matching the
    // notification's text becomes the target, so an older message still at
    // the bottom while the new one renders is never chosen.
    const newest = phase === "waiting" ? (bubbles().pop() ?? null) : null;
    const scroller = newest ? messageScroller(newest) : null;
    const settled = newest !== null && atBottom(scroller);
    if (phase === "waiting") {
      const found = announcedBubble(notified);
      ambiguous = found === "ambiguous";
      target = found === "ambiguous" ? null : found;
    }
    if (phase === "waiting") reactButton = target?.scope.querySelector(REACT_BUTTON) ?? null;
    const menuId = reactButton?.getAttribute("aria-controls");
    const menu =
      reactButton?.getAttribute("aria-expanded") === "true"
        ? (menuId && document.getElementById(menuId)) ||
          [...document.querySelectorAll('[role="menu"]')].pop() ||
          null
        : null;
    const thumb = menu ? thumbItem(menu) : null;
    const summary = target ? reactionSummary(target.scope) : "";
    const snapshot: QuickLikeSnapshot = {
      threadMatches: paneReady(),
      targetFound: target !== null && target.bubble.isConnected,
      ambiguous,
      settled,
      reactButton: reactButton !== null,
      menu: !menu
        ? "none"
        : !thumb
          ? "missing"
          : thumb.getAttribute("aria-checked") === "true"
            ? "selected"
            : "unselected",
      thumbShown: summary.includes(THUMB) && (summaryBefore === null || summary !== summaryBefore),
    };
    const decision = decideQuickLike(phase, snapshot, Date.now() >= deadline);
    phase = decision.phase;

    switch (decision.action) {
      case "settle":
        if (scroller && !atBottom(scroller)) scroller.scrollTop = scroller.scrollHeight;
        break;
      case "hover": {
        const bubble = target?.bubble;
        const rect = bubble?.getBoundingClientRect();
        const point = rect && {
          clientX: rect.x + rect.width / 2,
          clientY: rect.y + rect.height / 2,
        };
        bubble?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, ...point }));
        bubble?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, ...point }));
        break;
      }
      case "open-menu":
        reactButton?.click();
        break;
      case "select":
        summaryBefore = summary;
        thumb?.click();
        break;
      case "close-menu":
        summaryBefore = null;
        reactButton?.click();
        break;
      case "success":
        if (menu) reactButton?.click();
        return true;
      case "failure":
        if (menu) reactButton?.click();
        // Content-free state, so a field failure says which step stalled.
        diag(
          "quick-like.delivery",
          `like flow stopped in ${phase} (${document.visibilityState}; pane ${snapshot.threadMatches}, settled ${snapshot.settled}, target ${snapshot.targetFound}, ambiguous ${snapshot.ambiguous}, react ${snapshot.reactButton}, menu ${snapshot.menu})`,
        );
        return false;
      case "wait":
        break;
    }
    await pause();
  }
}

export function initQuickLike() {
  window.__carrierQuickLike = (path, target, id, attempt, budgetMs) => {
    const report = (ok: boolean) =>
      carrierReplyResult(id, attempt, ok).catch(() =>
        diag("quick-like.ack", "like acknowledgement emit failed"),
      );
    // What native recorded the notification announced, for this account.
    const notified = actionTargetFor(target, document.cookie);
    // No text (a photo, a sticker): nothing can identify the message.
    if (
      threadPathId(path) === null ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      !notified?.body.trim()
    ) {
      void report(false);
      return;
    }
    // Serialized with replies, mutes, and scheduled sends: all of them
    // navigate the same hidden page.
    // Native passes what is left of its acknowledgement wait, including after a
    // hard-navigation resume, and queue time counts against it: a like never
    // lands after native has reported failure.
    const deadline = Date.now() + Math.min(Number(budgetMs) || 0, LIKE_BUDGET_MS);
    void withComposerDeliveryWhenAvailable(() => like(path, notified, deadline))
      .then((ok) => report(ok))
      .catch(() => {
        diag("quick-like.exception", "like flow raised an exception");
        void report(false);
      });
  };
}
