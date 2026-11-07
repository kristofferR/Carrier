/*
 * Notification quick actions through Messenger's own code (Ref #368). Neither
 * navigates nor needs the window, so both work while Carrier is hidden.
 *
 * - Mark as Read calls `MWLSMarkThreadAsRead`, the function behind the inbox's
 *   "Mark as read", which handles encrypted and regular chats alike.
 * - React follows `MAWPSendOrRemoveReaction`: an encrypted chat sends through
 *   the MAW bridge's `sendReactionMsg` (as `MAWSendOrRemoveReaction` does), a
 *   regular chat runs `LSOptimisticUpsertReaction` (as
 *   `useMWPSendOrUnsendReaction` does). Both are hooks, so the plain modules
 *   they call are used directly.
 *
 * A changed module or ABI throws or reports a reason; native then opens the
 * conversation instead.
 */

export type Load = (name: string) => unknown;

/** "ok", or a content-free reason the action stopped. */
export type ActionOutcome = string;

interface I64 {
  of_string(value: string): unknown;
  to_string(value: unknown): unknown;
  of_float(value: number): unknown;
  gt(a: unknown, b: unknown): boolean;
}

interface Transaction {
  messages: { index(name: string): { get(key: unknown): Promise<unknown> } };
  reactions: { get(thread: unknown, message: unknown, actor: unknown): Promise<unknown> };
}

interface Database {
  tables: { threads: { get(key: unknown): Promise<unknown> } };
  runInTransaction<T>(
    run: (tx: Transaction) => Promise<T> | T,
    mode: "readonly" | "readwrite",
    ...trace: unknown[]
  ): Promise<T>;
}

const TRACE = "CarrierNotificationActions";
// How an action reached the conversation, for Messenger's attribution.
const ENTRYPOINT = "notificationInThreadReply";

/** A module's function export: `member`, or the module itself / its default. */
function exported<T>(load: Load, name: string, member?: string): T {
  const mod = load(name) as Record<string, unknown> | null | undefined;
  const value = member
    ? mod?.[member]
    : typeof mod === "function"
      ? mod
      : (mod as { default?: unknown } | null | undefined)?.default;
  if (typeof value !== "function") throw new Error(`${name} changed`);
  return value as T;
}

async function database(load: Load) {
  const singleton = load("LSDatabaseSingleton") as { LSDatabaseSingleton?: Promise<Database> };
  const db = await singleton?.LSDatabaseSingleton;
  const i64 = load("I64") as I64;
  if (
    typeof db?.runInTransaction !== "function" ||
    typeof db.tables?.threads?.get !== "function" ||
    typeof i64?.of_string !== "function"
  )
    throw new Error("Messenger database APIs changed");
  return { db, i64 };
}

const record = (value: unknown) =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

/**
 * Mark a conversation read as Messenger's inbox does, then confirm from its
 * row: read once the read watermark reaches the last activity.
 */
export async function markThreadRead(
  load: Load,
  threadId: string,
  deadline: number,
  wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
): Promise<ActionOutcome> {
  const { db, i64 } = await database(load);
  const key = i64.of_string(threadId);
  const markRead = exported<(db: Database, key: unknown) => Promise<unknown>>(
    load,
    "MWLSMarkThreadAsRead",
  );
  // Native has already given up and opened the conversation.
  if (Date.now() >= deadline) return "expired";
  await markRead(db, key);
  while (true) {
    const thread = record(await db.tables.threads.get(key));
    if (!thread) return "thread-missing";
    if (!i64.gt(thread.lastActivityTimestampMs, thread.lastReadWatermarkTimestampMs)) return "ok";
    if (Date.now() >= deadline) return "not-confirmed";
    await wait(200);
  }
}

export interface ReactionRequest {
  threadId: string;
  messageId: string;
  /** The signed-in account, which must not have sent the message. */
  account: string;
  reaction: string;
  /** Past this, native has given up: never react afterwards. */
  deadline: number;
}

