import { EMOJI_SOURCE_RE, emojiGlyph, SYSTEM_EMOJI_GLYPH_ATTR } from "./emoji";

/** The DOM surface conversationNodeText walks (a Node in production). */
export interface ConversationTextNode {
  nodeType: number;
  nodeValue?: string | null;
  tagName?: string;
  childNodes?: ArrayLike<ConversationTextNode> | null;
  getAttribute?: (name: string) => string | null;
}

/**
 * A row node's text with Facebook's emoji restored. Messenger renders emoji as
 * sprite images (and background-image spans), which `textContent` drops
 * entirely: a "Kim: 😢" preview would notify as "Kim:" and an emoji-only
 * preview would read as an unhydrated row and never notify at all.
 */
export function conversationNodeText(node: ConversationTextNode | null | undefined): string {
  if (!node) return "";
  if (node.nodeType === 3) return node.nodeValue || "";
  if (node.nodeType !== 1) return "";
  // Skip Carrier's own System emoji glyphs: the sprite they sit next to
  // contributes the same character below, so counting both would double it.
  if (node.getAttribute?.(SYSTEM_EMOJI_GLYPH_ATTR) != null) return "";
  if ((node.tagName || "").toUpperCase() === "IMG") {
    // A sprite URL is the reliable signal, but features/emoji-images.ts defers
    // `src` on off-screen emoji, so a bare-emoji alt counts on its own too.
    const source = node.getAttribute?.("src") || "";
    return !source || EMOJI_SOURCE_RE.test(source) ? emojiGlyph(node.getAttribute?.("alt")) : "";
  }
  let text = "";
  for (const child of Array.from(node.childNodes || [])) text += conversationNodeText(child);
  // Emoji drawn as a background image carry their glyph only on aria-label.
  return text || emojiGlyph(node.getAttribute?.("aria-label"));
}

/** Plain text of a node, the way `textContent` reads it (sprites excluded). */
function plainNodeText(node: ConversationTextNode): string {
  if (node.nodeType === 3) return node.nodeValue || "";
  if (node.nodeType !== 1) return "";
  let text = "";
  for (const child of Array.from(node.childNodes || [])) text += plainNodeText(child);
  return text;
}

/**
 * Whether a child element carries text of its own — that is, this node is a
 * wrapper whose text belongs to a deeper candidate. Carrier's own System emoji
 * glyphs never count: they sit beside a sprite *inside* the leaf, and reading
 * one as nested text would discard the whole preview (the sprite is not a
 * candidate itself, so nothing else would report that text).
 */
export function hasCandidateTextChild(node: ConversationTextNode): boolean {
  for (const child of Array.from(node.childNodes || [])) {
    if (child.nodeType !== 1) continue;
    if (child.getAttribute?.(SYSTEM_EMOJI_GLYPH_ATTR) != null) continue;
    if (plainNodeText(child).trim()) return true;
  }
  return false;
}

export interface ConversationTextCandidate {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  ariaHidden: boolean;
  inAbbreviation: boolean;
  hasTextChild: boolean;
}

/** Build the sender/title and preview from Messenger's nested text surfaces. */
export function conversationTextParts(candidates: ConversationTextCandidate[]): {
  title: string;
  body: string;
} {
  const values: { text: string; y: number }[] = [];
  for (const candidate of candidates
    .filter(
      ({ text, width, height, ariaHidden, inAbbreviation, hasTextChild }) =>
        !ariaHidden &&
        !inAbbreviation &&
        !hasTextChild &&
        width > 1 &&
        height > 1 &&
        text.trim().length > 0,
    )
    .sort((left, right) => left.y - right.y || left.x - right.x)) {
    const text = candidate.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    // Collapse wrapper duplicates: text rendered at the same vertical position
    // that one of the pair already contains. An emoji drawn as a nested span
    // is part of its parent's line, not a surface of its own — left standing it
    // would displace the preview. The same text on a different line is real
    // content: a contact named "OK" sending "OK" keeps both title and preview.
    const last = values[values.length - 1];
    if (last && Math.abs(last.y - candidate.y) < 1) {
      if (last.text.includes(text)) continue;
      if (text.includes(last.text)) {
        values[values.length - 1] = { text, y: candidate.y };
        continue;
      }
    }
    values.push({ text, y: candidate.y });
  }
  // An empty body means the row's preview has not hydrated yet — callers use
  // that to defer notification decisions instead of acting on placeholder text.
  return {
    title: (values[0]?.text || "Messenger").slice(0, 80),
    body: (values[1]?.text || "").slice(0, 240),
  };
}

/** Messenger marks unread row text with a semibold-or-heavier computed weight. */
export function isUnreadConversationText(fontWeight: string | number, text: string): boolean {
  const weight = typeof fontWeight === "number" ? fontWeight : Number.parseInt(fontWeight, 10) || 0;
  return weight >= 600 && text.trim().length > 1;
}
