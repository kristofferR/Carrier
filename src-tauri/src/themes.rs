//! Themes, accent color and message font (Settings → Appearance).
//!
//! A theme is one CSS file that recolors Messenger: built-in ones ship in
//! `src-tauri/themes/`, and imported ones are copied into the `themes` folder
//! beside `custom.css`. A theme is a palette on top of the light/dark choice,
//! never a third mode. Every theme starts with a header comment:
//!
//! ```css
//! /* Carrier theme
//!    name: Fjord
//!    author: ingrid
//!    mode: dark
//!    preview: #242933 #2e3440 #2e3440 #5e81ac #3b4252
//! */
//! ```
//!
//! `preview` is five colors for the card in Settings: window, conversation
//! list, chat, your messages, theirs. `mode` limits a theme to light or dark;
//! in the other mode Messenger's own colors show. Headers written for other
//! Messenger apps with the same shape are accepted too.
//!
//! A theme is CSS and nothing more: at most 2 MB, no `@import`, and no URL
//! other than `data:`, so it can't load or send anything. Themes can set
//! Carrier's `--carrier-*` palette tokens, which Carrier maps onto Messenger's
//! own CSS variables, and key dark colors on `html[data-carrier-dark]`.
//!
//! The page gets four `<style>` elements, created once in this order so later
//! ones win: the theme, High Contrast (whenever the system asks for more
//! contrast), the accent color, and the font. `custom.css` still comes last.

use std::path::{Path, PathBuf};

use cssparser::{ParseError, Parser, ParserInput, Token};
use serde::Serialize;
use tauri::{Manager, WebviewWindow};

use crate::settings::{AppState, Settings};
use crate::url_rules::is_messenger_web_url;

pub(crate) const DEFAULT_THEME: &str = "default";
pub(crate) const HIGH_CONTRAST_THEME: &str = "high-contrast";
const THEMES_DIR: &str = "themes";
const THEME_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Built-in themes, in gallery order. Default has no CSS: Messenger's own look.
const BUILT_IN: &[(&str, &str)] = &[
    (DEFAULT_THEME, ""),
    ("oled-black", include_str!("../themes/oled-black.css")),
    ("graphite", include_str!("../themes/graphite.css")),
    ("warm", include_str!("../themes/warm.css")),
    (
        HIGH_CONTRAST_THEME,
        include_str!("../themes/high-contrast.css"),
    ),
];

/// Carrier's palette tokens and the Messenger variables each one sets.
const PALETTE: &[(&str, &[&str])] = &[
    ("wash", &["--web-wash"]),
    // Behind the messages; set by its own rule (see `palette_mapping`).
    ("chat", &[]),
    (
        "page",
        &[
            "--surface-background",
            "--card-background",
            "--messenger-card-background",
            "--popover-background",
            "--mwp-header-background-color",
            "--chat-composer-background-color",
            "--reaction-pill-background-color",
        ],
    ),
    (
        "field",
        &[
            "--comment-background",
            "--input-background",
            "--secondary-button-background",
            "--chat-composer-input-background-color",
            "--chat-replied-message-background-color",
            "--chat-edit-message-overlay-color",
        ],
    ),
    ("hover", &["--hover-overlay"]),
    ("line", &["--divider"]),
    ("text", &["--primary-text", "--mwp-header-text-color"]),
    (
        "text-2",
        &[
            "--secondary-text",
            "--placeholder-text",
            "--secondary-icon",
            "--placeholder-icon",
            "--chat-admin-text-color",
            "--mwp-subheader-text-color",
            "--chat-scrollbar-thumb-color",
        ],
    ),
    ("icon", &["--primary-icon"]),
    (
        "brand",
        &[
            "--accent",
            "--primary-button-background",
            "--mwp-primary-theme-color",
            "--blue-link",
            "--chat-composer-button-color",
            "--chat-composer-caret-color",
            "--mwp-header-button-color",
        ],
    ),
    (
        "brand-soft",
        &[
            "--primary-deemphasized-button-background",
            "--reaction-pill-multireact-selected-color",
        ],
    ),
    ("brand-soft-text", &["--primary-deemphasized-button-text"]),
    ("out", &["--chat-outgoing-message-bubble-background-color"]),
    ("out-text", &["--chat-message-text-color"]),
    ("in", &["--chat-incoming-message-bubble-background-color"]),
    ("in-text", &["--chat-incoming-message-text-color"]),
    ("selection", &["--text-highlight"]),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ThemeMode {
    Light,
    Dark,
}

/// What a theme's header says about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ThemeHeader {
    pub(crate) name: String,
    pub(crate) author: Option<String>,
    pub(crate) mode: Option<ThemeMode>,
    pub(crate) preview: Option<[String; 5]>,
}

