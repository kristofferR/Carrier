import { expect, test } from "bun:test";
import { appstreamDescription, withReleases } from "./metainfo";

const NOTES = `Chatpane now **does more**, at [the site](https://example.com/).
<!-- chatpane:keep-draft -->

## What's New

- **Feature one.** Works with \`code\` & more (#123).
- **Feature two.** A longer item
  that wraps onto a second line.

- **Feature three.** After a blank line.

## Bug Fixes

- Sounds play again (#200, #201).

## Internal

- Refactored the build.

## Package managers

- **AUR:** install \`chatpane\`.
`;

test("keeps the opening and the user-facing lists, as plain text", () => {
  expect(appstreamDescription(NOTES).split("\n")).toEqual([
    "<p>Chatpane now does more, at the site.</p>",
    "<p>What's New</p>",
    "<ul><li>Feature one. Works with code &amp; more.</li><li>Feature two. A longer item that wraps onto a second line.</li><li>Feature three. After a blank line.</li></ul>",
    "<p>Bug Fixes</p>",
    "<ul><li>Sounds play again.</li></ul>",
  ]);
});

const METAINFO = `<component>
  <releases>
    <release version="3.1.0" date="2026-11-09">
      <description><p>Old.</p></description>
    </release>
  </releases>
</component>
`;

test("adds only releases newer than the newest entry, newest first", () => {
  const updated = withReleases(METAINFO, [
    { version: "3.1.0", date: "2026-11-09", notes: "Again." },
    { version: "3.1.1", date: "2026-11-10", notes: "## Bug Fixes\n- Fixed one thing." },
    { version: "3.2.0", date: "2026-11-12", notes: "## What's New\n- Added another." },
  ]);
  const versions = [...updated.matchAll(/<release version="([^"]+)" date="([^"]+)"/g)].map(
    (m) => `${m[1]} ${m[2]}`,
  );
  expect(versions).toEqual(["3.2.0 2026-11-12", "3.1.1 2026-11-10", "3.1.0 2026-11-09"]);
  expect(updated).not.toContain("Again.");
  expect(withReleases(METAINFO, [])).toBe(METAINFO);
});

test("lists an internal-only release without a description", () => {
  expect(
    withReleases(METAINFO, [
      { version: "3.2.0", date: "2026-11-12", notes: "## Internal\n- Only CI." },
    ]),
  ).toContain('<release version="3.2.0" date="2026-11-12"/>');
});
