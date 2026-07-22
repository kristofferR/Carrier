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
    // Collapse wrapper duplicates: the same text rendered at the same
    // vertical position. The same text on a different line is real content —
    // a contact named "OK" sending "OK" must keep both title and preview.
    const last = values[values.length - 1];
    if (last && last.text === text && Math.abs(last.y - candidate.y) < 1) continue;
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
