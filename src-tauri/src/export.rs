//! File ▸ Export Conversation as HTML/JSON… (Ref #371). The page reads the
//! conversation from Messenger's local database and sends structured rows
//! only. Facebook's scripts share that page, so its output is untrusted: this
//! side validates the model strictly, renders the HTML (every value escaped,
//! a CSP that forbids scripts and network loads) or the JSON itself, asks
//! where to save it, and writes the file. Nothing is uploaded.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{Listener, Manager};
use tauri_plugin_dialog::DialogExt;
use time::{OffsetDateTime, UtcOffset};

use crate::download::{
    complete_download, downloads_dir, is_unsafe_download, remember_download, sanitize_filename,
};
use crate::settings::AppState;
use crate::{NativeResultPhase, SignedAction, result_signature, signed_action_window};

pub(crate) const EVENT: &str = "carrier:export-conversation";
/// The request carries the whole conversation model. The page refuses models
/// over 32 MiB before JSON-escaping them into the signed message.
pub(crate) const MESSAGE_MAX: usize = 64 * 1024 * 1024;
const REVEAL_PREFIX: &str = "carrier-export:";

const FORMAT_NAME: &str = "carrier-conversation-export";
const FORMAT_VERSION: u32 = 1;
const MESSAGE_LIMIT: usize = 50_000;
const PARTICIPANT_LIMIT: usize = 1_000;
const REACTION_LIMIT: usize = 1_000;
const ATTACHMENT_LIMIT: usize = 100;
const MISSING_LIMIT: usize = 3;

/// A list that refuses to grow past `N` while it is parsed, so an oversized
/// array is rejected before it is allocated rather than after.
fn bounded<'de, D, T, const N: usize>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    struct Bounded<T, const N: usize>(std::marker::PhantomData<T>);
    impl<'de, T: Deserialize<'de>, const N: usize> serde::de::Visitor<'de> for Bounded<T, N> {
        type Value = Vec<T>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            write!(f, "a list of at most {N} items")
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Vec<T>, A::Error> {
            let mut out = Vec::with_capacity(seq.size_hint().unwrap_or(0).min(N).min(256));
            while let Some(item) = seq.next_element()? {
                if out.len() == N {
                    return Err(serde::de::Error::custom(format!("more than {N} items")));
                }
                out.push(item);
            }
            Ok(out)
        }
    }
    deserializer.deserialize_seq(Bounded::<T, N>(std::marker::PhantomData))
}
const ID_MAX: usize = 32;
const MESSAGE_ID_MAX: usize = 512;
const NAME_MAX: usize = 1024;
const TEXT_MAX: usize = 128 * 1024;
const SHORT_MAX: usize = 255;
const DETAIL_MAX: usize = 4096;
/// 9999-12-31T23:59:59.999Z, the last instant `time` represents by default.
const TIMESTAMP_MAX: i64 = 253_402_300_799_999;
const OFFSET_MAX_MINUTES: i32 = 24 * 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Format {
    Html,
    Json,
}

impl Format {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "html" => Some(Self::Html),
            "json" => Some(Self::Json),
            _ => None,
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Html => "html",
            Self::Json => "json",
        }
    }

    fn filter_name(self) -> &'static str {
        match self {
            Self::Html => "Web page",
            Self::Json => "JSON",
        }
    }

    /// The page call the native menu item makes.
    pub(crate) fn page_script(self) -> String {
        format!(
            "window.__carrierExportConversation && window.__carrierExportConversation('{}')",
            self.extension()
        )
    }
}