/// A theme as the Settings gallery shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThemeInfo {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) author: Option<String>,
    pub(crate) mode: Option<ThemeMode>,
    pub(crate) preview: Option<[String; 5]>,
    pub(crate) built_in: bool,
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// Read the header comment at the top of a theme file.
pub(crate) fn parse_header(css: &str) -> Result<ThemeHeader, String> {
    const MISSING: &str = "it doesn't start with a theme header. The file must begin with a comment whose first line ends in \"theme\" (such as \"Carrier theme\"), followed by a line such as \"name: My theme\".";
    let body = css.trim_start_matches('\u{feff}').trim_start();
    let comment = body
        .strip_prefix("/*")
        .and_then(|rest| rest.split_once("*/"))
        .map(|(comment, _)| comment)
        .ok_or_else(|| MISSING.to_string())?;
    let mut lines = comment.lines();
    let first = lines.next().unwrap_or("").trim();
    if !first.to_ascii_lowercase().ends_with(" theme") {
        return Err(MISSING.into());
    }
    let (mut name, mut author, mut mode, mut preview) = (None, None, None, None);
    for line in lines {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key.trim().to_ascii_lowercase().as_str() {
            "name" if !value.is_empty() => name = Some(value.chars().take(60).collect()),
            "author" if !value.is_empty() => author = Some(value.chars().take(60).collect()),
            "mode" => {
                mode = match value.to_ascii_lowercase().as_str() {
                    "light" => Some(ThemeMode::Light),
                    "dark" => Some(ThemeMode::Dark),
                    _ => return Err(format!("its mode is \"{value}\"; use light or dark.")),
                }
            }
            "preview" => {
                let colors: Vec<String> = value
                    .split_whitespace()
                    .map(|c| c.to_ascii_lowercase())
                    .collect();
                if colors.len() != 5 || !colors.iter().all(|c| is_hex_color(c)) {
                    return Err("its preview needs exactly five colors like #1a2b3c.".into());
                }
                preview = colors.try_into().ok();
            }
            _ => {}
        }
    }
    let name = name.ok_or("its header has no name: line.")?;
    Ok(ThemeHeader {
        name,
        author,
        mode,
        preview,
    })
}

const BLOCKED_FUNCTIONS: &[&str] = &[
    "image-set",
    "-webkit-image-set",
    "image",
    "cross-fade",
    "-webkit-cross-fade",
    "element",
    "-moz-element",
    "expression",
];

fn is_data_url(value: &str) -> bool {
    value
        .trim_start()
        .get(..5)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("data:"))
}

/// Walk every token, descending into blocks and functions. CSS escapes are
/// decoded by the tokenizer, so `\75 rl(` is still caught as `url(`.
/// Deeper nesting than any real theme needs; bounds the recursion below so
/// a file of `(((…` cannot overflow the stack.
const MAX_CSS_DEPTH: usize = 64;

