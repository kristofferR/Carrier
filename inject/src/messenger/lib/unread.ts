/** Unread messages: Facebook prefixes the page title with "(N)". */
export function unreadCountFromTitle(title: string): number {
  const m = (title || "").match(/^\s*\((\d+)\)/);
  return m ? parseInt(m[1]!, 10) : 0;
}

/**
 * The title count can lag behind Messenger's rendered read state (and a
 * parenthesized number later in a thread title is not a badge at all). Once the
 * hydrated chat list is trustworthy, use it to reject a stale zero/non-zero
 * disagreement while preserving the title's per-message total.
 */
export function reconcileUnreadMessageCount(
  titleCount: number,
  unreadConversations: number,
  conversationListTrustworthy: boolean,
): number {
  if (!conversationListTrustworthy) return titleCount;
  if (unreadConversations === 0) return 0;
  return Math.max(titleCount, unreadConversations);
}
