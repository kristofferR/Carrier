/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: inject/src/settings/early.ts (bundled by inject/build.ts via `bun run build:inject`).
 */
const I18N = window.__CHATPANE_I18N__ || { lang: "en", dir: "ltr", strings: {}, languages: [], system: "en" };
const LOCALE = I18N.lang.includes("-") ? I18N.lang : (navigator.languages || []).find((tag) => tag.split("-")[0] === I18N.lang) || I18N.lang;
function t(key, vars) {
  const text = I18N.strings[key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => {
    const value = vars[name];
    if (value === void 0) return match;
    return typeof value === "number" ? value.toLocaleString(LOCALE) : String(value);
  });
}
document.documentElement.lang = I18N.lang;
document.documentElement.dir = I18N.dir;
document.title = t("settings.window.title");
if (/Mac/.test(navigator.platform || "")) document.documentElement.classList.add("mac-title-bar");
(() => {
  const root = document.documentElement;
  const control = (action) => window.__TAURI_INTERNALS__.invoke("window_control", { action }).catch(() => {
  });
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