fn scan_tokens<'i>(
    parser: &mut Parser<'i, '_>,
    depth: usize,
) -> Result<(), ParseError<'i, String>> {
    if depth > MAX_CSS_DEPTH {
        let line = parser.current_source_location().line + 1;
        return Err(parser.new_custom_error(format!("line {line} is nested too deeply.")));
    }
    loop {
        let line = parser.current_source_location().line + 1;
        let token = match parser.next_including_whitespace_and_comments() {
            Ok(token) => token.clone(),
            Err(_) => return Ok(()),
        };
        let fail = |parser: &Parser<'i, '_>, why: String| {
            Err(parser.new_custom_error(format!("line {line} {why}")))
        };
        match &token {
            Token::AtKeyword(name) if name.eq_ignore_ascii_case("import") => {
                return fail(
                    parser,
                    "uses @import. Themes can't load other files.".into(),
                );
            }
            Token::UnquotedUrl(url) if !is_data_url(url) => {
                return fail(
                    parser,
                    "loads a file from outside the theme. Themes can only use data: URLs.".into(),
                );
            }
            Token::BadUrl(_) | Token::BadString(_) => {
                return fail(parser, "has a broken URL or string.".into());
            }
            Token::Function(name) => {
                let name = name.to_ascii_lowercase();
                if BLOCKED_FUNCTIONS.contains(&name.as_str()) {
                    return fail(parser, format!("uses {name}(), which themes can't use."));
                }
                let is_url = name == "url" || name == "src";
                parser.parse_nested_block(|parser| {
                    if is_url {
                        let argument = parser.expect_string_cloned().map_err(|_| {
                            parser.new_custom_error(format!(
                                "line {line} has a URL Carrier can't read."
                            ))
                        })?;
                        if !is_data_url(&argument) {
                            return Err(parser.new_custom_error(format!(
                                "line {line} loads a file from outside the theme. Themes can only use data: URLs."
                            )));
                        }
                    }
                    scan_tokens(parser, depth + 1)
                })?;
            }
            Token::ParenthesisBlock | Token::SquareBracketBlock | Token::CurlyBracketBlock => {
                parser.parse_nested_block(|parser| scan_tokens(parser, depth + 1))?;
            }
            _ => {}
        }
    }
}

/// Reject anything that could load or send data. The returned message
/// completes "Couldn't add <file>: …".
pub(crate) fn check_css(css: &str) -> Result<(), String> {
    if css.len() as u64 > THEME_MAX_BYTES {
        return Err("it is larger than 2 MB.".into());
    }
    let mut input = ParserInput::new(css);
    let mut parser = Parser::new(&mut input);
    scan_tokens(&mut parser, 0).map_err(|error| match error.kind {
        cssparser::ParseErrorKind::Custom(message) => message,
        cssparser::ParseErrorKind::Basic(_) => {
            format!("line {} could not be read as CSS.", error.location.line + 1)
        }
    })
}

/// A filesystem-safe id from a file name: "My Theme (2).css" → "my-theme-2".
fn theme_id_for(file_stem: &str) -> String {
    let mut id = String::new();
    for c in file_stem.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            id.push(c);
        } else if !id.ends_with('-') && !id.is_empty() {
            id.push('-');
        }
    }
    let mut id: String = id.trim_end_matches('-').chars().take(40).collect();
    if id.is_empty() {
        id = "theme".into();
    }
    if BUILT_IN.iter().any(|(built_in, _)| *built_in == id) {
        id.push_str("-imported");
    }
    id
}

fn is_user_theme_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 50
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !BUILT_IN.iter().any(|(built_in, _)| *built_in == id)
}

pub(crate) fn themes_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(THEMES_DIR))
        .map_err(|error| format!("could not locate Carrier's config folder: {error}"))
}

fn read_user_theme(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > THEME_MAX_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// The CSS for a theme id, or None for Default and for themes that are gone
/// or no longer pass the checks (Messenger's own look shows instead).
fn theme_css(app: &tauri::AppHandle, id: &str) -> Option<String> {
    if let Some((_, css)) = BUILT_IN.iter().find(|(built_in, _)| *built_in == id) {
        return (!css.is_empty()).then(|| (*css).to_string());
    }
    if !is_user_theme_id(id) {
        return None;
    }
    let path = themes_dir(app).ok()?.join(format!("{id}.css"));
    let css = read_user_theme(&path)?;
    match parse_header(&css).and_then(|_| check_css(&css)) {
        Ok(()) => Some(css),
        Err(error) => {
            log::warn!("theme {id} was not applied: {error}");
            None
        }
    }
}

/// The `--carrier-*` tokens a stylesheet defines.
fn defined_tokens(css: &str) -> Vec<&'static str> {
    PALETTE
        .iter()
        .map(|(token, _)| *token)
        .filter(|token| {
            let needle = format!("--carrier-{token}");
            css.match_indices(&needle).any(|(at, _)| {
                let rest = &css[at + needle.len()..];
                rest.trim_start().starts_with(':')
            })
        })
        .collect()
}

