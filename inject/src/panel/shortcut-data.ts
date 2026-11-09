import { t } from "../i18n";

export interface ShortcutItem {
  keys: string;
  action: string;
}

export interface ShortcutGroup {
  title: string;
  items: ShortcutItem[];
}

/** Built on demand, so the labels are in this launch's language. */
export function shortcutGroups(isMac: boolean): ShortcutGroup[] {
  const mod = isMac ? "⌘" : "Ctrl";
  const shift = isMac ? "⇧" : "Shift";
  const alt = isMac ? "⌥" : "Alt";
  const chord = (...keys: string[]) => keys.join(" + ");

  return [
    {
      title: t("page.shortcuts.group.conversations"),
      items: [
        { keys: chord(mod, "1–9"), action: t("page.shortcuts.jump_to_conversation") },
        {
          keys: "Ctrl + Tab / Ctrl + Shift + Tab",
          action: t("page.shortcuts.next_previous_conversation"),
        },
        {
          keys: `${chord(mod, "]")} / ${chord(mod, "[")}`,
          action: t("page.shortcuts.next_previous_conversation"),
        },
        { keys: chord(mod, shift, "N"), action: t("page.shortcuts.new_conversation") },
        { keys: chord(mod, "N"), action: t("page.shortcuts.new_window") },
        { keys: chord(mod, "K"), action: t("page.shortcuts.search_conversations") },
        { keys: chord(mod, "F"), action: t("page.shortcuts.search_in_conversation") },
        { keys: chord(mod, "L"), action: t("page.shortcuts.focus_message_input") },
      ],
    },
    {
      title: t("page.shortcuts.group.compose"),
      items: [
        { keys: chord(mod, "E"), action: t("page.shortcuts.emoji_picker") },
        { keys: chord(mod, "G"), action: t("page.shortcuts.gif_picker") },
        { keys: chord(mod, "T"), action: t("page.shortcuts.attach_files") },
        { keys: chord(mod, shift, alt, "V"), action: t("page.shortcuts.paste_and_match_style") },
      ],
    },
    {
      title: t("page.shortcuts.group.view"),
      items: [
        { keys: chord(mod, shift, "I"), action: t("page.shortcuts.toggle_conversation_info") },
        { keys: chord(mod, shift, "H"), action: t("page.shortcuts.hide_names") },
        { keys: chord(mod, shift, "M"), action: t("page.shortcuts.show_hide_app") },
        {
          keys: `${chord(mod, "-")} / ${chord(mod, "=")} / ${chord(mod, "0")}`,
          action: t("page.shortcuts.zoom"),
        },
        { keys: chord(mod, ","), action: t("page.shortcuts.open_settings") },
        { keys: chord(mod, "R"), action: t("page.shortcuts.reload") },
        { keys: chord(mod, shift, "Backspace"), action: t("page.shortcuts.clear_cache") },
        { keys: "F2 / F3 / F5", action: t("page.shortcuts.function_keys") },
        { keys: `${chord(mod, "/")} / F1`, action: t("page.shortcuts.keyboard_shortcuts") },
      ],
    },
  ];
}
