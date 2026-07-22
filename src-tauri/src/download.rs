//! Download safety for `on_download`: a strict media allowlist, filename
//! sanitising, the executable-extension blocklist, and a short-lived trusted
//! mapping used to reveal completed downloads in the platform file manager.

use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use url::Url;

use crate::url_rules::percent_decode;

const MAX_RECENT_DOWNLOADS: usize = 32;
const RECENT_DOWNLOAD_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_DOWNLOAD_URL_LEN: usize = 4096;

struct RecentDownload {
    url: String,
    path: PathBuf,
    at: Instant,
}

#[derive(Default)]
struct RecentDownloads {
    entries: VecDeque<RecentDownload>,
}

impl RecentDownloads {
    fn prune(&mut self, now: Instant) {
        while self
            .entries
            .front()
            .is_some_and(|entry| now.saturating_duration_since(entry.at) > RECENT_DOWNLOAD_TTL)
        {
            self.entries.pop_front();
        }
    }

    fn remember_at(&mut self, url: &str, path: PathBuf, now: Instant) {
        if url.is_empty() || url.len() > MAX_DOWNLOAD_URL_LEN {
            return;
        }
        self.prune(now);
        self.entries.retain(|entry| entry.url != url);
        self.entries.push_back(RecentDownload {
            url: url.to_string(),
            path,
            at: now,
        });
        while self.entries.len() > MAX_RECENT_DOWNLOADS {
            self.entries.pop_front();
        }
    }

    fn lookup_at(&mut self, url: &str, now: Instant) -> Option<PathBuf> {
        if url.is_empty() || url.len() > MAX_DOWNLOAD_URL_LEN {
            return None;
        }
        self.prune(now);
        self.entries
            .iter()
            .find(|entry| entry.url == url)
            .map(|entry| entry.path.clone())
    }

    fn forget(&mut self, url: &str) {
        self.entries.retain(|entry| entry.url != url);
    }
}

static RECENT_DOWNLOADS: OnceLock<Mutex<RecentDownloads>> = OnceLock::new();

fn recent_downloads() -> &'static Mutex<RecentDownloads> {
    RECENT_DOWNLOADS.get_or_init(|| Mutex::new(RecentDownloads::default()))
}

/// Remember a destination chosen by the trusted WebView download hook. The
/// remote page receives only the URL key and can never supply a filesystem path.
pub(crate) fn remember_download(url: &Url, path: PathBuf) {
    recent_downloads()
        .lock()
        .unwrap()
        .remember_at(url.as_str(), path, Instant::now());
}

pub(crate) fn forget_download(url: &Url) {
    recent_downloads().lock().unwrap().forget(url.as_str());
}

/// Non-consuming lookup so repeated clicks on the toast action keep working.
pub(crate) fn lookup_download(url: &str) -> Option<PathBuf> {
    recent_downloads()
        .lock()
        .unwrap()
        .lookup_at(url, Instant::now())
}

/// Only the commands that fetch a URL (copy/download image & video) are exposed
/// to the remote page, so restrict them to Facebook/Messenger media hosts over
/// HTTPS. This is a strict allowlist — far stronger than IP filtering, since an
/// attacker can't point `fbcdn.net` at a private/loopback address via DNS
/// rebinding to reach the local network (SSRF).
fn is_fetchable_media_host(url: &Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.strip_prefix("www.").unwrap_or(host);
    const HOSTS: &[&str] = &["fbcdn.net", "fbsbx.com", "facebook.com", "messenger.com"];
    HOSTS
        .iter()
        .any(|s| host == *s || host.ends_with(&format!(".{s}")))
}

pub(crate) fn downloads_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("USERPROFILE").map(std::path::PathBuf::from);
    #[cfg(not(target_os = "windows"))]
    let base = std::env::var_os("HOME").map(std::path::PathBuf::from);
    base.map(|b| b.join("Downloads"))
}

/// Strip path separators and shell-unsafe characters so a page-supplied name
/// can't escape the Downloads folder; falls back to "download".
pub(crate) fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if matches!(
                c,
                '/' | '\\' | '\0' | ':' | '<' | '>' | '"' | '|' | '?' | '*'
            ) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.');
    if cleaned.is_empty() {
        "download".into()
    } else {
        cleaned.to_string()
    }
}