/// Map palette tokens onto Messenger's variables. Messenger declares its
/// variables again on light/dark "islands" (tooltips, the media viewer) and on
/// each chat's color host, so the mapping goes on the islands that match the
/// page's mode and on chat hosts, where it outranks a chat's own colors.
fn palette_mapping(tokens: &[&str], chat_background: bool) -> String {
    if tokens.is_empty() {
        return String::new();
    }
    let mut map = String::new();
    for (token, variables) in PALETTE.iter().filter(|(t, _)| tokens.contains(t)) {
        for variable in *variables {
            map.push_str(&format!(
                "  {variable}: var(--carrier-{token}) !important;\n"
            ));
        }
        if *token == "out" {
            map.push_str("  --chat-outgoing-message-background-gradient: initial !important;\n");
        }
    }
    let mut css = format!(
        "\n:root,\n[style*=\"--chat-outgoing-message-bubble-background-color\"] {{\n{map}}}\n\
         @media (prefers-color-scheme: light) {{\n.__fb-light-mode {{\n{map}}}\n}}\n\
         @media (prefers-color-scheme: dark) {{\n.__fb-dark-mode {{\n{map}}}\n}}\n"
    );
    if chat_background && tokens.contains(&"chat") {
        css.push_str(
            "[role=\"main\"] [data-mw-file-dropzone] {\n  background-color: var(--carrier-chat) !important;\n}\n",
        );
    }
    css
}

/// A theme's CSS as the page gets it: the file, Carrier's mapping for the
/// tokens it sets, and a light- or dark-only wrapper when its header asks.
fn page_theme_css(css: &str) -> String {
    let mode = parse_header(css).ok().and_then(|header| header.mode);
    let mut full = String::with_capacity(css.len() + 2048);
    full.push_str(css);
    full.push_str(&palette_mapping(&defined_tokens(css), true));
    match mode {
        Some(ThemeMode::Light) => format!("@media (prefers-color-scheme: light) {{\n{full}\n}}"),
        Some(ThemeMode::Dark) => format!("@media (prefers-color-scheme: dark) {{\n{full}\n}}"),
        None => full,
    }
}

/// Black or white, whichever reads better on `hex` (WCAG relative luminance).
fn text_on(hex: &str) -> &'static str {
    let channel = |i: usize| {
        let value = f64::from(u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0)) / 255.0;
        if value <= 0.039_28 {
            value / 12.92
        } else {
            ((value + 0.055) / 1.055).powf(2.4)
        }
    };
    let luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
    // Contrast with white beats contrast with black below ~0.18.
    if luminance > 0.179 {
        "#000000"
    } else {
        "#ffffff"
    }
}

fn accent_css(accent: &str) -> String {
    if !is_hex_color(accent) {
        return String::new();
    }
    let accent = accent.to_ascii_lowercase();
    let text = text_on(&accent);
    format!(
        ":root {{\n  --carrier-brand: {accent};\n  --carrier-out: {accent};\n  --carrier-out-text: {text};\n}}\n{}",
        palette_mapping(&["brand", "out", "out-text"], false)
    )
}

/// Font names come from Settings, but quote them defensively anyway.
/// The message font: the messages of the open conversation and the message
/// box, not the chat list, headers or menus.
fn font_css(font: &str) -> String {
    let font = font.trim();
    if font.is_empty() || font.len() > 100 || font.chars().any(char::is_control) {
        return String::new();
    }
    let quoted = font.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        "[role=\"main\"] :is([role=\"log\"], [contenteditable=\"true\"][role=\"textbox\"]) :is(div, span, a, p, li),\n[role=\"main\"] [contenteditable=\"true\"][role=\"textbox\"] {{\n  font-family: \"{quoted}\", -apple-system, \"Segoe UI\", system-ui, sans-serif !important;\n}}\n"
    )
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AppearancePayload {
    theme: String,
    theme_media: &'static str,
    contrast: String,
    contrast_media: &'static str,
    accent: String,
    font: String,
}

