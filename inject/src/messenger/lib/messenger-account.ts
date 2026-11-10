/*
 * Messenger's own account settings (Ref #358): Active Status, Do Not Disturb
 * and read receipts, read and changed the way Messenger's own
 * dialogs and menus do, so they sync to the account. Idea from fMess
 * (github.com/toanbku/fmess, MIT).
 */
import { t } from "../../i18n";
import { defaultExport, type Load, loadFacebookModules } from "./facebook-loader";
import { readMessengerDndUntil } from "./messenger-dnd";

export interface MessengerAccountState {
  activeStatus: boolean | null;
  /** Seconds since 1970 when Do Not Disturb ends: 0 off, -1 until turned off. */
  dndUntil: number | null;
  /** Whether people see when you've read their messages (and you theirs). */
  readReceipts: boolean | null;
}

export type MessengerAccountChange =
  | { setting: "activeStatus"; value: boolean }
  /** Minutes: 0 turns it off, -1 until turned off. */
  | { setting: "doNotDisturb"; value: number }
  | { setting: "readReceipts"; value: boolean };

interface Relay {
  fetchQuery(
    environment: unknown,
    query: unknown,
    variables: object,
    options?: object,
  ): { toPromise(): Promise<unknown> };
}

export interface ChatSettingsViewer {
  chat_visibility?: unknown;
  chat_visibility_on_messenger?: unknown;
  chat_visibility_on_facebook?: unknown;
}

const flag = (value: unknown) => (typeof value === "boolean" ? value : null);

/** The state a chat settings query reports, Active Status resolved by Messenger's own rule. */
export function stateFromViewer(
  viewer: ChatSettingsViewer | null | undefined,
  resolveActiveStatus: (all: unknown, messenger: unknown, facebook: unknown) => unknown,
  dndUntil: number | null,
  readReceipts: boolean | null,
): MessengerAccountState {
  if (!viewer) return { activeStatus: null, dndUntil, readReceipts };
  const active = resolveActiveStatus(
    flag(viewer.chat_visibility),
    flag(viewer.chat_visibility_on_messenger),
    flag(viewer.chat_visibility_on_facebook),
  );
  return {
    activeStatus: flag(active),
    dndUntil,
    readReceipts,
  };
}

/** Messenger's LSReadReceiptSettingState. */
const READ_RECEIPTS_DEFAULT = 0;
const READ_RECEIPTS_DISABLED = 1;
const READ_RECEIPTS_ENABLED = 2;

/**
 * Whether read receipts are on, decided as useMWIsReadReceiptsDisabledForUser
 * does: the account's `messaging_privacy_settings` row when there is one (its
 * unset or default value means on), else the page's own
 * MessengerWebPrivacySettings. Null when neither is known.
 */
export function readReceiptsOn(
  row: { setting: number | null } | null,
  pageDefault: unknown,
): boolean | null {
  if (row) return (row.setting ?? READ_RECEIPTS_DEFAULT) !== READ_RECEIPTS_DISABLED;
  return typeof pageDefault === "number" ? pageDefault !== READ_RECEIPTS_DISABLED : null;
}

/** Do Not Disturb end for a change of `minutes` (0 off, -1 until turned off). */
export function dndUntilFor(minutes: number, nowMs: number): number {
  if (minutes === 0 || minutes === -1) return minutes;
  return Math.floor(nowMs / 1000) + minutes * 60;
}

/**
 * Some of the modules come only with the code of Messenger's Preferences
 * dialog, which it loads when the dialog first opens; load it the same way.
 */
async function loadPreferencesCode(load: Load | null): Promise<void> {
  const loadRoot = async (entrypoint: unknown) => {
    const root = (defaultExport(entrypoint) as { root?: { load?(): Promise<unknown> } }).root;
    if (typeof root?.load !== "function") throw new Error(t("page.account.preferences_changed"));
    await root.load();
  };
  const [dialog] = await loadFacebookModules(load, ["MWInboxSettingsDialog.entrypoint"]);
  await loadRoot(dialog);
  // Active Status has its own page, which the dialog's code references.
  const [presence] = await loadFacebookModules(load, ["MWInboxSettingsPresenceDialog.entrypoint"]);
  await loadRoot(presence);
}