/// Best-effort filename from a URL: last path segment, percent-decoded, query
/// stripped. Keeps the URL's own extension (so a video isn't saved as `.png`).
pub(crate) fn filename_from_url(url: &Url) -> String {
    let raw = url
        .path_segments()
        .and_then(|mut s| s.next_back())
        .filter(|s| !s.is_empty())
        .unwrap_or("download");
    sanitize_filename(&percent_decode(raw))
}

fn is_media_filename(name: &str) -> bool {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    matches!(
        ext.as_str(),
        "jpg"
            | "jpeg"
            | "png"
            | "gif"
            | "webp"
            | "heic"
            | "heif"
            | "bmp"
            | "tif"
            | "tiff"
            | "mp4"
            | "m4v"
            | "mov"
            | "webm"
            | "avi"
            | "mkv"
            | "3gp"
            | "mp3"
            | "m4a"
            | "aac"
            | "wav"
            | "ogg"
            | "opus"
            | "flac"
    )
}

fn is_media_data_url(url: &Url) -> bool {
    let Some(rest) = url.as_str().strip_prefix("data:") else {
        return false;
    };
    let header = rest.split_once(',').map(|(h, _)| h).unwrap_or(rest);
    let media_type = header.split_once(';').map(|(m, _)| m).unwrap_or(header);
    let media_type = media_type.to_ascii_lowercase();
    media_type.starts_with("image/")
        || media_type.starts_with("video/")
        || media_type.starts_with("audio/")
}

pub(crate) fn is_allowed_download(url: &Url, name: &str) -> bool {
    match url.scheme() {
        "blob" => is_media_filename(name),
        "data" => is_media_data_url(url) && is_media_filename(name),
        _ => is_fetchable_media_host(url) && is_media_filename(name),
    }
}

/// True for filenames whose extension is a directly-executable type, so a remote
/// page can't quietly drop malware in Downloads. Media, documents and archives
/// (the things you'd actually save from Messenger) are all allowed.
pub(crate) fn is_unsafe_download(name: &str) -> bool {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    matches!(
        ext.as_str(),
        "exe"
            | "msi"
            | "bat"
            | "cmd"
            | "com"
            | "scr"
            | "ps1"
            | "vbs"
            | "vbe"
            | "js"
            | "jse"
            | "wsf"
            | "wsh"
            | "hta"
            | "dmg"
            | "pkg"
            | "app"
            | "command"
            | "scpt"
            | "sh"
            | "bash"
            | "zsh"
            | "run"
            | "bin"
            | "jar"
            | "jnlp"
            | "deb"
            | "rpm"
            | "appimage"
    )
}

