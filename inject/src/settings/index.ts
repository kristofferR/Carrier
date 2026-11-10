import { formatLocale, settingsText as t } from "../i18n";
import { invoke } from "./bridge";
import type {
  MessengerAccountChange,
  MessengerAccountState,
  Settings,
  SettingsChange,
  SoundOption,
  Status,
  ThemeInfo,
} from "./native-types";
import { UpdateConsentController, type UpdateUiState } from "./update-consent";

// Injected when the window is built, so the first frame is the whole page.
const BOOT = window.__CHATPANE_SETTINGS_BOOT__!;

const I18N = {
  lang: "en",
  dir: "ltr",
  strings: {},
  languages: [],
  system: "en",
  ...window.__CHATPANE_I18N__,
};
const LOCALE = formatLocale();
const byId = (id: string) => document.getElementById(id)!;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

byId("tabs").setAttribute("aria-label", t("settings.tab.list_label"));
byId("share").textContent = t("settings.footer.share");
byId("star").textContent = t("shared.growth.star");
byId("reset").textContent = t("settings.footer.reset");
byId("check").textContent = t("settings.update.check");
byId("version").textContent = t("settings.footer.version", { version: BOOT.version }).trim();

// Per-field metadata: [key, label, hint]. Grouping into tabs is below.
const FIELDS = [
  [
    "always_on_top",
    t("settings.general.always_on_top.label"),
    t("settings.general.always_on_top.hint"),
  ],
  [
    "global_hotkey",
    t("settings.general.global_hotkey.label"),
    t("settings.general.global_hotkey.hint"),
  ],
  ["show_tray", t("settings.tray.show_tray.label"), t("settings.tray.show_tray.hint")],
  ["start_to_tray", t("settings.tray.start_to_tray.label"), t("settings.tray.start_to_tray.hint")],
  ["autostart", t("settings.tray.autostart.label"), t("settings.tray.autostart.hint")],
  [
    "hide_on_close",
    t("settings.general.hide_on_close.label"),
    t("settings.general.hide_on_close.hint"),
  ],
  [
    "unread_badge",
    t("settings.notifications.unread_badge.label"),
    t("settings.notifications.unread_badge.hint"),
  ],
  [
    "mute_notifications",
    t("settings.notifications.mute_notifications.label"),
    t("settings.notifications.mute_notifications.hint"),
  ],
  [
    "notification_sound",
    t("settings.notifications.notification_sound.label"),
    t("settings.notifications.notification_sound.hint"),
  ],
  [
    "notify_group_chats",
    t("settings.notifications.notify_group_chats.label"),
    t("settings.notifications.notify_group_chats.hint"),
  ],
  [
    "notify_reactions",
    t("settings.notifications.notify_reactions.label"),
    t("settings.notifications.notify_reactions.hint"),
  ],
  [
    "hide_notification_preview",
    t("settings.notifications.hide_notification_preview.label"),
    t("settings.notifications.hide_notification_preview.hint"),
  ],
  [
    "group_notifications_by_conversation",
    t("settings.notifications.group_by_conversation.label"),
    t("settings.notifications.group_by_conversation.hint"),
  ],
  [
    "clear_notifications_on_view",
    t("settings.notifications.clear_on_view.label"),
    t("settings.notifications.clear_on_view.hint"),
  ],
  [
    "attention_on_message",
    t("settings.notifications.attention.label"),
    t("settings.notifications.attention.hint"),
  ],
  ["hide_names", t("settings.privacy.hide_names.label"), t("settings.privacy.hide_names.hint")],
  [
    "hide_avatars",
    t("settings.privacy.hide_avatars.label"),
    t("settings.privacy.hide_avatars.hint"),
  ],
  [
    "system_emoji",
    t("settings.appearance.system_emoji.label"),
    t("settings.appearance.system_emoji.hint"),
  ],
  [
    "block_typing_indicator",
    t("settings.privacy.block_typing_indicator.label"),
    t("settings.privacy.block_typing_indicator.hint"),
  ],
  [
    "stop_media_autoplay",
    t("settings.general.stop_media_autoplay.label"),
    t("settings.general.stop_media_autoplay.hint"),
  ],
  ["menu_bar_only", t("settings.tray.menu_bar_only.label"), t("settings.tray.menu_bar_only.hint")],
  [
    "hide_menu_bar",
    t("settings.appearance.hide_menu_bar.label"),
    t("settings.appearance.hide_menu_bar.hint"),
  ],
  [
    "hide_on_minimize",
    t("settings.tray.hide_on_minimize.label"),
    t("settings.tray.hide_on_minimize.hint"),
  ],
  [
    "hide_on_focus_loss",
    t("settings.tray.hide_on_focus_loss.label"),
    t("settings.tray.hide_on_focus_loss.hint"),
  ],
  [
    "hide_taskbar_icon",
    t("settings.tray.hide_taskbar_icon.label"),
    t("settings.tray.hide_taskbar_icon.hint"),
  ],
  [
    "automatic_update_checks",
    t("settings.advanced.automatic_update_checks.label"),
    t("settings.advanced.automatic_update_checks.hint"),
  ],
  [
    "hold_failures",
    t("settings.advanced.hold_failures.label"),
    t("settings.advanced.hold_failures.hint"),
  ],
  [
    "focus_composer_on_return",
    t("settings.general.focus_composer_on_return.label"),
    t("settings.general.focus_composer_on_return.hint"),
  ],
  ["spellcheck", t("settings.general.spellcheck.label"), t("settings.general.spellcheck.hint")],
  [
    "block_telemetry",
    t("settings.privacy.block_telemetry.label"),
    t("settings.privacy.block_telemetry.hint"),
  ],
  [
    "strip_link_tracking",
    t("settings.privacy.strip_link_tracking.label"),
    t("settings.privacy.strip_link_tracking.hint"),
  ],
  [
    "send_with_accelerator",
    t("settings.advanced.send_with_accelerator.label"),
    t("settings.advanced.send_with_accelerator.hint"),
  ],
  [
    "multi_instance",
    t("settings.advanced.multi_instance.label"),
    t("settings.advanced.multi_instance.hint"),
  ],
] as const satisfies readonly (readonly [
  Extract<SettingsChange, { value: boolean | null }>["key"] | "notification_sound",
  string,
  string,
])[];
type SwitchKey = Exclude<(typeof FIELDS)[number][0], "notification_sound">;
const FIELD_META = Object.fromEntries(
  FIELDS.map(([k, label, hint]) => [k, { label, hint }]),
) as Record<(typeof FIELDS)[number][0], { label: string; hint: string }>;

