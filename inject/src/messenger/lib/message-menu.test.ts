import { describe, expect, test } from "bun:test";
import type { ConversationTextNode } from "./conversation-row";
import {
  classifyMoreRow,
  classifyToolbarButton,
  keyboardMenuPoint,
  type MessageMenuComponents,
  menuRowAction,
  messageActions,
  messageNodeText,
  pinAction,
  REPLY_ICON_PATH,
  reactionLabel,
  toolbarAction,
  uniqueReactions,
} from "./message-menu";
import type { Fiber } from "./react-fiber";

describe("message actions", () => {
  test("reads Messenger's More rows and toolbar buttons", () => {
    expect(menuRowAction(" Remove ")).toBe("shared.context.remove");
    expect(menuRowAction("Unsend")).toBe("shared.context.unsend");
    expect(menuRowAction("Reply")).toBe("shared.context.reply");
    expect(menuRowAction("Report")).toBeNull();
    expect(menuRowAction("Copy text")).toBeNull();
    expect(menuRowAction("shared.context.reply")).toBeNull();
    expect(toolbarAction("Reply to this message")).toBe("shared.context.reply");
    expect(toolbarAction("Forward")).toBe("shared.context.forward");
    expect(toolbarAction("React with an emoji")).toBeNull();
    expect(toolbarAction("More actions")).toBeNull();
    // A translated label still finds Reply by its icon.
    expect(toolbarAction("Svar på denne meldingen", REPLY_ICON_PATH)).toBe("shared.context.reply");
    expect(toolbarAction("Videresend", "M0 0h16v16H0z")).toBeNull();
  });

  test("lists only what the message offers, in menu order", () => {
    expect(
      messageActions({
        reactions: [],
        text: "hi",
        actions: [
          "shared.context.remove",
          "shared.context.pin",
          "shared.context.forward",
          "shared.context.reply",
        ],
      }),
    ).toEqual([
      "shared.context.reply",
      "shared.context.copy_text",
      "shared.context.forward",
      "shared.context.pin",
      "shared.context.remove",
    ]);
    // A photo: no text to copy, Reply from More, Forward from the toolbar.
    expect(
      messageActions({
        reactions: [],
        text: "",
        actions: ["shared.context.forward", "shared.context.reply"],
      }),
    ).toEqual(["shared.context.reply", "shared.context.forward"]);
    // A call entry offers only Remove.
    expect(messageActions({ reactions: [], text: "", actions: ["shared.context.remove"] })).toEqual(
      ["shared.context.remove"],
    );
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

describe("message text", () => {
  const text = (value: string): ConversationTextNode => ({ nodeType: 3, nodeValue: value });
  const element = (
    tagName: string,
    attributes: Record<string, string>,
    children: ConversationTextNode[] = [],
  ): ConversationTextNode => ({
    nodeType: 1,
    tagName,
    childNodes: children,
    getAttribute: (name) => attributes[name] ?? null,
  });

  test("reads emoji images and keeps each line", () => {
    const block = element("DIV", {}, [
      element("DIV", {}, [text("line 1")]),
      element("DIV", {}, [text("line 2 "), element("IMG", { alt: "😀" })]),
    ]);
    expect(messageNodeText(block)).toBe("line 1\nline 2 😀");
  });

  test("does not double emoji that System emoji replaced", () => {
    const block = element("DIV", {}, [
      text("Hello "),
      element("IMG", { alt: "😀" }),
      element("SPAN", { "data-chatpane-system-emoji-glyph": "" }, [text("😀")]),
    ]);
    expect(messageNodeText(block)).toBe("Hello 😀");
  });
});

describe("message menu components", () => {
  const c: MessageMenuComponents = {
    reactButton: () => null,
    replyButton: () => null,
    forwardButton: () => null,
    moreButton: { render: () => null },
    replyRow: () => null,
    editRow: () => null,
    forwardRow: () => null,
    pinRow: () => null,
    removeRow: () => null,
    menu: () => null,
  };
  /** A DOM node's fiber under one component, inside the menu. */
  const under = (type: unknown, props: Record<string, unknown> = {}): Fiber => ({
    type: "div",
    return: {
      type: () => null,
      return: { type, memoizedProps: props, return: { type: c.menu, return: null } },
    },
  });

  test("names toolbar buttons by component, forwardRef included", () => {
    expect(classifyToolbarButton(under(c.reactButton), c)).toBe("react");
    expect(classifyToolbarButton(under((c.moreButton as { render: unknown }).render), c)).toBe(
      "more",
    );
    expect(classifyToolbarButton(under(c.replyButton), c)).toBe("shared.context.reply");
    expect(classifyToolbarButton(under(c.forwardButton), c)).toBe("shared.context.forward");
    expect(
      classifyToolbarButton(
        under(() => null),
        c,
      ),
    ).toBeNull();
  });

  test("names More rows by component, whatever their text", () => {
    const own = (sender: unknown) => sender === "me";
    expect(classifyMoreRow(under(c.replyRow), c, own)).toBe("shared.context.reply");
    expect(classifyMoreRow(under(c.editRow), c, own)).toBe("shared.context.edit");
    expect(classifyMoreRow(under(c.forwardRow), c, own)).toBe("shared.context.forward");
    expect(classifyMoreRow(under(c.pinRow, { message: { messageId: "m" } }), c, own)).toEqual({
      pinMessage: { messageId: "m" },
    });
    expect(
      classifyMoreRow(
        under(() => null),
        c,
        own,
      ),
    ).toBeNull();
  });

  test("offers Unsend only for your own message Messenger lets you remove for everyone", () => {
    const own = (sender: unknown) => sender === "me";
    const remove = (sender: string, everyone: boolean) =>
      classifyMoreRow(
        under(c.removeRow, { canRemoveMessageGlobally: everyone, message: { senderId: sender } }),
        c,
        own,
      );
    expect(remove("me", true)).toBe("shared.context.unsend");
    expect(remove("me", false)).toBe("shared.context.remove");
    expect(remove("them", true)).toBe("shared.context.remove");
  });

  test("Pin rows perform Pin or Unpin, whichever their state shows", () => {
    expect(pinAction(true)).toBe("shared.context.unpin");
    expect(pinAction(false)).toBe("shared.context.pin");
  });
});
