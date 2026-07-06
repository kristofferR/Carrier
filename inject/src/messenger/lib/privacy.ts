/* Text heuristics for Hide Names & Avatars: which strings are identity
 * (blur) vs. metadata (leave readable). */

const PREVIEW_NAME_RE = /^([^:]{1,40}):(?=\s|$)/;
const PREVIEW_EVENT_RE =
  /^(.{1,40}?)(?=\s+(?:sent|replied|reacted|liked|laughed|loved|mentioned|shared|left|joined|added|removed|changed|created|named|started)\b)/i;

/** Timestamps, weekday abbreviations, and separator runs — never identity. */
export function isMetaText(value: string): boolean {
  return (
    !value ||
    /^(\d+\s*(?:s|m|h|d|w|mo|y)|now|just now)$/i.test(value) ||
    /^(sun|mon|tue|wed|thu|fri|sat)$/i.test(value) ||
    /^[·•.,\s\d]+$/.test(value)
  );
}

/**
 * The sender-name prefix of a message-preview string: "Name: message" or
 * "Name left the group"-style event lines. Null when the preview carries no
 * identifiable prefix (including "You:"/first-person previews).
 */
export function previewIdentity(value: string): { prefix: string; colon: boolean } | null {
  const colon = value.match(PREVIEW_NAME_RE);
  const event = colon ? null : value.match(PREVIEW_EVENT_RE);
  const match = colon || event;
  if (!match) return null;

  const prefix = match[1]!.trim();
  if (!prefix || prefix.length < 2 || /^(you|du|me|meg)$/i.test(prefix)) return null;
  if (/[\d:;!?]/.test(prefix)) return null;
  return { prefix, colon: !!colon };
}
