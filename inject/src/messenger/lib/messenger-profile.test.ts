import { describe, expect, test } from "bun:test";
import { readMessengerProfile } from "./messenger-profile";

const PICTURE = "https://scontent.example/me.jpg";

function page(contact: object | null, currentName: unknown = "Ada Lovelace") {
  const keys: unknown[] = [];
  const modules: Record<string, unknown> = {
    LSDatabaseSingleton: {
      LSDatabaseSingleton: Promise.resolve({
        tables: {
          threads: { get: async () => null },
          contacts: {
            get: async (key: unknown) => {
              keys.push(key);
              return contact;
            },
          },
        },
      }),
    },
    I64: { of_string: (value: string) => `key:${value}` },
    CurrentUser: { getName: () => currentName },
    getLSMediaContactProfilePictureUrl: {
      default: (row: { profilePictureUrl?: string }) => row.profilePictureUrl,
    },
  };
  return { keys, load: (name: string) => modules[name] };
}

const redraw = async (url: string) => `drawn:${url}`;

describe("Messenger profile", () => {
  test("names the account as Facebook does and redraws its own contact's picture", async () => {
    const h = page({ name: "Ada L.", profilePictureUrl: PICTURE });
    expect(await readMessengerProfile(h.load, "42", redraw)).toEqual({
      name: "Ada Lovelace",
      picture: `drawn:${PICTURE}`,
    });
    expect(h.keys).toEqual(["key:42"]);
  });

  test("falls back to the contact's name, never a sealed one", async () => {
    expect(
      (await readMessengerProfile(page({ name: " Ada L. " }, null).load, "42", redraw)).name,
    ).toBe("Ada L.");
    const sealed = page({ name: "1234567890##1234567890abc" }, "");
    expect((await readMessengerProfile(sealed.load, "42", redraw)).name).toBeNull();
  });

  test("reports no picture for a missing contact, a non-https URL or a failed redraw", async () => {
    const empty = { name: null, picture: null };
    expect(await readMessengerProfile(page(null, null).load, "42", redraw)).toEqual(empty);
    const local = page({ profilePictureUrl: "javascript:alert(1)" }, null);
    expect(await readMessengerProfile(local.load, "42", redraw)).toEqual(empty);
    const failed = page({ profilePictureUrl: PICTURE }, null);
    expect(await readMessengerProfile(failed.load, "42", async () => "")).toEqual(empty);
  });
});