const WHEN_NOT_CONTRAST: &str = "not all and (prefers-contrast: more)";
const WHEN_CONTRAST: &str = "(prefers-contrast: more)";

fn appearance_payload(
    theme: Option<&str>,
    high_contrast: Option<&str>,
    s: &Settings,
    system_high_contrast: bool,
) -> AppearancePayload {
    let chosen_contrast = s.color_theme == HIGH_CONTRAST_THEME;
    // The chosen theme and the accent give way to High Contrast while the
    // system asks for more contrast. Linux reports that through the settings
    // portal; the other webviews report it to the page as prefers-contrast.
    let (theme_media, contrast_media) = match (chosen_contrast, system_high_contrast) {
        (true, _) => ("all", "not all"),
        (false, true) => ("not all", "all"),
        (false, false) => (WHEN_NOT_CONTRAST, WHEN_CONTRAST),
    };
    AppearancePayload {
        theme: theme.map(page_theme_css).unwrap_or_default(),
        theme_media,
        contrast: if chosen_contrast {
            String::new()
        } else {
            high_contrast.map(page_theme_css).unwrap_or_default()
        },
        contrast_media,
        accent: accent_css(&s.accent_color),
        font: font_css(&s.message_font),
    }
}

fn appearance_script(payload: &AppearancePayload) -> String {
    // JSON permits U+2028/U+2029 unescaped; older engines did not in strings.
    let literal = serde_json::to_string(payload)
        .expect("appearance serialises as JSON")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    format!(
        r#"(function () {{
  var p = {literal};
  var parent = document.head || document.documentElement;
  // Create each element once and only update it afterwards, so the order
  // (theme, contrast, accent, font, then custom.css) never changes.
  function put(attribute, css, media) {{
    var style = document.querySelector('style[' + attribute + ']');
    if (!style) {{
      style = document.createElement('style');
      style.setAttribute(attribute, '');
      var custom = document.querySelector('style[data-carrier-custom]');
      if (custom && custom.parentNode) custom.parentNode.insertBefore(style, custom);
      else parent.appendChild(style);
    }}
    style.media = media;
    if (style.textContent !== css) style.textContent = css;
  }}
  put('data-carrier-theme', p.theme, p.themeMedia);
  put('data-carrier-high-contrast', p.contrast, p.contrastMedia);
  put('data-carrier-accent', p.accent, p.themeMedia);
  put('data-carrier-font', p.font, 'all');
}})();"#
    )
}

fn system_high_contrast(app: &tauri::AppHandle) -> bool {
    #[cfg(target_os = "linux")]
    {
        app.state::<AppState>()
            .linux_high_contrast
            .load(std::sync::atomic::Ordering::Acquire)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        false
    }
}

/// Put the chosen theme, accent and font into one Messenger window. Fails
/// soft: a broken theme must never block the app.
pub(crate) fn apply_appearance(window: &WebviewWindow, s: &Settings) {
    if !crate::window::is_messenger_window_label(window.label()) {
        return;
    }
    if !window.url().is_ok_and(|url| is_messenger_web_url(&url)) {
        return;
    }
    let app = window.app_handle();
    let theme = theme_css(app, &s.color_theme);
    let high_contrast = theme_css(app, HIGH_CONTRAST_THEME);
    let payload = appearance_payload(
        theme.as_deref(),
        high_contrast.as_deref(),
        s,
        system_high_contrast(app),
    );
    if let Err(error) = window.eval(appearance_script(&payload)) {
        log::warn!("could not apply the theme: {error}");
    }
}

/// Re-apply the appearance to every Messenger window (after a system contrast
/// change, or when a theme file changes).
pub(crate) fn apply_appearance_everywhere(app: &tauri::AppHandle) {
    let settings = app.state::<AppState>().settings.lock().unwrap().clone();
    for (_, window) in app.webview_windows() {
        apply_appearance(&window, &settings);
    }
}

fn info_for(id: &str, css: &str, built_in: bool) -> Option<ThemeInfo> {
    let header = if id == DEFAULT_THEME {
        ThemeHeader {
            name: "Default".into(),
            author: None,
            mode: None,
            preview: None,
        }
    } else {
        parse_header(css).ok()?
    };
    Some(ThemeInfo {
        id: id.to_string(),
        name: header.name,
        author: header.author,
        mode: header.mode,
        preview: header.preview,
        built_in,
    })
}

