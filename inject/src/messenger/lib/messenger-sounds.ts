/*
 * The new-message sound. Messenger asks for its own through
 * `MWLSChatPopperCommon.playChatTabSound` (every message while the window is
 * focused, the first three of a conversation while it is not). Chatpane never
 * plays Messenger's: the message sound is Chatpane's own setting (Settings →
 * Notifications), whatever Facebook's sound setting says. In the background
 * the notification carries it; in front there is no notification, so the
 * page asks native to play it. One message rings once.
 *
 * Messenger's own sound is one of the choices: Chatpane copies it from the
 * page as a WAV when it is picked.
 */
import { t } from "../../i18n";
import { defaultExport, type Load } from "./facebook-loader";

export interface MessageSoundState {
  /** Chatpane's Mute or Pause, or Messenger's Do Not Disturb. */
  globallyMuted: boolean;
  /** The message is old news (see isOldNews): it raises no notification either. */
  oldNews: boolean;
  /** The Messenger window has the focus. */
  focused: boolean;
}

/**
 * Whether Chatpane plays the message sound for a message Messenger would
 * ring for. Unfocused, the notification plays it instead.
 */
export function playsMessageSound(state: MessageSoundState): boolean {
  return state.focused && !state.globallyMuted && !state.oldNews;
}

/** Longest sound copied; Messenger's is about a second. */
const MAX_SECONDS = 10;

/** A 16-bit PCM WAV file of `channels` (equally long, samples in -1…1). */
export function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const count = channels.length;
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * count * 2;
  const view = new DataView(new ArrayBuffer(44 + dataBytes));
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * 2, true);
  view.setUint16(32, count * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (const channel of channels) {
      const sample = Math.max(-1, Math.min(1, channel[frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Uint8Array(view.buffer);
}

function dataUrl(bytes: Uint8Array, type: string): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

/** Decodes audio without opening an output, so no audio route is held (#232). */
async function decodeAudio(data: ArrayBuffer): Promise<AudioBuffer> {
  const Context = window.OfflineAudioContext;
  if (typeof Context !== "function") throw new Error("no Web Audio");
  return new Context(2, 1, 44100).decodeAudioData(data);
}

/**
 * Messenger's own new-message sound as a WAV data URL, from the files its
 * page config names (`MWChatConfig`). Rejects when the page has none it can
 * read.
 */
export async function messengerSoundWav(
  load: Load | null,
  fetchAudio: (url: string) => Promise<Response> = (url) => fetch(url),
  decode: (data: ArrayBuffer) => Promise<AudioBuffer> = decodeAudio,
): Promise<string> {
  let config: { soundNotifMp3Url?: unknown; soundNotifOggUrl?: unknown } | undefined;
  try {
    config = defaultExport(load?.("MWChatConfig")) as typeof config;
  } catch {}
  const urls = [config?.soundNotifMp3Url, config?.soundNotifOggUrl].filter(
    (url): url is string => typeof url === "string" && url.startsWith("https://"),
  );
  for (const url of urls) {
    try {
      const response = await fetchAudio(url);
      if (!response.ok) continue;
      const audio = await decode(await response.arrayBuffer());
      const frames = Math.min(audio.length, audio.sampleRate * MAX_SECONDS);
      const channels = Array.from({ length: Math.min(audio.numberOfChannels, 2) }, (_, i) =>
        audio.getChannelData(i).subarray(0, frames),
      );
      if (!frames || !channels.length) continue;
      return dataUrl(encodeWav(channels, audio.sampleRate), "audio/wav");
    } catch {}
  }
  throw new Error(t("page.sound.unavailable"));
}
