/* ------------------- Gradient chats without the flash ------------------- */
// In a chat with a gradient theme, Messenger paints the gradient on the box
// behind the messages and leaves your bubbles uncolored, so it shows through
// them. On macOS a fast scroll outruns WebKit's painting, and rows not yet
// painted showed the gradient: the chat flashed purple and blue. Your bubbles
// paint the gradient themselves instead (lib/chat-gradient.ts). The bubble
// class is read from Facebook's stylesheets, not written here: until it is
// found, or if Facebook stops coloring bubbles that way, the box keeps its
// gradient, so the flash comes back rather than bare bubbles. Adapted from
// fMess (github.com/toanbku/fmess, MIT; notice in lib/typing-block.ts).
import { chatGradientCss, collectBubbleClasses, GRADIENT_VAR } from "../lib/chat-gradient";

const CHECK_MS = 1_000;

export function initChatGradient() {
  const style = document.createElement("style");
  style.id = "chatpane-chat-gradient";
  const classes = new Set<string>();
  // Facebook adds rules to its sheets as it goes: a sheet is read again only
  // once it has more.
  const rulesRead = new WeakMap<CSSStyleSheet, number>();

  const readSheets = () => {
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch (_) {
        continue; // cross-origin sheet
      }
      if (rulesRead.get(sheet) === rules.length) continue;
      rulesRead.set(sheet, rules.length);
      collectBubbleClasses(rules, classes);
    }
  };

  let applied = 0;
  window.setInterval(() => {
    if (document.hidden) return;
    if (!document.querySelector(`[role="main"] [style*="${GRADIENT_VAR}"]`)) return;
    readSheets();
    if (!classes.size || classes.size === applied) return;
    applied = classes.size;
    style.textContent = chatGradientCss([...classes]);
    if (!style.isConnected) document.documentElement.append(style);
  }, CHECK_MS);
}
