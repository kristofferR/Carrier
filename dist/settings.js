/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: inject/src/settings/index.ts (bundled by inject/build.ts via `bun run build:inject`).
 */
"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

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

  // inject/src/settings/update-consent.ts
  function parseInstallMode(value) {
    if (typeof value !== "object" || value === null || !("kind" in value)) {
      throw new Error("missing update install mode");
    }
    if (value.kind === "built-in") return { kind: "built-in" };
    if ((value.kind === "manual" || value.kind === "debug") && "buttonLabel" in value && typeof value.buttonLabel === "string" && value.buttonLabel && "instructions" in value && typeof value.instructions === "string" && value.instructions) {
      return {
        kind: value.kind,
        buttonLabel: value.buttonLabel,
        instructions: value.instructions
      };
    }
    throw new Error("invalid update install mode");
  }
  var checkLabel = () => settingsText("settings.update.check");
  var installLabel = (version) => settingsText("settings.update.install", { version });
  function availableState(version, installMode, opened = false) {
    if (installMode.kind !== "manual") {
      return {
        phase: "available",
        buttonLabel: installLabel(version),
        status: settingsText("settings.update.available", { version }),
        busy: false,
        version
      };
    }
    const { buttonLabel, instructions } = installMode;
    return {
      phase: "available",
      buttonLabel,
      status: opened ? settingsText("settings.update.page_opened_with_instructions", { instructions }) : settingsText("settings.update.available_with_instructions", { version, instructions }),
      busy: false,
      version
    };
  }
  function failureDetail(error) {
    const raw = error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? "");
    return raw.replace(/\s+/g, " ").trim().slice(0, 240);
  }
  var UpdateConsentController = class {
    constructor(invoke2, onState = () => {
    }) {
      __publicField(this, "invoke", invoke2);
      __publicField(this, "onState", onState);
      __publicField(this, "version", "");
      __publicField(this, "phase", "idle");
      __publicField(this, "installMode", null);
    }
    publish(state) {
      this.phase = state.phase;
      this.onState(state);
      return state;
    }
    /** `known` is what native code already had when the window was built; with
     * it, the state is published before this returns its promise. */
    async initialize(known) {
      const [rawInstallMode, discovered] = known ? [known.installMode, known.discovered] : await Promise.all([this.invoke("update_install_mode"), this.invoke("discovered_update")]);
      this.installMode = parseInstallMode(rawInstallMode);
      if (this.installMode.kind === "debug") {
        return this.publish({
          phase: "idle",
          buttonLabel: this.installMode.buttonLabel,
          status: this.installMode.instructions,
          busy: false
        });
      }
      if (typeof discovered === "string" && discovered) {
        this.version = discovered;
        return this.publish(availableState(discovered, this.installMode));
      }
      this.version = "";
      return this.publish({
        phase: "idle",
        buttonLabel: checkLabel(),
        status: "",
        busy: false
      });
    }
    operationActive() {
      return this.phase === "checking" || this.phase === "installing" || this.phase === "opening-manual";
    }
    /**
     * Re-read the retained discovery (Settings regaining focus): show a newer
     * offer, or go back to "Check for updates" when it was cleared. Never
     * interrupts a check or install, including one that starts during the read.
     * Returns null when nothing changed.
     */
    async refresh() {
      if (!this.installMode || this.installMode.kind === "debug" || this.operationActive()) {
        return null;
      }
      const discovered = await this.invoke("discovered_update");
      if (this.operationActive()) return null;
      const version = typeof discovered === "string" ? discovered : "";
      if (version === this.version) return null;
      this.version = version;
      if (version) return this.publish(availableState(version, this.installMode));
      return this.publish({
        phase: "idle",
        buttonLabel: checkLabel(),
        status: "",
        busy: false
      });
    }
    async activate() {
      if (!this.installMode) throw new Error("update controller was not initialized");
      if (this.installMode.kind === "debug") {
        await this.invoke("open_manual_update");
        return this.publish({
          phase: "idle",
          buttonLabel: this.installMode.buttonLabel,
          status: this.installMode.instructions,
          busy: false
        });
      }
      if (!this.version) {
        this.publish({
          phase: "checking",
          buttonLabel: checkLabel(),
          status: settingsText("settings.update.checking"),
          busy: true
        });
        const result = String(await this.invoke("check_for_updates"));
        if (result === "up-to-date") {
          return this.publish({
            phase: "up-to-date",
            buttonLabel: checkLabel(),
            status: settingsText("settings.update.up_to_date"),
            busy: false
          });
        }
        this.version = result.startsWith("available:") ? result.slice(10) : "";
        if (!this.version) throw new Error(`unexpected update-check result: ${result}`);
        return this.publish(availableState(this.version, this.installMode));
      }
      this.publish(availableState(this.version, this.installMode));
      if (this.installMode.kind === "manual") {
        this.publish({
          phase: "opening-manual",
          buttonLabel: this.installMode.buttonLabel,
          status: settingsText("settings.update.opening_manual"),
          busy: true,
          version: this.version
        });
        await this.invoke("open_manual_update");
        return this.publish(availableState(this.version, this.installMode, true));
      }
      this.publish({
        phase: "installing",
        buttonLabel: installLabel(this.version),
        status: settingsText("settings.update.installing"),
        busy: true,
        version: this.version
      });
      const installResult = String(await this.invoke("install_update"));
      if (installResult === "up-to-date") {
        this.version = "";
        return this.publish({
          phase: "up-to-date",
          buttonLabel: checkLabel(),
          status: settingsText("settings.update.already_up_to_date"),
          busy: false
        });
      }
      return this.publish(availableState(this.version, this.installMode));
    }
    fail(error) {
      const detail = failureDetail(error);
      let status;
      if (this.phase === "installing") {
        status = detail ? settingsText("settings.update.install_failed_detail", { detail }) : settingsText("settings.update.install_failed");
      } else if (this.phase === "opening-manual") {
        status = detail ? settingsText("settings.update.open_failed_detail", { detail }) : settingsText("settings.update.open_failed");
      } else {
        status = detail ? settingsText("settings.update.check_failed_detail", { detail }) : settingsText("settings.update.check_failed");
      }
      return this.publish({
        phase: this.version ? "available" : "idle",
        buttonLabel: this.version && this.installMode?.kind === "manual" ? this.installMode.buttonLabel : this.version ? installLabel(this.version) : checkLabel(),
        status,
        busy: false,
        version: this.version || void 0
      });
    }
  };

  // inject/src/settings/index.ts
  var BOOT = window.__CHATPANE_SETTINGS_BOOT__;
  var I18N = {
    lang: "en",
    dir: "ltr",
    strings: {},
    languages: [],
    system: "en",
    ...window.__CHATPANE_I18N__
  };
  var LOCALE = formatLocale();
  var byId = (id) => document.getElementById(id);
  var errorMessage = (error) => error instanceof Error ? error.message : String(error);
  byId("tabs").setAttribute("aria-label", settingsText("settings.tab.list_label"));
  byId("share").textContent = settingsText("settings.footer.share");
  byId("star").textContent = settingsText("shared.growth.star");
  byId("reset").textContent = settingsText("settings.footer.reset");
  byId("check").textContent = settingsText("settings.update.check");
  byId("version").textContent = settingsText("settings.footer.version", { version: BOOT.version }).trim();
  var FIELDS = [
    [
      "always_on_top",
      settingsText("settings.general.always_on_top.label"),
      settingsText("settings.general.always_on_top.hint")
    ],
    [
      "global_hotkey",
      settingsText("settings.general.global_hotkey.label"),
      settingsText("settings.general.global_hotkey.hint")
    ],
    ["show_tray", settingsText("settings.tray.show_tray.label"), settingsText("settings.tray.show_tray.hint")],
    ["start_to_tray", settingsText("settings.tray.start_to_tray.label"), settingsText("settings.tray.start_to_tray.hint")],
    ["autostart", settingsText("settings.tray.autostart.label"), settingsText("settings.tray.autostart.hint")],
    [
      "hide_on_close",
      settingsText("settings.general.hide_on_close.label"),
      settingsText("settings.general.hide_on_close.hint")
    ],
    [
      "unread_badge",
      settingsText("settings.notifications.unread_badge.label"),
      settingsText("settings.notifications.unread_badge.hint")
    ],
    [
      "mute_notifications",
      settingsText("settings.notifications.mute_notifications.label"),
      settingsText("settings.notifications.mute_notifications.hint")
    ],
    [
      "notification_sound",
      settingsText("settings.notifications.notification_sound.label"),
      settingsText("settings.notifications.notification_sound.hint")
    ],
    [
      "notify_group_chats",
      settingsText("settings.notifications.notify_group_chats.label"),
      settingsText("settings.notifications.notify_group_chats.hint")
    ],
    [
      "notify_reactions",
      settingsText("settings.notifications.notify_reactions.label"),
      settingsText("settings.notifications.notify_reactions.hint")
    ],
    [
      "hide_notification_preview",
      settingsText("settings.notifications.hide_notification_preview.label"),
      settingsText("settings.notifications.hide_notification_preview.hint")
    ],
    [
      "group_notifications_by_conversation",
      settingsText("settings.notifications.group_by_conversation.label"),
      settingsText("settings.notifications.group_by_conversation.hint")
    ],
    [
      "clear_notifications_on_view",
      settingsText("settings.notifications.clear_on_view.label"),
      settingsText("settings.notifications.clear_on_view.hint")
    ],
    [
      "attention_on_message",
      settingsText("settings.notifications.attention.label"),
      settingsText("settings.notifications.attention.hint")
    ],
    ["hide_names", settingsText("settings.privacy.hide_names.label"), settingsText("settings.privacy.hide_names.hint")],
    [
      "hide_avatars",
      settingsText("settings.privacy.hide_avatars.label"),
      settingsText("settings.privacy.hide_avatars.hint")
    ],
    [
      "system_emoji",
      settingsText("settings.appearance.system_emoji.label"),
      settingsText("settings.appearance.system_emoji.hint")
    ],
    [
      "block_typing_indicator",
      settingsText("settings.privacy.block_typing_indicator.label"),
      settingsText("settings.privacy.block_typing_indicator.hint")
    ],
    [
      "stop_media_autoplay",
      settingsText("settings.general.stop_media_autoplay.label"),
      settingsText("settings.general.stop_media_autoplay.hint")
    ],
    ["menu_bar_only", settingsText("settings.tray.menu_bar_only.label"), settingsText("settings.tray.menu_bar_only.hint")],
    [
      "hide_menu_bar",
      settingsText("settings.appearance.hide_menu_bar.label"),
      settingsText("settings.appearance.hide_menu_bar.hint")
    ],
    [
      "hide_on_minimize",
      settingsText("settings.tray.hide_on_minimize.label"),
      settingsText("settings.tray.hide_on_minimize.hint")
    ],
    [
      "hide_on_focus_loss",
      settingsText("settings.tray.hide_on_focus_loss.label"),
      settingsText("settings.tray.hide_on_focus_loss.hint")
    ],
    [
      "hide_taskbar_icon",
      settingsText("settings.tray.hide_taskbar_icon.label"),
      settingsText("settings.tray.hide_taskbar_icon.hint")
    ],
    [
      "automatic_update_checks",
      settingsText("settings.advanced.automatic_update_checks.label"),
      settingsText("settings.advanced.automatic_update_checks.hint")
    ],
    [
      "hold_failures",
      settingsText("settings.advanced.hold_failures.label"),
      settingsText("settings.advanced.hold_failures.hint")
    ],
    [
      "focus_composer_on_return",
      settingsText("settings.general.focus_composer_on_return.label"),
      settingsText("settings.general.focus_composer_on_return.hint")
    ],
    ["spellcheck", settingsText("settings.general.spellcheck.label"), settingsText("settings.general.spellcheck.hint")],
    [
      "block_telemetry",
      settingsText("settings.privacy.block_telemetry.label"),
      settingsText("settings.privacy.block_telemetry.hint")
    ],
    [
      "strip_link_tracking",
      settingsText("settings.privacy.strip_link_tracking.label"),
      settingsText("settings.privacy.strip_link_tracking.hint")
    ],
    [
      "send_with_accelerator",
      settingsText("settings.advanced.send_with_accelerator.label"),
      settingsText("settings.advanced.send_with_accelerator.hint")
    ],
    [
      "multi_instance",
      settingsText("settings.advanced.multi_instance.label"),
      settingsText("settings.advanced.multi_instance.hint")
    ]
  ];
  var FIELD_META = Object.fromEntries(
    FIELDS.map(([k, label, hint]) => [k, { label, hint }])
  );
  var ICONS = {
    general: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
    appearance: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    tray: '<path d="M12 2v10"/><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>',
    notifications: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    privacy: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
    account: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    advanced: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'
  };
  var IS_MAC = /Mac/.test(navigator.platform || navigator.userAgent);
  var IS_WINDOWS = /Win/.test(navigator.platform || navigator.userAgent);
  var IS_LINUX = !IS_MAC && !IS_WINDOWS && /Linux/.test(navigator.userAgent);
  var runtimeCapabilities = BOOT.capabilities;
  if (IS_WINDOWS) {
    FIELD_META.attention_on_message = {
      label: settingsText("settings.notifications.attention.label_windows"),
      hint: settingsText("settings.notifications.attention.hint_windows")
    };
  }
  var TABS = [
    {
      id: "general",
      label: settingsText("settings.tab.general"),
      icon: ICONS.general,
      fields: [
        "language",
        "messenger_language",
        "always_on_top",
        "global_hotkey",
        "hide_on_close",
        "spellcheck",
        "stop_media_autoplay",
        "focus_composer_on_return",
        "download_behavior"
      ]
    },
    // A tab is one card of `fields`, or `cards`: each a list of fields or
    // the key of a section that builds its own card.
    {
      id: "appearance",
      label: settingsText("settings.tab.appearance"),
      icon: ICONS.appearance,
      cards: [
        // Windows: the native menu bar never shows next to Chatpane's
        // window buttons (src-tauri/src/title_bar.rs), so nothing to hide.
        ["zoom", ...IS_LINUX ? ["hide_menu_bar"] : [], "system_emoji", "nickname_scope"],
        "theme_section",
        "look_section",
        "app_icon"
      ]
    },
    {
      id: "tray",
      label: settingsText("settings.tab.tray"),
      icon: ICONS.tray,
      fields: [
        "show_tray",
        "start_to_tray",
        "autostart",
        ...IS_MAC || IS_LINUX || IS_WINDOWS ? ["tray_icon_style"] : [],
        ...IS_MAC ? ["menu_bar_only"] : [],
        ...IS_WINDOWS ? ["hide_on_minimize", "hide_on_focus_loss", "hide_taskbar_icon"] : []
      ]
    },
    {
      id: "notifications",
      label: settingsText("settings.tab.notifications"),
      icon: ICONS.notifications,
      fields: [
        "mute_notifications",
        "notification_sound",
        "notify_group_chats",
        "notify_reactions",
        "hide_notification_preview",
        "notification_reaction",
        ...IS_MAC ? ["group_notifications_by_conversation"] : [],
        ...IS_MAC || IS_WINDOWS ? ["clear_notifications_on_view", "attention_on_message"] : [],
        "unread_badge",
        "muted_conversations",
        "badge_mode",
        "test_notification"
      ]
    },
    {
      id: "privacy",
      label: settingsText("settings.tab.privacy"),
      icon: ICONS.privacy,
      fields: [
        "block_typing_indicator",
        "hide_names",
        "hide_avatars",
        "block_telemetry",
        "strip_link_tracking"
      ]
    },
    {
      id: "account",
      label: settingsText("settings.tab.account"),
      icon: ICONS.account,
      cards: ["messenger_account"]
    },
    {
      id: "advanced",
      label: settingsText("settings.tab.advanced"),
      icon: ICONS.advanced,
      fields: [
        "automatic_update_checks",
        "update_check_hours",
        "hold_failures",
        "send_with_accelerator",
        "multi_instance",
        "custom_css",
        "open_logs"
      ]
    }
  ];
  var activeTab = "general";
  try {
    const legacyTab = localStorage.getItem("carrier:settingsTab");
    if (legacyTab !== null) {
      if (localStorage.getItem("chatpane:settingsTab") === null) {
        localStorage.setItem("chatpane:settingsTab", legacyTab);
      }
      localStorage.removeItem("carrier:settingsTab");
    }
    const saved = localStorage.getItem("chatpane:settingsTab");
    if (saved && TABS.some((tab) => tab.id === saved)) activeTab = saved;
  } catch (_) {
  }
  var settings = BOOT.settings;
  var updateStatus = "";
  var statusTimer;
  function setStatus(message, clearAfter) {
    clearTimeout(statusTimer);
    byId("status").textContent = message || updateStatus;
    if (message && clearAfter) statusTimer = setTimeout(() => setStatus(""), clearAfter);
  }
  function svgIcon(inner) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.6");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = inner;
    return svg;
  }
  var autostartStatus = null;
  async function readAutostartStatus() {
    try {
      return await invoke("autostart_status");
    } catch (e) {
      console.error(e);
      return null;
    }
  }
  async function refresh() {
    try {
      const status = await readAutostartStatus();
      const fresh = await invoke("get_settings");
      if (status === autostartStatus && JSON.stringify(fresh) === JSON.stringify(settings)) return;
      autostartStatus = status;
      settings = fresh;
      render();
    } catch (e) {
      console.error(e);
    }
  }
  var pendingSave = Promise.resolve();
  function persist(change) {
    pendingSave = pendingSave.then(() => saveSetting(change));
    return pendingSave;
  }
  async function saveSetting(change) {
    try {
      settings = await invoke("update_setting", { change });
      if (change.key === "autostart") {
        autostartStatus = await readAutostartStatus();
        settings = await invoke("get_settings");
      }
      render();
      setStatus(settingsText("settings.status.saved"), 1200);
    } catch (error) {
      setStatus(errorMessage(error));
      console.error(error);
      await refresh();
      render();
    }
  }
  function rowText(label, hint) {
    const text2 = document.createElement("div");
    text2.className = "text";
    const name = document.createElement("div");
    name.className = "label";
    name.textContent = label;
    text2.append(name);
    if (hint) {
      const line = document.createElement("div");
      line.className = "hint";
      line.textContent = hint;
      text2.append(line);
    }
    return text2;
  }
  function buttonRow(label, hint, buttonText, onClick) {
    const row = document.createElement("div");
    row.className = "row";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary";
    btn.textContent = buttonText;
    btn.onclick = () => onClick(btn, row);
    row.append(rowText(label, hint), btn);
    return row;
  }
  function switchInput(checked) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "switch";
    input.setAttribute("role", "switch");
    input.checked = checked;
    return input;
  }
  function selectRow(current2, fallback, options, label, hint, disabled, onPick) {
    const row = el("label", "row");
    const select = document.createElement("select");
    for (const [value, text2] of options) {
      const option = el("option", "", text2);
      option.value = String(value);
      option.selected = String(current2 || fallback) === String(value);
      select.append(option);
    }
    select.disabled = disabled;
    select.onchange = () => {
      const option = options.find(([value]) => String(value) === select.value);
      if (option) onPick(option[0]);
    };
    row.append(rowText(label, hint), select);
    return row;
  }
  var themes = null;
  var fonts = null;
  var themeNotice = null;
  var DEFAULT_PREVIEW = {
    light: ["#f0f2f5", "#ffffff", "#ffffff", "#0866ff", "#f0f0f0"],
    dark: ["#1c1c1d", "#242526", "#242526", "#0866ff", "#303030"]
  };
  var DARK_PREVIEWS = {
    graphite: ["#141517", "#1d1e20", "#212224", "#d9dadd", "#2f3134"],
    warm: ["#16120f", "#1f1a16", "#241e19", "#d9774c", "#352c25"],
    pink: ["#1a0f15", "#24151d", "#2a1822", "#c93a7d", "#3a2230"],
    lavender: ["#15121d", "#1d1928", "#221d2e", "#7356c0", "#312a42"],
    sage: ["#121712", "#1a201a", "#1e251e", "#4f7a4a", "#2d362c"],
    slate: ["#161b23", "#1e2430", "#222937", "#4f73a8", "#2f3747"]
  };
  var ACCENTS = [
    ["#0866ff", settingsText("settings.appearance.accent.blue")],
    ["#8a3ffc", settingsText("settings.appearance.accent.purple")],
    ["#e0427a", settingsText("settings.appearance.accent.pink")],
    ["#e5484d", settingsText("settings.appearance.accent.red")],
    ["#f27a1a", settingsText("settings.appearance.accent.orange")],
    ["#2ea44f", settingsText("settings.appearance.accent.green")],
    ["#0f9d9a", settingsText("settings.appearance.accent.teal")]
  ];
  async function loadThemes() {
    try {
      themes = await invoke("list_themes");
    } catch (e) {
      themes = [];
      console.error(e);
    }
  }
  function pageIsDark() {
    if (settings.theme === "dark") return true;
    if (settings.theme === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function untilTime(ms) {
    const end = new Date(ms);
    const options = { hour: "2-digit", minute: "2-digit" };
    if (end.toDateString() !== (/* @__PURE__ */ new Date()).toDateString()) options.weekday = "short";
    return end.toLocaleString(LOCALE, options);
  }
  function el(tag, className = "", text2 = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text2 !== void 0) node.textContent = text2;
    return node;
  }
  function segmented(label, options, current2, onPick) {
    const seg = el("div", "seg");
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", label);
    for (const [value, text2] of options) {
      const b = el("button", "", text2);
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(value === current2));
      b.onclick = () => value !== current2 && onPick(value);
      seg.append(b);
    }
    return seg;
  }
  function titledCard(title, control) {
    const card = el("section", "card");
    const head = el("div", "card-head");
    const heading = el("h2", "card-title", title);
    heading.style.margin = "0";
    head.append(heading);
    if (control) head.append(control);
    card.append(head);
    return card;
  }
  function checkMark() {
    const check = el("span", "check");
    check.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return check;
  }
  function isDarkColor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const luma = 0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255);
    return luma < 128;
  }
  function previewFor(colors) {
    const [wash, list, chat, out, incoming] = colors;
    const box = el("span", "preview");
    box.style.background = wash;
    const side = el("span", "list");
    side.style.background = list;
    const ink = isDarkColor(list) ? "#ffffff" : "#000000";
    for (let i = 0; i < 4; i += 1) {
      const line = el("i");
      line.style.background = ink;
      line.style.width = `${[80, 60, 70, 50][i]}%`;
      side.append(line);
    }
    const pane = el("span", "chat");
    pane.style.background = chat;
    for (const [kind, color] of [
      ["in", incoming],
      ["out", out],
      ["in", incoming]
    ]) {
      const bubble = el("span", `bubble ${kind}`);
      bubble.style.background = color;
      pane.append(bubble);
    }
    box.append(side, pane);
    return box;
  }
  function cardColors(theme, dark) {
    let colors;
    if (theme.id === "default") colors = DEFAULT_PREVIEW[dark ? "dark" : "light"];
    else if (dark && DARK_PREVIEWS[theme.id]) colors = DARK_PREVIEWS[theme.id];
    else colors = theme.preview || DEFAULT_PREVIEW[dark ? "dark" : "light"];
    colors = [...colors];
    if (settings.accent_color) colors[3] = settings.accent_color;
    return colors;
  }
  function themeCard(theme, dark) {
    const card = el("button", "theme-card");
    card.type = "button";
    card.setAttribute("role", "radio");
    const selected = (settings.color_theme || "default") === theme.id;
    card.setAttribute("aria-checked", String(selected));
    const unavailable = theme.mode && theme.mode !== (dark ? "dark" : "light");
    if (unavailable) card.classList.add("unavailable");
    const preview = previewFor(cardColors(theme, dark));
    if (theme.mode) {
      const only = theme.mode === "dark" ? settingsText("settings.appearance.theme.dark_only") : settingsText("settings.appearance.theme.light_only");
      preview.append(el("span", "pill", only));
    }
    if (selected) preview.append(checkMark());
    const name = el("span", "name", theme.name);
    if (!theme.builtIn) {
      name.append(" ");
      const by = el(
        "span",
        "by",
        theme.author ? settingsText("settings.appearance.theme.author", { author: theme.author }) : settingsText("settings.appearance.theme.added_by_you")
      );
      name.append(by);
    }
    card.append(preview, name);
    if (!unavailable) card.title = theme.name;
    else if (theme.mode === "dark")
      card.title = settingsText("settings.appearance.theme.dark_only_title", { name: theme.name });
    else card.title = settingsText("settings.appearance.theme.light_only_title", { name: theme.name });
    card.onclick = () => persist({ key: "color_theme", value: theme.id });
    return card;
  }
  async function addTheme() {
    try {
      const id = await invoke("add_theme");
      if (!id) return;
      await loadThemes();
      const added = themes?.find((theme) => theme.id === id);
      themeNotice = {
        kind: "ok",
        text: added ? settingsText("settings.appearance.theme.added", { name: added.name }) : settingsText("settings.appearance.theme.added_unnamed")
      };
      await persist({ key: "color_theme", value: id });
    } catch (e) {
      themeNotice = { kind: "error", text: errorMessage(e) };
      render();
    }
  }
  async function removeTheme(theme) {
    try {
      await invoke("remove_theme", { id: theme.id });
      await loadThemes();
      themeNotice = {
        kind: "ok",
        text: settingsText("settings.appearance.theme.removed", { name: theme.name })
      };
      if ((settings.color_theme || "default") === theme.id)
        await persist({ key: "color_theme", value: "default" });
      else render();
    } catch (e) {
      themeNotice = { kind: "error", text: errorMessage(e) };
      render();
    }
  }
  function themeSection() {
    const wrap = titledCard(
      settingsText("settings.appearance.theme.title"),
      segmented(
        settingsText("settings.appearance.theme.mode_label"),
        [
          ["system", settingsText("settings.appearance.theme.mode.system")],
          ["light", settingsText("settings.appearance.theme.mode.light")],
          ["dark", settingsText("settings.appearance.theme.mode.dark")]
        ],
        settings.theme,
        (value) => persist({ key: "theme", value })
      )
    );
    if (!themes) {
      loadThemes().then(render);
      return wrap;
    }
    const dark = pageIsDark();
    const grid = el("div", "theme-grid");
    grid.setAttribute("role", "radiogroup");
    grid.setAttribute("aria-label", settingsText("settings.appearance.theme.title"));
    for (const theme of themes) grid.append(themeCard(theme, dark));
    const add = el("button", "theme-card theme-add");
    add.type = "button";
    const addPreview = el("span", "preview");
    addPreview.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    addPreview.append(el("span", "", settingsText("settings.appearance.theme.add")));
    add.append(addPreview);
    add.onclick = addTheme;
    grid.append(add);
    const links = el("div", "theme-links");
    const folder = el("button", "link-button", settingsText("settings.appearance.theme.open_folder"));
    folder.type = "button";
    folder.onclick = () => invoke("open_themes_folder").catch((e) => setStatus(String(e)));
    links.append(folder);
    const guide = el("button", "link-button", settingsText("settings.appearance.theme.guide"));
    guide.type = "button";
    guide.onclick = () => invoke("open_theme_guide").catch((e) => setStatus(String(e)));
    links.append(guide);
    const selected = themes.find((theme) => theme.id === (settings.color_theme || "default"));
    if (selected && !selected.builtIn) {
      const remove = el(
        "button",
        "link-button",
        settingsText("settings.appearance.theme.remove", { name: selected.name })
      );
      remove.type = "button";
      remove.onclick = () => removeTheme(selected);
      links.append(remove);
    }
    links.append(el("span", "hint", settingsText("settings.appearance.theme.custom_css_note")));
    wrap.append(grid, links);
    if (themeNotice) {
      const notice = el("div", `notice ${themeNotice.kind}`);
      notice.setAttribute("role", themeNotice.kind === "error" ? "alert" : "status");
      notice.append(el("span", "", themeNotice.text));
      const dismiss = el("button", "link-button", settingsText("settings.appearance.theme.dismiss"));
      dismiss.type = "button";
      dismiss.onclick = () => {
        themeNotice = null;
        render();
      };
      notice.append(dismiss);
      wrap.append(notice);
    }
    return wrap;
  }
  function lookSection() {
    const card = el("section", "card");
    card.append(accentPicker(), fontPicker());
    return card;
  }
  function accentPicker() {
    const box = el("div", "row");
    const row = el("div", "swatches");
    row.setAttribute("role", "radiogroup");
    row.setAttribute("aria-label", settingsText("settings.appearance.accent.label"));
    const current2 = (settings.accent_color || "").toLowerCase();
    const swatch = (className, color, name, value) => {
      const b = el("button", `swatch ${className}`);
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-label", name);
      b.title = name;
      if (color) b.style.background = color;
      b.setAttribute("aria-checked", String(value === current2));
      b.onclick = () => persist({ key: "accent_color", value });
      return b;
    };
    row.append(swatch("theme-accent", "", settingsText("settings.appearance.accent.theme"), ""));
    for (const [color, name] of ACCENTS) row.append(swatch("", color, name, color));
    const isCustom = current2 && !ACCENTS.some(([color]) => color === current2);
    const custom = swatch(
      "custom",
      isCustom ? current2 : "",
      settingsText("settings.appearance.accent.custom"),
      isCustom ? current2 : "custom"
    );
    const input = document.createElement("input");
    input.type = "color";
    input.value = current2 || "#0866ff";
    input.hidden = true;
    input.onchange = () => persist({ key: "accent_color", value: input.value.toLowerCase() });
    custom.onclick = () => input.click();
    row.append(custom, input);
    box.append(
      rowText(settingsText("settings.appearance.accent.label"), settingsText("settings.appearance.accent.hint")),
      row
    );
    return box;
  }
  function fontPicker() {
    const box = el("label", "row");
    const select = document.createElement("select");
    select.setAttribute("aria-label", settingsText("settings.appearance.font.label"));
    const current2 = settings.message_font || "";
    const options = [["", settingsText("settings.appearance.font.default")]];
    for (const family of fonts || []) options.push([family, family]);
    if (current2 && !(fonts || []).includes(current2)) options.push([current2, current2]);
    for (const [value, text2] of options) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = text2;
      o.selected = value === current2;
      select.append(o);
    }
    if (!fonts) {
      fonts = [];
      invoke("list_fonts").then((list) => {
        fonts = list;
        render();
      }).catch((e) => console.error(e));
    }
    select.onchange = () => persist({ key: "message_font", value: select.value });
    box.append(
      rowText(settingsText("settings.appearance.font.label"), settingsText("settings.appearance.font.hint")),
      select
    );
    return box;
  }
  var APP_ICONS = [
    ["color-light", settingsText("settings.appearance.app_icon.color")],
    ["color-dark", settingsText("settings.appearance.app_icon.color_dark")],
    ["mono-light", settingsText("settings.appearance.app_icon.mono")],
    ["mono-dark", settingsText("settings.appearance.app_icon.mono_dark")]
  ];
  function iconTiles(key, label) {
    const tiles = el("div", "icon-tiles");
    tiles.setAttribute("role", "radiogroup");
    tiles.setAttribute("aria-label", label);
    for (const [icon, name] of APP_ICONS) {
      const tile = el("button", "icon-tile");
      tile.type = "button";
      tile.setAttribute("role", "radio");
      tile.setAttribute("aria-checked", String(settings[key] === icon));
      const img = document.createElement("img");
      img.src = `app-icons/${icon}.png`;
      img.alt = "";
      tile.append(img, el("span", "", name));
      tile.onclick = () => persist({ key, value: icon });
      tiles.append(tile);
    }
    return tiles;
  }
  function appIconSection() {
    const card = el("section", "card");
    const body = el("div", "icon-card");
    const left = el("div");
    const title = el("h2", "card-title", settingsText("settings.appearance.app_icon.title"));
    title.style.margin = "0";
    const toggle = el("label", "icon-switch");
    const perMode = !!settings.app_icon_dark;
    const input = switchInput(perMode);
    input.onchange = () => persist({ key: "app_icon_dark_mode", value: input.checked });
    toggle.append(input, el("span", "", settingsText("settings.appearance.app_icon.per_mode")));
    left.append(title, toggle);
    const rows = el("div", "icon-rows");
    if (perMode) {
      rows.append(
        el("div", "mode", settingsText("settings.appearance.app_icon.light_mode")),
        iconTiles("app_icon", settingsText("settings.appearance.app_icon.light_label"))
      );
      rows.append(
        el("div", "mode", settingsText("settings.appearance.app_icon.dark_mode")),
        iconTiles("app_icon_dark", settingsText("settings.appearance.app_icon.dark_label"))
      );
    } else {
      rows.append(iconTiles("app_icon", settingsText("settings.appearance.app_icon.title")));
    }
    body.append(left, rows);
    card.append(body);
    if (IS_LINUX) {
      card.append(el("div", "section-hint", settingsText("settings.appearance.app_icon.linux_hint")));
    }
    return card;
  }
  function zoomRow() {
    const percent = new Intl.NumberFormat(LOCALE, { style: "percent" });
    const options = [];
    for (let z = 30; z <= 200; z += 10) options.push([z, percent.format(z / 100)]);
    const current2 = Number(settings.zoom) || 100;
    if (!options.some(([v]) => Number(v) === current2)) {
      options.push([current2, percent.format(current2 / 100)]);
      options.sort((a, b) => Number(a[0]) - Number(b[0]));
    }
    return selectRow(
      settings.zoom,
      100,
      options,
      settingsText("settings.appearance.zoom.label"),
      settingsText("settings.appearance.zoom.hint"),
      false,
      (value) => persist({ key: "zoom", value })
    );
  }
  function mutedConversationsRow() {
    const current2 = settings.muted_conversations || (settings.ignore_muted_conversations === false ? "include" : "ignore");
    return selectRow(
      settings.muted_conversations,
      current2,
      [
        ["ignore", settingsText("settings.notifications.muted_conversations.ignore")],
        ["badge", settingsText("settings.notifications.muted_conversations.badge")],
        ["include", settingsText("settings.notifications.muted_conversations.include")]
      ],
      settingsText("settings.notifications.muted_conversations.label"),
      settingsText("settings.notifications.muted_conversations.hint"),
      false,
      (value) => persist({ key: "muted_conversations", value })
    );
  }
  var sounds = null;
  var soundValue = (sound) => JSON.stringify(sound);
  function notificationSoundRow() {
    const row = el("div", "row");
    const select = document.createElement("select");
    select.id = "message-sound";
    select.setAttribute("aria-label", settingsText("settings.notifications.notification_sound.label"));
    const current2 = settings.notification_sound_choice ?? (settings.notification_sound === false ? "off" : "default");
    const options = [
      ["off", settingsText("settings.notifications.notification_sound.off")],
      ["default", settingsText("settings.notifications.notification_sound.default")],
      ["messenger", settingsText("settings.notifications.notification_sound.messenger")]
    ];
    for (const { label: label2, sound } of sounds || []) options.push([sound, label2]);
    options.push(["choose", settingsText("settings.notifications.notification_sound.choose")]);
    for (const [sound, label2] of options) {
      const o = document.createElement("option");
      o.value = sound === "choose" ? "choose" : soundValue(sound);
      o.textContent = label2;
      select.append(o);
    }
    select.value = soundValue(current2);
    if (select.value !== soundValue(current2)) select.value = soundValue("default");
    const shown = select.value;
    const selectedSound = () => {
      const choice = options.find(
        ([sound]) => sound !== "choose" && soundValue(sound) === select.value
      )?.[0];
      return choice && choice !== "choose" ? choice : null;
    };
    if (!sounds) {
      sounds = [];
      invoke("notification_sounds").then((list) => {
        sounds = list;
        render();
      }).catch((e) => console.error(e));
    }
    select.onchange = async () => {
      if (select.value !== "choose") {
        const sound = selectedSound();
        if (sound === "messenger") {
          select.disabled = true;
          try {
            await invoke("copy_messenger_sound");
          } catch (e) {
            select.value = shown;
            select.disabled = false;
            setStatus(errorMessage(e));
            return;
          }
        }
        if (sound) await persist({ key: "notification_sound_choice", value: sound });
        return;
      }
      select.value = shown;
      try {
        const picked = await invoke("choose_notification_sound");
        if (!picked) return;
        sounds = null;
        await persist({ key: "notification_sound_choice", value: picked });
      } catch (e) {
        setStatus(errorMessage(e));
      }
    };
    const preview = el("button", "secondary", settingsText("settings.notifications.notification_sound.preview"));
    preview.type = "button";
    preview.disabled = shown === soundValue("off");
    preview.onclick = () => {
      const sound = selectedSound();
      if (sound)
        invoke("preview_notification_sound", { sound }).catch((e) => setStatus(errorMessage(e)));
    };
    const controls = el("div", "row-controls");
    controls.append(select, preview);
    const { label, hint } = FIELD_META.notification_sound;
    row.append(rowText(label, hint), controls);
    return row;
  }
  function notificationReactionRow() {
    return selectRow(
      settings.notification_reaction,
      "👍",
      [
        ["👍", "👍"],
        ["❤", "❤️"],
        ["😆", "😆"],
        ["😮", "😮"],
        ["😢", "😢"],
        ["😡", "😡"]
      ],
      settingsText("settings.notifications.notification_reaction.label"),
      settingsText("settings.notifications.notification_reaction.hint"),
      false,
      (value) => persist({ key: "notification_reaction", value })
    );
  }
  function updateCheckHoursRow() {
    return selectRow(
      settings.update_check_hours,
      4,
      [
        [1, settingsText("settings.advanced.update_check_hours.hourly")],
        [4, settingsText("settings.advanced.update_check_hours.four_hours")],
        [24, settingsText("settings.advanced.update_check_hours.daily")]
      ],
      settingsText("settings.advanced.update_check_hours.label"),
      settingsText("settings.advanced.update_check_hours.hint"),
      !settings.automatic_update_checks || !runtimeCapabilities.automaticUpdateChecks,
      (value) => persist({ key: "update_check_hours", value })
    );
  }
  function badgeModeRow() {
    return selectRow(
      settings.badge_mode,
      "messages",
      [
        ["messages", settingsText("settings.notifications.badge_mode.messages")],
        ["conversations", settingsText("settings.notifications.badge_mode.conversations")],
        ["dot", settingsText("settings.notifications.badge_mode.dot")]
      ],
      settingsText("settings.notifications.badge_mode.label"),
      settingsText("settings.notifications.badge_mode.hint"),
      !settings.unread_badge,
      (value) => persist({ key: "badge_mode", value })
    );
  }
  function downloadBehaviorRow() {
    return selectRow(
      settings.download_behavior,
      "downloads",
      [
        ["downloads", settingsText("settings.general.download_behavior.downloads")],
        ["ask", settingsText("settings.general.download_behavior.ask")]
      ],
      settingsText("settings.general.download_behavior.label"),
      settingsText("settings.general.download_behavior.hint"),
      false,
      (value) => persist({ key: "download_behavior", value })
    );
  }
  function languageRow() {
    const current2 = settings.language || "system";
    const system = I18N.languages.find(({ code }) => code === I18N.system);
    const select = document.createElement("select");
    select.setAttribute("aria-label", settingsText("settings.general.language.label"));
    const options = [
      [
        "system",
        settingsText("settings.general.language.system", { language: system ? system.name : I18N.system })
      ]
    ];
    for (const { code, name } of I18N.languages) options.push([code, name]);
    for (const [value, text2] of options) {
      const o = el("option", "", text2);
      o.value = value;
      if (value !== "system") o.lang = value;
      o.selected = value === current2;
      select.append(o);
    }
    select.onchange = () => persist({ key: "language", value: select.value });
    const controls = el("div", "row-controls");
    controls.append(select);
    const pending = (current2 === "system" ? I18N.system : current2) !== I18N.lang;
    if (pending) {
      const restart = el("button", "secondary", settingsText("settings.general.language.restart"));
      restart.type = "button";
      restart.onclick = () => invoke("restart_app").catch((e) => setStatus(errorMessage(e)));
      controls.append(restart);
    }
    const hint = pending ? settingsText("settings.general.language.restart_hint") : settingsText("settings.general.language.hint");
    const row = el("div", "row");
    row.append(rowText(settingsText("settings.general.language.label"), hint), controls);
    return row;
  }
  function messengerLanguageRow() {
    return buttonRow(
      settingsText("settings.general.messenger_language.label"),
      settingsText("settings.general.messenger_language.hint"),
      settingsText("settings.general.messenger_language.change"),
      () => invoke("open_facebook_language").catch((e) => setStatus(errorMessage(e)))
    );
  }
  function trayIconStyleRow() {
    return selectRow(
      settings.tray_icon_style,
      "color",
      [
        ["color", settingsText("settings.tray.tray_icon_style.color")],
        ["symbolic", settingsText("settings.tray.tray_icon_style.symbolic")]
      ],
      settingsText("settings.tray.tray_icon_style.label"),
      IS_MAC ? settingsText("settings.tray.tray_icon_style.hint_mac") : settingsText("settings.tray.tray_icon_style.hint"),
      false,
      (value) => persist({ key: "tray_icon_style", value })
    );
  }
  function nicknameScope(current2) {
    return current2.nickname_scope || (current2.show_nicknames === false ? "off" : current2.nicknames_group_only ? "groups" : "all");
  }
  function nicknameRow() {
    return selectRow(
      settings.nickname_scope,
      nicknameScope(settings),
      [
        ["all", settingsText("settings.appearance.nickname_scope.all")],
        ["groups", settingsText("settings.appearance.nickname_scope.groups")],
        ["direct", settingsText("settings.appearance.nickname_scope.direct")],
        ["off", settingsText("settings.appearance.nickname_scope.off")]
      ],
      settingsText("settings.appearance.nickname_scope.label"),
      settingsText("settings.appearance.nickname_scope.hint"),
      false,
      (value) => persist({ key: "nickname_scope", value })
    );
  }
  function switchRow(key) {
    const meta = FIELD_META[key];
    const row = document.createElement("label");
    row.className = "row";
    const cb = switchInput(
      key === "hide_names" || key === "hide_avatars" ? (settings[key] ?? settings.hide_names_avatars) === true : !!settings[key]
    );
    const trayRequired = IS_WINDOWS && (settings.hide_on_minimize || settings.hide_on_focus_loss || settings.hide_taskbar_icon);
    const runtimeUnavailable = key === "multi_instance" && !runtimeCapabilities.multiInstance || key === "autostart" && !runtimeCapabilities.autostart || key === "automatic_update_checks" && !runtimeCapabilities.automaticUpdateChecks;
    if (key === "show_tray" && trayRequired || runtimeUnavailable) {
      cb.disabled = true;
    }
    cb.onchange = () => persist({ key, value: cb.checked });
    let hint = meta.hint;
    const pausedUntil = settings.notifications_paused_until;
    if (key === "mute_notifications" && typeof pausedUntil === "number" && pausedUntil > Date.now()) {
      hint = settingsText("settings.notifications.mute_notifications.paused", { time: untilTime(pausedUntil) });
    } else if (key === "show_tray" && trayRequired) {
      hint = settingsText("settings.tray.show_tray.required_hint");
    } else if (runtimeUnavailable) {
      if (key === "automatic_update_checks" && runtimeCapabilities.debug) {
        hint = settingsText("settings.unavailable.debug_updates");
      } else if (key === "multi_instance") {
        hint = settingsText("settings.unavailable.snap_single_instance");
      } else if (runtimeCapabilities.snap) {
        hint = key === "autostart" ? settingsText("settings.unavailable.snap_autostart") : settingsText("settings.unavailable.snap_managed");
      } else {
        hint = settingsText("settings.unavailable.environment");
      }
    }
    row.append(rowText(meta.label, hint), cb);
    return row;
  }
  function selectTab(id, focus) {
    if (id !== activeTab) {
      activeTab = id;
      try {
        localStorage.setItem("chatpane:settingsTab", id);
      } catch (_) {
      }
      render();
    }
    if (focus) {
      const el2 = byId(`tab-${id}`);
      if (el2) el2.focus();
    }
  }
  function onTabKeydown(e, id) {
    const i = TABS.findIndex((tab) => tab.id === id);
    if (i < 0) return;
    const [next, previous] = I18N.dir === "rtl" ? ["ArrowLeft", "ArrowRight"] : ["ArrowRight", "ArrowLeft"];
    let j = null;
    if (e.key === next) j = (i + 1) % TABS.length;
    else if (e.key === previous) j = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = TABS.length - 1;
    if (j === null) return;
    e.preventDefault();
    selectTab(TABS[j].id, true);
  }
  function renderTabs() {
    const nav = byId("tabs");
    nav.innerHTML = "";
    for (const tab of TABS) {
      const active = tab.id === activeTab;
      const b = document.createElement("button");
      b.type = "button";
      b.className = `tab${active ? " active" : ""}`;
      b.id = `tab-${tab.id}`;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(active));
      b.setAttribute("aria-controls", "rows");
      b.tabIndex = active ? 0 : -1;
      b.appendChild(svgIcon(tab.icon));
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = tab.label;
      b.appendChild(lbl);
      b.onclick = () => selectTab(tab.id, false);
      b.onkeydown = (e) => onTabKeydown(e, tab.id);
      nav.appendChild(b);
    }
    byId("rows").setAttribute("aria-labelledby", `tab-${activeTab}`);
  }
  function testNotificationRow() {
    return buttonRow(
      settingsText("settings.notifications.test.label"),
      settingsText("settings.notifications.test.hint"),
      settingsText("settings.notifications.test.send"),
      async (btn, row) => {
        const hint = row.querySelector(".hint");
        hint.setAttribute("role", "status");
        btn.disabled = true;
        hint.textContent = settingsText("settings.notifications.test.sending");
        try {
          hint.textContent = await invoke("send_test_notification");
        } catch (e) {
          hint.textContent = errorMessage(e);
        } finally {
          btn.disabled = false;
        }
      }
    );
  }
  function autostartRow() {
    const row = switchRow("autostart");
    if (autostartStatus !== "needs-approval") return row;
    const rows = document.createDocumentFragment();
    rows.append(
      row,
      buttonRow(
        settingsText("settings.tray.autostart.approval.label"),
        settingsText("settings.tray.autostart.approval.hint"),
        settingsText("settings.tray.autostart.approval.open"),
        () => invoke("open_login_items").catch(console.error)
      )
    );
    return rows;
  }
  function openLogsRow() {
    return buttonRow(
      settingsText("settings.advanced.logs.label"),
      settingsText("settings.advanced.logs.hint"),
      settingsText("settings.advanced.logs.open"),
      async () => {
        try {
          await invoke("open_log_folder");
        } catch (e) {
          setStatus(settingsText("settings.advanced.logs.open_failed"));
          console.error(e);
        }
      }
    );
  }
  function customCssRow() {
    return buttonRow(
      settingsText("settings.advanced.custom_css.label"),
      settingsText("settings.advanced.custom_css.hint"),
      settingsText("settings.advanced.custom_css.open"),
      async () => {
        try {
          await invoke("open_custom_css");
          setStatus(settingsText("settings.advanced.custom_css.opened"));
        } catch (e) {
          setStatus(settingsText("settings.advanced.custom_css.open_failed"));
          console.error(e);
        }
      }
    );
  }
  var messengerAccount = {
    state: null,
    error: "",
    loading: false
  };
  async function loadMessengerAccount(change) {
    if (messengerAccount.loading) return;
    messengerAccount.loading = true;
    messengerAccount.error = "";
    if (activeTab === "account") renderBody();
    try {
      messengerAccount.state = change ? await invoke("set_messenger_account", { change }) : await invoke("messenger_account");
    } catch (e) {
      messengerAccount.error = errorMessage(e);
    } finally {
      messengerAccount.loading = false;
      if (activeTab === "account") renderBody();
    }
  }
  function accountToggleRow(setting, label, hint, value) {
    const row = el("label", "row");
    const cb = switchInput(value === true);
    cb.disabled = value === null || messengerAccount.loading;
    cb.onchange = () => loadMessengerAccount({ setting, value: cb.checked });
    row.append(rowText(label, value === null ? settingsText("settings.account.not_reported") : hint), cb);
    return row;
  }
  function dndRow(until) {
    const row = el("label", "row");
    const sel = document.createElement("select");
    const options = [
      ["0", settingsText("settings.account.dnd.off")],
      ["60", settingsText("settings.account.dnd.one_hour")],
      ["480", settingsText("settings.account.dnd.eight_hours")],
      ["1440", settingsText("settings.account.dnd.day")],
      ["-1", settingsText("settings.account.dnd.until_off")]
    ];
    let current2 = until === -1 ? "-1" : "0";
    let hint = settingsText("settings.account.dnd.hint");
    if (until === null) {
      hint = settingsText("settings.account.dnd.not_reported");
    } else if (until === -1) {
      hint = settingsText("settings.account.dnd.on_until_off_hint");
    } else if (until !== null && until * 1e3 > Date.now()) {
      current2 = "on";
      options.unshift(["on", settingsText("settings.account.dnd.on_until", { time: untilTime(until * 1e3) })]);
      hint = settingsText("settings.account.dnd.on_until_time_hint");
    }
    for (const [value, text2] of options) {
      const option = el("option", "", text2);
      option.value = value;
      option.selected = value === current2;
      option.hidden = value === "on";
      sel.append(option);
    }
    sel.disabled = until === null || messengerAccount.loading;
    sel.onchange = () => {
      if (sel.value !== "on")
        loadMessengerAccount({ setting: "doNotDisturb", value: Number(sel.value) });
    };
    row.append(rowText(settingsText("settings.account.dnd.label"), hint), sel);
    return row;
  }
  function messengerAccountSection() {
    const wrap = titledCard(settingsText("settings.account.title"));
    const intro = el("div", "section-hint", settingsText("settings.account.intro"));
    const soundLink = el("button", "link-button", settingsText("settings.account.sound_link"));
    soundLink.type = "button";
    soundLink.style.marginTop = "4px";
    soundLink.onclick = () => {
      selectTab("notifications", false);
      const sound = document.getElementById("message-sound");
      sound?.scrollIntoView({ block: "center" });
      sound?.focus();
    };
    intro.append(el("br"), soundLink);
    wrap.append(intro);
    const { state, error, loading } = messengerAccount;
    if (error) {
      const notice = el("div", "notice error");
      notice.setAttribute("role", "alert");
      notice.append(el("span", "", error));
      const retry = el("button", "link-button", settingsText("settings.account.retry"));
      retry.type = "button";
      retry.onclick = () => loadMessengerAccount();
      notice.append(retry);
      wrap.append(notice);
    }
    if (!state) {
      if (loading) wrap.append(el("div", "section-hint", settingsText("settings.account.loading")));
      else if (!error) queueMicrotask(() => loadMessengerAccount());
      return wrap;
    }
    wrap.append(
      accountToggleRow(
        "activeStatus",
        settingsText("settings.account.active_status.label"),
        settingsText("settings.account.active_status.hint"),
        state.activeStatus
      ),
      accountToggleRow(
        "readReceipts",
        settingsText("settings.account.read_receipts.label"),
        settingsText("settings.account.read_receipts.hint"),
        state.readReceipts
      ),
      dndRow(state.dndUntil)
    );
    return wrap;
  }
  var CUSTOM_ROWS = {
    language: languageRow,
    messenger_language: messengerLanguageRow,
    theme_section: themeSection,
    app_icon: appIconSection,
    look_section: lookSection,
    zoom: zoomRow,
    badge_mode: badgeModeRow,
    muted_conversations: mutedConversationsRow,
    notification_reaction: notificationReactionRow,
    notification_sound: notificationSoundRow,
    update_check_hours: updateCheckHoursRow,
    download_behavior: downloadBehaviorRow,
    tray_icon_style: trayIconStyleRow,
    autostart: autostartRow,
    custom_css: customCssRow,
    open_logs: openLogsRow,
    test_notification: testNotificationRow,
    nickname_scope: nicknameRow,
    messenger_account: messengerAccountSection
  };
  function isCustomRow(key) {
    return Object.prototype.hasOwnProperty.call(CUSTOM_ROWS, key);
  }
  function renderBody() {
    const root = byId("rows");
    root.innerHTML = "";
    const tab = TABS.find((entry) => entry.id === activeTab) || TABS[0];
    for (const entry of tab.cards || [tab.fields]) {
      if (typeof entry === "string") {
        root.appendChild(CUSTOM_ROWS[entry]());
        continue;
      }
      const card = document.createElement("section");
      card.className = "card";
      for (const key of entry) {
        card.appendChild(isCustomRow(key) ? CUSTOM_ROWS[key]() : switchRow(key));
      }
      root.appendChild(card);
    }
  }
  function render() {
    renderTabs();
    renderBody();
  }
  byId("share").onclick = async (e) => {
    e.preventDefault();
    try {
      await invoke("copy_share_message");
      setStatus(settingsText("shared.growth.copied"), 3e3);
    } catch (err) {
      setStatus(errorMessage(err));
    }
  };
  byId("star").onclick = (e) => {
    e.preventDefault();
    invoke("open_github").catch(console.error);
  };
  byId("reset").onclick = (event) => {
    event.preventDefault();
    pendingSave = pendingSave.then(async () => {
      try {
        settings = await invoke("reset_settings");
        render();
        setStatus(settingsText("settings.status.reset"), 1200);
      } catch (error) {
        setStatus(errorMessage(error));
        console.error(error);
        await refresh();
      }
    });
  };
  window.addEventListener("focus", refresh);
  window.addEventListener("focus", () => {
    if (activeTab === "account" && messengerAccount.state) loadMessengerAccount();
  });
  window.addEventListener("focus", () => {
    updateController.refresh().catch(() => {
    });
  });
  var updateButton = byId("check");
  var notesBox = byId("update-notes");
  var notesVersion = "";
  async function showReleaseNotes(state) {
    if (state.phase !== "available" || !state.version) {
      notesBox.hidden = true;
      notesVersion = "";
      return;
    }
    if (notesVersion === state.version) return;
    notesVersion = state.version;
    let notes = null;
    try {
      notes = await invoke("update_release_notes", { version: state.version });
    } catch (_) {
    }
    if (notesVersion !== state.version) return;
    if (typeof notes !== "string" || !notes) {
      notesBox.hidden = true;
      return;
    }
    notesBox.querySelector("summary").textContent = settingsText("settings.update.notes_summary", {
      version: state.version
    });
    notesBox.querySelector(".update-notes-text").textContent = notes;
    notesBox.hidden = false;
  }
  var updateController = new UpdateConsentController(
    (command) => invoke(command),
    (state) => {
      updateButton.textContent = state.buttonLabel;
      updateButton.disabled = state.busy;
      updateStatus = state.status;
      setStatus(state.status);
      showReleaseNotes(state);
    }
  );
  updateButton.onclick = async () => {
    try {
      await updateController.activate();
    } catch (e) {
      updateController.fail(e);
      console.error(e);
    }
  };
  render();
  refresh();
  updateController.initialize(
    BOOT.install_mode ? { installMode: BOOT.install_mode, discovered: BOOT.discovered_update } : void 0
  ).catch((e) => {
    updateController.fail(e);
    console.error(e);
  });
})();
