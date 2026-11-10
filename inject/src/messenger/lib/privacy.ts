/* Text heuristics for Hide Names & Avatars: which strings are identity
 * (blur) vs. metadata (leave readable). None depends on the UI language. */

const PREVIEW_NAME_RE = /^([^:]{1,40}):(?=\s|$)/;

/** Separator runs, bare numbers and short relative times ("5m", "5 Min.")
 * — never identity. */
export function isMetaText(value: string): boolean {
  return !value || /^[·•.,\s\d]+$/.test(value) || /^\d+\s*\p{L}{1,4}\.?$/u.test(value);
}

/**
 * The sender-name prefix of a "Name: message" preview, for when the chat's
 * participants are unknown. Null when the preview carries no such prefix.
 */
export function previewIdentity(value: string): { prefix: string; colon: boolean } | null {
  const match = value.match(PREVIEW_NAME_RE);
  if (!match) return null;
  const prefix = match[1]!.trim();
  if (prefix.length < 2) return null;
  // Digits are valid in names ("Anna 2", band/group names). Reject only
  // punctuation/time-shaped prefixes rather than every digit-bearing sender.
  if (/[:;!?]/.test(prefix) || /^\d+(?:[ .-]\d+)*$/.test(prefix)) return null;
  return { prefix, colon: true };
}

const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;
// Scripts written without spaces between words, or that attach particles
// straight to a name (Japanese さん, Korean 님): a name there may run into
// the next letter.
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

const nameEdge = (beside: string | undefined, edge: string) =>
  beside === undefined || !WORD_CHAR.test(beside) || UNSPACED.test(beside) || UNSPACED.test(edge);

/**
 * Offsets of the chat's participant names wherever they stand in a preview,
 * as whole words: "Kim sent a photo", "Kim hat ein Foto gesendet",
 * "Kimさんが写真を送信しました". A longer name wins over a shorter one inside it.
 */
export function nameRanges(text: string, names: Iterable<string>): [number, number][] {
  const sorted = [...new Set([...names].map((name) => name.trim()))]
    .filter((name) => name.length >= 2)
    .sort((a, b) => b.length - a.length);
  const ranges: [number, number][] = [];
  for (const name of sorted) {
    for (let from = text.indexOf(name); from !== -1; from = text.indexOf(name, from + 1)) {
      const to = from + name.length;
      if (!nameEdge(text[from - 1], name[0]!) || !nameEdge(text[to], name[name.length - 1]!))
        continue;
      if (ranges.some(([start, end]) => from < end && to > start)) continue;
      ranges.push([from, to]);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** A position in a run of text nodes: [node index, offset within it]. */
export type TextPoint = [number, number];

/**
 * Node positions of the [from, to) offsets in the nodes' joined text. The
 * end stays inside the node holding the last character.
 */
export function locateSpan(
  texts: string[],
  from: number,
  to: number,
): { start: TextPoint; end: TextPoint } {
  const locate = (index: number, atEnd: boolean): TextPoint => {
    let offset = index;
    for (let node = 0; node < texts.length; node += 1) {
      const length = texts[node]!.length;
      if (atEnd ? offset <= length : offset < length) return [node, offset];
      offset -= length;
    }
    return [texts.length - 1, texts[texts.length - 1]!.length];
  };
  return { start: locate(from, false), end: locate(to, true) };
}

/**
 * Offsets of `prefix` when the text starts with it (after leading
 * whitespace). Null otherwise, including when whitespace differs from the
 * normalized prefix.
 */
export function prefixRange(text: string, prefix: string): [number, number] | null {
  const lead = text.length - text.trimStart().length;
  if (!prefix || !text.startsWith(prefix, lead)) return null;
  return [lead, lead + prefix.length];
}

// "@" (not inside a word, so not an e-mail address), the word after it, then
// up to three more words that start with a capital: "@Martine Rieck". Name
// particles before such a word belong to it ("@Martine van der Berg"), and
// combining marks count as letters ("José" written decomposed).
const NAME_CHAR = "[\\p{L}\\p{M}\\p{N}_.'-]";
const PARTICLE = "(?:van|von|der|den|de|del|della|di|da|du|dos|das|la|le|ten|ter|bin|ibn|al)";
// No lookbehind: WebKit before Safari 16.4 (older macOS) cannot parse it,
// and a throw here would stop every injected feature from starting.
const MENTION_RE = new RegExp(
  `(^|[^\\p{L}\\p{M}\\p{N}_])(@${NAME_CHAR}+(?:[ \\u00a0](?:${PARTICLE}[ \\u00a0])*\\p{Lu}${NAME_CHAR}*){0,3})`,
  "gu",
);

/** Offsets of @mentions in preview text. A capitalized word right after a
 * name counts as part of it, erring on the side of hiding. */
export function mentionRanges(text: string): [number, number][] {
  return [...text.matchAll(MENTION_RE)].map((m) => {
    const start = m.index + m[1]!.length;
    return [start, start + m[2]!.length];
  });
}

type IdentitySettings = {
  hide_names_avatars?: boolean;
  hide_names?: boolean | null;
  hide_avatars?: boolean | null;
};

/** Contact names are blurred (Ref #364); older installs keep the combined switch. */
export function hidesNames(settings: IdentitySettings | null | undefined): boolean {
  return (settings?.hide_names ?? settings?.hide_names_avatars) === true;
}

/** Avatars are blurred (Ref #364); older installs keep the combined switch. */
export function hidesAvatars(settings: IdentitySettings | null | undefined): boolean {
  return (settings?.hide_avatars ?? settings?.hide_names_avatars) === true;
}
