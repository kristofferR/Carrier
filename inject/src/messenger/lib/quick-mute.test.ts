import { describe, expect, test } from "bun:test";
import { decideQuickMute, type QuickMuteSnapshot } from "./quick-mute";

const snapshot = (overrides: Partial<QuickMuteSnapshot> = {}): QuickMuteSnapshot => ({
  threadMatches: true,
  muted: null,
  infoRequested: false,
  dialog: "none",
  ...overrides,
});

describe("decideQuickMute", () => {
  test("walks info pane, dialog, duration, and confirmation", () => {
    expect(decideQuickMute("waiting", snapshot(), false)).toEqual({
      action: "open-info",
      phase: "waiting",
    });
    expect(decideQuickMute("waiting", snapshot({ infoRequested: true }), false).action).toBe(
      "wait",
    );
    expect(decideQuickMute("waiting", snapshot({ muted: false }), false)).toEqual({
      action: "open-dialog",
      phase: "dialog",
    });
    expect(decideQuickMute("dialog", snapshot({ muted: false }), false).action).toBe("wait");
    expect(
      decideQuickMute("dialog", snapshot({ muted: false, dialog: "unselected" }), false).action,
    ).toBe("select");
    expect(decideQuickMute("dialog", snapshot({ muted: false, dialog: "ready" }), false)).toEqual({
      action: "confirm",
      phase: "confirming",
    });
    expect(decideQuickMute("confirming", snapshot({ muted: false }), false).action).toBe("wait");
    expect(decideQuickMute("confirming", snapshot({ muted: true }), false).action).toBe("success");
  });

  test("an already-muted thread succeeds without touching the dialog", () => {
    expect(decideQuickMute("waiting", snapshot({ muted: true }), false).action).toBe("success");
  });

  test("waits for navigation, but fails if the thread changes mid-flow", () => {
    expect(decideQuickMute("waiting", snapshot({ threadMatches: false }), false).action).toBe(
      "wait",
    );
    expect(
      decideQuickMute("dialog", snapshot({ threadMatches: false, dialog: "ready" }), false).action,
    ).toBe("failure");
    expect(
      decideQuickMute("confirming", snapshot({ threadMatches: false, muted: true }), false).action,
    ).toBe("failure");
  });

  test("times out unless the mute is already visible", () => {
    expect(decideQuickMute("confirming", snapshot({ muted: false }), true).action).toBe("failure");
    expect(decideQuickMute("confirming", snapshot({ muted: true }), true).action).toBe("success");
  });
});
