import { describe, expect, test } from "bun:test";
import { SEPARATOR_RE, threadIdFromHref, threadPathId } from "./threads";

describe("threadIdFromHref", () => {
  test("extracts the id from chat-list hrefs", () => {
    expect(threadIdFromHref("/t/1234567890/")).toBe("1234567890");
    expect(threadIdFromHref("https://www.facebook.com/messages/t/42")).toBe("42");
    expect(threadIdFromHref("/messages/t/7/?foo=bar")).toBe("7");
  });

  test("rejects hrefs without a numeric thread id", () => {
    expect(threadIdFromHref("/messages/")).toBeNull();
    expect(threadIdFromHref("/t/abc/")).toBeNull();
    expect(threadIdFromHref(null)).toBeNull();
    expect(threadIdFromHref(undefined)).toBeNull();
  });
});

describe("threadPathId", () => {
  test("accepts exactly '/t/<id>' with optional trailing slash", () => {
    expect(threadPathId("/t/123/")).toBe("123");
    expect(threadPathId("/t/123")).toBe("123");
  });

  test("rejects anything else (menus can only navigate exact thread paths)", () => {
    expect(threadPathId("/t/123/extra")).toBeNull();
    expect(threadPathId("https://www.facebook.com/t/123/")).toBeNull();
    expect(threadPathId("/t/abc/")).toBeNull();
    expect(threadPathId("")).toBeNull();
    expect(threadPathId(null)).toBeNull();
    expect(threadPathId(42)).toBeNull();
  });
});

describe("SEPARATOR_RE", () => {
  test("matches structural separators, not names", () => {
    expect(SEPARATOR_RE.test(" · ")).toBe(true);
    expect(SEPARATOR_RE.test("•")).toBe(true);
    expect(SEPARATOR_RE.test("...")).toBe(true);
    expect(SEPARATOR_RE.test("Mo")).toBe(false); // short real names stay
    expect(SEPARATOR_RE.test("A. B")).toBe(false);
  });
});
