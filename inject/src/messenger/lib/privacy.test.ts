import { describe, expect, test } from "bun:test";
import { isMetaText, previewIdentity } from "./privacy";

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
