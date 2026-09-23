export const SEND_GRACE_MS = 120_000;
export const MAX_SCHEDULED_CHARS = 2_000;

export interface ScheduledMessage {
  id: string;
  account: string;
  thread: string;
  text: string;
  due: number;
  status: "draft" | "scheduled" | "sending" | "missed" | "uncertain";
  toast_seen: boolean;
}

export interface ScheduleRequest {
  op:
    | "list"
    | "save"
    | "arm"
    | "claim"
    | "sent"
    | "missed"
    | "uncertain"
    | "defer"
    | "cancel"
    | "seen";
  account: string;
  id?: string;
  thread?: string;
  text?: string;
  due?: number;
}

export interface ScheduleResponse {
  items: ScheduledMessage[];
  claimed: string | null;
  saved: string | null;
  error: string | null;
  can_deliver: boolean;
}

export function sendWindow(due: number, now: number): "early" | "due" | "missed" {
  if (now < due) return "early";
  return now <= due + SEND_GRACE_MS ? "due" : "missed";
}

export function nextDueMessage(
  items: ScheduledMessage[],
  now: number,
): ScheduledMessage | undefined {
  return items
    .filter((item) => item.status === "scheduled" && sendWindow(item.due, now) === "due")
    .sort((a, b) => a.due - b.due)[0];
}

export function schedulePresets(now: number) {
  const evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return [
    { label: "In 15 minutes", due: now + 15 * 60_000 },
    { label: "In 1 hour", due: now + 60 * 60_000 },
    ...(evening.getTime() > now ? [{ label: "This evening", due: evening.getTime() }] : []),
    { label: "Tomorrow morning", due: tomorrow.getTime() },
  ];
}

/** Explicit HH:mm inputs avoid WebKit's locale-dependent AM/PM input chrome. */
export function localScheduleTime(date: string, time: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const value = new Date(`${date}T${time}:00`);
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  // Reject nonexistent local times during DST, rather than silently moving them.
  if (
    value.getFullYear() !== year ||
    value.getMonth() + 1 !== month ||
    value.getDate() !== day ||
    value.getHours() !== hour ||
    value.getMinutes() !== minute
  )
    return null;
  return value.getTime();
}

export function localDateValue(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export const formatScheduleTime = (time: number, includeDate = false): string =>
  new Intl.DateTimeFormat(undefined, {
    ...(includeDate ? ({ month: "short", day: "numeric" } as const) : {}),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(time);

/** Shared with notification replies so two automations cannot use one composer. */
let composerBusy = false;
const composerWaiters: Array<() => void> = [];
async function runComposerDelivery<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } finally {
    const next = composerWaiters.shift();
    if (next) next();
    else composerBusy = false;
  }
}

export function withComposerDelivery<T>(run: () => Promise<T>): Promise<T | undefined> {
  if (composerBusy) return Promise.resolve(undefined);
  composerBusy = true;
  return runComposerDelivery(run);
}

/** Keep a notification reply's draft fallback until the current delivery releases the composer. */
export async function withComposerDeliveryWhenAvailable<T>(run: () => Promise<T>): Promise<T> {
  if (composerBusy) await new Promise<void>((resolve) => composerWaiters.push(resolve));
  else composerBusy = true;
  return runComposerDelivery(run);
}