// Inline lucide-style icons (no icon dependency).
const ICONS = {
  general:
    '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  appearance:
    '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  tray: '<path d="M12 2v10"/><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>',
  notifications:
    '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  privacy:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  account: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  advanced:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
};

const IS_MAC = /Mac/.test(navigator.platform || navigator.userAgent);
const IS_WINDOWS = /Win/.test(navigator.platform || navigator.userAgent);
const IS_LINUX = !IS_MAC && !IS_WINDOWS && /Linux/.test(navigator.userAgent);
const runtimeCapabilities = BOOT.capabilities;

// The shared attention setting is a Dock bounce on macOS and a taskbar
// flash on Windows — same setting, per-OS wording (defined here because the
// platform flags are not available yet where FIELDS is built above).
if (IS_WINDOWS) {
  FIELD_META.attention_on_message = {
    label: t("settings.notifications.attention.label_windows"),
    hint: t("settings.notifications.attention.hint_windows"),
  };
}

type CustomRowKey = keyof typeof CUSTOM_ROWS;
type RowKey = SwitchKey | CustomRowKey;
type Tab = { id: string; label: string; icon: string } & (
  | { fields: RowKey[]; cards?: never }
  | { cards: (CustomRowKey | RowKey[])[]; fields?: never }
);
const TABS: Tab[] = [
  {
    id: "general",
    label: t("settings.tab.general"),
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
      "download_behavior",
    ],
  },
  // A tab is one card of `fields`, or `cards`: each a list of fields or
  // the key of a section that builds its own card.
  {
    id: "appearance",
    label: t("settings.tab.appearance"),
    icon: ICONS.appearance,
    cards: [
      // Windows: the native menu bar never shows next to Chatpane's
      // window buttons (src-tauri/src/title_bar.rs), so nothing to hide.
      ["zoom", ...(IS_LINUX ? (["hide_menu_bar"] as const) : []), "system_emoji", "nickname_scope"],
      "theme_section",
      "look_section",
      "app_icon",
    ],
  },
  {
    id: "tray",
    label: t("settings.tab.tray"),
    icon: ICONS.tray,
    fields: [
      "show_tray",
      "start_to_tray",
      "autostart",
      ...(IS_MAC || IS_LINUX || IS_WINDOWS ? (["tray_icon_style"] as const) : []),
      ...(IS_MAC ? (["menu_bar_only"] as const) : []),
      ...(IS_WINDOWS
        ? (["hide_on_minimize", "hide_on_focus_loss", "hide_taskbar_icon"] as const)
        : []),
    ],
  },
  {
    id: "notifications",
    label: t("settings.tab.notifications"),
    icon: ICONS.notifications,
    fields: [
      "mute_notifications",
      "notification_sound",
      "notify_group_chats",
      "notify_reactions",
      "hide_notification_preview",
      "notification_reaction",
      ...(IS_MAC ? (["group_notifications_by_conversation"] as const) : []),
      ...(IS_MAC || IS_WINDOWS
        ? (["clear_notifications_on_view", "attention_on_message"] as const)
        : []),
      "unread_badge",
      "muted_conversations",
      "badge_mode",
      "test_notification",
    ],
  },
  {
    id: "privacy",
    label: t("settings.tab.privacy"),
    icon: ICONS.privacy,
    fields: [
      "block_typing_indicator",
      "hide_names",
      "hide_avatars",
      "block_telemetry",
      "strip_link_tracking",
    ],
  },
  {
    id: "account",
    label: t("settings.tab.account"),
    icon: ICONS.account,
    cards: ["messenger_account"],
  },
  {
    id: "advanced",
    label: t("settings.tab.advanced"),
    icon: ICONS.advanced,
    fields: [
      "automatic_update_checks",
      "update_check_hours",
      "hold_failures",
      "send_with_accelerator",
      "multi_instance",
      "custom_css",
      "open_logs",
    ],
  },
];

let activeTab = "general";
try {
  // Chatpane was called Carrier; move the remembered tab to the new key.
  const legacyTab = localStorage.getItem("carrier:settingsTab");
  if (legacyTab !== null) {
    if (localStorage.getItem("chatpane:settingsTab") === null) {
      localStorage.setItem("chatpane:settingsTab", legacyTab);
    }
    localStorage.removeItem("carrier:settingsTab");
  }
  const saved = localStorage.getItem("chatpane:settingsTab");
  if (saved && TABS.some((tab) => tab.id === saved)) activeTab = saved;
} catch (_) {}

let settings: Settings = BOOT.settings;
// The footer line shows the update state's message (an offered update, the
// debug build's instructions). Other messages replace it, and with
// `clearAfter` they give way to it again.
let updateStatus = "";
let statusTimer: ReturnType<typeof setTimeout> | undefined;
function setStatus(message: string, clearAfter?: number) {
  clearTimeout(statusTimer);
  byId("status").textContent = message || updateStatus;
  if (message && clearAfter) statusTimer = setTimeout(() => setStatus(""), clearAfter);
}

function svgIcon(inner: string) {
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

// Start on System Startup as the OS reports it ("on", "off" or
// "needs-approval"). Reading it also corrects the stored setting.
let autostartStatus: Status | null = null;
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
    // Focusing the window runs this between a click's mousedown and
    // mouseup; re-rendering unchanged settings would swap the clicked
    // element out and swallow the click.
    if (status === autostartStatus && JSON.stringify(fresh) === JSON.stringify(settings)) return;
    autostartStatus = status;
    settings = fresh;
    render();
  } catch (e) {
    console.error(e);
  }
}

