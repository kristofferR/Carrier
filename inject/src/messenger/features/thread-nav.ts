/* ------------------- Open thread & conversation info ------------------ */
import { diag, invoke, toast } from "../bridge";
import { threadRestoreStep } from "../lib/thread-restore";
import { advanceThreadViewed, initialThreadViewedState } from "../lib/thread-viewed";
import { threadIdFromHref, threadPathId } from "../lib/threads";

const RESTORED_THREAD_KEY = "carrier-restored-thread";
let cancelThreadRestore = () => {};

/** The open thread's header "ⓘ" button that shows/hides the details sidebar. */
export function conversationInfoButton(): HTMLElement | null {
  const exact = document.querySelector<HTMLElement>(
    '[role="button"][aria-label="Conversation information"]',
  );
  if (exact) return exact;
  for (const el of document.querySelectorAll<HTMLElement>("[aria-label]")) {
    const label = (el.getAttribute("aria-label") || "").toLowerCase();
    if (label.includes("conversation information") || label.includes("conversation details"))
      return (el.closest('[role="button"]') as HTMLElement | null) || el;
  }
  return null;
}

/** Native actions call this first: an explicit request beats a pending restore. */
export function stopThreadRestore() {
  cancelThreadRestore();
}

// A window rebuilt to release memory reopens the conversation it showed. Real
// user input, a native action, or leaving a conversation for anything other
// than this one ends it: the user's choice wins.
function restoreRecycledThread(id: string) {
  const startedAt = Date.now();
  let cancelled = false;
  let lastThread = threadIdFromHref(location.pathname);
  const markDone = () => {
    try {
      sessionStorage.setItem(RESTORED_THREAD_KEY, id);
    } catch (_) {}
  };
  cancelThreadRestore = () => {
    cancelled = true;
    markDone();
  };
  const onUserInput = (event: Event) => {
    if (event.isTrusted) cancelThreadRestore();
  };
  for (const type of ["pointerdown", "keydown"]) {
    window.addEventListener(type, onUserInput, true);
  }
  const attempt = () => {
    if (cancelled) return;
    // Facebook's own landing moves from its home to a thread; leaving a thread
    // for any page we did not request came from the user.
    const current = threadIdFromHref(location.pathname);
    if (lastThread && current !== lastThread && current !== id) {
      cancelThreadRestore();
      return;
    }
    lastThread = current ?? lastThread;
    let done = false;
    try {
      done = sessionStorage.getItem(RESTORED_THREAD_KEY) === id;
    } catch (_) {}
    const row = [
      ...document.querySelectorAll<HTMLAnchorElement>('[role="navigation"] a[href*="/t/"]'),
    ].find((a) => threadIdFromHref(a.getAttribute("href")) === id);
    const step = threadRestoreStep({
      done,
      onThread: current === id,
      rowFound: !!row,
      waitedMs: Date.now() - startedAt,
    });
    if (step === "done") {
      if (!done) markDone();
      return;
    }
    if (step === "load") {
      markDone();
      location.href = `https://www.facebook.com/messages/t/${id}/`;
      return;
    }
    if (step === "click") row?.click();
    setTimeout(attempt, 500);
  };
  attempt();
}

export function initThreadNav() {
  // Native code sets the id in a startup script that runs after this bundle.
  setTimeout(() => {
    const restoreId = window.__CARRIER_RESTORE_THREAD__;
    if (typeof restoreId === "string" && /^\d{1,32}$/.test(restoreId)) {
      restoreRecycledThread(restoreId);
    }
  }, 0);
  // Open a conversation by its "/t/<id>/" path (used by the Dock/tray menus,
  // via eval from Rust). Prefer clicking the row — SPA navigation, no full
  // reload; fall back to a hard navigation when the row isn't in the list
  // (scrolled out of Facebook's virtualized list, or a fresh window).
  window.__carrierOpenThread = (href) => {
    const id = threadPathId(href);
    if (!id) return false;
    cancelThreadRestore();
    for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href*="/t/"]')) {
      if (threadIdFromHref(a.getAttribute("href")) === id) {
        a.click();
        return true;
      }
    }
    location.href = `https://www.facebook.com/messages/t/${id}/`;
    return true;
  };

  // Notification Center has no dependable Messenger read-receipt signal. A
  // visible, focused thread is the narrow native heuristic: report path only,
  // once per continuous view, and report again when focus returns.
  let viewed = initialThreadViewedState();
  const reportViewedThread = () => {
    const id = threadIdFromHref(location.pathname);
    const path = id ? `/t/${id}/` : null;
    const next = advanceThreadViewed(
      viewed,
      path,
      document.hasFocus() && !document.hidden,
      performance.now(),
    );
    viewed = next.state;
    if (next.emit) {
      invoke("plugin:event|emit", {
        event: "carrier:thread-viewed",
        payload: { thread_path: next.emit },
      })?.catch?.(() => diag("thread-viewed.emit", "thread view emit failed"));
    }
  };
  setInterval(reportViewedThread, 1_000);
  document.addEventListener("visibilitychange", reportViewedThread);
  window.addEventListener("focus", reportViewedThread);
  window.addEventListener("blur", reportViewedThread);
  reportViewedThread();

  /* ------------------ Toggle conversation information ------------------- */
  // Click Messenger's own conversation-info ("ⓘ") button in the open thread's
  // header so the native details sidebar shows/hides. Invoked from the View menu
  // / Cmd+Shift+I: the Rust side can't run page JS through a plugin (Facebook's
  // CSP blocks evaluating arbitrary strings), but it can call this function we
  // defined at document-start. Match the stable aria-label rather than FB's
  // churning class names; the label is unchanged whether the panel is open or
  // closed, so one click toggles it.
  window.__carrierToggleInfo = () => {
    const btn = conversationInfoButton();
    if (btn) {
      btn.click();
      return true;
    }
    toast("Open a conversation first");
    return false;
  };
}
