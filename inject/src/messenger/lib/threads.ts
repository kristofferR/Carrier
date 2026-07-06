/* Conversation ("thread") href parsing shared by the unread badge, the
 * recent-threads menu scrape, and the Dock/tray open-thread route. */

/** The numeric thread id from any href containing "/t/<id>", else null. */
export function threadIdFromHref(href: string | null | undefined): string | null {
  const m = (href || "").match(/\/t\/(\d+)/);
  return m ? m[1]! : null;
}

/** The thread id from an exact "/t/<id>" or "/t/<id>/" path, else null. */
export function threadPathId(href: unknown): string | null {
  const m = String(href || "").match(/^\/t\/(\d+)\/?$/);
  return m ? m[1]! : null;
}

// Structural separators that can appear between row fragments. Do not filter
// short or metadata-looking words: they can be real display names.
export const SEPARATOR_RE = /^[·•.,\s]+$/;