let pendingSave = Promise.resolve();
function persist(change: SettingsChange) {
  pendingSave = pendingSave.then(() => saveSetting(change));
  return pendingSave;
}

async function saveSetting(change: SettingsChange) {
  try {
    settings = await invoke("update_setting", { change });
    if (change.key === "autostart") {
      autostartStatus = await readAutostartStatus();
      settings = await invoke("get_settings");
    }
    render();
    setStatus(t("settings.status.saved"), 1200);
  } catch (error) {
    setStatus(errorMessage(error));
    console.error(error);
    await refresh();
    // A failed save can leave a control toggled even when the snapshot matches.
    render();
  }
}

// A row's left side: its label and hint.
function rowText(label: string, hint?: string) {
  const text = document.createElement("div");
  text.className = "text";
  const name = document.createElement("div");
  name.className = "label";
  name.textContent = label;
  text.append(name);
  if (hint) {
    const line = document.createElement("div");
    line.className = "hint";
    line.textContent = hint;
    text.append(line);
  }
  return text;
}

// A row with a button on the right.
function buttonRow(
  label: string,
  hint: string,
  buttonText: string,
  onClick: (button: HTMLButtonElement, row: HTMLDivElement) => unknown,
) {
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

function switchInput(checked: boolean) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "switch";
  input.setAttribute("role", "switch");
  input.checked = checked;
  return input;
}

// Each option keeps its typed value; DOM strings are only the selection key.
function selectRow<Value extends string | number>(
  current: Value | null | undefined,
  fallback: Value,
  options: readonly (readonly [Value, string])[],
  label: string,
  hint: string,
  disabled: boolean,
  onPick: (value: Value) => unknown,
) {
  const row = el("label", "row");
  const select = document.createElement("select");
  for (const [value, text] of options) {
    const option = el("option", "", text);
    option.value = String(value);
    option.selected = String(current || fallback) === String(value);
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

// ----- Appearance: theme gallery, accent color, font, app icon -----

let themes: ThemeInfo[] | null = null; // [{ id, name, author, mode, preview, builtIn }]
let fonts: string[] | null = null; // installed font families
let themeNotice: { kind: "error" | "ok"; text: string } | null = null; // { kind: "error" | "ok", text }

// Messenger's own colors for Default, and the dark previews of the
// built-in themes (theme headers carry one preview).
type PreviewColors = [string, string, string, string, string];
const DEFAULT_PREVIEW: Record<"light" | "dark", PreviewColors> = {
  light: ["#f0f2f5", "#ffffff", "#ffffff", "#0866ff", "#f0f0f0"],
  dark: ["#1c1c1d", "#242526", "#242526", "#0866ff", "#303030"],
};
const DARK_PREVIEWS: Record<string, PreviewColors> = {
  graphite: ["#141517", "#1d1e20", "#212224", "#d9dadd", "#2f3134"],
  warm: ["#16120f", "#1f1a16", "#241e19", "#d9774c", "#352c25"],
  pink: ["#1a0f15", "#24151d", "#2a1822", "#c93a7d", "#3a2230"],
  lavender: ["#15121d", "#1d1928", "#221d2e", "#7356c0", "#312a42"],
  sage: ["#121712", "#1a201a", "#1e251e", "#4f7a4a", "#2d362c"],
  slate: ["#161b23", "#1e2430", "#222937", "#4f73a8", "#2f3747"],
};
const ACCENTS = [
  ["#0866ff", t("settings.appearance.accent.blue")],
  ["#8a3ffc", t("settings.appearance.accent.purple")],
  ["#e0427a", t("settings.appearance.accent.pink")],
  ["#e5484d", t("settings.appearance.accent.red")],
  ["#f27a1a", t("settings.appearance.accent.orange")],
  ["#2ea44f", t("settings.appearance.accent.green")],
  ["#0f9d9a", t("settings.appearance.accent.teal")],
] as const;

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

// An end time in milliseconds: the time today, else the weekday and time.
function untilTime(ms: number) {
  const end = new Date(ms);
  const options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
  if (end.toDateString() !== new Date().toDateString()) options.weekday = "short";
  return end.toLocaleString(LOCALE, options);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function segmented<Value extends string>(
  label: string,
  options: readonly (readonly [Value, string])[],
  current: Value,
  onPick: (value: Value) => unknown,
) {
  const seg = el("div", "seg");
  seg.setAttribute("role", "radiogroup");
  seg.setAttribute("aria-label", label);
  for (const [value, text] of options) {
    const b = el("button", "", text);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(value === current));
    b.onclick = () => value !== current && onPick(value);
    seg.append(b);
  }
  return seg;
}

// A card with a title, and a control on the title's right.
function titledCard(title: string, control?: Node) {
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
  check.innerHTML =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return check;
}

function isDarkColor(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const luma = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return luma < 128;
}

// A drawn preview from five colors: window, list, chat, yours, theirs.
function previewFor(colors: PreviewColors) {
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
    ["in", incoming],
  ]) {
    const bubble = el("span", `bubble ${kind}`);
    bubble.style.background = color!;
    pane.append(bubble);
  }
  box.append(side, pane);
  return box;
}

function cardColors(theme: ThemeInfo, dark: boolean) {
  let colors: PreviewColors;
  if (theme.id === "default") colors = DEFAULT_PREVIEW[dark ? "dark" : "light"];
  else if (dark && DARK_PREVIEWS[theme.id]) colors = DARK_PREVIEWS[theme.id]!;
  else colors = theme.preview || DEFAULT_PREVIEW[dark ? "dark" : "light"];
  colors = [...colors];
  if (settings.accent_color) colors[3] = settings.accent_color;
  return colors;
}

