/* System-emoji heuristics: which sprites/labels are pure emoji glyphs. */

/** Facebook emoji sprite URLs (img src or CSS background-image). */
export const EMOJI_SOURCE_RE = /(?:emoji|emoji\.php|\/images\/emoji)/i;

// The bare variation selector (U+FE0F) is matched deliberately —
// text-presentation emoji carry it as their only emoji-signalling code point.
// biome-ignore lint/suspicious/noMisleadingCharacterClass: see above
const EMOJI_TEXT_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{FE0F}]/u;
const LABEL_TEXT_RE = /[\p{Letter}\p{Number}]/u;

/** The alt/aria-label text when it is a bare emoji sequence, else "". */
export function emojiGlyph(value: unknown): string {
  const text = String(value || "").trim();
  if (!text || text.length > 24 || !EMOJI_TEXT_RE.test(text)) return "";
  if (LABEL_TEXT_RE.test(text)) return "";
  return text;
}
