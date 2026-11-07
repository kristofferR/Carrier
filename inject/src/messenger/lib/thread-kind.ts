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

/** Whether a notification for this conversation should be held back as a group message. */
export async function suppressAsGroupChat(
  notifyGroupChats: boolean | undefined,
  threadId: string | null,
  isGroup: (threadId: string) => Promise<boolean | null>,
): Promise<boolean> {
  if (notifyGroupChats !== false || !threadId) return false;
  return (await isGroup(threadId)) === true;
}
