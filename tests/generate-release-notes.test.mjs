import { describe, expect, test } from "bun:test";
import { formatReleaseNotes } from "../.github/scripts/generate-release-notes.mjs";

describe("release note formatting", () => {
  test("keeps the real change instead of inferring a recycled feature", () => {
    const result = formatReleaseNotes("v1.3.0", "v1.2.4", [
      {
        title: "Restore reliable Messenger notifications",
        pr: "84",
        refs: ["80"],
        summary: [
          "add a conversation-row notification path when Facebook skips the Web Notification API",
          "track unread preview signatures without startup false positives",
        ],
        labels: [],
      },
    ]);

    expect(result.releaseTitle).toBe("v1.3.0");
    expect(result.releaseBody).toContain("## Bug Fixes");
    expect(result.releaseBody).toContain("**Restore reliable Messenger notifications**");
    expect(result.releaseBody).toContain(
      "Add a conversation-row notification path when Facebook skips the Web Notification API.",
    );
    expect(result.releaseBody).toContain("Track unread preview signatures without startup false positives.");
    expect(result.releaseBody).toContain("(#84, ref #80)");
    expect(result.releaseBody).not.toContain("Downloads");
    expect(result.releaseBody).not.toContain("Dock and tray");
    expect(result.releaseBody).not.toContain("focused polish release");
  });

  test("formats multiple issue references without repeating ref", () => {
    const result = formatReleaseNotes("v1.3.0", "v1.2.4", [
      {
        title: "Improve notifications",
        pr: "84",
        refs: ["80", "81"],
        summary: [],
        labels: [],
      },
    ]);

    expect(result.releaseBody).toContain("(#84, refs #80, #81)");
  });

  test("separates dependency updates from user-facing changes", () => {
    const result = formatReleaseNotes("1.4.0", "v1.3.0", [
      {
        title: "Add a useful setting",
        pr: "100",
        refs: [],
        summary: [],
        labels: [],
      },
      {
        title: "Bump example from 1.0.0 to 1.0.1",
        pr: "101",
        refs: [],
        summary: [],
        labels: ["dependencies"],
      },
    ]);

    expect(result.releaseTitle).toBe("v1.4.0");
    expect(result.releaseBody).toContain("## What's New\n\n- **Add a useful setting** (#100)");
    expect(result.releaseBody).toContain("## Internal\n\n- **Bump example from 1.0.0 to 1.0.1** (#101)");
  });

  test("uses conventional commit prefixes for sections without printing them", () => {
    const result = formatReleaseNotes("v1.4.0", "v1.3.0", [
      {
        title: "fix(notifications): avoid duplicate banners",
        pr: "102",
        refs: [],
        summary: [],
        labels: [],
      },
    ]);

    expect(result.releaseBody).toContain("## Bug Fixes");
    expect(result.releaseBody).toContain("**Avoid duplicate banners**");
    expect(result.releaseBody).not.toContain("fix(notifications)");
  });

  test("uses the requested repository for an optional compare link", () => {
    const withCompare = formatReleaseNotes("v1.4.0", "v1.3.0", [], "example/Carrier");
    const withoutCompare = formatReleaseNotes("v1.4.0", "", [], "example/Carrier");

    expect(withCompare.releaseBody).toContain(
      "https://github.com/example/Carrier/compare/v1.3.0...v1.4.0",
    );
    expect(withoutCompare.releaseBody).not.toContain("Full changelog");
  });
});
