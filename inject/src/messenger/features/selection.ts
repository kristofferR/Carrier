/* ------------------- Text selection like a native app ------------------- */
// In the chats, only text worth copying can be selected: messages, the pinned
// message and the details in the conversation pane, dialogs, and fields (CSS
// in messenger.css). The chat list and the rest of the chrome can't. Select
// All outside a field selects nothing, instead of every bit of text on the
// page in bands. Adapted from fMess (github.com/toanbku/fmess, MIT; notice in
// lib/typing-block.ts).
import { isMessengerContentPath } from "../lib/threads";

/** On <html> while a chats page shows. Other page CSS keys on it too. */
export const CHATS_ATTR = "data-chatpane-chats";

export function initSelection() {
  const html = document.documentElement;
  const sync = () => {
    const onChats = isMessengerContentPath(location.pathname);
    if (html.hasAttribute(CHATS_ATTR) !== onChats) html.toggleAttribute(CHATS_ATTR, onChats);
  };
  // Facebook moves between pages through the History API.
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const result = original.apply(this, args);
      sync();
      return result;
    };
  }
  window.addEventListener("popstate", sync);
  sync();

  const pageSelectAll = (target: EventTarget | null) =>
    html.hasAttribute(CHATS_ATTR) &&
    !html.hasAttribute("data-chatpane-login") &&
    (target === document.body || target === html);

  // Select All outside an editable root, from the keyboard or the native Edit
  // menu (Linux runs WebKit's SelectAll command directly), fires selectstart
  // at <body> in WebKit and Chromium; cancelling it keeps the selection.
  document.addEventListener(
    "selectstart",
    (event) => {
      if (pageSelectAll(event.target)) event.preventDefault();
    },
    true,
  );
  // The shortcut itself, in case an engine skips that event. A focused field
  // keeps its own Select All.
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.code !== "KeyA" || event.altKey || event.shiftKey) return;
      if (!(event.metaKey || event.ctrlKey) || (event.metaKey && event.ctrlKey)) return;
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.isContentEditable || active.closest("input, textarea"))
      )
        return;
      if (pageSelectAll(document.body)) event.preventDefault();
    },
    true,
  );
}
