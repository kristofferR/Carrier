//! Chatpane's own text in the user's language: native menus, dialogs and
//! notifications, the Settings window, and the features injected into
//! Messenger. Messenger itself follows the Facebook account's language.
//!
//! Each language is one flat JSON file in `src-tauri/locales/`, keyed by area
//! (`menu.reload`). `en.json` is the source; a translation falls back to
//! English key by key. Placeholders are `{name}`, and `{app}` is the product
//! name, filled in here so no translation spells it. A key ending in `#one`,
//! `#few` and so on is one plural form (CLDR categories, always with
//! `#other`); the injected scripts pick the form with `Intl.PluralRules`.
//!
//! The key's first segment decides which webviews receive it: `settings.`
//! keys go to the Settings window, `page.` keys to the Messenger windows, and
//! `shared.` keys to both. Rust can use every key.
//!
//! The language is resolved once per launch from `Settings::language`, so a
//! change applies after a restart.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Display;
use std::sync::OnceLock;

use serde::Serialize;

/// The product name every `{app}` placeholder becomes.
pub(crate) const APP_NAME: &str = "Chatpane";

/// The `Settings::language` value that follows the OS's preferred languages.
pub(crate) const SYSTEM: &str = "system";

pub(crate) struct Language {
    /// BCP 47 code, the same as the landing page's `docs/i18n/<code>.json`.
    pub(crate) code: &'static str,
    /// The language's name for itself, as the Settings picker lists it.
    pub(crate) name: &'static str,
    rtl: bool,
    source: &'static str,
}

impl Language {
    /// The writing direction, as HTML's `dir` attribute takes it.
    pub(crate) fn dir(&self) -> &'static str {
        if self.rtl { "rtl" } else { "ltr" }
    }
}

macro_rules! language {
    ($code:literal, $name:literal) => {
        language!($code, $name, false)
    };
    ($code:literal, $name:literal, $rtl:literal) => {
        Language {
            code: $code,
            name: $name,
            rtl: $rtl,
            source: include_str!(concat!("../locales/", $code, ".json")),
        }
    };
}

/// English first (the fallback), then the landing page's languages in its
/// picker's order.
pub(crate) const LANGUAGES: &[Language] = &[
    language!("en", "English"),
    language!("id", "Bahasa Indonesia"),
    language!("cs", "Čeština"),
    language!("da", "Dansk"),
    language!("de", "Deutsch"),
    language!("es", "Español"),
    language!("fil", "Filipino"),
    language!("fr", "Français"),
    language!("it", "Italiano"),
    language!("hu", "Magyar"),
    language!("nb", "Norsk"),
    language!("pl", "Polski"),
    language!("pt-BR", "Português (Brasil)"),
    language!("ro", "Română"),
    language!("sv", "Svenska"),
    language!("vi", "Tiếng Việt"),
    language!("tr", "Türkçe"),
    language!("el", "Ελληνικά"),
    language!("uk", "Українська"),
    language!("bn", "বাংলা"),
    language!("hi", "हिन्दी"),
    language!("ne", "नेपाली"),
    language!("si", "සිංහල"),
    language!("my", "မြန်မာ"),
    language!("km", "ខ្មែរ"),
    language!("lo", "ລາວ"),
    language!("th", "ไทย"),
    language!("zh-CN", "简体中文"),
    language!("ar", "العربية", true),
    language!("ur", "اردو", true),
];

struct Strings {
    language: &'static Language,
    text: HashMap<String, String>,
}

static STRINGS: OnceLock<Strings> = OnceLock::new();

/// Choose this launch's language from the `language` setting. Call it before
/// any text is built; text built earlier follows the OS language.
pub(crate) fn init(setting: &str) {
    let language = resolve(setting, sys_locale::get_locales());
    if STRINGS.set(load(language)).is_err() {
        log::warn!("UI language was already chosen before settings loaded");
    }
}

fn strings() -> &'static Strings {
    STRINGS.get_or_init(|| {
        // Tests read English whatever the machine's language.
        if cfg!(test) {
            return load(&LANGUAGES[0]);
        }
        load(resolve(SYSTEM, sys_locale::get_locales()))
    })
}