/// Built-in themes, then imported ones by name.
#[tauri::command]
pub(crate) fn list_themes(app: tauri::AppHandle) -> Vec<ThemeInfo> {
    let mut themes: Vec<ThemeInfo> = BUILT_IN
        .iter()
        .filter_map(|(id, css)| info_for(id, css, true))
        .collect();
    let mut imported = Vec::new();
    if let Ok(entries) =
        themes_dir(&app).and_then(|dir| std::fs::read_dir(dir).map_err(|error| error.to_string()))
    {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("css") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if !is_user_theme_id(id) {
                continue;
            }
            if let Some(info) = read_user_theme(&path).and_then(|css| info_for(id, &css, false)) {
                imported.push(info);
            }
        }
    }
    imported.sort_by_key(|info| info.name.to_lowercase());
    themes.extend(imported);
    themes
}

/// Validate a theme file and copy it into the themes folder. Returns its id.
fn import_theme(dir: &Path, source: &Path) -> Result<String, String> {
    let file_name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "the file".into());
    let fail = |why: String| format!("Couldn't add {file_name}: {why}");
    let metadata = std::fs::metadata(source).map_err(|error| fail(error.to_string()))?;
    if metadata.len() > THEME_MAX_BYTES {
        return Err(fail("it is larger than 2 MB.".into()));
    }
    let css =
        std::fs::read_to_string(source).map_err(|_| fail("it isn't a UTF-8 text file.".into()))?;
    let header = parse_header(&css).map_err(fail)?;
    check_css(&css).map_err(fail)?;
    let stem = source
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    // Adding the same theme again updates it; a different theme whose file
    // name happens to match gets its own id instead of replacing it.
    let base = theme_id_for(&stem);
    let mut id = base.clone();
    for n in 2.. {
        let existing = read_user_theme(&dir.join(format!("{id}.css")));
        match existing.map(|css| parse_header(&css).map(|h| h.name)) {
            Some(Ok(name)) if name != header.name => id = format!("{base}-{n}"),
            _ => break,
        }
    }
    std::fs::create_dir_all(dir).map_err(|error| fail(error.to_string()))?;
    std::fs::write(dir.join(format!("{id}.css")), css).map_err(|error| fail(error.to_string()))?;
    Ok(id)
}

/// "Add theme…": pick a .css file, check it and keep a copy. Returns the new
/// theme's id, or None when the picker was cancelled.
#[tauri::command]
pub(crate) async fn add_theme(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut picker = app
        .dialog()
        .file()
        .set_title("Add theme")
        .add_filter("Theme", &["css"]);
    if let Some(settings) = app.get_webview_window("settings") {
        picker = picker.set_parent(&settings);
    }
    let Some(picked) = picker.blocking_pick_file() else {
        return Ok(None);
    };
    let source = picked.into_path().map_err(|error| error.to_string())?;
    let dir = themes_dir(&app)?;
    let id = import_theme(&dir, &source)?;
    apply_appearance_everywhere(&app);
    Ok(Some(id))
}

#[tauri::command]
pub(crate) fn remove_theme(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if !is_user_theme_id(&id) {
        return Err("Built-in themes can't be removed.".into());
    }
    let path = themes_dir(&app)?.join(format!("{id}.css"));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Couldn't remove the theme: {error}")),
    }
}

#[tauri::command]
pub(crate) fn open_themes_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = themes_dir(&app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("could not create the themes folder: {error}"))?;
    open::that_detached(dir).map_err(|error| error.to_string())
}