/** The signed-in account's Messenger settings. Rejects when Messenger can't report them. */
export async function readMessengerAccount(
  load: Load | null,
  account: string,
): Promise<MessengerAccountState> {
  await loadPreferencesCode(load);
  const [environment, relay, query, resolve] = await loadFacebookModules(load, [
    "CometRelayEnvironment",
    "relay-runtime",
    "useCometHomeChatSettingsQuery.graphql",
    "resolveActiveStatus",
  ]);
  const data = (await (relay as Relay)
    .fetchQuery(defaultExport(environment), query, {}, { fetchPolicy: "network-only" })
    .toPromise()) as { viewer?: ChatSettingsViewer | null } | null;
  if (!data?.viewer) throw new Error(t("page.account.no_settings"));
  const dndUntil = await readMessengerDndUntil(account, load, 3000);
  return stateFromViewer(
    data.viewer,
    defaultExport(resolve) as (all: unknown, messenger: unknown, facebook: unknown) => unknown,
    dndUntil,
    await readReadReceipts(load, account),
  );
}

interface I64Module {
  zero: unknown;
  neg_one: unknown;
  of_float(value: number): unknown;
  of_string(value: string): unknown;
  to_float(value: unknown): number;
}

interface LSIntEnum {
  ofNumber(value: number): unknown;
  toNumber(value: unknown): number;
}

interface Database {
  runInTransaction(run: (tx: unknown) => unknown, mode: string): Promise<unknown>;
  tables?: { messaging_privacy_settings?: { get(key: unknown): Promise<unknown> } };
}

/** The account's read receipts setting, read where Messenger's own switch reads it. */
export async function readReadReceipts(
  load: Load | null,
  account: string,
  timeoutMs = 3000,
): Promise<boolean | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
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

  async function read(): Promise<boolean | null> {
    const [i64, database, intEnum] = (await loadFacebookModules(load, [
      "I64",
      "LSDatabaseSingleton",
      "LSIntEnum",
    ])) as [I64Module, { LSDatabaseSingleton: Promise<Database> }, LSIntEnum];
    const db = await database.LSDatabaseSingleton;
    const table = db.tables?.messaging_privacy_settings;
    const row = (
      typeof table?.get === "function" ? await table.get(i64.of_string(account)) : null
    ) as { readReceiptsDisabled?: unknown } | null;
    let pageDefault: unknown = null;
    try {
      // A server-sent configuration module; absent on some pages.
      pageDefault = (load?.("MessengerWebPrivacySettings") as { read_receipts_disabled?: unknown })
        ?.read_receipts_disabled;
    } catch {}
    return readReceiptsOn(
      row && typeof row === "object"
        ? {
            setting:
              row.readReceiptsDisabled == null ? null : intEnum.toNumber(row.readReceiptsDisabled),
          }
        : null,
      pageDefault,
    );
  }
}

/**
 * Read receipts the way Messenger's own "Show read receipts" switch
 * (MWReadReceiptsMenuItem) saves them: in the account's privacy settings,
 * which also tells Facebook's servers.
 */
async function setReadReceipts(load: Load | null, on: boolean) {
  // The stored procedure comes with the code of Messenger's settings menu
  // (the chat list's gear), which loads when that menu first opens.
  await loadFacebookModules(load, ["MWInboxSettingsMenu.react"]);
  const [database, factory, intEnum, update] = (await loadFacebookModules(load, [
    "LSDatabaseSingleton",
    "LSFactory",
    "LSIntEnum",
    "LSOptimisticallyUpdateMessagingPrivacySettingsStoredProcedure",
  ])) as [{ LSDatabaseSingleton: Promise<Database> }, unknown, LSIntEnum, unknown];
  const db = await database.LSDatabaseSingleton;
  const makeFactory = defaultExport(factory) as (tx: unknown) => unknown;
  const run = defaultExport(update) as (factory: unknown, input: object) => unknown;
  const value = intEnum.ofNumber(on ? READ_RECEIPTS_ENABLED : READ_RECEIPTS_DISABLED);
  await db.runInTransaction(
    (tx) => run(makeFactory(tx), { readReceiptsDisabled: value }),
    "readwrite",
  );
}

