/* Do-not-disturb window parsing ("HH:MM" wall-clock pairs, possibly spanning
 * midnight) for the notification bridge. */

/** Parse "HH:MM" into minutes since midnight; null when malformed/empty. */
export function parseDndTime(value: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!m) return null;
  const hour = Number(m[1]!);
  const minute = Number(m[2]!);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** Whether `now` falls inside the settings' DND window (start==end = off). */
export function dndActive(
  settings: { dnd_start?: string; dnd_end?: string } | undefined,
  now: Date = new Date(),
): boolean {
  const start = parseDndTime(settings?.dnd_start);
  const end = parseDndTime(settings?.dnd_end);
  if (start == null || end == null || start === end) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}
