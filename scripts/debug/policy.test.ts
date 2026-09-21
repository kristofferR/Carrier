import { expect, test } from "bun:test";
import { buildInfo, debugDraft, matchesBuild } from "./policy";

const good = {
  version: "1.15.0",
  revision: "a".repeat(40),
  debug: true,
  diagnostics: true,
  mcp: true,
  platform: "linux",
  arch: "x86_64",
};
test("installer refuses releases and partially instrumented builds", () => {
  for (const field of ["debug", "diagnostics", "mcp"])
    expect(() => buildInfo({ ...good, [field]: false })).toThrow();
  expect(() => buildInfo({ ...good, revision: "local" })).toThrow();
  expect(() => buildInfo({ ...good, revision: "../../unsafe" })).toThrow();
});
test("identity includes commit so new debug builds of the same version can advance", () => {
  const next = buildInfo({ ...good, revision: "b".repeat(40) });
  expect(next.version).toBe(good.version);
  expect(() => matchesBuild(good, next)).toThrow();
  expect(() => matchesBuild(next, next)).not.toThrow();
});

test("only complete unpublished debug drafts can supply updates", () => {
  const draft = {
    draft: true,
    tag_name: "debug-v1.15.0-aaaaaaaaaaaa",
    body: `Carrier debug ready\nCommit: ${"a".repeat(40)}`,
  };
  expect(debugDraft(draft)?.revision).toBe("a".repeat(40));
  expect(debugDraft({ ...draft, draft: false })).toBeNull();
  expect(debugDraft({ ...draft, tag_name: "v1.15.0" })).toBeNull();
  expect(debugDraft({ ...draft, body: "Still uploading" })).toBeNull();
  expect(
    debugDraft({ ...draft, body: `Carrier debug ready\nCommit: ${"b".repeat(40)}` }),
  ).toBeNull();
});