function themeCard(theme: ThemeInfo, dark: boolean) {
  const card = el("button", "theme-card");
  card.type = "button";
  card.setAttribute("role", "radio");
  const selected = (settings.color_theme || "default") === theme.id;
  card.setAttribute("aria-checked", String(selected));
  const unavailable = theme.mode && theme.mode !== (dark ? "dark" : "light");
  if (unavailable) card.classList.add("unavailable");
  const preview = previewFor(cardColors(theme, dark));
  if (theme.mode) {
    const only =
      theme.mode === "dark"
        ? t("settings.appearance.theme.dark_only")
        : t("settings.appearance.theme.light_only");
    preview.append(el("span", "pill", only));
  }
  if (selected) preview.append(checkMark());
  const name = el("span", "name", theme.name);
  if (!theme.builtIn) {
    name.append(" ");
    const by = el(
      "span",
      "by",
      theme.author
        ? t("settings.appearance.theme.author", { author: theme.author })
        : t("settings.appearance.theme.added_by_you"),
    );
    name.append(by);
  }
  card.append(preview, name);
  if (!unavailable) card.title = theme.name;
  else if (theme.mode === "dark")
    card.title = t("settings.appearance.theme.dark_only_title", { name: theme.name });
  else card.title = t("settings.appearance.theme.light_only_title", { name: theme.name });
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
      text: added
        ? t("settings.appearance.theme.added", { name: added.name })
        : t("settings.appearance.theme.added_unnamed"),
    };
    await persist({ key: "color_theme", value: id });
  } catch (e) {
    themeNotice = { kind: "error", text: errorMessage(e) };
    render();
  }
}

