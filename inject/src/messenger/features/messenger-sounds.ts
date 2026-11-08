/* --------------------- Messenger's in-page sounds ---------------------- */
// Messenger plays its short sounds (a new message, a sent like) from <audio>
// elements through `SoundPlayer.play`. WebKit offers any media element that
// has played as the system's Now Playing (macOS Control Center and media keys,
// MPRIS on Linux): "Messenger | Facebook" with a play button, left there after
// every message sound. Those one-shot sounds play through Web Audio instead,
// which is not offered; when that fails the element plays as before. Looping
// sounds (a call's ringtone) and every other media element are left alone.
//
// The new-message sound itself (`MWLSChatPopperCommon.playChatTabSound`)
// follows Do Not Disturb, Pause and Mute, and rings once per message (see
// lib/messenger-sounds.ts).
/*! Includes code adapted from fMess (https://github.com/toanbku/fmess).
 *
 * MIT License
 *
 * Copyright (c) 2026 fMess contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { diag } from "../bridge";
import { playsMessageSound } from "../lib/messenger-sounds";
import { notificationsGloballyMuted } from "../lib/mute";
import {
  isOldNews,
  messageThreadId,
  messengerMillis,
  serverNowMs,
  wrapFactoryExports,
} from "../lib/page-notifications";

type Define = (...args: unknown[]) => unknown;
type Factory = (...args: unknown[]) => unknown;

const SOUND_PLAYER_MODULE = "SoundPlayer";
const CHAT_POPPER_COMMON_MODULE = "MWLSChatPopperCommon";
// A context the page may not start yet would wait for a gesture forever.
const RESUME_WAIT_MS = 1000;

const pageLoad = () => (window as unknown as { require?: unknown }).require;

/* ---- Web Audio playback ---- */

// While above zero, an <audio> element's play() is one of SoundPlayer's one-shots.
let soundPlayerCalls = 0;
// Messenger plays a new message's sound a moment after asking for it (it
// first reads whether the account's sounds are on).
const MESSAGE_SOUND_PENDING_MS = 3000;
// A native notification this soon after Messenger's message sound is silent.
const MESSAGE_SOUND_RING_MS = 5000;
let pendingMessageSound: { thread: string; until: number } | null = null;
let messageSound: { thread: string; at: number } | null = null;

/**
 * Messenger's own new-message sound just played for this conversation, so a
 * native notification for it shouldn't ring too: a message rings once.
 */
export const messengerMessageSoundJustPlayed = (thread: string | null) =>
  thread !== null &&
  messageSound?.thread === thread &&
  Date.now() - messageSound.at < MESSAGE_SOUND_RING_MS;
let context: AudioContext | null = null;
let sounding = 0;
const buffers = new Map<string, Promise<AudioBuffer>>();
const sources = new WeakMap<HTMLMediaElement, Set<AudioBufferSourceNode>>();
// Pauses per element, so a pause stops a sound that is still loading.
const pauses = new WeakMap<HTMLMediaElement, number>();
const pausesOf = (element: HTMLMediaElement) => pauses.get(element) ?? 0;

function decoded(audio: AudioContext, src: string): Promise<AudioBuffer> {
  let buffer = buffers.get(src);
  if (!buffer) {
    buffer = fetch(src)
      .then((response) =>
        response.ok ? response.arrayBuffer() : Promise.reject(new Error(`HTTP ${response.status}`)),
      )
      .then((data) => audio.decodeAudioData(data));
    buffers.set(src, buffer);
    buffer.catch(() => buffers.delete(src));
  }
  return buffer;
}

/**
 * Plays the element's sound through Web Audio. Resolves once it has started
 * (or a pause cancelled it); rejects when Web Audio can't play it. The
 * context sleeps between sounds, so it holds no audio route while idle
 * (#232); Carrier's Web Audio idle gate also tracks it.
 */
async function playThroughWebAudio(element: HTMLMediaElement): Promise<void> {
  const pausesAtStart = pausesOf(element);
  const src = element.currentSrc || element.src;
  const Context = window.AudioContext;
  if (!src || typeof Context !== "function") throw new Error("no Web Audio");
  context ??= new Context();
  const audio = context;
  const awake = Promise.race([
    audio.resume(),
    new Promise((resolve) => setTimeout(resolve, RESUME_WAIT_MS)),
  ]);
  const [data] = await Promise.all([decoded(audio, src), awake]);
  if (pausesOf(element) !== pausesAtStart) return;
  if (audio.state !== "running") throw new Error(`audio ${audio.state}`);
  const source = audio.createBufferSource();
  const gain = audio.createGain();
  source.buffer = data;
  gain.gain.value = element.muted ? 0 : element.volume;
  source.connect(gain).connect(audio.destination);
  let playing = sources.get(element);
  if (!playing) sources.set(element, (playing = new Set()));
  playing.add(source);
  sounding += 1;
  source.onended = () => {
    playing.delete(source);
    sounding -= 1;
    if (sounding === 0) audio.suspend().catch(() => {});
  };
  source.start();
}

