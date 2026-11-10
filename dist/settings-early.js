/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: inject/src/settings/early.ts (bundled by inject/build.ts via `bun run build:inject`).
 */
"use strict";
(() => {
  // inject/src/i18n.ts
  var ENGLISH = { lang: "en", dir: "ltr", strings: {} };
  function current() {
    return globalThis.__CHATPANE_I18N__ ?? ENGLISH;
  }
  function formatLocale() {
    const { lang } = current();
    if (lang.includes("-")) return lang;
    return globalThis.navigator?.languages?.find((tag) => tag.split("-")[0] === lang) ?? lang;
  }
  function fill(text2, vars) {
    if (!vars) return text2;
    const locale = formatLocale();
    return text2.replace(/\{(\w+)\}/g, (match, name) => {
      const value = vars[name];
      if (value === void 0) return match;
      return typeof value === "number" ? value.toLocaleString(locale) : value;
    });
  }
  function text(key, vars) {
    return fill(current().strings[key] ?? key, vars);
  }
  var settingsText = text;

  // inject/src/settings/bridge.ts
  function invoke(command, ...args) {
    const bridge = window.__TAURI_INTERNALS__;
    return bridge.invoke(command, args[0]);
  }

  // inject/src/settings/early.ts
  var I18N = window.__CHATPANE_I18N__;
  document.documentElement.lang = I18N?.lang ?? "en";
  document.documentElement.dir = I18N?.dir ?? "ltr";
  document.title = settingsText("settings.window.title");
  if (/Mac/.test(navigator.platform || "")) document.documentElement.classList.add("mac-title-bar");
  (() => {
    const root = document.documentElement;
    const control = (action) => invoke("window_control", { action }).catch(() => {
    });
    let strip = null;
    let box = null;
    const apply = (state) => {
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
        close.title = settingsText("settings.window.close");
        close.setAttribute("aria-label", close.title);
        close.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg>';
        close.addEventListener("click", () => control("close"));
        box.append(close);
      }
      const attach = () => {
        if (box && strip && !box.isConnected) document.body.append(strip, box);
      };
      if (document.body) attach();
      else document.addEventListener("DOMContentLoaded", attach, { once: true });
    };
    window.__chatpaneTitleBar = (state) => apply(state);
    apply(window.__CHATPANE_TITLE_BAR__);
  })();
})();
