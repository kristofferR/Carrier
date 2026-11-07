import { describe, expect, test } from "bun:test";
import { actionTargetFor } from "./action-target";

describe("actionTargetFor", () => {
  const target = { account: "42", message: "mid.$1", reaction: "👍" };

  test("accepts a target for the signed-in account", () => {
    expect(actionTargetFor(target, "c_user=42; xs=1")).toEqual(target);
    expect(actionTargetFor({ account: "42" }, "c_user=42")).toEqual({
      account: "42",
      message: "",
      reaction: "",
    });
  });

  test("rejects another account, a signed-out page, and malformed input", () => {
    expect(actionTargetFor(target, "c_user=7")).toBeNull();
    expect(actionTargetFor(target, "")).toBeNull();
    expect(actionTargetFor({ ...target, account: "" }, "")).toBeNull();
    expect(actionTargetFor({ ...target, message: 1 }, "c_user=42")).toBeNull();
    expect(actionTargetFor("hi", "c_user=42")).toBeNull();
  });
});