let playbackInstalled = false;

/** Route SoundPlayer's one-shot sounds through Web Audio. Idempotent. */
export function installMessengerSoundPlayback() {
  if (playbackInstalled) return;
  playbackInstalled = true;
  const proto = HTMLMediaElement.prototype;
  const nativePlay = proto.play;
  const nativePause = proto.pause;
  proto.play = function (this: HTMLMediaElement) {
    const isSound =
      soundPlayerCalls > 0 &&
      this instanceof HTMLAudioElement &&
      Boolean(this.src) &&
      !this.loop &&
      !this.srcObject;
    if (!isSound) return nativePlay.call(this);
    // Do Not Disturb, Pause and Mute silence all of Messenger's sounds.
    if (notificationsGloballyMuted(window.__CARRIER_SETTINGS__)) return Promise.resolve();
    if (pendingMessageSound && Date.now() < pendingMessageSound.until) {
      messageSound = { thread: pendingMessageSound.thread, at: Date.now() };
      pendingMessageSound = null;
    }
    const pausesAtStart = pausesOf(this);
    return playThroughWebAudio(this).catch(() => {
      diag("sound.web-audio", "Web Audio could not play a Messenger sound; using the element");
      return pausesOf(this) === pausesAtStart ? nativePlay.call(this) : undefined;
    });
  };
  proto.pause = function (this: HTMLMediaElement) {
    if (this instanceof HTMLAudioElement) {
      pauses.set(this, pausesOf(this) + 1);
      for (const source of sources.get(this) ?? []) {
        try {
          source.stop();
        } catch (_) {}
      }
    }
    return nativePause.call(this);
  };
}

/* ---- Facebook modules ---- */

function patchSoundPlayer(exports: Record<string, unknown>): boolean {
  const play = exports.play;
  if (typeof play !== "function") return false;
  exports.play = function (this: unknown, ...args: unknown[]) {
    // A looping sound is a ringtone: a media element, as Messenger plays it.
    const loop = (args[1] as { loop?: unknown } | null | undefined)?.loop === true;
    if (loop) return Reflect.apply(play, this, args);
    soundPlayerCalls += 1;
    try {
      return Reflect.apply(play, this, args);
    } finally {
      soundPlayerCalls -= 1;
    }
  };
  return true;
}

function patchChatPopperCommon(exports: Record<string, unknown>): boolean {
  const playChatTabSound = exports.playChatTabSound;
  if (typeof playChatTabSound !== "function") return false;
  exports.playChatTabSound = function (this: unknown, ...args: unknown[]) {
    const settings = window.__CARRIER_SETTINGS__;
    const load = pageLoad();
    const message = args[0] as { timestampMs?: unknown } | null | undefined;
    const plays = playsMessageSound({
      globallyMuted: notificationsGloballyMuted(settings),
      oldNews: isOldNews(messengerMillis(message?.timestampMs, load), serverNowMs(load), null),
      focused: document.hasFocus(),
      nativeSoundOn: settings?.notification_sound !== false,
    });
    if (!plays) return undefined;
    const thread = messageThreadId(message, load);
    pendingMessageSound = thread ? { thread, until: Date.now() + MESSAGE_SOUND_PENDING_MS } : null;
    return Reflect.apply(playChatTabSound, this, args);
  };
  return true;
}

/** Wrap Facebook's module registration for the two sound modules. */
export function interceptSoundModules(define: Define): Define {
  return new Proxy(define, {
    apply(target, thisArg, args: unknown[]) {
      const factory = args[2];
      if (typeof factory === "function") {
        if (args[0] === SOUND_PLAYER_MODULE) {
          args[2] = wrapFactoryExports(factory as Factory, patchSoundPlayer);
        } else if (args[0] === CHAT_POPPER_COMMON_MODULE) {
          args[2] = wrapFactoryExports(factory as Factory, patchChatPopperCommon);
        }
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
}
