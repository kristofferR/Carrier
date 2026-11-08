import { describe, expect, test } from "bun:test";
import { chatRowAction, chatRowActions } from "./chat-row-menu";

describe("chat row menu", () => {
  test("keeps the rows Messenger offers a one-to-one chat", () => {
    expect(
      chatRowActions([
        "Mark as unread",
        "Mute notifications",
        "View profile",
        "Block",
        "Archive chat",
        "Delete chat",
        "Report",
      ]),
    ).toEqual([
      "Mark as unread",
      "Mute notifications",
      "View profile",
      "Block",
      "Archive chat",
      "Delete chat",
      "Report",
    ]);
  });

  test("drops calls and unknown rows from a group chat's menu", () => {
    expect(
      chatRowActions([
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
      "Mark as read",
      "Mute notifications",
      "Start end-to-end encrypted chat",
      "Archive chat",
      "Delete chat",
      "Report",
      "Leave group",
    ]);
  });

  test("orders and dedupes rows the way the native menu expects", () => {
    expect(chatRowActions(["Report", "Mark as unread", "Report"])).toEqual([
      "Mark as unread",
      "Report",
    ]);
  });

  test("matches whole labels only", () => {
    expect(chatRowAction("  Archive \n chat ")).toBe("Archive chat");
    expect(chatRowAction("Archive")).toBeNull();
    expect(chatRowAction("Block Kim")).toBeNull();
  });
});