async function removeTheme(theme: ThemeInfo) {
  try {
    await invoke("remove_theme", { id: theme.id });
    await loadThemes();
    themeNotice = {
      kind: "ok",
      text: t("settings.appearance.theme.removed", { name: theme.name }),
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
    t("settings.appearance.theme.title"),
    segmented(
      t("settings.appearance.theme.mode_label"),
      [
        ["system", t("settings.appearance.theme.mode.system")],
        ["light", t("settings.appearance.theme.mode.light")],
        ["dark", t("settings.appearance.theme.mode.dark")],
      ],
      settings.theme,
      (value) => persist({ key: "theme", value }),
    ),
  );
  if (!themes) {
    loadThemes().then(render);
    return wrap;
  }
  const dark = pageIsDark();

  const grid = el("div", "theme-grid");
  grid.setAttribute("role", "radiogroup");
  grid.setAttribute("aria-label", t("settings.appearance.theme.title"));
  for (const theme of themes) grid.append(themeCard(theme, dark));

  const add = el("button", "theme-card theme-add");
  add.type = "button";
  const addPreview = el("span", "preview");
  addPreview.innerHTML =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  addPreview.append(el("span", "", t("settings.appearance.theme.add")));
  add.append(addPreview);
  add.onclick = addTheme;
  grid.append(add);

  const links = el("div", "theme-links");
  const folder = el("button", "link-button", t("settings.appearance.theme.open_folder"));
  folder.type = "button";
  folder.onclick = () => invoke("open_themes_folder").catch((e) => setStatus(String(e)));
  links.append(folder);
  const guide = el("button", "link-button", t("settings.appearance.theme.guide"));
  guide.type = "button";
  guide.onclick = () => invoke("open_theme_guide").catch((e) => setStatus(String(e)));
  links.append(guide);
  const selected = themes.find((theme) => theme.id === (settings.color_theme || "default"));
  if (selected && !selected.builtIn) {
    const remove = el(
      "button",
      "link-button",
      t("settings.appearance.theme.remove", { name: selected.name }),
    );
    remove.type = "button";
    remove.onclick = () => removeTheme(selected);
    links.append(remove);
  }
  links.append(el("span", "hint", t("settings.appearance.theme.custom_css_note")));
  wrap.append(grid, links);

  if (themeNotice) {
    const notice = el("div", `notice ${themeNotice.kind}`);
    notice.setAttribute("role", themeNotice.kind === "error" ? "alert" : "status");
    notice.append(el("span", "", themeNotice.text));
    const dismiss = el("button", "link-button", t("settings.appearance.theme.dismiss"));
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
  row.setAttribute("aria-label", t("settings.appearance.accent.label"));
  const current = (settings.accent_color || "").toLowerCase();
  const swatch = (className: string, color: string, name: string, value: string) => {
    const b = el("button", `swatch ${className}`);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", name);
    b.title = name;
    if (color) b.style.background = color;
    b.setAttribute("aria-checked", String(value === current));
    b.onclick = () => persist({ key: "accent_color", value: value });
    return b;
  };
  row.append(swatch("theme-accent", "", t("settings.appearance.accent.theme"), ""));
  for (const [color, name] of ACCENTS) row.append(swatch("", color, name, color));
  const isCustom = current && !ACCENTS.some(([color]) => color === current);
  const custom = swatch(
    "custom",
    isCustom ? current : "",
    t("settings.appearance.accent.custom"),
    isCustom ? current : "custom",
  );
  const input = document.createElement("input");
  input.type = "color";
  input.value = current || "#0866ff";
  input.hidden = true;
  input.onchange = () => persist({ key: "accent_color", value: input.value.toLowerCase() });
  custom.onclick = () => input.click();
  row.append(custom, input);
  box.append(
    rowText(t("settings.appearance.accent.label"), t("settings.appearance.accent.hint")),
    row,
  );
  return box;
}

function fontPicker() {
  const box = el("label", "row");
  const select = document.createElement("select");
  select.setAttribute("aria-label", t("settings.appearance.font.label"));
  const current = settings.message_font || "";
  const options: [string, string][] = [["", t("settings.appearance.font.default")]];
  for (const family of fonts || []) options.push([family, family]);
  if (current && !(fonts || []).includes(current)) options.push([current, current]);
  for (const [value, text] of options) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    o.selected = value === current;
    select.append(o);
  }
  if (!fonts) {
    fonts = [];
    invoke("list_fonts")
      .then((list) => {
        fonts = list;
        render();
      })
      .catch((e) => console.error(e));
  }
  select.onchange = () => persist({ key: "message_font", value: select.value });
  box.append(
    rowText(t("settings.appearance.font.label"), t("settings.appearance.font.hint")),
    select,
  );
  return box;
}

const APP_ICONS = [
  ["color-light", t("settings.appearance.app_icon.color")],
  ["color-dark", t("settings.appearance.app_icon.color_dark")],
  ["mono-light", t("settings.appearance.app_icon.mono")],
  ["mono-dark", t("settings.appearance.app_icon.mono_dark")],
] as const;

// One row of icon tiles; picking one saves it to `key`.
function iconTiles(key: "app_icon" | "app_icon_dark", label: string) {
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

// The icon you pick is the icon you get. With a different icon in dark
// mode, each mode has its own row; any pair works.
function appIconSection() {
  const card = el("section", "card");
  const body = el("div", "icon-card");
  const left = el("div");
  const title = el("h2", "card-title", t("settings.appearance.app_icon.title"));
  title.style.margin = "0";
  const toggle = el("label", "icon-switch");
  const perMode = !!settings.app_icon_dark;
  const input = switchInput(perMode);
  // Turning it on starts dark mode at the picked icon's dark version.
  input.onchange = () => persist({ key: "app_icon_dark_mode", value: input.checked });
  toggle.append(input, el("span", "", t("settings.appearance.app_icon.per_mode")));
  left.append(title, toggle);

  const rows = el("div", "icon-rows");
  if (perMode) {
    rows.append(
      el("div", "mode", t("settings.appearance.app_icon.light_mode")),
      iconTiles("app_icon", t("settings.appearance.app_icon.light_label")),
    );
    rows.append(
      el("div", "mode", t("settings.appearance.app_icon.dark_mode")),
      iconTiles("app_icon_dark", t("settings.appearance.app_icon.dark_label")),
    );
  } else {
    rows.append(iconTiles("app_icon", t("settings.appearance.app_icon.title")));
  }
  body.append(left, rows);
  card.append(body);
  if (IS_LINUX) {
    card.append(el("div", "section-hint", t("settings.appearance.app_icon.linux_hint")));
  }
  return card;
}

// Page zoom — the same 10% steps as the Cmd/Ctrl+−/=/0 keyboard zoom
// (30–200%). A hand-edited off-step value is shown as an extra option so
// the select never displays a wrong level.
function zoomRow() {
  const percent = new Intl.NumberFormat(LOCALE, { style: "percent" });
  const options: [number, string][] = [];
  for (let z = 30; z <= 200; z += 10) options.push([z, percent.format(z / 100)]);
  const current = Number(settings.zoom) || 100;
  if (!options.some(([v]) => Number(v) === current)) {
    options.push([current, percent.format(current / 100)]);
    options.sort((a, b) => Number(a[0]) - Number(b[0]));
  }
  return selectRow(
    settings.zoom,
    100,
    options,
    t("settings.appearance.zoom.label"),
    t("settings.appearance.zoom.hint"),
    false,
    (value) => persist({ key: "zoom", value }),
  );
}

// Muted conversations: a three-way policy. Older installs only have the
// on/off switch, which maps to "ignore" (on) or "include" (off).
function mutedConversationsRow() {
  const current =
    settings.muted_conversations ||
    (settings.ignore_muted_conversations === false ? "include" : "ignore");
  return selectRow(
    settings.muted_conversations,
    current,
    [
      ["ignore", t("settings.notifications.muted_conversations.ignore")],
      ["badge", t("settings.notifications.muted_conversations.badge")],
      ["include", t("settings.notifications.muted_conversations.include")],
    ],
    t("settings.notifications.muted_conversations.label"),
    t("settings.notifications.muted_conversations.hint"),
    false,
    (value) => persist({ key: "muted_conversations", value }),
  );
}

// Notification sound: Off, the system default, the OS's own sounds and
// the ones added with Choose file… (Ref #363, #446).
let sounds: SoundOption[] | null = null; // [{ label, sound }] from the backend, read once per window
const soundValue = (sound: import("./native-types").NotificationSound) => JSON.stringify(sound);
function notificationSoundRow() {
  const row = el("div", "row");
  const select = document.createElement("select");
  select.id = "message-sound";
  select.setAttribute("aria-label", t("settings.notifications.notification_sound.label"));
  const current =
    settings.notification_sound_choice ??
    (settings.notification_sound === false ? "off" : "default");
  const options: [import("./native-types").NotificationSound | "choose", string][] = [
    ["off", t("settings.notifications.notification_sound.off")],
    ["default", t("settings.notifications.notification_sound.default")],
    ["messenger", t("settings.notifications.notification_sound.messenger")],
  ];
  for (const { label, sound } of sounds || []) options.push([sound, label]);
  options.push(["choose", t("settings.notifications.notification_sound.choose")]);
  for (const [sound, label] of options) {
    const o = document.createElement("option");
    o.value = sound === "choose" ? "choose" : soundValue(sound);
    o.textContent = label;
    select.append(o);
  }
  // A saved sound that has gone plays the system default.
  select.value = soundValue(current);
  if (select.value !== soundValue(current)) select.value = soundValue("default");
  const shown = select.value;
  const selectedSound = () => {
    const choice = options.find(
      ([sound]) => sound !== "choose" && soundValue(sound) === select.value,
    )?.[0];
    return choice && choice !== "choose" ? choice : null;
  };
  if (!sounds) {
    sounds = [];
    invoke("notification_sounds")
      .then((list) => {
        sounds = list;
        render();
      })
      .catch((e) => console.error(e));
  }
  select.onchange = async () => {
    if (select.value !== "choose") {
      const sound = selectedSound();
      if (sound === "messenger") {
        // Copy Messenger's sound from its page first; keep the current
        // sound when that fails.
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
      sounds = null; // list the added sound
      await persist({ key: "notification_sound_choice", value: picked });
    } catch (e) {
      setStatus(errorMessage(e));
    }
  };
  const preview = el("button", "secondary", t("settings.notifications.notification_sound.preview"));
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

// The reaction a notification's React button adds: Messenger's defaults.
function notificationReactionRow() {
  return selectRow(
    settings.notification_reaction,
    "👍",
    [
      ["👍", "👍"],
      ["\u2764", "\u2764\ufe0f"],
      ["😆", "😆"],
      ["😮", "😮"],
      ["😢", "😢"],
      ["😡", "😡"],
    ],
    t("settings.notifications.notification_reaction.label"),
    t("settings.notifications.notification_reaction.hint"),
    false,
    (value) => persist({ key: "notification_reaction", value }),
  );
}

// How often automatic update checks run; only meaningful while they are on.
function updateCheckHoursRow() {
  return selectRow(
    settings.update_check_hours,
    4,
    [
      [1, t("settings.advanced.update_check_hours.hourly")],
      [4, t("settings.advanced.update_check_hours.four_hours")],
      [24, t("settings.advanced.update_check_hours.daily")],
    ],
    t("settings.advanced.update_check_hours.label"),
    t("settings.advanced.update_check_hours.hint"),
    !settings.automatic_update_checks || !runtimeCapabilities.automaticUpdateChecks,
    (value) => persist({ key: "update_check_hours", value }),
  );
}

// Badge counts mode — only meaningful while the unread badge is on.
function badgeModeRow() {
  return selectRow(
    settings.badge_mode,
    "messages",
    [
      ["messages", t("settings.notifications.badge_mode.messages")],
      ["conversations", t("settings.notifications.badge_mode.conversations")],
      ["dot", t("settings.notifications.badge_mode.dot")],
    ],
    t("settings.notifications.badge_mode.label"),
    t("settings.notifications.badge_mode.hint"),
    !settings.unread_badge,
    (value) => persist({ key: "badge_mode", value }),
  );
}

function downloadBehaviorRow() {
  return selectRow(
    settings.download_behavior,
    "downloads",
    [
      ["downloads", t("settings.general.download_behavior.downloads")],
      ["ask", t("settings.general.download_behavior.ask")],
    ],
    t("settings.general.download_behavior.label"),
    t("settings.general.download_behavior.hint"),
    false,
    (value) => persist({ key: "download_behavior", value }),
  );
}

// Chatpane's own language. It is chosen at launch, so a choice that
// resolves to another language than the running one offers a restart.
function languageRow() {
  const current = settings.language || "system";
  const system = I18N.languages.find(({ code }) => code === I18N.system);
  const select = document.createElement("select");
  select.setAttribute("aria-label", t("settings.general.language.label"));
  const options: [string, string][] = [
    [
      "system",
      t("settings.general.language.system", { language: system ? system.name : I18N.system }),
    ],
  ];
  for (const { code, name } of I18N.languages) options.push([code, name]);
  for (const [value, text] of options) {
    const o = el("option", "", text);
    o.value = value;
    if (value !== "system") o.lang = value;
    o.selected = value === current;
    select.append(o);
  }
  select.onchange = () => persist({ key: "language", value: select.value });
  const controls = el("div", "row-controls");
  controls.append(select);
  const pending = (current === "system" ? I18N.system : current) !== I18N.lang;
  if (pending) {
    const restart = el("button", "secondary", t("settings.general.language.restart"));
    restart.type = "button";
    restart.onclick = () => invoke("restart_app").catch((e) => setStatus(errorMessage(e)));
    controls.append(restart);
  }
  const hint = pending
    ? t("settings.general.language.restart_hint")
    : t("settings.general.language.hint");
  const row = el("div", "row");
  row.append(rowText(t("settings.general.language.label"), hint), controls);
  return row;
}

// Messenger's own language is the Facebook account's, changed only in
// Facebook's settings. Rust opens them and reloads Messenger after.
function messengerLanguageRow() {
  return buttonRow(
    t("settings.general.messenger_language.label"),
    t("settings.general.messenger_language.hint"),
    t("settings.general.messenger_language.change"),
    () => invoke("open_facebook_language").catch((e) => setStatus(errorMessage(e))),
  );
}

function trayIconStyleRow() {
  return selectRow(
    settings.tray_icon_style,
    "color",
    [
      ["color", t("settings.tray.tray_icon_style.color")],
      ["symbolic", t("settings.tray.tray_icon_style.symbolic")],
    ],
    t("settings.tray.tray_icon_style.label"),
    IS_MAC ? t("settings.tray.tray_icon_style.hint_mac") : t("settings.tray.tray_icon_style.hint"),
    false,
    (value) => persist({ key: "tray_icon_style", value }),
  );
}

function nicknameScope(current: Partial<Settings>): NonNullable<Settings["nickname_scope"]> {
  return (
    current.nickname_scope ||
    (current.show_nicknames === false ? "off" : current.nicknames_group_only ? "groups" : "all")
  );
}

// `nickname_scope` names where nicknames still show.
function nicknameRow() {
  return selectRow(
    settings.nickname_scope,
    nicknameScope(settings),
    [
      ["all", t("settings.appearance.nickname_scope.all")],
      ["groups", t("settings.appearance.nickname_scope.groups")],
      ["direct", t("settings.appearance.nickname_scope.direct")],
      ["off", t("settings.appearance.nickname_scope.off")],
    ],
    t("settings.appearance.nickname_scope.label"),
    t("settings.appearance.nickname_scope.hint"),
    false,
    (value) => persist({ key: "nickname_scope", value }),
  );
}

function switchRow(key: SwitchKey) {
  const meta = FIELD_META[key];
  const row = document.createElement("label");
  row.className = "row";
  // Hide Names / Hide Avatars fall back to the older combined switch.
  const cb = switchInput(
    key === "hide_names" || key === "hide_avatars"
      ? (settings[key] ?? settings.hide_names_avatars) === true
      : !!settings[key],
  );
  const trayRequired =
    IS_WINDOWS &&
    (settings.hide_on_minimize || settings.hide_on_focus_loss || settings.hide_taskbar_icon);
  const runtimeUnavailable =
    (key === "multi_instance" && !runtimeCapabilities.multiInstance) ||
    (key === "autostart" && !runtimeCapabilities.autostart) ||
    (key === "automatic_update_checks" && !runtimeCapabilities.automaticUpdateChecks);
  if ((key === "show_tray" && trayRequired) || runtimeUnavailable) {
    cb.disabled = true;
  }
  // FIELDS is restricted to boolean wire variants; TypeScript cannot keep
  // the discriminant correlated when the key is a union.
  cb.onchange = () => persist({ key, value: cb.checked } as SettingsChange);
  let hint = meta.hint;
  const pausedUntil = settings.notifications_paused_until;
  if (key === "mute_notifications" && typeof pausedUntil === "number" && pausedUntil > Date.now()) {
    hint = t("settings.notifications.mute_notifications.paused", { time: untilTime(pausedUntil) });
  } else if (key === "show_tray" && trayRequired) {
    hint = t("settings.tray.show_tray.required_hint");
  } else if (runtimeUnavailable) {
    if (key === "automatic_update_checks" && runtimeCapabilities.debug) {
      hint = t("settings.unavailable.debug_updates");
    } else if (key === "multi_instance") {
      hint = t("settings.unavailable.snap_single_instance");
    } else if (runtimeCapabilities.snap) {
      hint =
        key === "autostart"
          ? t("settings.unavailable.snap_autostart")
          : t("settings.unavailable.snap_managed");
    } else {
      hint = t("settings.unavailable.environment");
    }
  }
  row.append(rowText(meta.label, hint), cb);
  return row;
}

// Switch to a tab (no-op re-render if already active) and, when asked,
// move focus to its button — used by keyboard nav so focus follows the
// selection across the re-render that rebuilds the buttons.
function selectTab(id: string, focus: boolean) {
  if (id !== activeTab) {
    activeTab = id;
    try {
      localStorage.setItem("chatpane:settingsTab", id);
    } catch (_) {}
    render();
  }
  if (focus) {
    const el = byId(`tab-${id}`);
    if (el) el.focus();
  }
}

// ARIA tablist keyboard support: Left/Right move between tabs (wrapping,
// in the visual order, so mirrored for right-to-left languages),
// Home/End jump to the first/last. Activation follows focus (automatic
// activation — switching panels is cheap). Other keys fall through.
function onTabKeydown(e: KeyboardEvent, id: string) {
  const i = TABS.findIndex((tab) => tab.id === id);
  if (i < 0) return;
  const [next, previous] =
    I18N.dir === "rtl" ? ["ArrowLeft", "ArrowRight"] : ["ArrowRight", "ArrowLeft"];
  let j = null;
  if (e.key === next) j = (i + 1) % TABS.length;
  else if (e.key === previous) j = (i - 1 + TABS.length) % TABS.length;
  else if (e.key === "Home") j = 0;
  else if (e.key === "End") j = TABS.length - 1;
  if (j === null) return;
  e.preventDefault();
  selectTab(TABS[j]!.id, true);
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
    // Roving tabindex: only the active tab is in the Tab order; the arrow
    // keys move focus among the rest.
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
  // The single shared panel is labelled by whichever tab is selected.
  byId("rows").setAttribute("aria-labelledby", `tab-${activeTab}`);
}

function testNotificationRow() {
  return buttonRow(
    t("settings.notifications.test.label"),
    t("settings.notifications.test.hint"),
    t("settings.notifications.test.send"),
    async (btn, row) => {
      const hint = row.querySelector<HTMLElement>(".hint")!;
      hint.setAttribute("role", "status");
      btn.disabled = true;
      hint.textContent = t("settings.notifications.test.sending");
      try {
        hint.textContent = await invoke("send_test_notification");
      } catch (e) {
        hint.textContent = errorMessage(e);
      } finally {
        btn.disabled = false;
      }
    },
  );
}

// macOS registers the login item but opens it at login only once the
// user allows it in Login Items.
function autostartRow() {
  const row = switchRow("autostart");
  if (autostartStatus !== "needs-approval") return row;
  const rows = document.createDocumentFragment();
  rows.append(
    row,
    buttonRow(
      t("settings.tray.autostart.approval.label"),
      t("settings.tray.autostart.approval.hint"),
      t("settings.tray.autostart.approval.open"),
      () => invoke("open_login_items").catch(console.error),
    ),
  );
  return rows;
}

// Chatpane logs warnings and page-integration failures to a file; this
// opens its folder so the log is easy to attach to a bug report.
function openLogsRow() {
  return buttonRow(
    t("settings.advanced.logs.label"),
    t("settings.advanced.logs.hint"),
    t("settings.advanced.logs.open"),
    async () => {
      try {
        await invoke("open_log_folder");
      } catch (e) {
        setStatus(t("settings.advanced.logs.open_failed"));
        console.error(e);
      }
    },
  );
}

function customCssRow() {
  return buttonRow(
    t("settings.advanced.custom_css.label"),
    t("settings.advanced.custom_css.hint"),
    t("settings.advanced.custom_css.open"),
    async () => {
      try {
        await invoke("open_custom_css");
        setStatus(t("settings.advanced.custom_css.opened"));
      } catch (e) {
        setStatus(t("settings.advanced.custom_css.open_failed"));
        console.error(e);
      }
    },
  );
}

// ----- Account: Messenger's own account settings (Ref #358) -----
// Read and changed through the Messenger page, which reports the state
// Messenger has afterwards.
const messengerAccount: { state: MessengerAccountState | null; error: string; loading: boolean } = {
  state: null,
  error: "",
  loading: false,
};

async function loadMessengerAccount(change?: MessengerAccountChange) {
  if (messengerAccount.loading) return;
  messengerAccount.loading = true;
  messengerAccount.error = "";
  if (activeTab === "account") renderBody();
  try {
    messengerAccount.state = change
      ? await invoke("set_messenger_account", { change })
      : await invoke("messenger_account");
  } catch (e) {
    messengerAccount.error = errorMessage(e);
  } finally {
    messengerAccount.loading = false;
    if (activeTab === "account") renderBody();
  }
}

function accountToggleRow(
  setting: "activeStatus" | "readReceipts",
  label: string,
  hint: string,
  value: boolean | null,
) {
  const row = el("label", "row");
  const cb = switchInput(value === true);
  cb.disabled = value === null || messengerAccount.loading;
  cb.onchange = () => loadMessengerAccount({ setting, value: cb.checked });
  row.append(rowText(label, value === null ? t("settings.account.not_reported") : hint), cb);
  return row;
}

function dndRow(until: number | null) {
  const row = el("label", "row");
  const sel = document.createElement("select");
  const options: [string, string][] = [
    ["0", t("settings.account.dnd.off")],
    ["60", t("settings.account.dnd.one_hour")],
    ["480", t("settings.account.dnd.eight_hours")],
    ["1440", t("settings.account.dnd.day")],
    ["-1", t("settings.account.dnd.until_off")],
  ];
  let current = until === -1 ? "-1" : "0";
  let hint = t("settings.account.dnd.hint");
  if (until === null) {
    hint = t("settings.account.dnd.not_reported");
  } else if (until === -1) {
    hint = t("settings.account.dnd.on_until_off_hint");
  } else if (until !== null && until * 1000 > Date.now()) {
    current = "on";
    options.unshift(["on", t("settings.account.dnd.on_until", { time: untilTime(until * 1000) })]);
    hint = t("settings.account.dnd.on_until_time_hint");
  }
  for (const [value, text] of options) {
    const option = el("option", "", text);
    option.value = value;
    option.selected = value === current;
    option.hidden = value === "on";
    sel.append(option);
  }
  sel.disabled = until === null || messengerAccount.loading;
  sel.onchange = () => {
    if (sel.value !== "on")
      loadMessengerAccount({ setting: "doNotDisturb", value: Number(sel.value) });
  };
  row.append(rowText(t("settings.account.dnd.label"), hint), sel);
  return row;
}

function messengerAccountSection() {
  const wrap = titledCard(t("settings.account.title"));
  const intro = el("div", "section-hint", t("settings.account.intro"));
  // The message sound is Chatpane's own, on the Notifications tab.
  const soundLink = el("button", "link-button", t("settings.account.sound_link"));
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
    const retry = el("button", "link-button", t("settings.account.retry"));
    retry.type = "button";
    retry.onclick = () => loadMessengerAccount();
    notice.append(retry);
    wrap.append(notice);
  }
  if (!state) {
    if (loading) wrap.append(el("div", "section-hint", t("settings.account.loading")));
    else if (!error) queueMicrotask(() => loadMessengerAccount());
    return wrap;
  }
  wrap.append(
    accountToggleRow(
      "activeStatus",
      t("settings.account.active_status.label"),
      t("settings.account.active_status.hint"),
      state.activeStatus,
    ),
    accountToggleRow(
      "readReceipts",
      t("settings.account.read_receipts.label"),
      t("settings.account.read_receipts.hint"),
      state.readReceipts,
    ),
    dndRow(state.dndUntil),
  );
  return wrap;
}

// Fields with their own builder; every other field is a switch. The
// sections (theme, look, app icon, account) build a whole card.
const CUSTOM_ROWS = {
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
  messenger_account: messengerAccountSection,
};

function isCustomRow(key: RowKey): key is CustomRowKey {
  // biome-ignore lint/suspicious/noPrototypeBuiltins: Object.hasOwn needs Safari 15.4; macOS 10.15 ships older WebKit.
  return Object.prototype.hasOwnProperty.call(CUSTOM_ROWS, key);
}

function renderBody() {
  const root = byId("rows");
  root.innerHTML = "";
  const tab = TABS.find((entry) => entry.id === activeTab) || TABS[0]!;
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
    setStatus(t("shared.growth.copied"), 3000);
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
      setStatus(t("settings.status.reset"), 1200);
    } catch (error) {
      setStatus(errorMessage(error));
      console.error(error);
      await refresh();
    }
  });
};

