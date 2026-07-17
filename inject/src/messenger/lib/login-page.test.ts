import { describe, expect, test } from "bun:test";
import {
  isFooterNoiseLink,
  isLanguageFooterLink,
  lowestScoreIndex,
  qualifiesCookieActionRow,
  topLanguageLinkIndexes,
} from "./login-page";

describe("login footer links", () => {
  test("finds a structural language strip while excluding footer noise", () => {
    const links = [
      { href: "#", text: "English (US)" },
      { href: "#", text: "Norsk (bokmål)" },
      { href: "#", text: "Privacy" },
      { href: "/help", text: "Help" },
    ];
    expect(topLanguageLinkIndexes(links)).toEqual([0, 1]);
    expect(isLanguageFooterLink(links[0]!)).toBe(true);
    expect(isFooterNoiseLink(links[2]!)).toBe(true);
  });

  test("requires at least two language candidates", () => {
    expect(topLanguageLinkIndexes([{ href: "#", text: "English" }])).toEqual([]);
  });
});

describe("cookie action rows", () => {
  test("accepts two-button rows or larger rows with a strong primary action", () => {
    expect(qualifiesCookieActionRow([0, 0])).toBe(true);
    expect(qualifiesCookieActionRow([5, 60, 10])).toBe(true);
    expect(qualifiesCookieActionRow([5, 10, 15])).toBe(false);
    expect(qualifiesCookieActionRow([80])).toBe(false);
  });

  test("selects the least-primary action as the decline choice", () => {
    expect(lowestScoreIndex([90, 5])).toBe(1);
    expect(lowestScoreIndex([5, 90])).toBe(0);
    expect(lowestScoreIndex([])).toBeNull();
  });
});
