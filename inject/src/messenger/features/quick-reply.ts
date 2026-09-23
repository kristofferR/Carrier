import { diag } from "../bridge";
import {
  composerContainsReply,
  composerIncludesReply,
  decideQuickReply,
  type QuickReplyPhase,
  type QuickReplySnapshot,
} from "../lib/quick-reply";
import {
  composerControls,
  composerText,
  findSendButton,
  hasComposerMedia,
} from "../lib/scheduled-composer";
import { withComposerDelivery, withComposerDeliveryWhenAvailable } from "../lib/scheduled-send";
import { threadIdFromHref, threadPathId } from "../lib/threads";
import { firstShown } from "./conversation-actions";

const POLL_MS = 250;
const DELIVERY_BUDGET_MS = 12_000;
const MAX_REPLY_CHARS = 2_000;
const COMPOSER_SELECTOR =
  '[role="main"] [contenteditable="true"][role="textbox"], [contenteditable="true"][data-lexical-editor="true"]';
const insertedReplies = new Map<number, { path: string; text: string }>();

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));

const currentThreadId = () => threadIdFromHref(location.pathname);

const composer = () => firstShown<HTMLElement>(COMPOSER_SELECTOR);

const emitReplyResult = (id: number, attempt: number, ok: boolean) => {
  carrierReplyResult(id, attempt, ok).catch(() =>
    diag("quick-reply.ack", "reply acknowledgement emit failed"),
  );
};

const validRequest = (path: string, text: string, id: number, attempt: number) =>
  threadPathId(path) !== null &&
  text.trim().length > 0 &&
  [...text].length <= MAX_REPLY_CHARS &&
  Number.isSafeInteger(id) &&
  id > 0 &&
  Number.isSafeInteger(attempt) &&
  attempt > 0;

async function deliver(path: string, text: string, id: number): Promise<boolean> {
  const wantedThread = threadPathId(path);
  if (
    !wantedThread ||
    (currentThreadId() !== wantedThread && window.__carrierOpenThread?.(path) !== true)
  ) {
    diag("quick-reply.open", "validated thread could not be opened");
    return false;
  }

  const deadline = Date.now() + DELIVERY_BUDGET_MS;
  let phase: QuickReplyPhase = "waiting";
  let controls = new Map<HTMLElement, string>();
  while (true) {
    const box = composer();
    if (box && hasComposerMedia(box)) return false;
    const button = phase === "inserted" && box ? findSendButton(box, controls) : null;
    const snapshot: QuickReplySnapshot = {
      threadMatches: currentThreadId() === wantedThread,
      composerReady: box !== null,
      draftMatches: composerContainsReply(box ? composerText(box) : null, text),
      sendAvailable: button !== null,
      composerEmpty: !box || !composerText(box).trim(),
    };
    const decision = decideQuickReply(phase, snapshot, Date.now() >= deadline);
    phase = decision.phase;

    switch (decision.action) {
      case "wait":
        await pause();
        break;
      case "insert": {
        if (!box) return false;
        controls = composerControls(box);
        box.focus();
        if (!document.execCommand("insertText", false, text)) {
          diag("quick-reply.insert", "composer rejected insertText");
          return false;
        }
        insertedReplies.set(id, { path, text });
        break;
      }
      case "send":
        button?.click();
        await pause();
        break;
      case "success":
        insertedReplies.delete(id);
        return true;
      case "failure":
        diag("quick-reply.delivery", `reply flow stopped in ${phase}`);
        return false;
    }
  }
}

async function preserveDraft(path: string, text: string, id: number): Promise<boolean> {
  const wantedThread = threadPathId(path);
  if (
    !wantedThread ||
    (currentThreadId() !== wantedThread && window.__carrierOpenThread?.(path) !== true)
  ) {
    return false;
  }
  const deadline = Date.now() + DELIVERY_BUDGET_MS;
  while (Date.now() < deadline) {
    const box = composer();
    if (currentThreadId() === wantedThread && box) {
      box.focus();
      if (!text) return true;
      const inserted = insertedReplies.get(id);
      const current = composerText(box);
      if (
        composerContainsReply(current, text) ||
        (inserted?.path === path && inserted.text === text && composerIncludesReply(current, text))
      ) {
        insertedReplies.delete(id);
        return true;
      }
      // This fallback never sends automatically. Preserve both pieces when a
      // draft already exists instead of acknowledging and dropping the native
      // reply that brought the user here.
      if (current.trim()) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(box);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
        if (!document.execCommand("insertText", false, `\n\n${text}`)) {
          diag("quick-reply.draft", "fallback append failed");
          return false;
        }
        insertedReplies.delete(id);
        return true;
      }
      if (!document.execCommand("insertText", false, text)) {
        diag("quick-reply.draft", "fallback insertText failed");
        return false;
      }
      insertedReplies.delete(id);
      return true;
    }
    await pause();
  }
  diag("quick-reply.draft", "fallback composer did not become ready");
  return false;
}

export function initQuickReply() {
  window.__carrierQuickReply = (path, rawText, id, attempt) => {
    const text = String(rawText);
    if (!validRequest(path, text, id, attempt)) {
      emitReplyResult(id, attempt, false);
      return;
    }
    void withComposerDelivery(() => deliver(path, text, id))
      .then((ok) => emitReplyResult(id, attempt, ok === true))
      .catch(() => {
        diag("quick-reply.exception", "reply flow raised an exception");
        emitReplyResult(id, attempt, false);
      });
  };

  window.__carrierQuickReplyDraft = (path, rawText, id, attempt) => {
    const text = String(rawText);
    if (
      threadPathId(path) === null ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      !Number.isSafeInteger(attempt) ||
      attempt <= 0
    ) {
      emitReplyResult(id, attempt, false);
      return;
    }
    void withComposerDeliveryWhenAvailable(() => preserveDraft(path, text, id))
      .then((ok) => emitReplyResult(id, attempt, ok === true))
      .catch(() => {
        diag("quick-reply.draft", "fallback draft flow raised an exception");
        emitReplyResult(id, attempt, false);
      });
  };
}
