import { describe, expect, test } from "bun:test";
import {
  hidesAvatars,
  hidesNames,
  isMetaText,
  locateSpan,
  mentionRanges,
  nameRanges,
  prefixRange,
  previewIdentity,
} from "./privacy";

describe("previewIdentity", () => {
  test("finds the sender prefix in 'Name: message' previews", () => {
    expect(previewIdentity("Kari Nordmann: hei!")).toEqual({
      prefix: "Kari Nordmann",
      colon: true,
    });
    expect(previewIdentity("Anna 2: hello")).toEqual({
      prefix: "Anna 2",
      colon: true,
    });
  });

  test("skips non-name prefixes and previews without one", () => {
    expect(previewIdentity("12:30: reminder")).toBeNull();
    expect(previewIdentity("123 456: reminder")).toBeNull();
    expect(previewIdentity("Kari left the group")).toBeNull();
    expect(previewIdentity("no identity here")).toBeNull();
    expect(previewIdentity("")).toBeNull();
  });
});

describe("nameRanges", () => {
  const names = ["Kim Andersen", "Kim", "Tobias"];
  const words = (text: string) => nameRanges(text, names).map(([a, b]) => text.slice(a, b));

  test("finds participants wherever the language puts them", () => {
    expect(words("Kim sent a photo")).toEqual(["Kim"]);
    expect(words("Kim hat ein Foto gesendet")).toEqual(["Kim"]);
    expect(words("Tobias a réagi à votre message")).toEqual(["Tobias"]);
    expect(words("Kim Andersen: see you, Tobias")).toEqual(["Kim Andersen", "Tobias"]);
    expect(words("Kimさんが写真を送信しました")).toEqual(["Kim"]);
    expect(nameRanges("민수님이 사진을 보냈습니다", ["민수"])).toEqual([[0, 2]]);
  });

  test("matches whole words only, and nothing without names", () => {
    expect(words("Kimchi for dinner")).toEqual([]);
    expect(words("Akim: hi")).toEqual([]);
    expect(nameRanges("Kim: hi", [])).toEqual([]);
    expect(nameRanges("A: hi", ["A"])).toEqual([]);
  });
});

describe("isMetaText", () => {
  test("relative times, numbers and separators are metadata", () => {
    expect(isMetaText("4h")).toBe(true);
    expect(isMetaText("12 m")).toBe(true);
    expect(isMetaText("5 Min.")).toBe(true);
    expect(isMetaText("3分")).toBe(true);
    expect(isMetaText("· 3")).toBe(true);
    expect(isMetaText("")).toBe(true);
  });

  test("names are not metadata", () => {
    expect(isMetaText("Kari")).toBe(false);
    expect(isMetaText("Mo")).toBe(false);
    expect(isMetaText("Thu")).toBe(false);
  });
});

describe("hidesNames / hidesAvatars", () => {
  test("keep the combined switch until one is set on its own", () => {
    expect(hidesNames({ hide_names_avatars: true })).toBe(true);
    expect(hidesAvatars({ hide_names_avatars: true })).toBe(true);
    const namesOnly = { hide_names_avatars: true, hide_avatars: false };
    expect(hidesNames(namesOnly)).toBe(true);
    expect(hidesAvatars(namesOnly)).toBe(false);
    expect(hidesAvatars({ hide_avatars: true })).toBe(true);
    expect(hidesNames({ hide_names: null })).toBe(false);
    expect(hidesNames(undefined)).toBe(false);
  });
});

describe("prefixRange / locateSpan", () => {
  test("finds the sender inside the preview's own text node", () => {
    const texts = ["Kari Nordmann: hei!"];
    expect(prefixRange(texts.join(""), "Kari Nordmann")).toEqual([0, 13]);
    expect(locateSpan(texts, 0, 13)).toEqual({ start: [0, 0], end: [0, 13] });
  });

  test("spans nodes and skips leading whitespace", () => {
    const texts = ["  Kari ", "Nordmann", ": hei"];
    const [from, to] = prefixRange(texts.join(""), "Kari Nordmann")!;
    expect(locateSpan(texts, from, to)).toEqual({ start: [0, 2], end: [1, 8] });
  });

  test("starts in the next node when one ends right before the name", () => {
    const texts = [" ", "Kari: hei"];
    const [from, to] = prefixRange(texts.join(""), "Kari")!;
    expect(locateSpan(texts, from, to)).toEqual({ start: [1, 0], end: [1, 4] });
  });

  test("is null when the text does not start with the name", () => {
    expect(prefixRange("Kari\u00a0Nordmann: hei", "Kari Nordmann")).toBeNull();
    expect(prefixRange("hei", "Kari")).toBeNull();
    expect(prefixRange("", "Kari")).toBeNull();
  });
});

describe("mentionRanges", () => {
  const mentions = (text: string) => mentionRanges(text).map(([a, b]) => text.slice(a, b));

  test("takes the name after @ with its capitalized words", () => {
    expect(mentions("Frank: @Martine Rieck")).toEqual(["@Martine Rieck"]);
    expect(mentions("@Kari kan du ta med kake?")).toEqual(["@Kari"]);
    expect(mentions("hei @Åse Marie Øien og @ola")).toEqual(["@Åse Marie Øien", "@ola"]);
  });

  test("keeps name particles and combining marks with the name", () => {
    expect(mentions("Anne: @Martine van der Berg kommer")).toEqual(["@Martine van der Berg"]);
    expect(mentions("@Jose\u0301 Garci\u0301a")).toEqual(["@Jose\u0301 Garci\u0301a"]);
  });

  test("skips e-mail addresses and lone @", () => {
    expect(mentions("send til kari@example.com @ 12")).toEqual([]);
  });
});