/** Add `reaction` to exactly the message a notification named. */
export async function reactToMessage(load: Load, request: ReactionRequest): Promise<ActionOutcome> {
  const { db, i64 } = await database(load);
  const message = record(
    await db.runInTransaction(
      (tx) => tx.messages.index("messageId").get(request.messageId),
      "readonly",
      undefined,
      undefined,
      TRACE,
    ),
  );
  if (!message) return "message-missing";
  const threadKey = message.threadKey;
  // The message must belong to the notification's conversation, and never be
  // one this account sent.
  if (String(i64.to_string(threadKey)) !== request.threadId) return "thread-mismatch";
  const sender = String(i64.to_string(message.senderId));
  if (sender === request.account) return "own-message";
  const thread = record(await db.tables.threads.get(threadKey));
  if (!thread) return "thread-missing";
  const types = load("LSMessagingThreadTypeUtil") as {
    isArmadilloSecure(type: unknown): boolean;
  };
  const attribution = exported<(thread: unknown, entrypoint: string) => unknown>(
    load,
    "LSThreadAttributionTypeUtil",
    "getSourceWithoutReset",
  );
  const source = attribution(threadKey, ENTRYPOINT);

  if (types.isArmadilloSecure(thread.threadType)) {
    const msgId = exported<(id: string) => string | null>(
      load,
      "MAWDbMsg",
      "toMsgId",
    )(request.messageId);
    if (!msgId) return "message-id";
    const ready = await exported<
      (tables: unknown, key: unknown, description: string) => Promise<{ chatJid?: unknown }>
    >(load, "MAWMiActOnActThreadReady", "waitForACTThreadReady")(db.tables, threadKey, TRACE);
    const protocolId = await exported<(id: string) => Promise<unknown>>(
      load,
      "MAWGetProtocolMsgIdByMsgIdInUI",
      "getProtocolMsgIdByMsgIdUI",
    )(msgId);
    if (!ready?.chatJid || !protocolId) return "protocol-id";
    if (Date.now() >= request.deadline) return "expired";
    let qplEventType: unknown;
    try {
      qplEventType = exported<(id: number, token: string) => unknown>(
        load,
        "qpl",
        "_",
      )(25313175, "1551");
    } catch (_) {}
    const result = await exported<
      (backend: string, route: string, payload: unknown) => Promise<unknown>
    >(load, "MAWBridgeSendAndReceive", "sendAndReceive")("backend", "sendReactionMsg", {
      args: {
        groupIndex: undefined,
        groupingKey: "",
        reaction: request.reaction,
        reactToAuthor: sender,
        reactToProtocolMsgId: protocolId,
        source,
      },
      chatJid: ready.chatJid,
      externalId: exported<() => unknown>(load, "MAWExternalId", "generateExternalId")(),
      qplEventType,
      qplInstanceKey: undefined,
    });
    return record(result)?.success === false ? "bridge-refused" : "ok";
  }

  // Reactions V2 (communities and channels) take a different procedure.
  const v2 = exported<(thread: unknown) => boolean>(
    load,
    "useIsReactionsV2Enabled",
    "isReactionsV2Enabled",
  );
  if (v2(thread)) return "reactions-v2";
  const actorId = i64.of_string(request.account);
  const mine = record(
    await db.runInTransaction(
      (tx) => tx.reactions.get(threadKey, message.messageId, actorId),
      "readonly",
      undefined,
      undefined,
      TRACE,
    ),
  );
  if (mine?.reaction === request.reaction) return "ok";
  if (Date.now() >= request.deadline) return "expired";
  const factory = exported<(tx: Transaction) => unknown>(load, "LSFactory");
  const upsert = exported<(factory: unknown, args: unknown) => Promise<unknown>>(
    load,
    "LSOptimisticUpsertReactionStoredProcedure",
  );
  await db.runInTransaction(
    (tx) =>
      upsert(factory(tx), {
        actorId,
        messageId: message.messageId,
        reaction: request.reaction,
        sendAttribution: source,
        threadKey,
        timestampMs: i64.of_float(Date.now()),
      }),
    "readwrite",
    undefined,
    undefined,
    TRACE,
  );
  return "ok";
}
