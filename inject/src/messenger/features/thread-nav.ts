/* ------------------- Open thread & conversation info ------------------ */

import { t } from "../../i18n";
import { diag, invoke, toast } from "../bridge";
import { noteExplicitAction } from "../lib/composer-focus";
import { pageRequire } from "../lib/facebook-loader";
import { isRenderedBy, moduleExport } from "../lib/react-fiber";
import { threadRestoreStep } from "../lib/thread-restore";
import { advanceThreadViewed, initialThreadViewedState } from "../lib/thread-viewed";
import { threadIdFromHref, threadPathId } from "../lib/threads";

const RESTORED_THREAD_KEY = "chatpane-restored-thread";
let cancelThreadRestore = () => {};

/** The open thread's header "ⓘ" button that shows/hides the details sidebar,
 * found by its icon component (MWChatRTCInfoButtonIcon renders the svg). */
function conversationInfoButton(): HTMLElement | null {
  const load = pageRequire();
  const icon = moduleExport(load, "MWChatRTCInfoButtonIcon.react");
  if (icon == null) return null;
  for (const svg of document.querySelectorAll('[role="button"] svg')) {
    if (isRenderedBy(svg, icon, load, 2)) return svg.closest<HTMLElement>('[role="button"]');
  }
  return null;
}

/**
 * Open `path` for a background action and return a check for "the pane now
 * shows it". The route changes before Messenger replaces the pane, so after
 * navigating the pane counts only once its message log is a new element.
 * Null when the thread can't be opened.
 */
export function openThreadForAction(path: string): (() => boolean) | null {
  const wanted = threadPathId(path);
  if (!wanted) return null;
  const log = () => document.querySelector('[role="main"] [role="log"]');
  const onRoute = () => threadIdFromHref(location.pathname) === wanted;
  if (onRoute()) return onRoute;
  const staleLog = log();
  if (window.__chatpaneOpenThread?.(path) !== true) return null;
  return () => {
    const current = log();
    return onRoute() && current !== null && current !== staleLog;
  };
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
    const restoreId = window.__CHATPANE_RESTORE_THREAD__;
    if (typeof restoreId === "string" && /^\d{1,32}$/.test(restoreId)) {
      restoreRecycledThread(restoreId);
    }
  }, 0);
  // Open a conversation by its "/t/<id>/" path (used by the Dock/tray menus,
  // via eval from Rust). Prefer clicking the row — SPA navigation, no full
  // reload; fall back to a hard navigation when the row isn't in the list
  // (scrolled out of Facebook's virtualized list, or a fresh window).
  window.__chatpaneOpenThread = (href) => {
    noteExplicitAction();
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
        event: "chatpane:thread-viewed",
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
  // defined at document-start. The button is the same whether the panel is
  // open or closed, so one click toggles it.
  window.__chatpaneToggleInfo = () => {
    const btn = conversationInfoButton();
    if (btn) {
      btn.click();
      return true;
    }
    toast(t("page.thread.open_first"));
    return false;
  };
}
