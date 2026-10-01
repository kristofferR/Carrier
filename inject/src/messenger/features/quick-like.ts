/* ------------------- Notification 👍 reaction ------------------------ */
// Reacts 👍 to the newest message from someone else, like the Messenger iOS
// notification action, without raising the window. Messenger mounts a
// message's toolbar only on hover, so a synthetic hover comes first. Message
// bubbles and the React button are matched by English accessible labels; the
// reaction itself is found by its emoji image, which is locale-independent.
import { diag } from "../bridge";
import { decideQuickLike, type QuickLikePhase, type QuickLikeSnapshot } from "../lib/quick-like";
import { withComposerDeliveryWhenAvailable } from "../lib/scheduled-send";
import { threadIdFromHref, threadPathId } from "../lib/threads";

const POLL_MS = 250;
const LIKE_BUDGET_MS = 12_000;
const THUMB = "👍";
const BUBBLE = '[aria-label^="Enter, Message sent"]';
const REACT_BUTTON = '[role="button"][aria-label="React with an emoji"]';

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));

function newestIncoming(): { bubble: HTMLElement; scope: HTMLElement } | null {
  const bubble = [
    ...document.querySelectorAll<HTMLElement>(`[role="main"] [role="article"] ${BUBBLE}`),
  ]
    .reverse()
    .find((el) => !/ by You(?::|$)/.test(el.getAttribute("aria-label") || ""));
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

async function like(path: string, deadline: number): Promise<boolean> {
  const wantedThread = threadPathId(path);
  // Expired while queued: the native side has already given up on it.
  if (Date.now() >= deadline) return false;
  if (
    !wantedThread ||
    (threadIdFromHref(location.pathname) !== wantedThread &&
      window.__carrierOpenThread?.(path) !== true)
  ) {
    diag("quick-like.open", "validated thread could not be opened");
    return false;
  }

  let phase: QuickLikePhase = "waiting";
  let target: ReturnType<typeof newestIncoming> = null;
  let reactButton: HTMLElement | null = null;
  // null: 👍 was already ours, so any visible 👍 confirms it.
  let summaryBefore: string | null = "";
  while (true) {
    if (phase === "waiting") target = newestIncoming();
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
      threadMatches: threadIdFromHref(location.pathname) === wantedThread,
      targetFound: target !== null && target.bubble.isConnected,
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
        diag("quick-like.delivery", `like flow stopped in ${phase}`);
        return false;
      case "wait":
        break;
    }
    await pause();
  }
}

export function initQuickLike() {
  window.__carrierQuickLike = (path, id, attempt) => {
    const report = (ok: boolean) =>
      carrierReplyResult(id, attempt, ok).catch(() =>
        diag("quick-like.ack", "like acknowledgement emit failed"),
      );
    if (threadPathId(path) === null || !Number.isSafeInteger(id) || id <= 0) {
      void report(false);
      return;
    }
    // Serialized with replies, mutes, and scheduled sends: all of them
    // navigate the same hidden page.
    // The budget includes any wait behind another page action, so a queued
    // like ends within the native acknowledgement window instead of after it.
    const deadline = Date.now() + LIKE_BUDGET_MS;
    void withComposerDeliveryWhenAvailable(() => like(path, deadline))
      .then((ok) => report(ok))
      .catch(() => {
        diag("quick-like.exception", "like flow raised an exception");
        void report(false);
      });
  };
}
