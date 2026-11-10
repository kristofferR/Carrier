/*
 * The signed-in account's name and picture for the top of Settings →
 * Account: the name Facebook's page knows the account by (CurrentUser), and
 * the picture of the account's own row in Messenger's contacts table, chosen
 * the way Messenger chooses a contact's picture.
 */
import { defaultExport, type Load } from "./facebook-loader";
import { readMessengerDatabase } from "./messenger-db";

export interface MessengerProfile {
  name: string | null;
  /** A PNG data URL. */
  picture: string | null;
}

interface ContactRow {
  name?: unknown;
}

/** MAWVault's at-rest marker: such text is sealed, not a name. */
const VAULTED = /\d{10}##\d{10}/;

function nameOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name && !VAULTED.test(name) ? name : null;
}

/**
 * Reads the profile of `account` (the signed-in user's id). `toPicture`
 * redraws the picture's URL as a PNG data URL, or "" when it can't.
 */
export async function readMessengerProfile(
  load: Load | null,
  account: string,
  toPicture: (url: string) => Promise<string>,
): Promise<MessengerProfile> {
  const contact = await readMessengerDatabase(
    load,
    ({ db, i64 }) =>
      (db.tables.contacts as { get(key: unknown): Promise<unknown> }).get(i64.of_string(account)),
    3000,
  );
  const row = contact && typeof contact === "object" ? (contact as ContactRow) : null;
  let name: string | null = null;
  try {
    name = nameOf((load?.("CurrentUser") as { getName?(): unknown } | undefined)?.getName?.());
  } catch {}
  name ??= nameOf(row?.name);

  let url: unknown;
  try {
    const pictureOf = defaultExport(load?.("getLSMediaContactProfilePictureUrl"));
    if (row && typeof pictureOf === "function") url = pictureOf(row);
  } catch {}
  const picture = typeof url === "string" && url.startsWith("https://") ? await toPicture(url) : "";
  return { name, picture: picture || null };
}
