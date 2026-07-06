/* ------------------- Open thread & conversation info ------------------ */
import { toast } from "../bridge";
import { threadIdFromHref, threadPathId } from "../lib/threads";

export function initThreadNav() {
  // Open a conversation by its "/t/<id>/" path (used by the Dock/tray menus,
  // via eval from Rust). Prefer clicking the row — SPA navigation, no full
  // reload; fall back to a hard navigation when the row isn't in the list
  // (scrolled out of Facebook's virtualized list, or a fresh window).
  window.__carrierOpenThread = (href) => {
    const id = threadPathId(href);
    if (!id) return false;
    for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href*="/t/"]')) {
      if (threadIdFromHref(a.getAttribute("href")) === id) {
        a.click();
        return true;
      }
    }
    location.href = `https://www.facebook.com/messages/t/${id}/`;
    return true;
  };

  /* ------------------ Toggle conversation information ------------------- */
  // Click Messenger's own conversation-info ("ⓘ") button in the open thread's
  // header so the native details sidebar shows/hides. Invoked from the View menu
  // / Cmd+Shift+I: the Rust side can't run page JS through a plugin (Facebook's
  // CSP blocks evaluating arbitrary strings), but it can call this function we
  // defined at document-start. Match the stable aria-label rather than FB's
  // churning class names; the label is unchanged whether the panel is open or
  // closed, so one click toggles it.
  window.__carrierToggleInfo = () => {
    const wanted = (el: Element) => {
      const l = (el.getAttribute("aria-label") || "").toLowerCase();
      return l.includes("conversation information") || l.includes("conversation details");
    };
    let btn = document.querySelector<HTMLElement>(
      '[role="button"][aria-label="Conversation information"]',
    );
    if (!btn)
      for (const el of document.querySelectorAll<HTMLElement>("[aria-label]"))
        if (wanted(el)) {
          btn = (el.closest('[role="button"]') as HTMLElement | null) || el;
          break;
        }
    if (btn) {
      btn.click();
      return true;
    }
    toast("Open a conversation first");
    return false;
  };
}
