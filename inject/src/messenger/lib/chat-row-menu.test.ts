import { describe, expect, test } from "bun:test";
import {
  blockAction,
  type ChatRowComponents,
  chatRowAction,
  chatRowActions,
  classifyChatRow,
} from "./chat-row-menu";
import type { Fiber } from "./react-fiber";

/** The English menu read row by row, as the fallback does. */
const fromText = (texts: string[]) => chatRowActions(texts.map(chatRowAction));

describe("chat row menu", () => {
  test("keeps the rows Messenger offers a one-to-one chat", () => {
    expect(
      fromText([
        "Mark as unread",
        "Mute notifications",
        "View profile",
        "Block",
        "Archive chat",
        "Delete chat",
        "Report",
      ]),
    ).toEqual([
      "shared.context.mark_as_unread",
      "shared.context.mute_notifications",
      "shared.context.view_profile",
      "shared.context.block",
      "shared.context.archive_chat",
      "shared.context.delete_chat",
      "shared.context.report",
    ]);
  });

  test("drops calls and unknown rows from a group chat's menu", () => {
    expect(
      fromText([
        "Mark as read",
        "Mute notifications",
        "Start end-to-end encrypted chat",
        "Audio call",
        "Video chat",
        "Archive chat",
        "Delete chat",
        "Report",
        "Leave group",
        "Something new",
      ]),
    ).toEqual([
      "shared.context.mark_as_read",
      "shared.context.mute_notifications",
      "shared.context.start_encrypted_chat",
      "shared.context.archive_chat",
      "shared.context.delete_chat",
      "shared.context.report",
      "shared.context.leave_group",
    ]);
  });

  test("orders and dedupes rows the way the native menu expects", () => {
    expect(fromText(["Report", "Mark as unread", "Report"])).toEqual([
      "shared.context.mark_as_unread",
      "shared.context.report",
    ]);
  });

  test("matches whole labels only", () => {
    expect(chatRowAction("  Archive \n chat ")).toBe("shared.context.archive_chat");
    expect(chatRowAction("Archive")).toBeNull();
    expect(chatRowAction("Block Kim")).toBeNull();
    expect(chatRowAction("shared.context.block")).toBeNull();
  });
});

describe("classifyChatRow", () => {
  // Stand-ins for Messenger's components and icons.
  const c: ChatRowComponents = {
    markRead: () => null,
    mute: () => null,
    unmute: () => null,
    archive: () => null,
    unarchive: () => null,
    deleteChat: () => null,
    leaveGroup: { $$typeof: "memo", type: () => null },
    startEncryptedChat: () => null,
    block: () => null,
    menu: () => null,
    viewProfileIcon: () => null,
    reportIcons: [() => null],
  };
  const menuItem = () => null;
  const menuItemBase = () => null;
  /** A row's fibers from the DOM node up to the menu: host, the menu item's
   * base (which takes the rendered iconNode), menu item, wrapper, menu. */
  const row = (item: Record<string, unknown>, wrapper?: Fiber): Fiber => {
    const menu: Fiber = { type: c.menu, return: { type: "outside" } };
    const parent = wrapper ? { ...wrapper, return: menu } : menu;
    const fdsItem: Fiber = { type: menuItem, memoizedProps: item, return: parent };
    const base: Fiber = {
      type: menuItemBase,
      memoizedProps: { primaryText: item.primaryText, iconNode: {} },
      return: fdsItem,
    };
    return { type: "div", memoizedProps: {}, return: base };
  };

  test("names rows by their component, whatever their text", () => {
    const text = { primaryText: "Als ungelesen markieren" };
    expect(
      classifyChatRow(row(text, { type: c.markRead, memoizedProps: { isUnread: false } }), c),
    ).toBe("shared.context.mark_as_unread");
    expect(
      classifyChatRow(row(text, { type: c.markRead, memoizedProps: { isUnread: true } }), c),
    ).toBe("shared.context.mark_as_read");
    expect(classifyChatRow(row(text, { type: c.mute }), c)).toBe(
      "shared.context.mute_notifications",
    );
    expect(classifyChatRow(row(text, { type: c.unmute }), c)).toBe(
      "shared.context.unmute_notifications",
    );
    expect(classifyChatRow(row(text, { type: c.archive }), c)).toBe("shared.context.archive_chat");
    expect(classifyChatRow(row(text, { type: c.unarchive }), c)).toBe(
      "shared.context.unarchive_chat",
    );
    expect(classifyChatRow(row(text, { type: c.deleteChat }), c)).toBe(
      "shared.context.delete_chat",
    );
    expect(classifyChatRow(row(text, { type: c.startEncryptedChat }), c)).toBe(
      "shared.context.start_encrypted_chat",
    );
  });

  test("sees through memo wrappers", () => {
    const inner = (c.leaveGroup as { type: unknown }).type;
    expect(
      classifyChatRow(row({ primaryText: "x" }, { type: inner, elementType: c.leaveGroup }), c),
    ).toBe("shared.context.leave_group");
  });

  test("tells plain menu items apart by icon", () => {
    expect(classifyChatRow(row({ primaryText: "Profil", icon: c.viewProfileIcon }), c)).toBe(
      "shared.context.view_profile",
    );
    expect(classifyChatRow(row({ primaryText: "Melden", icon: c.reportIcons[0] }), c)).toBe(
      "shared.context.report",
    );
    // A call row, or anything new, is left out.
    expect(classifyChatRow(row({ primaryText: "Anruf", icon: () => null }), c)).toBeNull();
    expect(classifyChatRow(null, c)).toBeNull();
  });

  test("hands Block rows over with their contact, decided by its block state", () => {
    const kind = classifyChatRow(
      row({ primaryText: "Blockieren" }, { type: c.block, memoizedProps: { contactId: "7" } }),
      c,
    );
    expect(kind).toEqual({ blockContact: "7" });
    expect(blockAction(0)).toBe("shared.context.block");
    expect(blockAction(null)).toBe("shared.context.block");
    expect(blockAction(1)).toBe("shared.context.unblock");
    expect(blockAction(2)).toBe("shared.context.unblock");
  });

  test("stops at the menu, so components outside a row never count", () => {
    const outside: Fiber = { type: c.deleteChat, return: null };
    const menu: Fiber = { type: c.menu, return: outside };
    const item: Fiber = { type: menuItem, memoizedProps: { primaryText: "x" }, return: menu };
    expect(classifyChatRow({ type: "div", return: item }, c)).toBeNull();
  });
});
