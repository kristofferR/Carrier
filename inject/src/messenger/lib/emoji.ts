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

export interface ReactionMenuChild {
  glyphs: number;
  role: string | null;
}

/**
 * Messenger's compact reaction menu has 5–8 one-glyph slots followed by one
 * glyph-free add-reaction button. Keeping this structural prevents reaction
 * sizing from leaking into inline emoji or unrelated menus.
 */
export function isReactionMenuShape(children: ReactionMenuChild[]) {
  if (children.length < 6 || children.length > 9) return false;
  const addButton = children.at(-1);
  return (
    addButton?.glyphs === 0 &&
    addButton.role === "button" &&
    children.slice(0, -1).every((child) => child.glyphs === 1)
  );
}
