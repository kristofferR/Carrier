import { describe, expect, test } from "bun:test";
import { encodeWav, messengerSoundWav, playsMessageSound } from "./messenger-sounds";

const base = { globallyMuted: false, oldNews: false, focused: true };

describe("playsMessageSound", () => {
  test("rings in front; in the background the notification rings", () => {
    expect(playsMessageSound(base)).toBe(true);
    expect(playsMessageSound({ ...base, focused: false })).toBe(false);
  });

  test("stays quiet during Do Not Disturb, Pause or Mute, and for old news", () => {
    expect(playsMessageSound({ ...base, globallyMuted: true })).toBe(false);
    expect(playsMessageSound({ ...base, oldNews: true })).toBe(false);
  });
});

describe("Messenger's sound", () => {
  test("encodes interleaved 16-bit PCM WAV", () => {
    const wav = encodeWav([new Float32Array([1, -1]), new Float32Array([0, 2])], 44100);
    const view = new DataView(wav.buffer);
    const ascii = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
    expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect([view.getUint16(22, true), view.getUint32(24, true)]).toEqual([2, 44100]);
    // Frame by frame, clamped: (1, 0), (-1, 1).
    expect([44, 46, 48, 50].map((at) => view.getInt16(at, true))).toEqual([
      0x7fff, 0, -0x8000, 0x7fff,
    ]);
  });

  test("copies the first file Messenger's config names that decodes", async () => {
    const fetched: string[] = [];
    const load = (name: string) =>
      name === "MWChatConfig"
        ? {
            soundNotifMp3Url: "https://static.example/a.mp3",
            soundNotifOggUrl: "https://static.example/a.ogg",
          }
        : undefined;
    const audio = {
      length: 2,
      sampleRate: 8000,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array([0, 0.5]),
    } as unknown as AudioBuffer;
    const url = await messengerSoundWav(
      load,
      async (url) => {
        fetched.push(url);
        return new Response(url.endsWith(".mp3") ? null : "ogg", {
          status: url.endsWith(".mp3") ? 404 : 200,
        });
      },
      async () => audio,
    );
    expect(fetched).toEqual(["https://static.example/a.mp3", "https://static.example/a.ogg"]);
    expect(url.startsWith("data:audio/wav;base64,UklGR")).toBe(true);
  });

  test("rejects when the page names no sound", async () => {
    await expect(messengerSoundWav(() => ({ soundNotifMp3Url: "/local.mp3" }))).rejects.toThrow();
  });
});
