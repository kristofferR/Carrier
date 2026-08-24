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
 *
 * `mutedUnreadKnown` means Facebook's "(N)" includes muted chats we must not
 * badge: fall back to the unmuted conversation count instead of the title.
 */
export function reconcileUnreadMessageCount(
  titleCount: number,
  unreadConversations: number,
  conversationListTrustworthy: boolean,
  mutedUnreadKnown = false,
): number {
  // Facebook's "(N)" includes muted chats. Once any muted unread is known,
  // the title total cannot be split, so the unmuted conversation count is
  // the badge — even when the list is scrolled and may under-count.
  if (mutedUnreadKnown) return unreadConversations;
  if (!conversationListTrustworthy) return titleCount;
  if (unreadConversations === 0) return 0;
  return Math.max(titleCount, unreadConversations);
}
