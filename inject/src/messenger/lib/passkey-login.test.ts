import { describe, expect, test } from "bun:test";
import { isPasskeyAssertFrame, isTwoStepVerificationPath, passkeysCanWork } from "./passkey-login";

describe("passkey login step", () => {
  test("passkeys work only where the webview can complete them", () => {
    expect(passkeysCanWork("macos", true)).toBe(false);
    expect(passkeysCanWork("linux", false)).toBe(false);
    expect(passkeysCanWork("windows", true)).toBe(true);
    expect(passkeysCanWork("windows", false)).toBe(false);
  });

  test("matches Facebook's two-factor pages only", () => {
    expect(isTwoStepVerificationPath("/two_step_verification/two_factor/")).toBe(true);
    expect(isTwoStepVerificationPath("/two_step_verification")).toBe(true);
    expect(isTwoStepVerificationPath("/two_step_verification_help/")).toBe(false);
    expect(isTwoStepVerificationPath("/messages/t/1/")).toBe(false);
  });

  test("recognizes the passkey frame and nothing that imitates it", () => {
    expect(
      isPasskeyAssertFrame(
        "https://accounts.meta.com/passkey/iframe/assert/?uri=https%3A%2F%2Fwww.facebook.com&renders_type=cds_dialog_footer",
      ),
    ).toBe(true);
    expect(isPasskeyAssertFrame("https://accounts.meta.com/passkey/iframe/register/")).toBe(false);
    expect(
      isPasskeyAssertFrame("https://accounts.meta.com.example.com/passkey/iframe/assert/"),
    ).toBe(false);
    expect(isPasskeyAssertFrame("about:blank")).toBe(false);
    expect(isPasskeyAssertFrame("")).toBe(false);
  });
});
