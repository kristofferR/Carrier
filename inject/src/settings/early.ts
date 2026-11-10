import { settingsText as t } from "../i18n";
import { invoke } from "./bridge";

const I18N = window.__CHATPANE_I18N__;
document.documentElement.lang = I18N?.lang ?? "en";
document.documentElement.dir = I18N?.dir ?? "ltr";
document.title = t("settings.window.title");

// Before the first paint, so the tab bar doesn't move.
if (/Mac/.test(navigator.platform || "")) document.documentElement.classList.add("mac-title-bar");
// Windows and Linux: Chatpane's close button and drag strip. Settings
// can't be minimized or maximized, so close is the only control.
(() => {
  const root = document.documentElement;
  const control = (action: "drag" | "close") =>
    invoke("window_control", { action }).catch(() => {});
  let strip: HTMLDivElement | null = null;
  let box: HTMLDivElement | null = null;
  const apply = (state: Window["__CHATPANE_TITLE_BAR__"]) => {
    if (!state?.controls || state.inset <= 0) {
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
      close.innerHTML =
        '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg>';
      close.addEventListener("click", () => control("close"));
      box.append(close);
    }
    const attach = () => {
      if (box && strip && !box.isConnected) document.body.append(strip, box);
    };
    if (document.body) attach();
    else document.addEventListener("DOMContentLoaded", attach, { once: true });
  };
  window.__chatpaneTitleBar = (state) => apply(state as Window["__CHATPANE_TITLE_BAR__"]);
  apply(window.__CHATPANE_TITLE_BAR__);
})();