/** Changes one setting, then returns what Messenger reports afterwards. */
export async function changeMessengerAccount(
  load: Load | null,
  account: string,
  change: MessengerAccountChange,
): Promise<MessengerAccountState> {
  await loadPreferencesCode(load);
  if (change.setting === "activeStatus") {
    await setActiveStatus(load, change.value);
  } else if (change.setting === "readReceipts") {
    await setReadReceipts(load, change.value);
  } else {
    await setDoNotDisturb(load, account, change.value);
  }
  // Facebook may take a moment to report a saved change.
  for (let attempt = 0; ; attempt++) {
    const state = await readMessengerAccount(load, account);
    if (applied(state, change)) return state;
    if (attempt === 3) throw new Error(t("page.account.not_applied"));
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export function applied(state: MessengerAccountState, change: MessengerAccountChange): boolean {
  switch (change.setting) {
    case "activeStatus":
      return state.activeStatus === change.value;
    case "readReceipts":
      return state.readReceipts === change.value;
    case "doNotDisturb": {
      if (change.value <= 0) return state.dndUntil === change.value;
      // A timed one ends about `value` minutes from now.
      const expected = dndUntilFor(change.value, Date.now());
      return state.dndUntil !== null && Math.abs(state.dndUntil - expected) <= 120;
    }
  }
}

/**
 * Do Not Disturb the way Messenger's Preferences set it: the account-level
 * end time in its database (synced to the account), plus the copy this
 * browser's notifications check.
 */
async function setDoNotDisturb(load: Load | null, account: string, minutes: number) {
  const [i64, serverTime, database, factory, writer, update] = (await loadFacebookModules(load, [
    "I64",
    "ServerTime",
    "LSDatabaseSingleton",
    "LSFactory",
    "MessengerNotificationsWriter",
    "LSOptimisticallyUpdateGlobalMuteUntilStoredProcedure",
  ])) as [
    I64Module,
    { getMillis(): number },
    { LSDatabaseSingleton: Promise<Database> },
    unknown,
    { updateMute(account: string, until: number): void },
    unknown,
  ];
  const seconds = dndUntilFor(minutes, serverTime.getMillis());
  const until = seconds === 0 ? i64.zero : seconds < 0 ? i64.neg_one : i64.of_float(seconds);
  const db = await database.LSDatabaseSingleton;
  const makeFactory = defaultExport(factory) as (tx: unknown) => unknown;
  const run = defaultExport(update) as (factory: unknown, input: object) => unknown;
  await db.runInTransaction((tx) => run(makeFactory(tx), { globalMuteUntil: until }), "readwrite");
  writer.updateMute(account, seconds === 0 ? 0 : i64.to_float(until));
}

/**
 * Active Status the way Messenger's own switch saves it
 * (MWInboxSettingsPresenceMainPushPage): on shows it to everyone but the
 * people it was already hidden from, off hides it from everyone.
 */
async function setActiveStatus(load: Load | null, on: boolean) {
  const [environment, relay, mutation, report, database, gkx, qex] = await loadFacebookModules(
    load,
    [
      "CometRelayEnvironment",
      "CometRelay",
      "UpdatePresenceSettingsMutation.graphql",
      "MWPReportActiveSetting",
      "LSDatabaseSingleton",
      "gkx",
      "qex",
    ],
  );
  const messenger = (defaultExport(gkx) as (name: string) => boolean)("23433");
  const experiments = defaultExport(qex) as { _(name: string): unknown };
  // The experiment reads null outside Messenger's own dialog, and the
  // server then refuses a change without the platform.
  const withPlatform = experiments._(messenger ? "998" : "5461") !== false;
  const input: Record<string, unknown> = on
    ? { online_policy: "BLOCKLIST", web_allowlist: null, web_blocklist: null, web_visibility: true }
    : { online_policy: "ALLOWLIST", web_allowlist: [], web_visibility: false };
  if (withPlatform) input.platform = messenger ? "MESSENGER" : "FACEBOOK";
  const saved = new Promise<void>((resolve, reject) =>
    // CometRelay's commit adds the actor and mutation ids Facebook requires.
    (relay as { commitMutation(env: unknown, config: object): unknown }).commitMutation(
      defaultExport(environment),
      {
        mutation,
        variables: { input },
        onCompleted: (_response: unknown, errors: { message?: string }[] | null) =>
          errors?.length
            ? reject(new Error(errors[0]?.message || t("page.account.refused")))
            : resolve(),
        onError: reject,
      },
    ),
  );
  // Messenger also reports the switch to its local database when the
  // mutation doesn't carry the platform.
  const reported = withPlatform
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) =>
        (
          report as {
            reportActiveSetting(
              db: unknown,
              on: boolean,
              done: () => void,
              fail: (e: unknown) => void,
            ): void;
          }
        ).reportActiveSetting(
          (database as { LSDatabaseSingleton: unknown }).LSDatabaseSingleton,
          on,
          resolve,
          reject,
        ),
      );
  await Promise.all([saved, reported]);
}
