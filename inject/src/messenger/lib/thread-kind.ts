/*
 * Whether a conversation is a group chat, from Messenger's local database
 * (Ref #368). Read-only; null whenever the answer is not certain.
 */

type Load = (name: string) => unknown;

export async function readThreadIsGroup(
  threadId: string,
  load: unknown,
  timeoutMs = 750,
): Promise<boolean | null> {
  if (!/^\d+$/.test(threadId) || typeof load !== "function") return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const singleton = (load as Load)("LSDatabaseSingleton") as {
      LSDatabaseSingleton: Promise<{
        tables?: { threads?: { get(key: unknown): Promise<unknown> } };
      }>;
    };
    const db = await singleton.LSDatabaseSingleton;
    const i64 = (load as Load)("I64") as { of_string?: (value: string) => unknown };
    const types = (load as Load)("LSMessagingThreadTypeUtil") as {
      isGroup?: (type: unknown) => unknown;
      isOneToOne?: (type: unknown) => unknown;
    };
    const threads = db?.tables?.threads;
    if (
      typeof threads?.get !== "function" ||
      typeof i64?.of_string !== "function" ||
      typeof types?.isGroup !== "function" ||
      typeof types.isOneToOne !== "function"
    ) {
      return null;
    }
    const thread = await threads.get(i64.of_string(threadId));
    if (!thread || typeof thread !== "object" || !("threadType" in thread)) return null;
    if (types.isGroup(thread.threadType) === true) return true;
    if (types.isOneToOne(thread.threadType) === true) return false;
    return null;
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

const KIND_LIMIT = 500;

/**
 * Known conversation kinds, filled ahead of delivery so the synchronous
 * notification decisions can read them. Only definite answers are kept.
 */
export class ThreadKindCache {
  private readonly kinds = new Map<string, boolean>();
  private readonly pending = new Map<string, Promise<boolean | null>>();

  constructor(private readonly read: (threadId: string) => Promise<boolean | null>) {}

  /** true for a known group chat, false for a known one-to-one, undefined if unknown. */
  isGroup(threadId: string): boolean | undefined {
    return this.kinds.get(threadId);
  }

  /** Read the kind once; concurrent callers share the read. */
  ensure(threadId: string): Promise<boolean | null> {
    const known = this.kinds.get(threadId);
    if (known !== undefined) return Promise.resolve(known);
    let read = this.pending.get(threadId);
    if (!read) {
      read = this.read(threadId)
        .catch(() => null)
        .then((isGroup) => {
          this.pending.delete(threadId);
          if (isGroup !== null) {
            this.kinds.set(threadId, isGroup);
            if (this.kinds.size > KIND_LIMIT) this.kinds.delete(this.kinds.keys().next().value!);
          }
          return isGroup;
        });
      this.pending.set(threadId, read);
    }
    return read;
  }
}

/** A group chat's notification is held back: the setting is off and the chat is a known group. */
export function suppressGroupChat(
  settings: { notify_group_chats?: boolean } | null | undefined,
  isGroup: boolean | undefined,
): boolean {
  return settings?.notify_group_chats === false && isGroup === true;
}
