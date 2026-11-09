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
    expect(chatRowActions(["Report", "Mark as unread", "Report"])).toEqual([
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
