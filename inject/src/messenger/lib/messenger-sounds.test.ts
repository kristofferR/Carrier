import { describe, expect, test } from "bun:test";
import { playsMessageSound } from "./messenger-sounds";

const base = { globallyMuted: false, oldNews: false, focused: true, nativeSoundOn: true };

describe("playsMessageSound", () => {
  test("rings once: Messenger's sound when focused, the notification's when not", () => {
    expect(playsMessageSound(base)).toBe(true);
    expect(playsMessageSound({ ...base, focused: false })).toBe(false);
    // Silent notifications leave the ringing to Messenger.
    expect(playsMessageSound({ ...base, focused: false, nativeSoundOn: false })).toBe(true);
  });

  test("stays quiet during Do Not Disturb, Pause or Mute, and for old news", () => {
    expect(playsMessageSound({ ...base, globallyMuted: true })).toBe(false);
    expect(playsMessageSound({ ...base, oldNews: true })).toBe(false);
    expect(
      playsMessageSound({ ...base, focused: false, nativeSoundOn: false, oldNews: true }),
    ).toBe(false);
  });
});