/// This launch's language.
pub(crate) fn current() -> &'static Language {
    strings().language
}

/// The language a `language` setting picks: a supported code, or for
/// "system" (and anything unknown) the first of the OS's preferred languages
/// Chatpane has, else English.
fn resolve(setting: &str, preferred: impl IntoIterator<Item = String>) -> &'static Language {
    find(setting)
        .or_else(|| preferred.into_iter().find_map(|tag| matching(&tag)))
        .unwrap_or(&LANGUAGES[0])
}

fn find(code: &str) -> Option<&'static Language> {
    LANGUAGES
        .iter()
        .find(|language| language.code.eq_ignore_ascii_case(code))
}

/// The supported language for an OS locale such as `nb-NO`, `pt_BR.UTF-8` or
/// `zh-Hans-CN`, with the landing page's fallbacks for regional variants.
fn matching(tag: &str) -> Option<&'static Language> {
    let tag = tag.split(['.', '@']).next()?.replace('_', "-");
    if let Some(language) = find(&tag) {
        return Some(language);
    }
    let base = tag.split('-').next()?.to_ascii_lowercase();
    find(match base.as_str() {
        "pt" => "pt-BR",
        "zh" => "zh-CN",
        "no" | "nn" => "nb",
        "tl" => "fil",
        other => other,
    })
}

/// Whether a `language` setting names "system" or a supported language.
pub(crate) fn is_valid_setting(setting: &str) -> bool {
    setting == SYSTEM || LANGUAGES.iter().any(|language| language.code == setting)
}

fn parse(language: &Language) -> HashMap<String, String> {
    serde_json::from_str(language.source).unwrap_or_else(|error| {
        log::error!("locales/{}.json is invalid: {error}", language.code);
        HashMap::new()
    })
}

fn plural_base(key: &str) -> Option<&str> {
    key.split_once('#').map(|(base, _)| base)
}

/// `language`'s text over English's, with `{app}` filled in. A translated
/// plural replaces all of English's forms, since languages have different ones.
fn load(language: &'static Language) -> Strings {
    let mut text = parse(&LANGUAGES[0]);
    if language.code != LANGUAGES[0].code {
        let translated = parse(language);
        let plurals: HashSet<&str> = translated
            .keys()
            .filter_map(|key| plural_base(key))
            .collect();
        text.retain(|key, _| plural_base(key).is_none_or(|base| !plurals.contains(base)));
        text.extend(translated);
    }
    for value in text.values_mut() {
        if value.contains("{app}") {
            *value = value.replace("{app}", APP_NAME);
        }
    }
    Strings { language, text }
}

