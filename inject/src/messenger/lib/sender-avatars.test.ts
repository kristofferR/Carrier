import { describe, expect, test } from "bun:test";
import { avatarPhotoId, SENDER_AVATAR_STORAGE_KEY, SenderAvatarStore } from "./sender-avatars";

const memoryStorage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};

const THREAD = "100";
const OTHER_THREAD = "200";

describe("SenderAvatarStore", () => {
  test("looks a sender up by their exact name", () => {
    const store = new SenderAvatarStore();
    store.remember(THREAD, "Kim", "https://cdn/kim.jpg");
    expect(store.lookup(THREAD, "kim")).toBe("https://cdn/kim.jpg");
    expect(store.lookup(THREAD, " Kim ")).toBe("https://cdn/kim.jpg");
    expect(store.lookup(THREAD, "Jane")).toBe("");
    expect(store.lookup(THREAD, "")).toBe("");
    expect(store.lookup("", "Kim")).toBe("");
  });

  test("keeps threads apart so namesakes cannot borrow a face", () => {
    const store = new SenderAvatarStore();
    store.remember(THREAD, "Kim Andersen", "https://cdn/kim-a.jpg");
    store.remember(OTHER_THREAD, "Kim Andersen", "https://cdn/kim-b.jpg");
    expect(store.lookup(THREAD, "Kim Andersen")).toBe("https://cdn/kim-a.jpg");
    expect(store.lookup(OTHER_THREAD, "Kim Andersen")).toBe("https://cdn/kim-b.jpg");
    // A thread nobody was harvested in resolves to nothing at all.
    expect(store.lookup("300", "Kim Andersen")).toBe("");
  });

  test("resolves a preview's short name against a unique full name", () => {
    const store = new SenderAvatarStore();
    store.remember(THREAD, "Kim Andersen", "https://cdn/kim.jpg");
    expect(store.lookup(THREAD, "Kim")).toBe("https://cdn/kim.jpg");
    // Two members of the same group share the short name: the group photo
    // beats the wrong face.
    store.remember(THREAD, "Kim Berg", "https://cdn/kim-berg.jpg");
    expect(store.lookup(THREAD, "Kim")).toBe("");
    expect(store.lookup(THREAD, "Kim Berg")).toBe("https://cdn/kim-berg.jpg");
  });

  test("poisons a short-name alias two people answer to", () => {
    const store = new SenderAvatarStore();
    store.remember(THREAD, "Kim", "https://cdn/kim.jpg", "Kim Andersen");
    expect(store.lookup(THREAD, "Kim")).toBe("https://cdn/kim.jpg");
    expect(store.remember(THREAD, "Kim", "https://cdn/kim-berg.jpg", "Kim Berg")).toBe(true);
    expect(store.lookup(THREAD, "Kim")).toBe("");
    // Sticky: the first owner cannot reclaim it either.
    expect(store.remember(THREAD, "Kim", "https://cdn/kim.jpg", "Kim Andersen")).toBe(false);
    expect(store.lookup(THREAD, "Kim")).toBe("");
    // Another thread's "Kim" is untouched by that conflict.
    store.remember(OTHER_THREAD, "Kim", "https://cdn/kim.jpg", "Kim Andersen");
    expect(store.lookup(OTHER_THREAD, "Kim")).toBe("https://cdn/kim.jpg");
  });

  test("keeps refreshing one owner's rotating avatar URL", () => {
    const store = new SenderAvatarStore();
    store.remember(THREAD, "Kim", "https://cdn/kim.jpg?token=old", "Kim Andersen");
    expect(store.remember(THREAD, "Kim", "https://cdn/kim.jpg?token=new", "Kim Andersen")).toBe(
      true,
    );
    expect(store.lookup(THREAD, "Kim")).toBe("https://cdn/kim.jpg?token=new");
  });

  test("ignores empty pairings and re-seen ones", () => {
    const store = new SenderAvatarStore();
    expect(store.remember(THREAD, "", "https://cdn/kim.jpg")).toBe(false);
    expect(store.remember("", "Kim", "https://cdn/kim.jpg")).toBe(false);
    expect(store.remember(THREAD, "Kim", "")).toBe(false);
    expect(store.remember(THREAD, "Kim", "https://cdn/kim.jpg")).toBe(true);
    // The same faces re-render on every scan; that must not rewrite storage.
    expect(store.remember(THREAD, "Kim", "https://cdn/kim.jpg")).toBe(false);
    // A re-signed URL for the same photo is a refresh, not a second person.
    expect(store.remember(THREAD, "Kim", "https://cdn/kim.jpg?oh=new")).toBe(true);
    expect(store.lookup(THREAD, "Kim")).toBe("https://cdn/kim.jpg?oh=new");
  });

  test("evicts the least recently updated sender past the limit", () => {
    const store = new SenderAvatarStore(null, 2);
    store.remember(THREAD, "Kim", "https://cdn/kim.jpg");
    store.remember(THREAD, "Jane", "https://cdn/jane.jpg");
    // Kim's avatar URL was re-signed, which makes Jane the oldest entry.
    store.remember(THREAD, "Kim", "https://cdn/kim.jpg?oh=new");
    store.remember(THREAD, "John", "https://cdn/john.jpg");
    expect(store.size).toBe(2);
    expect(store.lookup(THREAD, "Jane")).toBe("");
    expect(store.lookup(THREAD, "Kim")).toBe("https://cdn/kim.jpg?oh=new");
  });

  test("survives the auto-refresh reload through storage", () => {
    const storage = memoryStorage();
    new SenderAvatarStore(storage).remember(THREAD, "Kim", "https://cdn/kim.jpg", "Kim Andersen");
    const reloaded = new SenderAvatarStore(storage);
    expect(reloaded.lookup(THREAD, "Kim")).toBe("https://cdn/kim.jpg");
    // The owner survives too, so a second Kim still poisons the alias.
    expect(reloaded.remember(THREAD, "Kim", "https://cdn/kim-berg.jpg", "Kim Berg")).toBe(true);
    expect(reloaded.lookup(THREAD, "Kim")).toBe("");
  });

  test("gives up on a name two members of one thread wear", () => {
    const store = new SenderAvatarStore();
    store.remember(THREAD, "Kim Andersen", "https://cdn/kim.jpg");
    expect(store.markAmbiguous(THREAD, "Kim Andersen")).toBe(true);
    expect(store.lookup(THREAD, "Kim Andersen")).toBe("");
    // Sticky, and confined to the thread that has the collision.
    expect(store.remember(THREAD, "Kim Andersen", "https://cdn/kim.jpg")).toBe(false);
    expect(store.markAmbiguous(THREAD, "Kim Andersen")).toBe(false);
    store.remember(OTHER_THREAD, "Kim Andersen", "https://cdn/kim.jpg");
    expect(store.lookup(OTHER_THREAD, "Kim Andersen")).toBe("https://cdn/kim.jpg");
    expect(store.markAmbiguous(THREAD, "")).toBe(false);
    expect(store.markAmbiguous("", "Kim")).toBe(false);
  });

  test("reads two faces for one name, passes apart, as two people", () => {
    const store = new SenderAvatarStore();
    store.remember(THREAD, "Kim Andersen", "https://cdn/kim-a.jpg", "Kim Andersen", 1_000);
    // Virtualization can surface the other Kim Andersen in a later pass.
    expect(
      store.remember(THREAD, "Kim Andersen", "https://cdn/kim-b.jpg", "Kim Andersen", 30_000),
    ).toBe(true);
    expect(store.lookup(THREAD, "Kim Andersen")).toBe("");
  });

  test("accepts a genuinely new profile picture later on", () => {
    const store = new SenderAvatarStore();
    store.remember(THREAD, "Kim", "https://cdn/kim-a.jpg", "Kim", 1_000);
    expect(store.remember(THREAD, "Kim", "https://cdn/kim-b.jpg", "Kim", 1_000 + 6 * 60_000)).toBe(
      true,
    );
    expect(store.lookup(THREAD, "Kim")).toBe("https://cdn/kim-b.jpg");
  });

  test("retires the short names an ambiguous full name owns", () => {
    const store = new SenderAvatarStore();
    store.remember(THREAD, "Kim Andersen", "https://cdn/kim.jpg");
    store.remember(THREAD, "Kim", "https://cdn/kim.jpg", "Kim Andersen");
    expect(store.lookup(THREAD, "Kim")).toBe("https://cdn/kim.jpg");
    // A second Kim Andersen turns up: the alias cannot survive its owner.
    store.markAmbiguous(THREAD, "Kim Andersen");
    expect(store.lookup(THREAD, "Kim")).toBe("");
    expect(store.describe(THREAD, "Kim")).toBe("ambiguous");
    // Another thread's alias for that name is untouched.
    store.remember(OTHER_THREAD, "Kim", "https://cdn/kim.jpg", "Kim Andersen");
    expect(store.lookup(OTHER_THREAD, "Kim")).toBe("https://cdn/kim.jpg");
  });

  test("keeps a collision after its avatars are evicted", () => {
    const storage = memoryStorage();
    const store = new SenderAvatarStore(storage, 1);
    store.markAmbiguous(THREAD, "Kim");
    // Fill the tiny avatar cache; the collision must not be what gets evicted.
    store.remember(THREAD, "Jane", "https://cdn/jane.jpg");
    store.remember(THREAD, "John", "https://cdn/john.jpg");
    expect(store.remember(THREAD, "Kim", "https://cdn/kim.jpg")).toBe(false);
    expect(store.lookup(THREAD, "Kim")).toBe("");
    expect(new SenderAvatarStore(storage, 1).lookup(THREAD, "Kim")).toBe("");
  });

  test("reads a collision recorded by an earlier build", () => {
    const stored = memoryStorage({
      [SENDER_AVATAR_STORAGE_KEY]: JSON.stringify({
        version: 3,
        entries: [[`${THREAD}\u0000kim`, "", "kim andersen"]],
      }),
    });
    const store = new SenderAvatarStore(stored);
    expect(store.lookup(THREAD, "Kim")).toBe("");
    expect(store.remember(THREAD, "Kim", "https://cdn/kim.jpg")).toBe(false);
  });

  test("explains a verdict for the dev probe", () => {
    const store = new SenderAvatarStore();
    expect(store.describe(THREAD, "")).toBe("no-sender");
    expect(store.describe(THREAD, "Kim")).toBe("miss");
    store.remember(THREAD, "Kim Andersen", "https://cdn/kim.jpg");
    expect(store.describe(THREAD, "Kim")).toBe("full-name");
    expect(store.describe(THREAD, "Kim Andersen")).toBe("exact");
    store.markAmbiguous(THREAD, "Kim Andersen");
    expect(store.describe(THREAD, "Kim Andersen")).toBe("ambiguous");
    expect(store.stats).toEqual({ avatars: 0, groups: 0, retired: 1 });
  });

  test("remembers which threads are groups, across a reload", () => {
    const storage = memoryStorage();
    const store = new SenderAvatarStore(storage);
    expect(store.isGroupThread(THREAD)).toBe(false);
    expect(store.rememberGroupThread(THREAD)).toBe(true);
    expect(store.rememberGroupThread(THREAD)).toBe(false);
    expect(store.isGroupThread(THREAD)).toBe(true);
    expect(new SenderAvatarStore(storage).isGroupThread(THREAD)).toBe(true);
    expect(new SenderAvatarStore(storage).isGroupThread(OTHER_THREAD)).toBe(false);
  });

  test("ignores unusable stored payloads and re-bounds oversized ones", () => {
    expect(new SenderAvatarStore(memoryStorage({ [SENDER_AVATAR_STORAGE_KEY]: "{" })).size).toBe(0);
    expect(
      new SenderAvatarStore(
        memoryStorage({ [SENDER_AVATAR_STORAGE_KEY]: JSON.stringify(["kim", "url"]) }),
      ).size,
    ).toBe(0);
    const oversized = memoryStorage({
      [SENDER_AVATAR_STORAGE_KEY]: JSON.stringify({
        version: 3,
        entries: [
          [`${THREAD} kim`, "https://cdn/kim.jpg", "kim"],
          [`${THREAD} jane`, "https://cdn/jane.jpg", "jane"],
          [`${THREAD} john`, 7, "john"],
        ],
      }),
    });
    const store = new SenderAvatarStore(oversized, 1);
    expect(store.size).toBe(1);
    expect(store.lookup(THREAD, "Jane")).toBe("https://cdn/jane.jpg");
    expect(oversized.getItem(SENDER_AVATAR_STORAGE_KEY)).toContain("jane");
  });
});

describe("avatarPhotoId", () => {
  test("ignores the signature and size a CDN URL varies by", () => {
    const photo = "https://scontent.xx.fbcdn.net/v/t39.30808-1/1_2_3_n.jpg";
    expect(avatarPhotoId(`${photo}?stp=dst-jpg_s60x60&oh=aaa&oe=bbb`)).toBe(
      avatarPhotoId(`${photo}?stp=dst-jpg_s28x28&oh=ccc&oe=ddd`),
    );
  });

  test("keeps two different photos apart, and survives a junk URL", () => {
    expect(avatarPhotoId("https://cdn/v/one_n.jpg")).not.toBe(
      avatarPhotoId("https://cdn/v/two_n.jpg"),
    );
    expect(avatarPhotoId("not a url")).toBe("/not%20a%20url");
  });
});
