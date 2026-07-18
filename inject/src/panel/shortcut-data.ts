export interface ShortcutItem {
  keys: string;
  action: string;
}

export interface ShortcutGroup {
  title: string;
  items: ShortcutItem[];
}

export function shortcutGroups(isMac: boolean): ShortcutGroup[] {
  const mod = isMac ? "⌘" : "Ctrl";
  const shift = isMac ? "⇧" : "Shift";
  const alt = isMac ? "⌥" : "Alt";
  const chord = (...keys: string[]) => keys.join(" + ");

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
        { keys: chord(mod, "L"), action: "Focus message input" },
      ],
    },
    {
      title: "Compose",
      items: [
        { keys: chord(mod, "E"), action: "Open emoji picker" },
        { keys: chord(mod, "G"), action: "Open GIF picker" },
        { keys: chord(mod, "T"), action: "Attach files" },
        { keys: chord(mod, shift, alt, "V"), action: "Paste and match style" },
      ],
    },
    {
      title: "View & Carrier",
      items: [
        { keys: chord(mod, shift, "I"), action: "Toggle conversation information" },
        { keys: chord(mod, shift, "H"), action: "Hide names and avatars" },
        { keys: chord(mod, shift, "M"), action: "Show or hide Carrier globally" },
        {
          keys: `${chord(mod, "-")} / ${chord(mod, "=")} / ${chord(mod, "0")}`,
          action: "Zoom out / in / reset",
        },
        { keys: chord(mod, ","), action: "Open Settings" },
        { keys: chord(mod, "R"), action: "Reload" },
        { keys: chord(mod, shift, "Backspace"), action: "Clear cache and restart" },
        { keys: "F2 / F3 / F5", action: "Update settings / Settings / reload" },
        { keys: `${chord(mod, "/")} / F1`, action: "Keyboard shortcuts" },
      ],
    },
  ];
}
