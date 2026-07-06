import { describe, expect, test } from "bun:test";
import { classifyHref } from "./links";

const BASE = "https://www.facebook.com/messages/t/123/";

describe("classifyHref", () => {
  test("keeps Facebook-family hosts internal", () => {
    expect(classifyHref("https://www.facebook.com/messages/t/9/", BASE).external).toBe(false);
    expect(classifyHref("https://www.messenger.com/t/9/", BASE).external).toBe(false);
    expect(classifyHref("https://scontent.fbcdn.net/v/img.jpg", BASE).external).toBe(false);
    expect(classifyHref("https://cdn.fbsbx.com/file.pdf", BASE).external).toBe(false);
    expect(classifyHref("/messages/new/", BASE).external).toBe(false);
  });

  test("treats l.php tracking redirects as external", () => {
    expect(
      classifyHref("https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com", BASE).external,
    ).toBe(true);
    expect(classifyHref("https://lm.facebook.com/l.php?u=x", BASE).external).toBe(true);
    expect(classifyHref("https://www.facebook.com/l.php?u=x", BASE).external).toBe(true);
    // …but a non-l.php facebook path stays internal.
    expect(classifyHref("https://www.facebook.com/some/page", BASE).external).toBe(false);
  });

  test("sends non-Facebook sites to the real browser", () => {
    expect(classifyHref("https://example.com/", BASE).external).toBe(true);
    // Lookalike hosts don't get the internal treatment.
    expect(classifyHref("https://evilfacebook.com/", BASE).external).toBe(true);
    expect(classifyHref("https://facebook.com.evil.example/", BASE).external).toBe(true);
  });

  test("keeps OAuth provider hosts in-app so social login popups work", () => {
    expect(classifyHref("https://accounts.google.com/o/oauth2/auth", BASE).external).toBe(false);
    expect(classifyHref("https://appleid.apple.com/auth/authorize", BASE).external).toBe(false);
    expect(classifyHref("https://login.microsoftonline.com/common", BASE).external).toBe(false);
    // Subdomains of the auth hosts count too.
    expect(classifyHref("https://sub.accounts.google.com/x", BASE).external).toBe(false);
  });

  test("hands mailto:/tel: to the OS, keeps other schemes in place", () => {
    expect(classifyHref("mailto:kim@example.com", BASE).external).toBe(true);
    expect(classifyHref("tel:+4712345678", BASE).external).toBe(true);
    expect(classifyHref("blob:https://www.facebook.com/abc", BASE).external).toBe(false);
    expect(classifyHref("javascript:void(0)", BASE).external).toBe(false);
  });

  test("fails closed (internal) on unparseable hrefs", () => {
    expect(classifyHref("https://exa mple.com/^", "not a base").external).toBe(false);
  });
});
