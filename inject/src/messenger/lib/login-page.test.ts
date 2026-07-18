import { describe, expect, test } from "bun:test";
import {
  isCookiePolicyHref,
  isLanguageFooterLink,
  lowestScoreIndex,
  qualifiesCookieActionRow,
  topLanguageLinkIndexes,
} from "./login-page";

describe("login footer links", () => {
  test("finds a structural language strip independently of locale", () => {
    const links = [
      { href: "#", text: "Deutsch" },
      { href: "#", text: "Français (France)" },
      { href: "#", text: "日本語" },
      { href: "/help", text: "Help" },
    ];
    expect(topLanguageLinkIndexes(links)).toEqual([0, 1, 2]);
    expect(isLanguageFooterLink(links[0]!)).toBe(true);
  });

  test("requires at least two language candidates", () => {
    expect(topLanguageLinkIndexes([{ href: "#", text: "English" }])).toEqual([]);
  });

  test("rejects real destinations that merely end in '#'", () => {
    // A raw href like "/help#" is a genuine link, not a language switch.
    expect(isLanguageFooterLink({ href: "/help#", text: "Help center" })).toBe(false);
    expect(isLanguageFooterLink({ href: "#", text: "English (US)" })).toBe(true);
    // Such a link must not be picked up even alongside a real "#" strip.
    expect(
      topLanguageLinkIndexes([
        { href: "#", text: "English (US)" },
        { href: "/help#", text: "Deutsch" },
      ]),
    ).toEqual([]);
  });
});

describe("cookie policy links", () => {
  test("accepts localized Meta-owned policy destinations", () => {
    expect(isCookiePolicyHref("/privacy/policies/cookies/")).toBe(true);
    expect(isCookiePolicyHref("https://www.facebook.com/privacy/policy/")).toBe(true);
    expect(isCookiePolicyHref("https://privacycenter.instagram.com/policies/cookies/")).toBe(true);
  });

  test("rejects unrelated and lookalike destinations", () => {
    expect(isCookiePolicyHref("/help/")).toBe(false);
    expect(isCookiePolicyHref("https://example.com/privacy/policies/cookies/")).toBe(false);
    expect(isCookiePolicyHref("https://facebook.com.example.com/privacy/")).toBe(false);
    expect(isCookiePolicyHref("not a url")).toBe(false);
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
