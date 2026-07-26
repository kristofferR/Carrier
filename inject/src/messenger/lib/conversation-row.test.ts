import { describe, expect, test } from "bun:test";
import {
  type ConversationTextCandidate,
  type ConversationTextNode,
  conversationNodeText,
  conversationTextParts,
  hasCandidateTextChild,
  isUnreadConversationText,
} from "./conversation-row";

const textNode = (value: string): ConversationTextNode => ({ nodeType: 3, nodeValue: value });

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

const emojiSprite = (glyph: string) =>
  element("IMG", {
    alt: glyph,
    src: "https://static.xx.fbcdn.net/images/emoji.php/v9/t4b/1/16/1f622.png",
  });

const candidate = (
  text: string,
  overrides: Partial<ConversationTextCandidate> = {},
): ConversationTextCandidate => ({
  text,
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  ariaHidden: false,
  inAbbreviation: false,
  hasTextChild: false,
  ...overrides,
});

describe("conversationTextParts", () => {
  test("orders visible deepest leaves and removes adjacent wrapper duplicates", () => {
    expect(
      conversationTextParts([
        candidate("10:30", { y: 0, inAbbreviation: true }),
        candidate("Preview", { y: 20 }),
        candidate("Jane", { y: 0 }),
        candidate("Jane", { y: 0, x: 20 }),
        candidate("wrapper", { y: 0, hasTextChild: true }),
        candidate("hidden", { y: 0, ariaHidden: true }),
      ]),
    ).toEqual({ title: "Jane", body: "Preview" });
  });

  test("keeps a preview identical to the title on its own line", () => {
    expect(conversationTextParts([candidate("OK", { y: 0 }), candidate("OK", { y: 20 })])).toEqual({
      title: "OK",
      body: "OK",
    });
  });

  test("uses safe defaults and caps scraped text", () => {
    expect(conversationTextParts([])).toEqual({
      title: "Messenger",
      body: "",
    });
    const parts = conversationTextParts([
      candidate("T".repeat(100)),
      candidate("B".repeat(300), { y: 20 }),
    ]);
    expect(parts.title).toHaveLength(80);
    expect(parts.body).toHaveLength(240);
  });
});

describe("conversationNodeText", () => {
  test("restores emoji sprites inside a preview", () => {
    expect(conversationNodeText(element("SPAN", {}, [textNode("Kim: "), emojiSprite("😢")]))).toBe(
      "Kim: 😢",
    );
  });

  test("reads an emoji-only preview that textContent would leave empty", () => {
    expect(conversationNodeText(element("SPAN", {}, [emojiSprite("😢")]))).toBe("😢");
  });

  test("counts a deferred sprite by its alt and skips real images", () => {
    expect(conversationNodeText(element("IMG", { alt: "😢" }))).toBe("😢");
    expect(
      conversationNodeText(element("IMG", { alt: "Kim Andersen", src: "https://cdn/avatar.jpg" })),
    ).toBe("");
  });

  test("takes a background-image emoji from its aria-label", () => {
    expect(conversationNodeText(element("SPAN", { "aria-label": "😢" }))).toBe("😢");
    expect(conversationNodeText(element("SPAN", { "aria-label": "Kim Andersen" }))).toBe("");
  });

  test("ignores Carrier's injected system-emoji glyphs", () => {
    expect(
      conversationNodeText(
        element("SPAN", {}, [
          emojiSprite("😢"),
          element("SPAN", { "data-carrier-system-emoji-glyph": "" }, [textNode("😢")]),
        ]),
      ),
    ).toBe("😢");
  });
});

describe("hasCandidateTextChild", () => {
  test("treats a nested text span as the real candidate", () => {
    expect(
      hasCandidateTextChild(element("SPAN", {}, [element("SPAN", {}, [textNode("Preview")])])),
    ).toBe(true);
  });

  test("keeps a sprite leaf a candidate, glyph span and all", () => {
    // What System emoji renders: "Kim: " + sprite + Carrier's own glyph span.
    const glyph = element("SPAN", { "data-carrier-system-emoji-glyph": "" }, [
      textNode("\u{1F622}"),
    ]);
    expect(
      hasCandidateTextChild(
        element("SPAN", {}, [textNode("Kim: "), emojiSprite("\u{1F622}"), glyph]),
      ),
    ).toBe(false);
    expect(hasCandidateTextChild(element("SPAN", {}, [emojiSprite("\u{1F622}"), glyph]))).toBe(
      false,
    );
  });
});

describe("isUnreadConversationText", () => {
  test("accepts semibold meaningful text", () => {
    expect(isUnreadConversationText("600", "Jane")).toBe(true);
    expect(isUnreadConversationText(700, "Preview")).toBe(true);
  });

  test("rejects light, empty, and one-character surfaces", () => {
    expect(isUnreadConversationText("500", "Jane")).toBe(false);
    expect(isUnreadConversationText("bold", "Jane")).toBe(false);
    expect(isUnreadConversationText("700", " ")).toBe(false);
    expect(isUnreadConversationText("700", "·")).toBe(false);
  });
});
