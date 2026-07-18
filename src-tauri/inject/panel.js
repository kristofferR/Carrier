/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: inject/src/panel/index.ts (bundled by inject/build.ts via `bun run build:inject`).
 */
"use strict";
(() => {
  // inject/src/panel/shortcut-data.ts
  function shortcutGroups(isMac) {
    const mod = isMac ? "⌘" : "Ctrl";
    const shift = isMac ? "⇧" : "Shift";
    const alt = isMac ? "⌥" : "Alt";
    const chord = (...keys) => keys.join(" + ");
    return [
      {
        title: "Conversations",
        items: [
          { keys: chord(mod, "1–9"), action: "Jump to a conversation" },
          { keys: "Ctrl + Tab / Ctrl + Shift + Tab", action: "Next / previous conversation" },
          { keys: `${chord(mod, "]")} / ${chord(mod, "[")}`, action: "Next / previous conversation" },
          { keys: chord(mod, shift, "N"), action: "New conversation" },
          { keys: chord(mod, "N"), action: "New window" },
          { keys: chord(mod, "K"), action: "Search conversations" },
          { keys: chord(mod, "F"), action: "Search in conversation" },
          { keys: chord(mod, "L"), action: "Focus message input" }
        ]
      },
      {
        title: "Compose",
        items: [
          { keys: chord(mod, "E"), action: "Open emoji picker" },
          { keys: chord(mod, "G"), action: "Open GIF picker" },
          { keys: chord(mod, "T"), action: "Attach files" },
          { keys: chord(mod, shift, alt, "V"), action: "Paste and match style" }
        ]
      },
      {
        title: "View & Carrier",
        items: [
          { keys: chord(mod, shift, "I"), action: "Toggle conversation information" },
          { keys: chord(mod, shift, "H"), action: "Hide names and avatars" },
          { keys: chord(mod, shift, "M"), action: "Show or hide Carrier globally" },
          {
            keys: `${chord(mod, "-")} / ${chord(mod, "=")} / ${chord(mod, "0")}`,
            action: "Zoom out / in / reset"
          },
          { keys: chord(mod, ","), action: "Open Settings" },
          { keys: chord(mod, "R"), action: "Reload" },
          { keys: chord(mod, shift, "Backspace"), action: "Clear cache and restart" },
          { keys: "F2 / F3 / F5", action: "Update settings / Settings / reload" },
          { keys: `${chord(mod, "/")} / F1`, action: "Keyboard shortcuts" }
        ]
      }
    ];
  }

  // inject/src/panel/index.ts
  var invoke = (cmd, args) => window.__TAURI_INTERNALS__?.invoke(cmd, args);
  var emit = (event) => invoke("plugin:event|emit", { event, payload: null })?.catch?.(() => {
  });
  function main() {
    let toastEl = null;
    let toastTimer;
    window.__carrierToast = (msg) => {
      if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.setAttribute("role", "status");
        toastEl.setAttribute("aria-live", "polite");
        toastEl.setAttribute("aria-atomic", "true");
        Object.assign(toastEl.style, {
          position: "fixed",
          bottom: "24px",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 2147483647,
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
        document.body.appendChild(toastEl);
      }
      const el = toastEl;
      el.textContent = msg;
      requestAnimationFrame(() => {
        el.style.opacity = "1";
        el.style.transform = "translateX(-50%) translateY(0)";
      });
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        el.style.opacity = "0";
        el.style.transform = "translateX(-50%) translateY(8px)";
      }, 2600);
    };
    window.__carrierCheckUpdates = () => {
      window.__carrierToast?.("Opening Settings to check for updates…");
      emit("carrier:open-settings");
    };
    window.__carrierToggleSettings = () => {
      emit("carrier:open-settings");
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
      overlay.setAttribute("data-carrier-shortcuts-overlay", "");
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-labelledby", "carrier-shortcuts-title");
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
      title.id = "carrier-shortcuts-title";
      title.textContent = "Keyboard Shortcuts";
      Object.assign(title.style, { margin: "0", fontSize: "20px", lineHeight: "1.2" });
      const close = document.createElement("button");
      close.type = "button";
      close.setAttribute("aria-label", "Close keyboard shortcuts");
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
    window.__carrierToggleShortcuts = () => {
      if (shortcutOverlay) closeShortcuts();
      else openShortcuts();
    };
  }
  if (window.top === window.self) main();
})();
