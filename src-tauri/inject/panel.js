/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: inject/src/panel/index.ts (bundled by inject/build.ts via `bun run build:inject`).
 */
"use strict";
(() => {
  // inject/src/native-timers.ts
  var page = window;
  var setTimeout = page.setTimeout.bind(page);
  var clearTimeout = page.clearTimeout.bind(page);
  var setInterval = page.setInterval.bind(page);
  var clearInterval = page.clearInterval.bind(page);

  // inject/src/i18n.ts
  var ENGLISH = { lang: "en", dir: "ltr", strings: {} };
  function current() {
    return globalThis.__CHATPANE_I18N__ ?? ENGLISH;
  }
  function language() {
    const { lang, dir } = current();
    return { lang, dir };
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
  var t = text;

  // inject/src/panel/shortcut-data.ts
  function shortcutGroups(isMac) {
    const mod = isMac ? "⌘" : "Ctrl";
    const shift = isMac ? "⇧" : "Shift";
    const alt = isMac ? "⌥" : "Alt";
    const chord = (...keys) => keys.join(" + ");
    return [
      {
        title: t("page.shortcuts.group.conversations"),
        items: [
          { keys: chord(mod, "1–9"), action: t("page.shortcuts.jump_to_conversation") },
          {
            keys: "Ctrl + Tab / Ctrl + Shift + Tab",
            action: t("page.shortcuts.next_previous_conversation")
          },
          {
            keys: `${chord(mod, "]")} / ${chord(mod, "[")}`,
            action: t("page.shortcuts.next_previous_conversation")
          },
          { keys: chord(mod, shift, "N"), action: t("page.shortcuts.new_conversation") },
          { keys: chord(mod, "N"), action: t("page.shortcuts.new_window") },
          { keys: chord(mod, "K"), action: t("page.shortcuts.search_conversations") },
          { keys: chord(mod, "F"), action: t("page.shortcuts.search_in_conversation") },
          { keys: chord(mod, "L"), action: t("page.shortcuts.focus_message_input") }
        ]
      },
      {
        title: t("page.shortcuts.group.compose"),
        items: [
          { keys: chord(mod, "E"), action: t("page.shortcuts.emoji_picker") },
          { keys: chord(mod, "G"), action: t("page.shortcuts.gif_picker") },
          { keys: chord(mod, "T"), action: t("page.shortcuts.attach_files") },
          { keys: chord(mod, shift, alt, "V"), action: t("page.shortcuts.paste_and_match_style") }
        ]
      },
      {
        title: t("page.shortcuts.group.view"),
        items: [
          { keys: chord(mod, shift, "I"), action: t("page.shortcuts.toggle_conversation_info") },
          { keys: chord(mod, shift, "H"), action: t("page.shortcuts.hide_names") },
          { keys: chord(mod, shift, "M"), action: t("page.shortcuts.show_hide_app") },
          {
            keys: `${chord(mod, "-")} / ${chord(mod, "=")} / ${chord(mod, "0")}`,
            action: t("page.shortcuts.zoom")
          },
          { keys: chord(mod, ","), action: t("page.shortcuts.open_settings") },
          { keys: chord(mod, "R"), action: t("page.shortcuts.reload") },
          { keys: chord(mod, shift, "Backspace"), action: t("page.shortcuts.clear_cache") },
          { keys: "F2 / F3 / F5", action: t("page.shortcuts.function_keys") },
          { keys: `${chord(mod, "/")} / F1`, action: t("page.shortcuts.keyboard_shortcuts") }
        ]
      }
    ];
  }

  // inject/src/panel/star-prompt.ts
  var SETTLE_MS = 2e3;
  var TYPING_QUIET_MS = 1e4;
  var VISIBLE_MS = 2e4;
  var isQuietMoment = (moment) => moment.focused && moment.messengerUi && !moment.dialogOpen && moment.msSinceKey >= TYPING_QUIET_MS && moment.draftLength === 0;
  function installStarPrompt() {
    let lastKey = Number.NEGATIVE_INFINITY;
    window.addEventListener("keydown", () => lastKey = performance.now(), true);
    let shown = false;
    let pending;
    const moment = () => ({
      focused: document.visibilityState === "visible" && document.hasFocus(),
      // The chat list, so not the login page.
      messengerUi: Boolean(document.querySelector('[role="navigation"] a[href*="/t/"]')),
      dialogOpen: [...document.querySelectorAll('[role="dialog"]')].some(
        (dialog) => dialog.getClientRects().length > 0
      ),
      msSinceKey: performance.now() - lastKey,
      draftLength: [
        ...document.querySelectorAll('[role="main"] [contenteditable="true"][role="textbox"]')
      ].reduce((length, box) => length + (box.textContent?.trim().length ?? 0), 0)
    });
    Object.defineProperty(window, "__chatpaneStarPrompt", {
      value: () => {
        if (shown) return;
        clearTimeout(pending);
        pending = setTimeout(() => {
          if (shown || !isQuietMoment(moment())) return;
          shown = true;
          window.__chatpaneToast?.(
            t("page.growth.star_prompt"),
            { label: t("shared.growth.star"), kind: "star-github" },
            { duration: VISIBLE_MS, closable: true, bottom: 88 }
          );
          chatpaneStarPrompt("shown")?.catch?.(() => {
          });
        }, SETTLE_MS);
      },
      writable: false,
      configurable: false
    });
  }

  // inject/src/panel/toast.ts
  var canActivateToastAction = (eventIsTrusted, userActivationIsActive) => eventIsTrusted && userActivationIsActive;
  function installToast() {
    const toastEl = document.createElement("div");
    toastEl.setAttribute("role", "status");
    toastEl.setAttribute("aria-live", "polite");
    toastEl.setAttribute("aria-atomic", "true");
    Object.assign(toastEl, language());
    Object.assign(toastEl.style, {
      position: "fixed",
      bottom: "24px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: 2147483647,
      display: "flex",
      alignItems: "center",
      gap: "12px",
      background: "#242526",
      color: "#e4e6eb",
      padding: "10px 16px",
      borderRadius: "10px",
      boxShadow: "0 8px 28px rgba(0,0,0,.45)",
      font: "13px -apple-system, system-ui, sans-serif",
      opacity: "0",
      transition: "opacity .2s, transform .2s",
      pointerEvents: "none",
      maxWidth: "80vw"
    });
    const message = document.createElement("span");
    const button = document.createElement("button");
    button.type = "button";
    Object.assign(button.style, {
      border: "0",
      padding: "0",
      background: "transparent",
      color: "#8ab4ff",
      font: "inherit",
      fontWeight: "600",
      whiteSpace: "nowrap",
      cursor: "pointer"
    });
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "✕";
    close.setAttribute("aria-label", t("page.window.close"));
    Object.assign(close.style, {
      border: "0",
      padding: "0 2px",
      background: "transparent",
      color: "#b0b3b8",
      font: "inherit",
      cursor: "pointer"
    });
    let mounted = false;
    let action;
    let toastTimer;
    let toastRemoveTimer;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!action || !canActivateToastAction(event.isTrusted, navigator.userActivation?.isActive === true)) {
        return;
      }
      if (action.kind === "reveal-download") chatpaneRevealDownload(action.url)?.catch?.(() => {
      });
      else if (action.kind === "open-download-privacy")
        chatpaneOpenDownloadPrivacy()?.catch?.(() => {
        });
      else if (action.kind === "star-github") chatpaneStarPrompt("star")?.catch?.(() => {
      });
      hide();
    });
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      hide();
    });
    const hide = () => {
      clearTimeout(toastTimer);
      clearTimeout(toastRemoveTimer);
      action = void 0;
      toastEl.style.pointerEvents = "none";
      toastEl.style.opacity = "0";
      toastEl.style.transform = "translateX(-50%) translateY(8px)";
      toastRemoveTimer = setTimeout(() => {
        toastEl.remove();
        mounted = false;
        action = void 0;
      }, 250);
    };
    const scheduleHide = (ms) => {
      clearTimeout(toastTimer);
      toastTimer = setTimeout(hide, ms);
    };
    toastEl.addEventListener("mouseenter", () => clearTimeout(toastTimer));
    toastEl.addEventListener("mouseleave", () => {
      if (mounted) scheduleHide(2600);
    });
    const showToast = (msg, nextAction, options) => {
      if (!mounted) {
        document.body.appendChild(toastEl);
        mounted = true;
      }
      action = nextAction;
      toastEl.setAttribute("role", options?.warning ? "alert" : "status");
      toastEl.setAttribute("aria-live", options?.warning ? "assertive" : "polite");
      toastEl.style.border = options?.warning ? "1px solid #b58130" : "none";
      toastEl.style.bottom = `${options?.bottom ?? 24}px`;
      message.textContent = msg;
      toastEl.replaceChildren(message);
      toastEl.style.pointerEvents = action || options?.closable ? "auto" : "none";
      if (action) {
        button.textContent = action.label;
        toastEl.append(button);
      }
      if (options?.closable) toastEl.append(close);
      requestAnimationFrame(() => {
        toastEl.style.opacity = "1";
        toastEl.style.transform = "translateX(-50%) translateY(0)";
      });
      clearTimeout(toastRemoveTimer);
      scheduleHide(options?.duration ?? (options?.warning ? 8e3 : action ? 6e3 : 2600));
    };
    Object.defineProperty(window, "__chatpaneToast", {
      value: showToast,
      writable: false,
      configurable: false
    });
    return () => {
      clearTimeout(toastTimer);
      clearTimeout(toastRemoveTimer);
      toastEl.remove();
      mounted = false;
      action = void 0;
    };
  }

  // inject/src/panel/index.ts
  var invoke = (cmd, args) => window.__TAURI_INTERNALS__?.invoke(cmd, args);
  var emit = (event) => invoke("plugin:event|emit", { event, payload: null })?.catch?.(() => {
  });
  function main() {
    installToast();
    installStarPrompt();
    window.__chatpaneCheckUpdates = () => {
      window.__chatpaneToast?.(t("page.update.opening_settings"));
      emit("chatpane:open-settings");
    };
    window.__chatpaneToggleSettings = () => {
      emit("chatpane:open-settings");
    };
    const isMac = /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
    let shortcutOverlay = null;
    let shortcutReturnFocus = null;
    let shortcutKeyHandler = null;
    const closeShortcuts = () => {
      shortcutOverlay?.remove();
      shortcutOverlay = null;
      if (shortcutKeyHandler) window.removeEventListener("keydown", shortcutKeyHandler, true);
      shortcutKeyHandler = null;
      shortcutReturnFocus?.focus({ preventScroll: true });
      shortcutReturnFocus = null;
    };
    const openShortcuts = () => {
      if (shortcutOverlay) return;
      shortcutReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const overlay = document.createElement("div");
      overlay.setAttribute("data-chatpane-shortcuts-overlay", "");
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-labelledby", "chatpane-shortcuts-title");
      Object.assign(overlay, language());
      Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483647",
        display: "grid",
        placeItems: "center",
        padding: "24px",
        background: "rgba(0, 0, 0, .58)",
        font: "14px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
      });
      const card = document.createElement("section");
      Object.assign(card.style, {
        width: "min(760px, 100%)",
        maxHeight: "min(760px, 88vh)",
        overflow: "auto",
        boxSizing: "border-box",
        color: "var(--primary-text, CanvasText)",
        background: "var(--card-background, Canvas)",
        border: "1px solid var(--divider, rgba(127, 127, 127, .3))",
        borderRadius: "14px",
        boxShadow: "0 18px 60px rgba(0, 0, 0, .45)",
        padding: "20px"
      });
      const header = document.createElement("header");
      Object.assign(header.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "16px",
        marginBottom: "16px"
      });
      const title = document.createElement("h2");
      title.id = "chatpane-shortcuts-title";
      title.textContent = t("page.shortcuts.title");
      Object.assign(title.style, { margin: "0", fontSize: "20px", lineHeight: "1.2" });
      const close = document.createElement("button");
      close.type = "button";
      close.setAttribute("aria-label", t("page.shortcuts.close"));
      close.textContent = "×";
      Object.assign(close.style, {
        width: "36px",
        height: "36px",
        border: "0",
        borderRadius: "50%",
        color: "inherit",
        background: "var(--hover-overlay, rgba(127, 127, 127, .16))",
        cursor: "pointer",
        font: "26px/30px -apple-system, system-ui, sans-serif"
      });
      close.addEventListener("click", closeShortcuts);
      header.append(title, close);
      card.append(header);
      const groups = document.createElement("div");
      Object.assign(groups.style, {
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "20px 28px"
      });
      for (const group of shortcutGroups(isMac)) {
        const section = document.createElement("section");
        const heading = document.createElement("h3");
        heading.textContent = group.title;
        Object.assign(heading.style, {
          margin: "0 0 9px",
          fontSize: "13px",
          color: "var(--secondary-text, GrayText)",
          textTransform: "uppercase",
          letterSpacing: ".06em"
        });
        const list = document.createElement("dl");
        Object.assign(list.style, { display: "grid", gap: "9px", margin: "0" });
        for (const item of group.items) {
          const row = document.createElement("div");
          Object.assign(row.style, {
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr)",
            gap: "4px"
          });
          const keys = document.createElement("dt");
          const key = document.createElement("kbd");
          key.dir = "ltr";
          key.textContent = item.keys;
          Object.assign(key.style, {
            display: "inline-block",
            padding: "3px 6px",
            border: "1px solid var(--divider, rgba(127, 127, 127, .35))",
            borderRadius: "5px",
            background: "var(--wash, rgba(127, 127, 127, .1))",
            font: "12px ui-monospace, SFMono-Regular, Consolas, monospace",
            whiteSpace: "nowrap"
          });
          keys.append(key);
          const action = document.createElement("dd");
          action.textContent = item.action;
          Object.assign(action.style, { margin: "0", lineHeight: "1.35" });
          row.append(keys, action);
          list.append(row);
        }
        section.append(heading, list);
        groups.append(section);
      }
      card.append(groups);
      overlay.append(card);
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closeShortcuts();
      });
      shortcutKeyHandler = (event) => {
        const helpKey = event.key === "F1" || !event.altKey && (isMac ? event.metaKey : event.ctrlKey) && event.key === "/";
        if (event.key === "Escape" || helpKey) {
          event.preventDefault();
          event.stopPropagation();
          closeShortcuts();
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          close.focus();
          return;
        }
        if ((event.key === "Enter" || event.key === " ") && document.activeElement === close) {
          return;
        }
        event.stopPropagation();
      };
      window.addEventListener("keydown", shortcutKeyHandler, true);
      shortcutOverlay = overlay;
      document.body.append(overlay);
      close.focus({ preventScroll: true });
    };
    window.__chatpaneToggleShortcuts = () => {
      if (shortcutOverlay) closeShortcuts();
      else openShortcuts();
    };
  }
  if (window.top === window.self) main();
})();
