/** Unread messages: Facebook prefixes the page title with "(N)". */
export function unreadCountFromTitle(title: string): number {
  const m = (title || "").match(/\((\d+)\)/);
  return m ? parseInt(m[1]!, 10) : 0;
}
