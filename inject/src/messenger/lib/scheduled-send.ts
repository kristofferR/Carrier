import { formatLocale, t } from "../../i18n";

export const SEND_GRACE_MS = 120_000;
export const MAX_SCHEDULED_CHARS = 2_000;

export interface ScheduledMessage {
  id: string;
  account: string;
  thread: string;
  text: string;
  due: number;
  status: "draft" | "scheduled" | "sending" | "missed" | "missed_draft" | "uncertain";
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

export interface SchedulePreset {
  id: "soon" | "hour" | "evening" | "morning";
  label: string;
  due: number;
}

export function schedulePresets(now: number): SchedulePreset[] {
  const evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const presets: SchedulePreset[] = [
    { id: "soon", label: t("page.schedule.preset.in_15_minutes"), due: now + 15 * 60_000 },
    { id: "hour", label: t("page.schedule.preset.in_1_hour"), due: now + 60 * 60_000 },
  ];
  if (evening.getTime() > now)
    presets.push({
      id: "evening",
      label: t("page.schedule.preset.this_evening"),
      due: evening.getTime(),
    });
  presets.push({
    id: "morning",
    label: t("page.schedule.preset.tomorrow_morning"),
    due: tomorrow.getTime(),
  });
  return presets;
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

/** Only as much date as `time` needs: "14:52" today, "Tue 09:00" within the
 * coming week, "Nov 18, 09:00" otherwise (including past days). */
export function formatScheduleTime(time: number, now = Date.now()): string {
  const midnight = (value: number) => new Date(value).setHours(0, 0, 0, 0);
  // Rounded, so a DST change inside the span still counts whole calendar days.
  const days = Math.round((midnight(time) - midnight(now)) / 86_400_000);
  return new Intl.DateTimeFormat(formatLocale(), {
    ...(days === 0
      ? {}
      : days > 0 && days < 7
        ? ({ weekday: "short" } as const)
        : ({ month: "short", day: "numeric" } as const)),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(time);
}

/** The system time zone as people say it ("Eastern Time"), else its IANA ID. */
export function timeZoneLabel(now = Date.now()): string {
  try {
    const name = new Intl.DateTimeFormat(formatLocale(), { timeZoneName: "longGeneric" })
      .formatToParts(now)
      .find((part) => part.type === "timeZoneName")?.value;
    if (name) return name;
  } catch {
    // Engines without generic zone names fall through to the ID.
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Shared with notification replies so two automations cannot use one composer. */
let composerBusy = false;
const composerWaiters: Array<() => void> = [];
/** Includes the native claim and result handshakes while the composer is empty. */
export const isComposerDeliveryActive = () => composerBusy;
const setComposerBusy = (busy: boolean) => {
  composerBusy = busy;
  if (typeof window !== "undefined") window.dispatchEvent(new Event("chatpane:protection-change"));
};
async function runComposerDelivery<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } finally {
    const next = composerWaiters.shift();
    if (next) next();
    else setComposerBusy(false);
  }
}

export function withComposerDelivery<T>(run: () => Promise<T>): Promise<T | undefined> {
  if (composerBusy) return Promise.resolve(undefined);
  setComposerBusy(true);
  return runComposerDelivery(run);
}

/** Keep a notification reply's draft fallback until the current delivery releases the composer. */
export async function withComposerDeliveryWhenAvailable<T>(run: () => Promise<T>): Promise<T> {
  if (composerBusy) await new Promise<void>((resolve) => composerWaiters.push(resolve));
  else setComposerBusy(true);
  return runComposerDelivery(run);
}
