import { describe, expect, test } from "bun:test";
import {
  keyboardMenuPoint,
  menuRowAction,
  messageActions,
  reactionLabel,
  toolbarAction,
  uniqueReactions,
} from "./message-menu";

describe("message actions", () => {
  test("reads Messenger's More rows and toolbar buttons", () => {
    expect(menuRowAction(" Remove ")).toBe("Remove");
    expect(menuRowAction("Unsend")).toBe("Unsend");
    expect(menuRowAction("Reply")).toBe("Reply");
    expect(menuRowAction("Report")).toBeNull();
    expect(menuRowAction("Copy text")).toBeNull();
    expect(toolbarAction("Reply to this message")).toBe("Reply");
    expect(toolbarAction("Forward")).toBe("Forward");
    expect(toolbarAction("React with an emoji")).toBeNull();
    expect(toolbarAction("More actions")).toBeNull();
  });

  test("lists only what the message offers, in menu order", () => {
    expect(
      messageActions({ reactions: [], text: "hi", actions: ["Remove", "Pin", "Forward", "Reply"] }),
    ).toEqual(["Reply", "Copy text", "Forward", "Pin", "Remove"]);
    // A photo: no text to copy, Reply from More, Forward from the toolbar.
    expect(messageActions({ reactions: [], text: "", actions: ["Forward", "Reply"] })).toEqual([
      "Reply",
      "Forward",
    ]);
    // A call entry offers only Remove.
    expect(messageActions({ reactions: [], text: "", actions: ["Remove"] })).toEqual(["Remove"]);
  });
});

describe("reactions", () => {
  test("drops empty and repeated emoji", () => {
    expect(
      uniqueReactions([
        { emoji: "❤", checked: false },
        { emoji: "", checked: false },
        { emoji: "❤", checked: true },
        { emoji: "👍", checked: true },
      ]),
    ).toEqual([
      { emoji: "❤", checked: false },
      { emoji: "👍", checked: true },
    ]);
  });

  test("asks for emoji presentation of text-style symbols only", () => {
    expect(reactionLabel("❤")).toBe("❤️");
    expect(reactionLabel("❤️")).toBe("❤️");
    expect(reactionLabel("👍")).toBe("👍");
    expect(reactionLabel("😆")).toBe("😆");
  });
});

describe("keyboard menu placement", () => {
  const target = { x: 100, y: 100, width: 200, height: 50 };
  const anchor = { x: 120.4, y: 110, width: 80, height: 20.6 };

  test("a right-click inside the message pops up at the pointer", () => {
    expect(keyboardMenuPoint({ x: 150, y: 120 }, target, anchor)).toBeNull();
  });

  test("a key press pops up under the message text", () => {
    expect(keyboardMenuPoint({ x: -1, y: -1 }, target, anchor)).toEqual([120, 131]);
    expect(keyboardMenuPoint({ x: 0, y: 0 }, { ...target, x: 0, y: 0 }, anchor)).toEqual([
      120, 131,
    ]);
  });
});