/* ------------------------------- Model -------------------------------- */

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum History {
    Complete,
    Partial,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum MissingPart {
    Participants,
    Reactions,
    Attachments,
}

/// What the page sends. Every field is required and nothing else is accepted.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PageExport {
    conversation: Conversation,
    history: History,
    truncated: bool,
    #[serde(deserialize_with = "bounded::<_, _, MISSING_LIMIT>")]
    missing: Vec<MissingPart>,
    #[serde(deserialize_with = "bounded::<_, _, MESSAGE_LIMIT>")]
    messages: Vec<Message>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Conversation {
    id: String,
    title: String,
    is_group: bool,
    #[serde(deserialize_with = "bounded::<_, _, PARTICIPANT_LIMIT>")]
    participants: Vec<Person>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Person {
    id: String,
    name: String,
    nickname: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Message {
    id: String,
    sender_id: Option<String>,
    sender_name: Option<String>,
    /// Filled natively from `timestamp_ms`.
    #[serde(skip_deserializing)]
    timestamp: String,
    timestamp_ms: i64,
    /// Only used to render local dates; not part of the saved JSON.
    #[serde(skip_serializing)]
    utc_offset_minutes: i32,
    text: Option<String>,
    system: bool,
    unsent: bool,
    unreadable: bool,
    forwarded: bool,
    edited: bool,
    sticker: bool,
    call: Option<Call>,
    reply_to: Option<Reply>,
    #[serde(deserialize_with = "bounded::<_, _, REACTION_LIMIT>")]
    reactions: Vec<Reaction>,
    #[serde(deserialize_with = "bounded::<_, _, ATTACHMENT_LIMIT>")]
    attachments: Vec<Attachment>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum CallType {
    Audio,
    Video,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum CallOutcome {
    Missed,
    Ended,
    Started,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Call {
    #[serde(rename = "type")]
    kind: CallType,
    outcome: Option<CallOutcome>,
    duration_sec: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Reply {
    message_id: String,
    sender_id: Option<String>,
    sender_name: Option<String>,
    text: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Reaction {
    actor_id: Option<String>,
    actor_name: Option<String>,
    reaction: String,
    timestamp_ms: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum AttachmentKind {
    Image,
    Video,
    Audio,
    File,
    Link,
    Other,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Attachment {
    kind: AttachmentKind,
    filename: Option<String>,
    title: Option<String>,
    mime_type: Option<String>,
}

/// The saved, versioned JSON document. The HTML is rendered from the same value.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportDocument {
    format: &'static str,
    version: u32,
    exported_at: String,
    conversation: Conversation,
    history: History,
    notes: Vec<String>,
    messages: Vec<Message>,
}

/* ----------------------------- Validation ----------------------------- */

fn digits(value: &str) -> bool {
    !value.is_empty() && value.len() <= ID_MAX && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn optional_digits(value: &Option<String>) -> bool {
    value.as_deref().is_none_or(digits)
}

fn within(value: &str, max: usize) -> bool {
    value.len() <= max
}

fn optional_within(value: &Option<String>, max: usize) -> bool {
    value.as_deref().is_none_or(|value| within(value, max))
}

fn timestamp_ok(value: i64) -> bool {
    (0..=TIMESTAMP_MAX).contains(&value)
}

fn validate_message(message: &Message) -> bool {
    !message.id.is_empty()
        && within(&message.id, MESSAGE_ID_MAX)
        && optional_digits(&message.sender_id)
        && optional_within(&message.sender_name, NAME_MAX)
        && timestamp_ok(message.timestamp_ms)
        && (-OFFSET_MAX_MINUTES..=OFFSET_MAX_MINUTES).contains(&message.utc_offset_minutes)
        // The local date must exist: near the end of the timestamp range an
        // offset can push it past what a date can hold.
        && Moment::new(message.timestamp_ms, message.utc_offset_minutes).is_some()
        && optional_within(&message.text, TEXT_MAX)
        // Unreadable means there is no text, never ciphertext passed off as text.
        && !(message.unreadable && message.text.is_some())
        && message.reply_to.as_ref().is_none_or(|reply| {
            !reply.message_id.is_empty()
                && within(&reply.message_id, MESSAGE_ID_MAX)
                && optional_digits(&reply.sender_id)
                && optional_within(&reply.sender_name, NAME_MAX)
                && optional_within(&reply.text, TEXT_MAX)
        })
        && message.reactions.len() <= REACTION_LIMIT
        && message.reactions.iter().all(|reaction| {
            optional_digits(&reaction.actor_id)
                && optional_within(&reaction.actor_name, NAME_MAX)
                && !reaction.reaction.is_empty()
                && within(&reaction.reaction, SHORT_MAX)
                && reaction.timestamp_ms.is_none_or(timestamp_ok)
        })
        && message.attachments.len() <= ATTACHMENT_LIMIT
        && message.attachments.iter().all(|attachment| {
            optional_within(&attachment.filename, DETAIL_MAX)
                && optional_within(&attachment.title, DETAIL_MAX)
                && optional_within(&attachment.mime_type, SHORT_MAX)
        })
}

fn validate(export: &PageExport) -> Result<(), &'static str> {
    let conversation = &export.conversation;
    if !digits(&conversation.id) || !within(&conversation.title, NAME_MAX) {
        return Err("conversation");
    }
    if conversation.participants.len() > PARTICIPANT_LIMIT
        || !conversation.participants.iter().all(|person| {
            digits(&person.id)
                && within(&person.name, NAME_MAX)
                && optional_within(&person.nickname, NAME_MAX)
        })
    {
        return Err("participants");
    }
    if export.missing.len() > MISSING_LIMIT {
        return Err("missing");
    }
    if export.messages.len() > MESSAGE_LIMIT {
        return Err("message count");
    }
    if !export.messages.iter().all(validate_message) {
        return Err("message");
    }
    Ok(())
}

/* ------------------------------- Dates -------------------------------- */

struct Moment {
    date: OffsetDateTime,
}

impl Moment {
    fn new(timestamp_ms: i64, offset_minutes: i32) -> Option<Self> {
        let offset = UtcOffset::from_whole_seconds(offset_minutes.checked_mul(60)?).ok()?;
        let date = OffsetDateTime::from_unix_timestamp_nanos(i128::from(timestamp_ms) * 1_000_000)
            .ok()?
            .checked_to_offset(offset)?;
        Some(Self { date })
    }

    fn iso(&self) -> String {
        let d = self.date;
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}{}",
            d.year(),
            u8::from(d.month()),
            d.day(),
            d.hour(),
            d.minute(),
            d.second(),
            d.millisecond(),
            offset_suffix(d.offset())
        )
    }

    fn day(&self) -> String {
        let d = self.date;
        format!("{}, {} {} {}", d.weekday(), d.day(), d.month(), d.year())
    }

    fn time(&self) -> String {
        format!("{:02}:{:02}", self.date.hour(), self.date.minute())
    }
}

fn offset_suffix(offset: UtcOffset) -> String {
    if offset.is_utc() {
        return "Z".into();
    }
    let (hours, minutes, _) = offset.as_hms();
    let sign = if offset.is_negative() { '-' } else { '+' };
    format!("{sign}{:02}:{:02}", hours.abs(), minutes.abs())
}

fn utc_iso(timestamp_ms: i64) -> String {
    Moment::new(timestamp_ms, 0).map_or_else(String::new, |moment| moment.iso())
}

/* ------------------------------ Document ------------------------------ */

fn notes(export: &PageExport, history: History) -> Vec<String> {
    let mut notes = Vec::new();
    if export.truncated {
        notes.push("Only the newest 50,000 messages are included.".to_string());
    } else if history == History::Partial {
        notes.push(
            "Older messages are not included because Messenger has not loaded them on this \
             device. Scroll up in the conversation to load more, then export again."
                .into(),
        );
    } else if history == History::Unknown {
        notes.push(
            "Includes the messages Messenger has stored on this device. Older messages may be \
             missing; scroll up in the conversation to load more, then export again."
                .into(),
        );
    }
    let unreadable = export
        .messages
        .iter()
        .filter(|message| message.unreadable)
        .count();
    if unreadable == 1 {
        notes.push("1 encrypted message couldn't be read on this device.".into());
    } else if unreadable > 1 {
        notes.push(format!(
            "{unreadable} encrypted messages couldn't be read on this device."
        ));
    }
    notes.push(
        "Photos, videos, and files are not included. Attachments are listed by type and name."
            .into(),
    );
    for (part, note) in [
        (
            MissingPart::Participants,
            "Participant names could not be read.",
        ),
        (
            MissingPart::Reactions,
            "Reactions could not be read and are not included.",
        ),
        (
            MissingPart::Attachments,
            "Attachments and calls could not be read and are not included.",
        ),
    ] {
        if export.missing.contains(&part) {
            notes.push(note.into());
        }
    }
    notes
}

fn document(export: PageExport, now_ms: i64) -> ExportDocument {
    let history = if export.truncated {
        History::Partial
    } else {
        export.history
    };
    let notes = notes(&export, history);
    let mut messages = export.messages;
    for message in &mut messages {
        message.timestamp = utc_iso(message.timestamp_ms);
    }
    ExportDocument {
        format: FORMAT_NAME,
        version: FORMAT_VERSION,
        exported_at: utc_iso(now_ms),
        conversation: export.conversation,
        history,
        notes,
        messages,
    }
}

fn render_json(document: &ExportDocument) -> String {
    let mut json = serde_json::to_string_pretty(document).expect("export document serializes");
    json.push('\n');
    json
}

/* -------------------------------- HTML -------------------------------- */

fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for char in value.chars() {
        match char {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(char),
        }
    }
    out
}

const STYLE: &str = r#"
:root{color-scheme:light dark;--bg:#fff;--fg:#1c1e21;--muted:#65676b;--line:#e4e6eb;--quote:#f0f2f5}
@media (prefers-color-scheme:dark){:root{--bg:#18191a;--fg:#e4e6eb;--muted:#b0b3b8;--line:#3a3b3c;--quote:#242526}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header,main{max-width:760px;margin:0 auto;padding:16px 20px}
header{border-bottom:1px solid var(--line)}
h1{margin:0 0 4px;font-size:22px}
.meta{margin:2px 0;color:var(--muted);font-size:13px}
.notes{margin:10px 0 0;padding-left:18px;color:var(--muted);font-size:13px}
.day{margin:24px 0 8px;font-size:13px;font-weight:600;color:var(--muted);text-align:center}
.msg{padding:6px 0}
.head{display:flex;gap:8px;align-items:baseline}
.sender{font-weight:600}
time,.flags{color:var(--muted);font-size:12px}
.text{margin:2px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.note{margin:2px 0;color:var(--muted);font-style:italic}
.system{margin:8px 0;color:var(--muted);font-size:13px;text-align:center;white-space:pre-wrap}
.reply{margin:4px 0;padding:4px 10px;border-left:3px solid var(--line);background:var(--quote);border-radius:4px;font-size:13px;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
.reply a{color:inherit}
.attachments{margin:2px 0;padding-left:18px;color:var(--muted);font-size:13px}
.reactions{margin:2px 0;font-size:13px;color:var(--muted)}
"#;

fn attachment_label(attachment: &Attachment) -> String {
    let label = match attachment.kind {
        AttachmentKind::Image => "Photo",
        AttachmentKind::Video => "Video",
        AttachmentKind::Audio => "Audio",
        AttachmentKind::File => "File",
        AttachmentKind::Link => "Link",
        AttachmentKind::Other => "Attachment",
    };
    match attachment
        .filename
        .as_deref()
        .or(attachment.title.as_deref())
    {
        Some(detail) => format!("{label}: {detail}"),
        None => label.to_string(),
    }
}

fn duration_label(seconds: u32) -> String {
    let (hours, minutes, seconds) = (seconds / 3600, seconds / 60 % 60, seconds % 60);
    if hours > 0 {
        format!("{hours} h {minutes} min")
    } else if minutes > 0 {
        format!("{minutes} min {seconds} s")
    } else {
        format!("{seconds} s")
    }
}

fn call_label(call: &Call) -> String {
    let label = match (call.kind, call.outcome) {
        (CallType::Audio, Some(CallOutcome::Missed)) => "Missed audio call",
        (CallType::Video, Some(CallOutcome::Missed)) => "Missed video call",
        (CallType::Audio, Some(CallOutcome::Started)) => "Audio call started",
        (CallType::Video, Some(CallOutcome::Started)) => "Video call started",
        (CallType::Audio, _) => "Audio call",
        (CallType::Video, _) => "Video call",
    };
    match call.duration_sec {
        Some(duration) if call.outcome != Some(CallOutcome::Missed) => {
            format!("{label}, {}", duration_label(duration))
        }
        _ => label.to_string(),
    }
}

fn render_html(document: &ExportDocument) -> String {
    let anchors: std::collections::HashMap<&str, usize> = document
        .messages
        .iter()
        .enumerate()
        .map(|(index, message)| (message.id.as_str(), index + 1))
        .collect();
    let title = escape(&document.conversation.title);
    let count = document.messages.len();
    let mut out = String::with_capacity(4096 + count * 256);
    let _ = write!(
        out,
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <meta name=\"generator\" content=\"Carrier\">\n<title>{title}</title>\n<style>{STYLE}</style>\n\
         </head>\n<body>\n<header>\n<h1>{title}</h1>\n\
         <p class=\"meta\">{count} {noun}, exported {exported}</p>\n",
        noun = if count == 1 { "message" } else { "messages" },
        // "2026-11-07T10:30:00.000Z" -> "2026-11-07 10:30 UTC"
        exported = escape(&format!(
            "{} UTC",
            document
                .exported_at
                .get(..16)
                .unwrap_or_default()
                .replace('T', " ")
        )),
    );
    let people: Vec<&str> = document
        .conversation
        .participants
        .iter()
        .filter_map(|person| {
            Some(person.name.as_str())
                .filter(|name| !name.is_empty())
                .or(person.nickname.as_deref())
        })
        .collect();
    if !people.is_empty() {
        let _ = writeln!(
            out,
            "<p class=\"meta\">Participants: {}</p>",
            escape(&people.join(", "))
        );
    }
    out.push_str("<ul class=\"notes\">");
    for note in &document.notes {
        let _ = write!(out, "<li>{}</li>", escape(note));
    }
    out.push_str("</ul>\n</header>\n<main>\n");

    let mut last_day = String::new();
    for (index, message) in document.messages.iter().enumerate() {
        let Some(moment) = Moment::new(message.timestamp_ms, message.utc_offset_minutes) else {
            continue;
        };
        let day = moment.day();
        if day != last_day {
            let _ = writeln!(out, "<h2 class=\"day\">{}</h2>", escape(&day));
            last_day = day;
        }
        let anchor = index + 1;
        let when = format!(
            "<time datetime=\"{}\">{}</time>",
            escape(&moment.iso()),
            escape(&moment.time())
        );
        if message.system {
            let text = message.text.as_deref().unwrap_or("Conversation update");
            let _ = writeln!(
                out,
                "<p class=\"system\" id=\"m{anchor}\">{} · {when}</p>",
                escape(text)
            );
            continue;
        }
        let sender = message.sender_name.as_deref().unwrap_or("Unknown sender");
        let _ = write!(
            out,
            "<article class=\"msg\" id=\"m{anchor}\"><div class=\"head\"><span class=\"sender\">{}</span>{when}",
            escape(sender)
        );
        let flags: Vec<&str> = [
            message.forwarded.then_some("Forwarded"),
            message.edited.then_some("Edited"),
        ]
        .into_iter()
        .flatten()
        .collect();
        if !flags.is_empty() {
            let _ = write!(out, "<span class=\"flags\">{}</span>", flags.join(" · "));
        }
        out.push_str("</div>");
        if let Some(reply) = &message.reply_to {
            let who = escape(reply.sender_name.as_deref().unwrap_or("a message"));
            let label = match anchors.get(reply.message_id.as_str()) {
                Some(target) => format!("<a href=\"#m{target}\">Replying to {who}</a>"),
                None => format!("Replying to {who}"),
            };
            let quoted = reply
                .text
                .as_deref()
                .map(|text| format!(": {}", escape(text)))
                .unwrap_or_default();
            let _ = write!(
                out,
                "<blockquote class=\"reply\">{label}{quoted}</blockquote>"
            );
        }
        if let Some(call) = &message.call {
            let _ = write!(out, "<p class=\"text\">{}</p>", escape(&call_label(call)));
        }
        if message.unsent {
            out.push_str("<p class=\"note\">Message unsent</p>");
        } else if message.unreadable {
            out.push_str("<p class=\"note\">Encrypted message (couldn't be read)</p>");
        } else if let Some(text) = &message.text {
            let _ = write!(out, "<p class=\"text\">{}</p>", escape(text));
        } else if message.sticker {
            out.push_str("<p class=\"note\">Sticker</p>");
        }
        if !message.attachments.is_empty() {
            out.push_str("<ul class=\"attachments\">");
            for attachment in &message.attachments {
                let _ = write!(out, "<li>{}</li>", escape(&attachment_label(attachment)));
            }
            out.push_str("</ul>");
        }
        if !message.reactions.is_empty() {
            let reactions: Vec<String> = message
                .reactions
                .iter()
                .map(|reaction| match &reaction.actor_name {
                    Some(name) => escape(&format!("{} {name}", reaction.reaction)),
                    None => escape(&reaction.reaction),
                })
                .collect();
            let _ = write!(out, "<p class=\"reactions\">{}</p>", reactions.join(" · "));
        }
        out.push_str("</article>\n");
    }
    if count == 0 {
        out.push_str("<p class=\"system\">No messages are stored on this device yet.</p>\n");
    }
    out.push_str("</main>\n</body>\n</html>\n");
    out
}

/// Validate the page's model and render the file natively.
fn render(format: Format, export: PageExport, now_ms: i64) -> Result<String, &'static str> {
    validate(&export)?;
    let document = document(export, now_ms);
    Ok(match format {
        Format::Html => render_html(&document),
        Format::Json => render_json(&document),
    })
}

/* ------------------------------- Saving ------------------------------- */

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExportMsg<C> {
    request: String,
    format: String,
    /// First skipped (to learn where to report a refusal), then parsed straight
    /// into the bounded model: never into an untyped tree.
    conversation: C,
    reveal: String,
}

/// The suggested file name: the conversation title made safe, or a generic
/// name while names are hidden (the dialog may be on a shared screen).
fn suggested_file_name(title: &str, names_hidden: bool, format: Format) -> String {
    let title = if names_hidden { "Conversation" } else { title };
    let stem: String = sanitize_filename(title).chars().take(80).collect();
    format!("{}.{}", stem.trim(), format.extension())
}

/// The user may edit the name in the dialog; still refuse executable types.
fn destination_allowed(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| !is_unsafe_download(name))
}

/// The opaque key the page's toast uses to reveal the saved file.
fn reveal_url(reveal: &str) -> Option<url::Url> {
    let token = reveal.strip_prefix(REVEAL_PREFIX)?;
    if token.len() != 32 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    url::Url::parse(reveal).ok()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(TIMESTAMP_MAX)
        })
}

#[derive(Clone, Copy)]
enum Outcome {
    Saved,
    Cancelled,
    Failed,
}

fn send_result(
    app: &tauri::AppHandle,
    label: &str,
    request: &str,
    outcome: Outcome,
    phase: NativeResultPhase,
) {
    // Field order must match the result object carrierNativeCall verifies.
    #[derive(Serialize)]
    struct ExportResult<'a> {
        request: &'a str,
        saved: bool,
        phase: NativeResultPhase,
        cancelled: bool,
    }

    let result_event = format!("{EVENT}-result");
    let result = ExportResult {
        request,
        saved: matches!(outcome, Outcome::Saved),
        phase,
        cancelled: matches!(outcome, Outcome::Cancelled),
    };
    let signature = app
        .state::<AppState>()
        .download_reveal_tokens
        .lock()
        .unwrap()
        .get(label)
        .and_then(|secret| result_signature(secret, &result_event, &result));
    let Some(signature) = signature else {
        log::warn!("failed to authenticate {result_event}");
        return;
    };
    let mut detail = serde_json::to_value(&result).expect("export result serializes");
    detail["signature"] = signature.into();
    if let Some(window) = app.get_webview_window(label)
        && let Err(error) = window.eval(format!(
            "window.dispatchEvent(new CustomEvent('{result_event}', {{ detail: {detail} }}));"
        ))
    {
        log::warn!("failed to report {result_event}: {error}");
    }
}

pub(crate) fn install(app: &tauri::AppHandle) {
    let handle = app.clone();
    app.listen_any(EVENT, move |event| {
        let Ok(signed) = serde_json::from_str::<SignedAction>(event.payload()) else {
            log::warn!("{EVENT} payload did not parse");
            return;
        };
        let Some(label) = signed_action_window(&handle, EVENT, &signed) else {
            log::warn!("{EVENT} was not authorized");
            return;
        };
        let Ok(msg) = serde_json::from_str::<ExportMsg<serde::de::IgnoredAny>>(&signed.message)
        else {
            log::warn!("{EVENT} message did not parse");
            return;
        };
        if msg.request.len() != 32 || !msg.request.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            log::warn!("{EVENT} had an invalid request token");
            return;
        }
        let fail = |reason: &str| {
            log::warn!("{EVENT} was refused: {reason}");
            send_result(
                &handle,
                &label,
                &msg.request,
                Outcome::Failed,
                NativeResultPhase::Complete,
            );
        };
        let (Some(format), Some(reveal)) = (Format::parse(&msg.format), reveal_url(&msg.reveal))
        else {
            return fail("invalid format or reveal key");
        };
        let export = match serde_json::from_str::<ExportMsg<PageExport>>(&signed.message) {
            Ok(full) => full.conversation,
            Err(error) => return fail(&format!("model did not parse: {error}")),
        };
        let title = export.conversation.title.clone();
        let content = match render(format, export, now_ms()) {
            Ok(content) => content,
            Err(reason) => return fail(&format!("invalid {reason}")),
        };
        let Some(window) = handle.get_webview_window(&label) else {
            log::warn!("{EVENT} window was no longer available");
            return;
        };
        let names_hidden = handle
            .state::<AppState>()
            .settings
            .lock()
            .unwrap()
            .hide_names_avatars;

        let mut dialog = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Export Conversation")
            .set_file_name(suggested_file_name(&title, names_hidden, format))
            .add_filter(format.filter_name(), &[format.extension()]);
        if let Some(directory) = downloads_dir() {
            dialog = dialog.set_directory(directory);
        }
        let result_handle = handle.clone();
        let result_label = label.clone();
        let request = msg.request.clone();
        dialog.save_file(move |selection| {
            let Some(selection) = selection else {
                send_result(
                    &result_handle,
                    &result_label,
                    &request,
                    Outcome::Cancelled,
                    NativeResultPhase::Complete,
                );
                return;
            };
            let path: Option<PathBuf> = selection
                .into_path()
                .ok()
                .filter(|path| destination_allowed(path));
            let Some(path) = path else {
                log::warn!("{EVENT} destination was refused");
                send_result(
                    &result_handle,
                    &result_label,
                    &request,
                    Outcome::Failed,
                    NativeResultPhase::Complete,
                );
                return;
            };
            tauri::async_runtime::spawn_blocking(move || {
                let outcome = match std::fs::write(&path, content.as_bytes()) {
                    Ok(()) => {
                        let id = reveal.path().to_string();
                        remember_download(&reveal, id, path);
                        // Reveal looks up completed entries only.
                        complete_download(&reveal);
                        Outcome::Saved
                    }
                    Err(error) => {
                        log::warn!("failed to write conversation export: {error}");
                        Outcome::Failed
                    }
                };
                send_result(
                    &result_handle,
                    &result_label,
                    &request,
                    outcome,
                    NativeResultPhase::Complete,
                );
            });
        });
        // The dialog can stay open indefinitely; acknowledge it so the page
        // drops its response timeout.
        send_result(
            &handle,
            &label,
            &msg.request,
            Outcome::Saved,
            NativeResultPhase::Presented,
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const T0: i64 = 1_794_043_800_000; // 2026-11-07T09:30:00Z

    fn message(id: &str, timestamp_ms: i64) -> serde_json::Value {
        json!({
            "id": id, "senderId": "2", "senderName": "Alex Example",
            "timestampMs": timestamp_ms, "utcOffsetMinutes": 60,
            "text": "Lunch?", "system": false, "unsent": false, "unreadable": false,
            "forwarded": false, "edited": false, "sticker": false,
            "call": null, "replyTo": null, "reactions": [], "attachments": []
        })
    }

    fn page(messages: Vec<serde_json::Value>) -> serde_json::Value {
        json!({
            "conversation": {
                "id": "100", "title": "Weekend", "isGroup": true,
                "participants": [{ "id": "2", "name": "Alex Example", "nickname": "Captain" }]
            },
            "history": "complete", "truncated": false, "missing": [],
            "messages": messages
        })
    }

    fn parse(value: serde_json::Value) -> PageExport {
        serde_json::from_value(value).expect("valid page model")
    }

    fn rendered(format: Format, value: serde_json::Value) -> String {
        render(format, parse(value), T0 + 3_600_000).expect("renders")
    }

    #[test]
    fn oversized_lists_are_refused_while_parsing() {
        let mut model = page(vec![]);
        model["missing"] = json!(vec!["reactions"; MISSING_LIMIT + 1]);
        assert!(serde_json::from_value::<PageExport>(model).is_err());

        let reaction =
            json!({ "actorId": "2", "actorName": null, "reaction": "👍", "timestampMs": null });
        let mut reactions = message("mid.1", T0);
        reactions["reactions"] = json!(vec![reaction; REACTION_LIMIT + 1]);
        let error = serde_json::from_value::<PageExport>(page(vec![reactions]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("more than"), "{error}");
    }

    #[test]
    fn rejects_unknown_fields_and_malformed_values() {
        let mut extra = page(vec![message("mid.1", T0)]);
        extra["html"] = json!("<script>");
        assert!(serde_json::from_value::<PageExport>(extra).is_err());

        let mut timestamp = message("mid.1", T0);
        timestamp["timestamp"] = json!("2026");
        assert!(serde_json::from_value::<PageExport>(page(vec![timestamp])).is_err());

        let mut kind = message("mid.1", T0);
        kind["attachments"] =
            json!([{ "kind": "script", "filename": null, "title": null, "mimeType": null }]);
        assert!(serde_json::from_value::<PageExport>(page(vec![kind])).is_err());

        for (field, value) in [
            ("senderId", json!("2<b>")),
            ("timestampMs", json!(-1)),
            ("utcOffsetMinutes", json!(5000)),
            ("utcOffsetMinutes", json!(i32::MIN)),
            ("id", json!("")),
        ] {
            let mut bad = message("mid.1", T0);
            bad[field] = value;
            assert!(
                validate(&parse(page(vec![bad]))).is_err(),
                "{field} should be rejected"
            );
        }

        // A local date past what a date can hold is rejected, not a panic.
        let mut overflow = message("mid.1", TIMESTAMP_MAX);
        overflow["utcOffsetMinutes"] = json!(60);
        assert!(validate(&parse(page(vec![overflow]))).is_err());

        let mut ciphertext = message("mid.1", T0);
        ciphertext["unreadable"] = json!(true);
        assert!(validate(&parse(page(vec![ciphertext]))).is_err());

        let mut long = message("mid.1", T0);
        long["text"] = json!("x".repeat(TEXT_MAX + 1));
        assert!(validate(&parse(page(vec![long]))).is_err());

        let mut conversation = page(vec![]);
        conversation["conversation"]["id"] = json!("../1");
        assert!(validate(&parse(conversation)).is_err());
    }

    #[test]
    fn writes_versioned_json_with_native_dates_and_notes() {
        let mut reply = message("mid.2", T0 + 60_000);
        reply["replyTo"] = json!({ "messageId": "mid.1", "senderId": "2", "senderName": "Alex Example", "text": "Lunch?" });
        reply["reactions"] = json!([{ "actorId": "2", "actorName": "Alex Example", "reaction": "❤", "timestampMs": T0 + 70_000 }]);
        let mut locked = message("mid.3", T0 + 120_000);
        locked["text"] = json!(null);
        locked["unreadable"] = json!(true);
        let mut model = page(vec![message("mid.1", T0), reply, locked]);
        model["history"] = json!("partial");
        model["missing"] = json!(["reactions"]);

        let text = rendered(Format::Json, model);
        assert!(text.starts_with(
            "{\n  \"format\": \"carrier-conversation-export\",\n  \"version\": 1,\n  \"exportedAt\": "
        ));
        let saved: serde_json::Value = serde_json::from_str(&text).expect("valid JSON");
        assert_eq!(saved["format"], FORMAT_NAME);
        assert_eq!(saved["version"], 1);
        assert_eq!(saved["exportedAt"], "2026-11-07T10:30:00.000Z");
        assert_eq!(saved["history"], "partial");
        assert_eq!(
            saved["messages"][0]["timestamp"],
            "2026-11-07T09:30:00.000Z"
        );
        assert!(saved["messages"][0].get("utcOffsetMinutes").is_none());
        assert_eq!(saved["messages"][1]["replyTo"]["messageId"], "mid.1");
        assert_eq!(saved["messages"][1]["reactions"][0]["reaction"], "❤");
        assert_eq!(saved["messages"][2]["unreadable"], true);
        let notes: Vec<&str> = saved["notes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|note| note.as_str().unwrap())
            .collect();
        assert!(notes[0].starts_with("Older messages are not included"));
        assert!(notes.contains(&"1 encrypted message couldn't be read on this device."));
        assert!(notes.contains(&"Reactions could not be read and are not included."));
    }

    #[test]
    fn renders_self_contained_html_with_everything_escaped() {
        let mut hostile = message("mid.1", T0);
        hostile["text"] = json!("</p><script>alert(1)</script><img src=x onerror=a>");
        hostile["senderName"] = json!("<b>Alex</b>");
        hostile["replyTo"] = json!({ "messageId": "\"><svg>", "senderId": null, "senderName": null, "text": "<i>q</i>" });
        hostile["reactions"] =
            json!([{ "actorId": null, "actorName": "'x'", "reaction": "<3", "timestampMs": null }]);
        hostile["attachments"] =
            json!([{ "kind": "file", "filename": "\"><iframe>", "title": null, "mimeType": null }]);
        let mut model = page(vec![hostile]);
        model["conversation"]["title"] = json!("<title></title><script>");
        let html = rendered(Format::Html, model);

        assert!(html.starts_with("<!doctype html>"));
        assert!(html.contains("content=\"default-src 'none'; style-src 'unsafe-inline'\""));
        let lower = html.to_ascii_lowercase();
        for raw in [
            "<script", "<img", "<iframe", "<svg", "<b>", "<i>", "<3", "http:", "https:",
        ] {
            assert!(!lower.contains(raw), "{raw} leaked into the HTML");
        }
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(html.contains("<h1>&lt;title&gt;&lt;/title&gt;&lt;script&gt;</h1>"));
        assert!(html.contains("&#39;x&#39;"));
    }

    #[test]
    fn renders_local_days_calls_and_unreadable_messages() {
        let mut missed = message("mid.2", T0 + 60_000);
        missed["text"] = json!(null);
        missed["call"] = json!({ "type": "video", "outcome": "missed", "durationSec": null });
        let mut ended = message("mid.3", T0 + 120_000);
        ended["text"] = json!(null);
        ended["call"] = json!({ "type": "audio", "outcome": "ended", "durationSec": 125 });
        let mut locked = message("mid.4", T0 + 180_000);
        locked["text"] = json!(null);
        locked["unreadable"] = json!(true);
        let mut reply = message("mid.5", T0 + 240_000);
        reply["replyTo"] = json!({ "messageId": "mid.1", "senderId": "2", "senderName": "Alex Example", "text": "Lunch?" });
        let html = rendered(
            Format::Html,
            page(vec![message("mid.1", T0), missed, ended, locked, reply]),
        );

        assert!(html.contains("<h2 class=\"day\">Saturday, 7 November 2026</h2>"));
        assert!(html.contains("<time datetime=\"2026-11-07T10:30:00.000+01:00\">10:30</time>"));
        assert!(html.contains("Missed video call"));
        assert!(html.contains("Audio call, 2 min 5 s"));
        assert!(html.contains("Encrypted message (couldn't be read)"));
        assert!(html.contains("<a href=\"#m1\">Replying to Alex Example</a>: Lunch?"));
        assert!(html.contains("Participants: Alex Example"));
        assert!(html.contains("5 messages, exported 2026-11-07 10:30 UTC"));
    }

    #[test]
    fn caps_and_flags_follow_the_native_rules() {
        let mut model = page(vec![]);
        model["truncated"] = json!(true);
        model["history"] = json!("complete");
        let saved: serde_json::Value =
            serde_json::from_str(&rendered(Format::Json, model)).unwrap();
        assert_eq!(saved["history"], "partial");
        assert_eq!(
            saved["notes"][0],
            "Only the newest 50,000 messages are included."
        );
    }

    #[test]
    fn suggests_a_safe_or_generic_name() {
        assert_eq!(
            suggested_file_name("Weekend plans", false, Format::Html),
            "Weekend plans.html"
        );
        assert_eq!(
            suggested_file_name("Alex Example", true, Format::Json),
            "Conversation.json"
        );
        assert_eq!(
            suggested_file_name("a/b:c", false, Format::Json),
            "a_b_c.json"
        );
        assert_eq!(
            suggested_file_name("...", false, Format::Json),
            "download.json"
        );
        assert_eq!(
            suggested_file_name(&"x".repeat(200), false, Format::Html),
            format!("{}.html", "x".repeat(80))
        );
    }

    #[test]
    fn refuses_executable_destinations() {
        assert!(destination_allowed(Path::new("/tmp/chat.html")));
        assert!(destination_allowed(Path::new("/tmp/chat")));
        assert!(!destination_allowed(Path::new("/tmp/chat.sh")));
        assert!(!destination_allowed(Path::new("/tmp/chat.exe")));
    }

    #[test]
    fn accepts_only_opaque_reveal_keys() {
        let key = format!("{REVEAL_PREFIX}{}", "a".repeat(32));
        assert_eq!(reveal_url(&key).map(|url| url.to_string()), Some(key));
        assert!(reveal_url("carrier-export:short").is_none());
        assert!(reveal_url(&format!("https://{}", "a".repeat(32))).is_none());
        assert!(reveal_url(&format!("{REVEAL_PREFIX}{}", "g".repeat(32))).is_none());
    }

    #[test]
    fn a_saved_export_can_be_revealed() {
        let reveal = reveal_url(&format!("{REVEAL_PREFIX}{}", "b".repeat(32))).unwrap();
        remember_download(&reveal, "b".repeat(32), PathBuf::from("/tmp/chat.html"));
        assert!(crate::download::lookup_download(reveal.as_str()).is_none());
        complete_download(&reveal);
        assert_eq!(
            crate::download::lookup_download(reveal.as_str()),
            Some(PathBuf::from("/tmp/chat.html"))
        );
    }

    #[test]
    fn parses_only_known_formats() {
        assert_eq!(Format::parse("html"), Some(Format::Html));
        assert_eq!(Format::parse("json"), Some(Format::Json));
        assert_eq!(Format::parse("pdf"), None);
        assert!(Format::Json.page_script().ends_with("('json')"));
    }
}
