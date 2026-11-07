import { describe, expect, test } from "bun:test";
import { hidesAvatars, hidesNames, isMetaText, prefixSpan, previewIdentity } from "./privacy";

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

  test("finds the actor in event previews", () => {
    expect(previewIdentity("Kari left the group")).toEqual({ prefix: "Kari", colon: false });
    expect(previewIdentity("Ola reacted to your message")).toEqual({
      prefix: "Ola",
      colon: false,
    });
  });

  test("skips first-person and non-name prefixes", () => {
    expect(previewIdentity("You: sounds good")).toBeNull();
    expect(previewIdentity("Du: den er grei")).toBeNull();
    expect(previewIdentity("12:30: reminder")).toBeNull();
    expect(previewIdentity("123 456: reminder")).toBeNull();
    expect(previewIdentity("no identity here")).toBeNull();
    expect(previewIdentity("")).toBeNull();
  });
});

describe("isMetaText", () => {
  test("timestamps, weekdays, and separators are metadata", () => {
    expect(isMetaText("4h")).toBe(true);
    expect(isMetaText("12 m")).toBe(true);
    expect(isMetaText("now")).toBe(true);
    expect(isMetaText("Thu")).toBe(true);
    expect(isMetaText("· 3")).toBe(true);
    expect(isMetaText("")).toBe(true);
  });

  test("names are not metadata", () => {
    expect(isMetaText("Kari")).toBe(false);
    expect(isMetaText("Mo")).toBe(false);
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

describe("prefixSpan", () => {
  test("finds the sender inside the preview's own text node", () => {
    expect(prefixSpan(["Kari Nordmann: hei!"], "Kari Nordmann")).toEqual({
      start: [0, 0],
      end: [0, 13],
    });
  });

  test("spans nodes and skips leading whitespace", () => {
    expect(prefixSpan(["  Kari ", "Nordmann", ": hei"], "Kari Nordmann")).toEqual({
      start: [0, 2],
      end: [1, 8],
    });
  });

  test("starts in the next node when one ends right before the name", () => {
    expect(prefixSpan([" ", "Kari: hei"], "Kari")).toEqual({ start: [1, 0], end: [1, 4] });
  });

  test("is null when the text does not start with the name", () => {
    expect(prefixSpan(["Kari\u00a0Nordmann: hei"], "Kari Nordmann")).toBeNull();
    expect(prefixSpan(["hei"], "Kari")).toBeNull();
    expect(prefixSpan([], "Kari")).toBeNull();
  });
});
