// bun test: Chatpane's English strings, as src-tauri/src/i18n.rs injects them.
import english from "../src-tauri/locales/en.json";

globalThis.__CHATPANE_I18N__ = {
  lang: "en",
  dir: "ltr",
  strings: Object.fromEntries(
    Object.entries(english).map(([key, value]) => [key, value.replaceAll("{app}", "Chatpane")]),
  ),
};
