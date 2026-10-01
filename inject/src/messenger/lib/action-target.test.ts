import { describe, expect, test } from "bun:test";
import { actionTargetFor } from "./action-target";

describe("actionTargetFor", () => {
  const target = { body: "hi", at: 5, account: "42" };

  test("accepts a target for the signed-in account", () => {
    expect(actionTargetFor(target, "c_user=42; xs=1")).toEqual(target);
  });

  test("rejects another account, a signed-out page, and malformed input", () => {
    expect(actionTargetFor(target, "c_user=7")).toBeNull();
    expect(actionTargetFor(target, "")).toBeNull();
    expect(actionTargetFor({ ...target, account: "" }, "")).toBeNull();
    expect(actionTargetFor({ body: 1, at: 5, account: "42" }, "c_user=42")).toBeNull();
    expect(actionTargetFor("hi", "c_user=42")).toBeNull();
  });
});
