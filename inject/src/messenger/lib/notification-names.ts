import { normalizeSenderName } from "./sender-avatars";

export interface NotificationParticipant {
  name: string;
  firstName: string;
  nickname: string;
  avatar: string;
}

export interface ConversationNotificationNames {
  title: string;
  isGroup: boolean;
  participants: NotificationParticipant[];
}

function aliases(person: NotificationParticipant) {
  return [person.name, person.firstName, person.nickname].filter(Boolean).map(normalizeSenderName);
}

function namedParticipant(name: string, group: ConversationNotificationNames) {
  const matches = group.participants.filter((person) =>
    aliases(person).includes(normalizeSenderName(name)),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** Only rewrite a proven sender prefix; the message following it is untouched. */
function prefixedParticipant(body: string, group: ConversationNotificationNames) {
  const matches = new Map<NotificationParticipant, number>();
  // A nickname can itself contain a colon. If more than one person could own
  // the prefix, neither a short-name guess nor a longest-prefix guess is safe.
  for (let end = body.indexOf(": "); end > 0 && end <= 200; end = body.indexOf(": ", end + 2)) {
    const prefix = normalizeSenderName(body.slice(0, end));
    for (const person of group.participants) {
      if (aliases(person).includes(prefix)) matches.set(person, end + 2);
    }
  }
  if (matches.size !== 1) return undefined;
  const [person, end] = matches.entries().next().value!;
  return { person, end };
}

export function notificationSender(body: string, group: ConversationNotificationNames | null) {
  if (!group?.isGroup) return undefined;
  return prefixedParticipant(body, group)?.person;
}

/** Presentation only: matching, routes and dedupe must keep using the original text. */
export function notificationNames(
  title: string,
  body: string,
  group: ConversationNotificationNames | null,
  showNicknames: boolean,
  titleKind: "sender" | "group" | "unknown" = "unknown",
) {
  if (!group) return { title, body };
  const displayName = (person: NotificationParticipant) =>
    (showNicknames && person.nickname) || (group.isGroup && person.firstName) || person.name;
  if (!group.isGroup) {
    const person = namedParticipant(title, group);
    return { title: person ? displayName(person) : title, body };
  }
  // The row path knows which field it rendered. A native page notification
  // only gives text, so it needs a known group title before we infer a role.
  const kind =
    titleKind === "unknown" && group.title
      ? normalizeSenderName(title) === normalizeSenderName(group.title)
        ? "group"
        : "sender"
      : titleKind;
  const person = kind === "sender" ? namedParticipant(title, group) : undefined;
  const prefix = kind === "group" ? prefixedParticipant(body, group) : undefined;
  return {
    title: person ? displayName(person) : title,
    body: prefix ? `${displayName(prefix.person)}: ${body.slice(prefix.end)}` : body,
  };
}

interface Query {
  getKeyRange(key: unknown): Query;
  take(limit: number): Query;
}
interface MessengerQueries {
  fromTableAscending(table: unknown): Query;
  leftJoin(left: Query, right: Query): Query;
  toArrayAsync(query: Query): Promise<unknown>;
}
interface MessengerDatabase {
  tables: {
    threads: { get(key: unknown): Promise<unknown> };
    participants: unknown;
    contacts: unknown;
  };
}

const PARTICIPANT_LIMIT = 500;

/** Read the exact conversation's local data, including unopened chats; never write to Messenger. */
export async function readConversationNotificationNames(
  threadId: string,
  importModule: unknown,
  timeoutMs = 750,
): Promise<ConversationNotificationNames | null> {
  if (!/^\d+$/.test(threadId) || typeof importModule !== "function") return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async (): Promise<ConversationNotificationNames | null> => {
    // These are Messenger's existing read APIs. A changed ABI, missing module,
    // unready database or incomplete membership must retain the original text.
    const singleton = importModule("LSDatabaseSingleton") as {
      LSDatabaseSingleton: Promise<MessengerDatabase>;
    };
    const db = await singleton.LSDatabaseSingleton;
    const i64 = importModule("I64") as { of_string(value: string): unknown };
    const q = importModule("ReQL") as MessengerQueries;
    const types = importModule("LSMessagingThreadTypeUtil") as {
      isGroup(type: unknown): boolean;
      isOneToOne(type: unknown): boolean;
    };
    const key = i64.of_string(threadId);
    const thread = await db.tables.threads.get(key);
    if (!thread || typeof thread !== "object" || !("threadType" in thread)) return null;
    const isGroup = types.isGroup(thread.threadType) === true;
    if (!isGroup && types.isOneToOne(thread.threadType) !== true) return null;
    const rows = await q.toArrayAsync(
      q
        .leftJoin(
          q.fromTableAscending(db.tables.participants).getKeyRange(key),
          q.fromTableAscending(db.tables.contacts),
        )
        .take(PARTICIPANT_LIMIT + 1),
    );
    if (!Array.isArray(rows) || !rows.length || rows.length > PARTICIPANT_LIMIT) return null;
    let photo: unknown;
    try {
      photo = importModule("getLSMediaContactProfilePictureUrl");
    } catch (_) {}
    const participants: NotificationParticipant[] = [];
    for (const row of rows) {
      if (!Array.isArray(row)) return null;
      const [participant, contact]: unknown[] = row;
      if (
        !participant ||
        typeof participant !== "object" ||
        !contact ||
        typeof contact !== "object"
      )
        return null;
      const p = participant as Record<string, unknown>;
      const c = contact as Record<string, unknown>;
      if (typeof c.name !== "string" || !c.name.trim()) return null;
      let avatar: unknown;
      try {
        if (typeof photo === "function") avatar = photo(contact);
      } catch (_) {}
      participants.push({
        name: c.name,
        firstName: typeof c.firstName === "string" ? c.firstName : "",
        nickname: typeof p.nickname === "string" ? p.nickname : "",
        avatar: typeof avatar === "string" ? avatar : "",
      });
    }
    return {
      isGroup,
      title:
        "threadName" in thread && typeof thread.threadName === "string" ? thread.threadName : "",
      participants,
    };
  };
  try {
    return await Promise.race([
      read().catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
