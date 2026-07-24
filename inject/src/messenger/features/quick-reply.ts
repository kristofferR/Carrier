import { diag, invoke } from "../bridge";
import {
  composerContainsReply,
  decideQuickReply,
  type QuickReplyPhase,
  type QuickReplySnapshot,
} from "../lib/quick-reply";
import { threadIdFromHref, threadPathId } from "../lib/threads";
import { buttonByLabel, firstShown } from "./conversation-actions";

const POLL_MS = 250;
const DELIVERY_BUDGET_MS = 12_000;
const MAX_REPLY_CHARS = 2_000;
const COMPOSER_SELECTOR =
  '[role="main"] [contenteditable="true"][role="textbox"], [contenteditable="true"][data-lexical-editor="true"]';

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));

const currentThreadId = () => threadIdFromHref(location.pathname);

const composer = () => firstShown<HTMLElement>(COMPOSER_SELECTOR);

const sendButton = () => {
  const root = document.querySelector('[role="main"]');
  if (!root) return null;
  return buttonByLabel(["press enter to send", "send message"], root);
};

const emitReplyResult = (id: number, attempt: number, ok: boolean) => {
  invoke("plugin:event|emit", {
    event: "carrier:reply-result",
    payload: { id, attempt, ok },
  })?.catch?.(() => diag("quick-reply.ack", "reply acknowledgement emit failed"));
};

const validRequest = (path: string, text: string, id: number, attempt: number) =>
  threadPathId(path) !== null &&
  text.trim().length > 0 &&
  [...text].length <= MAX_REPLY_CHARS &&
  Number.isSafeInteger(id) &&
  id > 0 &&
  Number.isSafeInteger(attempt) &&
  attempt > 0;

async function deliver(path: string, text: string): Promise<boolean> {
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
  while (true) {
    const box = composer();
    const button = phase === "inserted" ? sendButton() : null;
    const snapshot: QuickReplySnapshot = {
      threadMatches: currentThreadId() === wantedThread,
      composerReady: box !== null,
      draftMatches: composerContainsReply(box?.textContent || null, text),
      sendAvailable: button !== null,
      composerEmpty: !(box?.textContent || "").trim(),
    };
    const decision = decideQuickReply(phase, snapshot, Date.now() >= deadline);
    phase = decision.phase;

    switch (decision.action) {
      case "wait":
        await pause();
        break;
      case "insert": {
        if (!box) return false;
        box.focus();
        if (!document.execCommand("insertText", false, text)) {
          diag("quick-reply.insert", "composer rejected insertText");
          return false;
        }
        break;
      }
      case "send":
        button?.click();
        await pause();
        break;
      case "success":
        return true;
      case "failure":
        diag("quick-reply.delivery", `reply flow stopped in ${phase}`);
        return false;
    }
  }
}

async function preserveDraft(path: string, text: string): Promise<boolean> {
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
      if (composerContainsReply(box.textContent, text)) return true;
      // Never merge a notification reply into a draft the user already wrote.
      if ((box.textContent || "").trim()) {
        diag("quick-reply.draft", "existing composer draft preserved");
        return true;
      }
      if (!document.execCommand("insertText", false, text)) {
        diag("quick-reply.draft", "fallback insertText failed");
        return false;
      }
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
    void deliver(path, text)
      .then((ok) => emitReplyResult(id, attempt, ok))
      .catch(() => {
        diag("quick-reply.exception", "reply flow raised an exception");
        emitReplyResult(id, attempt, false);
      });
  };

  window.__carrierQuickReplyDraft = (path, rawText, id, attempt) => {
    const text = String(rawText);
    if (
      threadPathId(path) === null ||
      [...text].length > MAX_REPLY_CHARS ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      !Number.isSafeInteger(attempt) ||
      attempt <= 0
    ) {
      emitReplyResult(id, attempt, false);
      return;
    }
    void preserveDraft(path, text)
      .then((ok) => emitReplyResult(id, attempt, ok))
      .catch(() => {
        diag("quick-reply.draft", "fallback draft flow raised an exception");
        emitReplyResult(id, attempt, false);
      });
  };
}
