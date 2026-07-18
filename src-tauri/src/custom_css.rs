//! Best-effort user stylesheet support.
//!
//! `custom.css` lives beside Carrier's settings file. It is read afresh after
//! each Messenger page load so editing it and pressing Reload is sufficient;
//! missing, unreadable, non-UTF-8, or unreasonably large files are ignored.

use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::{Manager, WebviewWindow};

use crate::url_rules::is_messenger_web_url;

const CUSTOM_CSS_FILE: &str = "custom.css";
const CUSTOM_CSS_MAX_BYTES: u64 = 512 * 1024;
const CUSTOM_CSS_TEMPLATE: &str = r#"/*
 * Carrier custom CSS
 *
 * This advanced customization is best-effort: Facebook can change Messenger's
 * markup at any time. Save this file, then reload Carrier (Ctrl/Cmd+R).
 */

"#;

pub(crate) fn custom_css_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(CUSTOM_CSS_FILE))
        .map_err(|error| format!("could not locate Carrier's config folder: {error}"))
}

fn ensure_custom_css_at(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "custom CSS path has no parent folder".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("could not create the config folder: {error}"))?;
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => file
            .write_all(CUSTOM_CSS_TEMPLATE.as_bytes())
            .map_err(|error| format!("could not create custom.css: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(format!("could not create custom.css: {error}")),
    }
}

pub(crate) fn ensure_custom_css(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = custom_css_path(app)?;
    ensure_custom_css_at(&path)?;
    Ok(path)
}

fn read_custom_css_from_path(path: &Path) -> Option<String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            log::warn!(
                "could not inspect custom CSS file {}: {error}",
                path.display()
            );
            return None;
        }
    };
    if !metadata.is_file() {
        log::warn!("custom CSS path is not a regular file: {}", path.display());
        return None;
    }
    if metadata.len() > CUSTOM_CSS_MAX_BYTES {
        log::warn!(
            "custom CSS file is too large ({} bytes; limit is {CUSTOM_CSS_MAX_BYTES})",
            metadata.len()
        );
        return None;
    }
    match std::fs::read_to_string(path) {
        Ok(css) if !css.trim().is_empty() => Some(css),
        Ok(_) => None,
        Err(error) => {
            log::warn!("could not read custom CSS file {}: {error}", path.display());
            None
        }
    }
}

fn custom_css_script(css: &str) -> String {
    // JSON permits U+2028/U+2029 unescaped, while older JavaScript engines
    // treated them as literal line terminators inside source strings.
    let literal = serde_json::to_string(css)
        .expect("CSS serialises as a JSON string")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    format!(
        r#"(function () {{
  var css = {literal};
  var style = document.querySelector('style[data-carrier-custom]');
  if (!style) {{
    style = document.createElement('style');
    style.setAttribute('data-carrier-custom', '');
    (document.head || document.documentElement).appendChild(style);
  }}
  style.textContent = css;
}})();"#
    )
}

/// Read and inject the latest custom stylesheet after a Messenger page load.
/// This deliberately fails soft: customization must never block the app.
pub(crate) fn apply_custom_css(window: &WebviewWindow, url: &url::Url) {
    if !is_messenger_web_url(url) {
        return;
    }
    let Ok(path) = custom_css_path(window.app_handle()) else {
        return;
    };
    let Some(css) = read_custom_css_from_path(&path) else {
        return;
    };
    if let Err(error) = window.eval(custom_css_script(&css)) {
        log::warn!("could not inject custom CSS: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_SEQ: AtomicUsize = AtomicUsize::new(0);

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "carrier-custom-css-{}-{}-{name}",
            std::process::id(),
            TEST_SEQ.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn missing_empty_invalid_and_oversized_stylesheets_fail_soft() {
        let missing = test_path("missing.css");
        assert_eq!(read_custom_css_from_path(&missing), None);

        let empty = test_path("empty.css");
        std::fs::write(&empty, " \n\t").unwrap();
        assert_eq!(read_custom_css_from_path(&empty), None);
        std::fs::remove_file(empty).unwrap();

        let invalid = test_path("invalid.css");
        std::fs::write(&invalid, [0xff, 0xfe]).unwrap();
        assert_eq!(read_custom_css_from_path(&invalid), None);
        std::fs::remove_file(invalid).unwrap();

        let oversized = test_path("oversized.css");
        let file = std::fs::File::create(&oversized).unwrap();
        file.set_len(CUSTOM_CSS_MAX_BYTES + 1).unwrap();
        assert_eq!(read_custom_css_from_path(&oversized), None);
        std::fs::remove_file(oversized).unwrap();
    }

    #[test]
    fn existing_custom_css_is_never_overwritten() {
        let directory = test_path("directory");
        let path = directory.join(CUSTOM_CSS_FILE);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(&path, "body { color: rebeccapurple; }").unwrap();

        ensure_custom_css_at(&path).unwrap();
        assert_eq!(
            read_custom_css_from_path(&path).as_deref(),
            Some("body { color: rebeccapurple; }")
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn new_custom_css_has_safe_helpful_template() {
        let directory = test_path("directory");
        let path = directory.join(CUSTOM_CSS_FILE);
        ensure_custom_css_at(&path).unwrap();
        let css = std::fs::read_to_string(&path).unwrap();
        assert!(css.contains("best-effort"));
        assert!(css.contains("Ctrl/Cmd+R"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn injection_uses_text_content_and_a_json_string_literal() {
        let script = custom_css_script("body::after { content: \"</style>\\n\u{2028}\u{2029}\"; }");
        assert!(script.contains("style.textContent = css"));
        assert!(script.contains("data-carrier-custom"));
        assert!(script.contains(r#"\"</style>\\n"#));
        assert!(script.contains("\\u2028"));
        assert!(script.contains("\\u2029"));
        assert!(!script.contains("innerHTML"));
    }
}