/// Installed font families for the Message font list, sorted A to Z.
#[tauri::command]
pub(crate) async fn list_fonts() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        let mut families: Vec<String> = db
            .faces()
            .filter_map(|face| face.families.first().map(|(name, _)| name.clone()))
            // Hidden system families (".SF NS") aren't meant to be picked.
            .filter(|name| !name.starts_with('.') && !name.trim().is_empty())
            .collect();
        families.sort_by_key(|name| name.to_lowercase());
        families.dedup();
        families
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = "/* Carrier theme\n   name: Fjord\n   author: ingrid\n   preview: #242933 #2e3440 #2e3440 #5e81ac #3b4252\n*/\n";

    #[test]
    fn headers_name_the_theme_and_its_card() {
        let header = parse_header(HEADER).unwrap();
        assert_eq!(header.name, "Fjord");
        assert_eq!(header.author.as_deref(), Some("ingrid"));
        assert_eq!(header.mode, None);
        assert_eq!(header.preview.unwrap()[3], "#5e81ac");
    }

    #[test]
    fn other_apps_headers_and_modes_are_accepted() {
        let header = parse_header("\u{feff}/* fMess theme\n name: Night\n mode: dark\n*/").unwrap();
        assert_eq!(header.name, "Night");
        assert_eq!(header.mode, Some(ThemeMode::Dark));
    }

    #[test]
    fn broken_headers_say_what_is_wrong() {
        assert!(
            parse_header("body { color: red }")
                .unwrap_err()
                .contains("theme header")
        );
        assert!(
            parse_header("/* Carrier theme\n author: x */")
                .unwrap_err()
                .contains("name")
        );
        assert!(
            parse_header("/* Carrier theme\n name: x\n preview: #fff #000 */")
                .unwrap_err()
                .contains("five colors")
        );
        assert!(
            parse_header("/* Carrier theme\n name: x\n mode: sepia */")
                .unwrap_err()
                .contains("light or dark")
        );
    }

    #[test]
    fn built_in_themes_have_headers_and_pass_the_checks() {
        for (id, css) in BUILT_IN.iter().filter(|(id, _)| *id != DEFAULT_THEME) {
            let header = parse_header(css).unwrap_or_else(|e| panic!("{id}: {e}"));
            assert!(
                header.preview.is_some(),
                "{id} needs a preview for its card"
            );
            check_css(css).unwrap_or_else(|e| panic!("{id}: {e}"));
        }
    }

    #[test]
    fn data_urls_are_allowed() {
        check_css(&format!(
            "{HEADER}@font-face {{ font-family: x; src: url(data:font/woff2;base64,AAAA); }}\n\
             a {{ background: url(\"data:image/png;base64,AAAA\") }}"
        ))
        .unwrap();
    }

    #[test]
    fn anything_that_loads_or_sends_is_rejected_with_its_line() {
        let cases = [
            ("@import url(theme2.css);", "@import"),
            (
                "a { background: url(https://example.com/x.png) }",
                "data: URLs",
            ),
            (
                "a { background: url(\"//example.com/x.png\") }",
                "data: URLs",
            ),
            (
                "a { background: \\75 rl(https://example.com/x.png) }",
                "data: URLs",
            ),
            ("a { background: image-set(\"x.png\" 1x) }", "image-set"),
            ("@media screen { a { b: url(http://x) } }", "data: URLs"),
            (
                "@font-face { src: src(\"https://x/font.woff\") }",
                "data: URLs",
            ),
        ];
        for (css, why) in cases {
            let error = check_css(&format!("{HEADER}\n{css}")).unwrap_err();
            assert!(error.contains(why), "{css}: {error}");
            assert!(error.starts_with("line 7"), "{css}: {error}");
        }
    }

    #[test]
    fn imported_files_get_safe_ids_that_never_shadow_built_ins() {
        assert_eq!(theme_id_for("My Theme (2)"), "my-theme-2");
        assert_eq!(theme_id_for("Graphite"), "graphite-imported");
        assert_eq!(theme_id_for("???"), "theme");
        assert!(is_user_theme_id("my-theme-2"));
        assert!(!is_user_theme_id("graphite"));
        assert!(!is_user_theme_id("../settings"));
    }

    #[test]
    fn importing_copies_valid_themes_and_explains_invalid_ones() {
        let dir = std::env::temp_dir().join(format!("carrier-themes-{}", std::process::id()));
        let source = std::env::temp_dir().join(format!("Fjord {}.css", std::process::id()));
        std::fs::write(
            &source,
            format!("{HEADER}:root {{ --carrier-out: #5e81ac; }}"),
        )
        .unwrap();
        let id = import_theme(&dir, &source).unwrap();
        assert!(dir.join(format!("{id}.css")).is_file());

        // Re-adding the same theme updates it; another theme with the same
        // file name gets its own id.
        assert_eq!(import_theme(&dir, &source).unwrap(), id);
        std::fs::write(&source, HEADER.replace("Fjord", "Fjell")).unwrap();
        assert_eq!(import_theme(&dir, &source).unwrap(), format!("{id}-2"));

        std::fs::write(&source, format!("{HEADER}@import url(x.css);")).unwrap();
        let error = import_theme(&dir, &source).unwrap_err();
        assert!(error.starts_with("Couldn't add Fjord"), "{error}");
        assert!(error.contains("@import"), "{error}");
        std::fs::remove_file(source).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_the_tokens_a_theme_sets_are_mapped() {
        let css = page_theme_css(&format!("{HEADER}:root {{ --carrier-out : #5e81ac; }}"));
        assert!(
            css.contains("--chat-outgoing-message-bubble-background-color: var(--carrier-out)")
        );
        assert!(css.contains(".__fb-dark-mode"));
        assert!(
            !css.contains("--accent:"),
            "unset tokens must not override Messenger"
        );
        assert!(!css.contains("data-mw-file-dropzone"));
        let graphite = page_theme_css(include_str!("../themes/graphite.css"));
        assert!(graphite.contains("background-color: var(--carrier-chat)"));
    }

    #[test]
    fn single_mode_themes_only_apply_in_their_mode() {
        let css = page_theme_css(include_str!("../themes/oled-black.css"));
        assert!(css.starts_with("@media (prefers-color-scheme: dark)"));
    }

    #[test]
    fn high_contrast_takes_over_while_the_system_asks_for_it() {
        let mut s = Settings {
            color_theme: "warm".into(),
            ..Settings::default()
        };
        let page = appearance_payload(Some("w"), Some("hc"), &s, false);
        assert_eq!(page.theme_media, WHEN_NOT_CONTRAST);
        assert_eq!(page.contrast_media, WHEN_CONTRAST);
        assert!(!page.contrast.is_empty());

        let portal = appearance_payload(Some("w"), Some("hc"), &s, true);
        assert_eq!(
            (portal.theme_media, portal.contrast_media),
            ("not all", "all")
        );

        s.color_theme = HIGH_CONTRAST_THEME.into();
        let chosen = appearance_payload(Some("hc"), Some("hc"), &s, false);
        assert_eq!(chosen.theme_media, "all");
        assert!(chosen.contrast.is_empty());
    }

    #[test]
    fn accent_and_font_are_validated_before_reaching_the_page() {
        assert!(accent_css("").is_empty());
        assert!(accent_css("red; } body { x").is_empty());
        // Message text takes whichever of white or black contrasts more.
        let accent = accent_css("#0866FF");
        assert!(accent.contains("--carrier-out: #0866ff"));
        assert!(accent.contains("--carrier-out-text: #ffffff"));
        assert!(accent_css("#0f9d9a").contains("--carrier-out-text: #000000"));

        assert!(font_css("").is_empty());
        assert!(font_css("Bad\nFont").is_empty());
        assert!(font_css("A \"quoted\" font").contains(r#""A \"quoted\" font""#));
    }

    #[test]
    fn deeply_nested_css_is_refused_not_a_stack_overflow() {
        let error = check_css(&"(".repeat(1_000_000)).unwrap_err();
        assert!(error.contains("nested too deeply"), "{error}");
        assert!(
            check_css(&format!(
                "a {{ width: {}1px{} }}",
                "calc(".repeat(8),
                ")".repeat(8)
            ))
            .is_ok()
        );
    }

    #[test]
    fn the_script_keeps_style_order_stable_and_escapes_css() {
        let payload = AppearancePayload {
            theme: "a::after { content: \"</style>\u{2028}\" }".into(),
            theme_media: "all",
            contrast: String::new(),
            contrast_media: "not all",
            accent: String::new(),
            font: String::new(),
        };
        let script = appearance_script(&payload);
        assert!(script.contains("insertBefore(style, custom)"));
        assert!(script.contains("\\u2028"));
        assert!(!script.contains("innerHTML"));
    }
}