/// Avoid clobbering an existing file by appending " (n)".
pub(crate) fn unique_path(p: PathBuf) -> PathBuf {
    if !p.exists() {
        return p;
    }
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("download")
        .to_string();
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let parent = p.parent().map(|x| x.to_path_buf()).unwrap_or_default();
    for n in 1..10000 {
        let cand = parent.join(format!("{stem} ({n}){ext}"));
        if !cand.exists() {
            return cand;
        }
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn fetchable_media_host_is_an_https_fb_allowlist() {
        assert!(is_fetchable_media_host(&u(
            "https://scontent.fbcdn.net/v/x.jpg"
        )));
        assert!(is_fetchable_media_host(&u(
            "https://video.xx.fbcdn.net/x.mp4"
        )));
        assert!(is_fetchable_media_host(&u("https://www.facebook.com/x")));
        // wrong scheme, arbitrary hosts, and IPs are all rejected
        assert!(!is_fetchable_media_host(&u(
            "http://scontent.fbcdn.net/x.jpg"
        ))); // not https
        assert!(!is_fetchable_media_host(&u("https://example.com/x.jpg")));
        assert!(!is_fetchable_media_host(&u("https://evil-fbcdn.net/x"))); // suffix trick
        assert!(!is_fetchable_media_host(&u("https://127.0.0.1/x")));
        assert!(!is_fetchable_media_host(&u("https://localhost/x")));
    }

    #[test]
    fn sanitize_blocks_traversal_and_windows_drive() {
        let a = sanitize_filename("../../etc/passwd");
        assert!(!a.contains('/') && !a.contains('\\'));
        let b = sanitize_filename("C:evil.exe");
        assert!(!b.contains(':'));
        assert_eq!(sanitize_filename("   "), "download");
        assert_eq!(sanitize_filename("..."), "download");
        assert_eq!(sanitize_filename("photo.png"), "photo.png");
    }

    #[test]
    fn filename_keeps_real_extension() {
        assert_eq!(
            filename_from_url(&u("https://x.com/a/video.mp4?dl=1")),
            "video.mp4"
        );
        assert_eq!(filename_from_url(&u("https://x.com/")), "download");
    }

    #[test]
    fn media_filename_accepts_media_extensions_only() {
        assert!(is_media_filename("photo.jpg"));
        assert!(is_media_filename("clip.MP4"));
        assert!(is_media_filename("voice.opus"));
        assert!(!is_media_filename("document.pdf"));
        assert!(!is_media_filename("archive.zip"));
        assert!(!is_media_filename("download"));
    }

    #[test]
    fn media_data_url_requires_media_mime_type() {
        assert!(is_media_data_url(&u("data:image/png;base64,iVBORw0KGgo=")));
        assert!(is_media_data_url(&u("data:video/mp4;base64,AAAA")));
        assert!(!is_media_data_url(&u("data:text/html,<script>1</script>")));
        assert!(!is_media_data_url(&u("data:application/pdf;base64,AAAA")));
    }

    #[test]
    fn allowed_download_requires_media_for_generated_urls() {
        assert!(is_allowed_download(
            &u("blob:https://www.facebook.com/123"),
            "photo.png"
        ));
        assert!(!is_allowed_download(
            &u("blob:https://www.facebook.com/123"),
            "document.pdf"
        ));
        assert!(is_allowed_download(
            &u("data:image/png;base64,iVBORw0KGgo="),
            "photo.png"
        ));
        assert!(!is_allowed_download(
            &u("data:text/html,<script>1</script>"),
            "photo.png"
        ));
        assert!(!is_allowed_download(
            &u("data:image/png;base64,iVBORw0KGgo="),
            "document.pdf"
        ));
    }

    #[test]
    fn allowed_download_requires_media_host_and_name_for_remote_urls() {
        assert!(is_allowed_download(
            &u("https://scontent.fbcdn.net/v/photo.jpg"),
            "photo.jpg"
        ));
        assert!(!is_allowed_download(
            &u("https://scontent.fbcdn.net/v/document.pdf"),
            "document.pdf"
        ));
        assert!(!is_allowed_download(
            &u("https://example.com/photo.jpg"),
            "photo.jpg"
        ));
    }

    #[test]
    fn unique_path_preserves_stem_and_extension() {
        let dir = std::env::temp_dir().join(format!(
            "carrier-unique-path-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let first = dir.join("Messenger.jpeg");
        let second = dir.join("Messenger (1).jpeg");
        let third = dir.join("Messenger (2).jpeg");
        std::fs::write(&first, b"").unwrap();
        assert_eq!(unique_path(first.clone()), second);
        std::fs::write(&second, b"").unwrap();
        assert_eq!(unique_path(first), third);

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn recent_downloads_are_capped_and_lookup_is_non_consuming() {
        let now = Instant::now();
        let mut downloads = RecentDownloads::default();
        for n in 0..=MAX_RECENT_DOWNLOADS {
            downloads.remember_at(
                &format!("blob:carrier/{n}"),
                PathBuf::from(format!("download-{n}.png")),
                now,
            );
        }

        assert_eq!(downloads.entries.len(), MAX_RECENT_DOWNLOADS);
        assert_eq!(downloads.lookup_at("blob:carrier/0", now), None);
        let newest = PathBuf::from(format!("download-{MAX_RECENT_DOWNLOADS}.png"));
        assert_eq!(
            downloads.lookup_at(&format!("blob:carrier/{MAX_RECENT_DOWNLOADS}"), now),
            Some(newest.clone())
        );
        assert_eq!(
            downloads.lookup_at(&format!("blob:carrier/{MAX_RECENT_DOWNLOADS}"), now),
            Some(newest)
        );
    }

    #[test]
    fn recent_downloads_expire_and_failed_entries_can_be_forgotten() {
        let now = Instant::now();
        let mut downloads = RecentDownloads::default();
        downloads.remember_at("blob:carrier/expired", PathBuf::from("expired.png"), now);
        assert_eq!(
            downloads.lookup_at(
                "blob:carrier/expired",
                now + RECENT_DOWNLOAD_TTL + Duration::from_millis(1)
            ),
            None
        );

        downloads.remember_at("blob:carrier/failed", PathBuf::from("failed.png"), now);
        downloads.forget("blob:carrier/failed");
        assert_eq!(downloads.lookup_at("blob:carrier/failed", now), None);
    }

    #[test]
    fn recent_downloads_reject_oversized_url_keys() {
        let now = Instant::now();
        let mut downloads = RecentDownloads::default();
        let oversized = "x".repeat(MAX_DOWNLOAD_URL_LEN + 1);
        downloads.remember_at(&oversized, PathBuf::from("ignored.png"), now);
        assert!(downloads.entries.is_empty());
        assert_eq!(downloads.lookup_at(&oversized, now), None);
    }

    // -----------------------------------------------------------------------
    // is_unsafe_download  (new in this PR)
    // -----------------------------------------------------------------------

    #[test]
    fn unsafe_download_blocks_all_listed_executable_extensions() {
        // Every extension in the explicit blocklist must be rejected.
        let blocked = [
            "malware.exe",
            "setup.msi",
            "run.bat",
            "run.cmd",
            "trojan.com",
            "screen.scr",
            "evil.ps1",
            "script.vbs",
            "script.vbe",
            "payload.js",
            "payload.jse",
            "config.wsf",
            "config.wsh",
            "app.hta",
            "installer.dmg",
            "package.pkg",
            "bundle.app",
            "run.command",
            "autorun.scpt",
            "start.sh",
            "start.bash",
            "start.zsh",
            "start.run",
            "payload.bin",
            "library.jar",
            "webstart.jnlp",
            "package.deb",
            "package.rpm",
            "portable.appimage",
        ];
        for name in &blocked {
            assert!(
                is_unsafe_download(name),
                "expected {name} to be blocked as unsafe"
            );
        }
    }

    #[test]
    fn unsafe_download_allows_safe_media_and_document_extensions() {
        // Common file types users legitimately save from Messenger must be allowed.
        let allowed = [
            "photo.jpg",
            "image.jpeg",
            "picture.png",
            "animation.gif",
            "photo.webp",
            "clip.mp4",
            "video.mov",
            "video.avi",
            "audio.mp3",
            "audio.wav",
            "audio.ogg",
            "document.pdf",
            "spreadsheet.xlsx",
            "presentation.pptx",
            "archive.zip",
            "archive.tar",
            "archive.gz",
            "archive.7z",
            "text.txt",
            "data.csv",
            "data.json",
        ];
        for name in &allowed {
            assert!(
                !is_unsafe_download(name),
                "expected {name} to be allowed (safe extension)"
            );
        }
    }

    #[test]
    fn unsafe_download_is_case_insensitive() {
        // Extensions should be compared case-insensitively.
        assert!(is_unsafe_download("VIRUS.EXE"));
        assert!(is_unsafe_download("Script.Ps1"));
        assert!(is_unsafe_download("Payload.SH"));
        assert!(!is_unsafe_download("Photo.PNG"));
        assert!(!is_unsafe_download("Clip.MP4"));
    }

    #[test]
    fn unsafe_download_no_extension_is_safe() {
        // A filename with no extension at all is allowed (not executable by extension).
        assert!(!is_unsafe_download("filenoext"));
        assert!(!is_unsafe_download("download"));
    }

    #[test]
    fn unsafe_download_dotfile_edge_cases() {
        // A dotfile whose name is exactly the "extension" portion — rsplit_once('.') returns
        // ("", "sh") for ".sh", so ".sh" is blocked; ".gitignore" has ext "gitignore" (safe).
        assert!(is_unsafe_download(".sh"));
        assert!(!is_unsafe_download(".gitignore"));
        // Multiple dots: only the last segment is checked.
        assert!(is_unsafe_download("setup.tar.exe"));
        assert!(!is_unsafe_download("setup.exe.zip"));
    }
}
