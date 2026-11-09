/**
 * Chatpane's own text in the user's language. The native side picks the
 * language once per launch and sets `window.__CHATPANE_I18N__` before these
 * scripts run (src-tauri/src/i18n.rs): Messenger windows get the `page.` and
 * `shared.` keys, the Settings window the `settings.` and `shared.` keys.
 * Keys come from src-tauri/locales/en.json, so an unknown key, or one the
 * webview never receives, fails the typecheck.
 */
import type english from "../../src-tauri/locales/en.json";

type Key = keyof typeof english;
type For<Prefix extends string> = Extract<Key, `${Prefix}.${string}` | `shared.${string}`>;
/** Plain keys, without the plural ones (`base#one`, `base#other`, …). */
type Plain<K> = K extends `${string}#${string}` ? never : K;
/** A plural key's base: `page.x` for `page.x#other`. */
type Plural<K> = K extends `${infer Base}#other` ? Base : never;

export type PageKey = Plain<For<"page">>;
export type PagePluralKey = Plural<For<"page">>;
export type SettingsKey = Plain<For<"settings">>;
export type SettingsPluralKey = Plural<For<"settings">>;

type Vars = Record<string, string | number>;

interface Strings {
  lang: string;
  dir: "ltr" | "rtl";
  strings: Record<string, string>;
  languages?: { code: string; name: string }[];
  system?: string;
}

declare global {
  var __CHATPANE_I18N__: Strings | undefined;
}

const ENGLISH: Strings = { lang: "en", dir: "ltr", strings: {} };

function current(): Strings {
  return globalThis.__CHATPANE_I18N__ ?? ENGLISH;
}

/** This launch's language code (BCP 47) and writing direction, shaped to
 * `Object.assign` onto an element Chatpane creates. */
export function language(): { lang: string; dir: "ltr" | "rtl" } {
  const { lang, dir } = current();
  return { lang, dir };
}

/** The locale for dates and numbers: the language, in the OS's regional
 * format when the OS prefers the same language (en-GB keeps its day-month
 * order), as the Settings window does. */
export function formatLocale(): string {
  const { lang } = current();
  if (lang.includes("-")) return lang;
  return globalThis.navigator?.languages?.find((tag) => tag.split("-")[0] === lang) ?? lang;
}

/** Replace `{name}` placeholders in one pass; numbers in the user's format. */
function fill(text: string, vars?: Vars): string {
  if (!vars) return text;
  const locale = formatLocale();
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    if (value === undefined) return match;
    return typeof value === "number" ? value.toLocaleString(locale) : value;
  });
}

function text(key: string, vars?: Vars): string {
  return fill(current().strings[key] ?? key, vars);
}

const pluralRules = new Map<string, Intl.PluralRules>();

/** The form of `key` for `count` (also filled in as `{count}`). */
function plural(key: string, count: number, vars?: Vars): string {
  const { lang, strings } = current();
  let rules = pluralRules.get(lang);
  if (!rules) {
    rules = new Intl.PluralRules(lang);
    pluralRules.set(lang, rules);
  }
  const form = strings[`${key}#${rules.select(count)}`] ?? strings[`${key}#other`] ?? key;
  return fill(form, { count, ...vars });
}

/** Text for the Messenger windows. */
export const t: (key: PageKey, vars?: Vars) => string = text;
/** Plural text for the Messenger windows, with `{count}` filled in. */
export const tn: (key: PagePluralKey, count: number, vars?: Vars) => string = plural;
/** Text for the Settings window. */
export const settingsText: (key: SettingsKey, vars?: Vars) => string = text;
/** Plural text for the Settings window, with `{count}` filled in. */
export const settingsPlural: (key: SettingsPluralKey, count: number, vars?: Vars) => string =
  plural;