/// The text for `key` in this launch's language.
pub(crate) fn t(key: &'static str) -> &'static str {
    match strings().text.get(key) {
        Some(text) => text,
        None => {
            log::warn!("missing UI string {key}");
            key
        }
    }
}

/// `t(key)` with each `{name}` placeholder replaced by its value.
pub(crate) fn tf(key: &'static str, args: &[(&str, &dyn Display)]) -> String {
    fill(t(key), args)
}

/// Replace `{name}` placeholders in one pass, so a value that itself looks
/// like a placeholder (a chat named "{count}") stays as it is.
fn fill(text: &str, args: &[(&str, &dyn Display)]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let value = after.find('}').and_then(|close| {
            let name = &after[..close];
            args.iter()
                .find(|(arg, _)| *arg == name)
                .map(|(_, value)| (value.to_string(), close))
        });
        match value {
            Some((value, close)) => {
                out.push_str(&value);
                rest = &after[close + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Which webview a script carries strings for.
#[derive(Clone, Copy)]
pub(crate) enum Audience {
    /// Messenger windows: `page.` and `shared.` keys.
    Page,
    /// The Settings window: `settings.` and `shared.` keys, plus the
    /// language picker's choices.
    Settings,
}

#[derive(Serialize)]
struct Choice {
    code: &'static str,
    name: &'static str,
}

#[derive(Serialize)]
struct Payload {
    lang: &'static str,
    dir: &'static str,
    strings: BTreeMap<&'static str, &'static str>,
    /// Settings only: every language, and the one "system" picks.
    #[serde(skip_serializing_if = "Option::is_none")]
    languages: Option<Vec<Choice>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<&'static str>,
}

/// A statement that sets `window.__CHATPANE_I18N__` for `audience`, for an
/// initialization script (read by `inject/src/i18n.ts` and the Settings page).
pub(crate) fn script(audience: Audience) -> String {
    let strings = strings();
    let prefix = match audience {
        Audience::Page => "page.",
        Audience::Settings => "settings.",
    };
    let settings = matches!(audience, Audience::Settings);
    let payload = Payload {
        lang: strings.language.code,
        dir: strings.language.dir(),
        strings: strings
            .text
            .iter()
            .filter(|(key, _)| key.starts_with(prefix) || key.starts_with("shared."))
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect(),
        languages: settings.then(|| {
            LANGUAGES
                .iter()
                .map(|language| Choice {
                    code: language.code,
                    name: language.name,
                })
                .collect()
        }),
        system: settings.then(|| resolve(SYSTEM, sys_locale::get_locales()).code),
    };
    format!(
        "window.__CHATPANE_I18N__ = {};",
        serde_json::to_string(&payload).expect("UI strings serialise")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolved(setting: &str, preferred: &[&str]) -> &'static str {
        resolve(setting, preferred.iter().map(|tag| tag.to_string())).code
    }

    #[test]
    fn a_chosen_language_wins_over_the_os() {
        assert_eq!(resolved("de", &["nb-NO"]), "de");
        assert_eq!(resolved("pt-BR", &["en-US"]), "pt-BR");
    }

    #[test]
    fn system_takes_the_first_supported_preferred_language() {
        assert_eq!(resolved(SYSTEM, &["fi-FI", "sv-SE", "en-US"]), "sv");
        assert_eq!(resolved(SYSTEM, &["nb_NO.UTF-8"]), "nb");
        assert_eq!(resolved(SYSTEM, &["fi-FI", "ja-JP"]), "en");
        assert_eq!(resolved(SYSTEM, &[]), "en");
        assert_eq!(resolved("klingon", &["fr-CA"]), "fr");
    }

    #[test]
    fn regional_variants_follow_the_landing_page() {
        assert_eq!(resolved(SYSTEM, &["pt-PT"]), "pt-BR");
        assert_eq!(resolved(SYSTEM, &["zh-Hans-CN"]), "zh-CN");
        assert_eq!(resolved(SYSTEM, &["zh-TW"]), "zh-CN");
        assert_eq!(resolved(SYSTEM, &["nn-NO"]), "nb");
        assert_eq!(resolved(SYSTEM, &["no"]), "nb");
        assert_eq!(resolved(SYSTEM, &["tl-PH"]), "fil");
        assert_eq!(resolved(SYSTEM, &["es-ES"]), "es");
        assert_eq!(resolved(SYSTEM, &["C", "POSIX"]), "en");
    }

    #[test]
    fn placeholders_fill_in_one_pass() {
        let name = "{count}";
        assert_eq!(
            fill("{name} sent {count}", &[("name", &name), ("count", &3)]),
            "{count} sent 3"
        );
        assert_eq!(fill("{unknown} and {", &[]), "{unknown} and {");
    }

    fn locale(language: &Language) -> BTreeMap<String, String> {
        serde_json::from_str(language.source)
            .unwrap_or_else(|error| panic!("locales/{}.json: {error}", language.code))
    }

    fn placeholders(text: &str) -> BTreeSet<&str> {
        text.split('{')
            .skip(1)
            .filter_map(|part| part.split_once('}').map(|(name, _)| name))
            .collect()
    }

    use std::collections::BTreeSet;

    const PLURAL_CATEGORIES: &[&str] = &["zero", "one", "two", "few", "many", "other"];

    /// Every translation has English's keys and placeholders. Plurals may use
    /// their language's own forms, and a form may leave out a placeholder
    /// ("one message") but not add one.
    #[test]
    fn translations_match_english() {
        let english = locale(&LANGUAGES[0]);
        let singles = |map: &BTreeMap<String, String>| -> BTreeSet<String> {
            map.keys()
                .filter(|key| plural_base(key).is_none())
                .cloned()
                .collect()
        };
        let plurals = |map: &BTreeMap<String, String>| -> BTreeSet<String> {
            map.keys()
                .filter_map(|key| plural_base(key))
                .map(str::to_string)
                .collect()
        };
        for language in LANGUAGES {
            let code = language.code;
            let text = locale(language);
            assert_eq!(
                singles(&text),
                singles(&english),
                "{code}: keys differ from en"
            );
            assert_eq!(
                plurals(&text),
                plurals(&english),
                "{code}: plurals differ from en"
            );
            for (key, value) in &text {
                assert!(!value.trim().is_empty(), "{code}: {key} is empty");
                let source = match plural_base(key) {
                    Some(base) => {
                        let category = &key[base.len() + 1..];
                        assert!(PLURAL_CATEGORIES.contains(&category), "{code}: {key}");
                        let other = format!("{base}#other");
                        assert!(text.contains_key(&other), "{code}: {key} has no #other");
                        let allowed = placeholders(&english[&other]);
                        assert!(
                            placeholders(value).is_subset(&allowed),
                            "{code}: {key} has placeholders English lacks"
                        );
                        continue;
                    }
                    None => &english[key],
                };
                assert_eq!(
                    placeholders(value),
                    placeholders(source),
                    "{code}: {key} placeholders differ from en"
                );
            }
        }
    }

    /// Source files that may name UI string keys.
    fn sources() -> Vec<(String, String)> {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let mut files = Vec::new();
        let mut dirs = vec![root.join("src-tauri/src"), root.join("inject/src")];
        while let Some(dir) = dirs.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                let name = path.to_string_lossy().to_string();
                if path.is_dir() {
                    dirs.push(path);
                } else if (name.ends_with(".rs") || name.ends_with(".ts"))
                    && !name.ends_with(".test.ts")
                    && !name.ends_with("i18n.rs")
                {
                    files.push((name, std::fs::read_to_string(&path).unwrap()));
                }
            }
        }
        for page in ["dist/settings.html", "dist/index.html"] {
            let path = root.join(page);
            files.push((page.into(), std::fs::read_to_string(path).unwrap()));
        }
        files
    }

    /// The keys passed literally to `t(`, `tf(` or `tn(` in `source`.
    fn called_keys(source: &str) -> Vec<&str> {
        let mut keys = Vec::new();
        for call in ["t(\"", "tf(\"", "tn(\""] {
            for (at, _) in source.match_indices(call) {
                let word = source[..at].chars().next_back();
                if word.is_some_and(|c| c.is_alphanumeric() || c == '_') {
                    continue;
                }
                let rest = &source[at + call.len()..];
                if let Some(end) = rest.find('"') {
                    keys.push(&rest[..end]);
                }
            }
        }
        keys
    }

    #[test]
    fn every_key_in_use_exists_and_every_key_is_used() {
        let english = locale(&LANGUAGES[0]);
        let bases: BTreeSet<&str> = english
            .keys()
            .map(|key| plural_base(key).unwrap_or(key))
            .collect();
        let sources = sources();
        for (file, source) in &sources {
            for key in called_keys(source) {
                assert!(bases.contains(key), "{file} uses unknown UI string {key}");
            }
        }
        for key in bases {
            let quoted = format!("\"{key}\"");
            assert!(
                sources.iter().any(|(_, source)| source.contains(&quoted)),
                "UI string {key} is never used"
            );
        }
    }

    #[test]
    fn webviews_get_only_their_keys() {
        let page = script(Audience::Page);
        let json = page
            .strip_prefix("window.__CHATPANE_I18N__ = ")
            .and_then(|rest| rest.strip_suffix(';'))
            .unwrap();
        let payload: serde_json::Value = serde_json::from_str(json).unwrap();
        let strings = payload["strings"].as_object().unwrap();
        assert!(
            strings
                .keys()
                .all(|key| key.starts_with("page.") || key.starts_with("shared."))
        );
        assert!(payload.get("languages").is_none());
        assert!(script(Audience::Settings).contains("\"languages\":"));
    }

    #[test]
    fn app_name_is_filled_in() {
        let english = load(&LANGUAGES[0]);
        assert!(english.text.values().all(|value| !value.contains("{app}")));
    }
}
