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
  const values: string[] = [];
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
    if (text && values[values.length - 1] !== text) values.push(text);
  }
  // An empty body means the row's preview has not hydrated yet — callers use
  // that to defer notification decisions instead of acting on placeholder text.
  return {
    title: (values[0] || "Messenger").slice(0, 80),
    body: (values[1] || "").slice(0, 240),
  };
}

/** Messenger marks unread row text with a semibold-or-heavier computed weight. */
export function isUnreadConversationText(fontWeight: string | number, text: string): boolean {
  const weight = typeof fontWeight === "number" ? fontWeight : Number.parseInt(fontWeight, 10) || 0;
  return weight >= 600 && text.trim().length > 1;
}