// Pick up changes made elsewhere (e.g. the View menu) when refocused.
window.addEventListener("focus", refresh);
// And Messenger account changes made on another device.
window.addEventListener("focus", () => {
  if (activeTab === "account" && messengerAccount.state) loadMessengerAccount();
});
// A newer discovery may have replaced or cleared the offered update.
window.addEventListener("focus", () => {
  updateController.refresh().catch(() => {});
});

const updateButton = byId("check") as HTMLButtonElement;
// The pending update's own release notes, as plain text, while one is offered.
const notesBox = byId("update-notes");
let notesVersion = "";
async function showReleaseNotes(state: UpdateUiState) {
  if (state.phase !== "available" || !state.version) {
    notesBox.hidden = true;
    notesVersion = "";
    return;
  }
  if (notesVersion === state.version) return;
  notesVersion = state.version;
  let notes = null;
  try {
    // Native returns notes only while it still offers this version.
    notes = await invoke("update_release_notes", { version: state.version });
  } catch (_) {}
  if (notesVersion !== state.version) return;
  if (typeof notes !== "string" || !notes) {
    notesBox.hidden = true;
    return;
  }
  notesBox.querySelector("summary")!.textContent = t("settings.update.notes_summary", {
    version: state.version,
  });
  notesBox.querySelector(".update-notes-text")!.textContent = notes;
  notesBox.hidden = false;
}
const updateController = new UpdateConsentController(
  (command) => invoke(command),
  (state) => {
    updateButton.textContent = state.buttonLabel;
    updateButton.disabled = state.busy;
    updateStatus = state.status;
    setStatus(state.status);
    showReleaseNotes(state);
  },
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
// The OS's Start on System Startup state, which may also correct the setting.
refresh();
updateController
  .initialize(
    BOOT.install_mode
      ? { installMode: BOOT.install_mode, discovered: BOOT.discovered_update }
      : undefined,
  )
  .catch((e) => {
    updateController.fail(e);
    console.error(e);
  });
