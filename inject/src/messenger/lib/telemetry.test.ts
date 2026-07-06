import { describe, expect, test } from "bun:test";
import { isBlockedTelemetryUrl } from "./telemetry";

const BASE = "https://www.facebook.com/messages/t/1/";
const blocked = (url: string) => isBlockedTelemetryUrl(url, BASE);

describe("isBlockedTelemetryUrl", () => {
  test("blocks the pure logging sinks", () => {
    expect(blocked("/ajax/bz")).toBe(true);
    expect(blocked("/ajax/bz/batch")).toBe(true);
    expect(blocked("/a/bz")).toBe(true);
    expect(blocked("/ajax/bnzai/")).toBe(true);
    expect(blocked("/ajax/qm")).toBe(true);
    expect(blocked("/ajax/qm.php")).toBe(true);
    expect(blocked("/common/scribe_endpoint.php")).toBe(true);
    expect(blocked("/security/hsts-pixel.gif")).toBe(true);
    expect(blocked("/tr/")).toBe(true);
    expect(blocked("/ajax/error/report")).toBe(true);
    expect(blocked("https://pixel.facebook.com/anything")).toBe(true);
    expect(blocked("https://www.messenger.com/ajax/bz")).toBe(true);
  });

  test("never blocks messaging-critical endpoints", () => {
    expect(blocked("/api/graphql/")).toBe(false);
    expect(blocked("/ajax/bootloader-endpoint/")).toBe(false);
    expect(blocked("/ajax/bulk-route-definitions/")).toBe(false);
    expect(blocked("/ajax/mercury/thread_info.php")).toBe(false);
    expect(blocked("/ajax/dtsg/")).toBe(false);
    expect(blocked("https://rupload.facebook.com/messenger_image/1")).toBe(false);
    // Anchored prefixes: similar-looking paths elsewhere don't match.
    expect(blocked("/something/ajax/bz")).toBe(false);
    expect(blocked("/ajax/bzz")).toBe(false);
    expect(blocked("/traffic")).toBe(false);
  });

  test("only classifies facebook.com / messenger.com hosts", () => {
    expect(blocked("https://example.com/ajax/bz")).toBe(false);
    expect(blocked("https://notfacebook.com/tr/")).toBe(false);
  });

  test("fails open on unclassifiable input", () => {
    expect(isBlockedTelemetryUrl("http://", "not a base")).toBe(false);
  });
});
