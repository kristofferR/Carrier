// @ts-nocheck
// Moved verbatim from dist/settings.html. A classic script: its globals (I18N,
// LOCALE, t) are shared with the rest of the Settings window's scripts.
// Chatpane's own text in this launch's language. src-tauri/src/i18n.rs
// sets __CHATPANE_I18N__ (the settings. and shared. keys of
// src-tauri/locales/, and the language picker's choices) before this runs.
const I18N = window.__CHATPANE_I18N__ || { lang: "en", dir: "ltr", strings: {}, languages: [], system: "en" };
// Dates and numbers follow the UI language, in the OS's regional format
// when the OS prefers the same language (en-GB keeps its 24-hour clock).
const LOCALE = I18N.lang.includes("-")
  ? I18N.lang
  : (navigator.languages || []).find((tag) => tag.split("-")[0] === I18N.lang) || I18N.lang;
// `key`'s text with `{name}` placeholders filled in one pass, so a value
// that looks like a placeholder stays as it is.
function t(key, vars) {
  const text = I18N.strings[key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => {
    const value = vars[name];
    if (value === undefined) return match;
    return typeof value === "number" ? value.toLocaleString(LOCALE) : String(value);
  });
}
document.documentElement.lang = I18N.lang;
document.documentElement.dir = I18N.dir;
document.title = t("settings.window.title");

// Before the first paint, so the tab bar doesn't move.
if (/Mac/.test(navigator.platform || "")) document.documentElement.classList.add("mac-title-bar");
// Windows and Linux: Chatpane's close button and drag strip. Settings
// can't be minimized or maximized, so close is the only control.
(() => {
  const root = document.documentElement;
  const control = (action) => window.__TAURI_INTERNALS__.invoke("window_control", { action }).catch(() => {});
  let strip = null;
  let box = null;
  const apply = (state) => {
    const shown = Boolean(state && state.controls && state.inset > 0);
    if (!shown) {
      strip?.remove();
      box?.remove();
      delete root.dataset.controls;
      return;
    }
    root.dataset.controls = state.controls;
    root.style.setProperty("--inset", `${state.inset}px`);
    if (!box) {
      strip = document.createElement("div");
      strip.id = "title-strip";
      strip.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        control("drag");
      });
      box = document.createElement("div");
      box.id = "window-controls";
      const close = document.createElement("button");
      close.type = "button";
      close.title = t("settings.window.close");
      close.setAttribute("aria-label", close.title);
      close.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg>';
      close.addEventListener("click", () => control("close"));
      box.append(close);
    }
    const attach = () => {
      if (!box.isConnected) document.body.append(strip, box);
    };
    if (document.body) attach();
    else document.addEventListener("DOMContentLoaded", attach, { once: true });
  };
  window.__chatpaneTitleBar = apply;
  apply(window.__CHATPANE_TITLE_BAR__);
})();
