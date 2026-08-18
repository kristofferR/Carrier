import { describe, expect, test } from "bun:test";
import {
  WEB_AUDIO_IDLE_MS,
  WEB_AUDIO_PING_PONG_WINDOW_MS,
  WebAudioIdleGate,
} from "./web-audio-idle";

const FIGHT_ROUNDS = 9;

describe("WebAudioIdleGate", () => {
  test("a fresh context is idle: creating one is not activity", () => {
    // Creation must never keep the context awake — otherwise the gate resumes
    // a context the page deliberately left suspended and starts the audio
    // hardware for a page that has produced no sound.
    const gate = new WebAudioIdleGate(0);
    expect(gate.wantsRunning(0)).toBe(false);
    expect(gate.nextIdleAt(0)).toBeNull();
    expect(gate.autoSuspendedByUs()).toBe(false);
  });

  test("real activity opens the grace window, which then expires", () => {
    const gate = new WebAudioIdleGate(0);
    gate.activity(1_000);
    expect(gate.wantsRunning(1_000)).toBe(true);
    expect(gate.nextIdleAt(1_000)).toBe(1_000 + WEB_AUDIO_IDLE_MS);
    expect(gate.wantsRunning(1_000 + WEB_AUDIO_IDLE_MS)).toBe(false);
  });

  test("only a gate-initiated suspend may be undone by the gate", () => {
    const gate = new WebAudioIdleGate(0);
    expect(gate.autoSuspendedByUs()).toBe(false);
    gate.autoSuspended(5_000);
    expect(gate.autoSuspendedByUs()).toBe(true);
    gate.pageResumed(20_000);
    expect(gate.autoSuspendedByUs()).toBe(false);
  });

  test("a completed gate resume no longer counts as the gate's suspend", () => {
    // Otherwise a later WebKit interruption would look like ours and get undone.
    const gate = new WebAudioIdleGate(0);
    gate.autoSuspended(5_000);
    gate.autoResumed();
    expect(gate.autoSuspendedByUs()).toBe(false);
  });

  test("activity restarts the grace window and never moves it backwards", () => {
    const gate = new WebAudioIdleGate(0);
    gate.activity(3_000);
    expect(gate.nextIdleAt(3_000)).toBe(3_000 + WEB_AUDIO_IDLE_MS);
    gate.activity(1_000);
    expect(gate.nextIdleAt(3_000)).toBe(3_000 + WEB_AUDIO_IDLE_MS);
  });

  test("a hold keeps the context awake past idle until released, once", () => {
    const gate = new WebAudioIdleGate(0);
    const release = gate.hold(0);
    const late = WEB_AUDIO_IDLE_MS * 10;
    expect(gate.wantsRunning(late)).toBe(true);
    // Held: no idle deadline to schedule; the release drives the next check.
    expect(gate.nextIdleAt(late)).toBeNull();
    release();
    release();
    expect(gate.wantsRunning(late)).toBe(false);
    // A second hold after a double release still counts as one.
    const again = gate.hold(late);
    expect(gate.wantsRunning(late)).toBe(true);
    again();
    // The hold itself was activity, so the grace window still applies.
    expect(gate.wantsRunning(late)).toBe(true);
    expect(gate.wantsRunning(late + WEB_AUDIO_IDLE_MS)).toBe(false);
  });

  test("an active call keeps the context awake without any graph activity", () => {
    const gate = new WebAudioIdleGate(0);
    const late = WEB_AUDIO_IDLE_MS * 10;
    gate.setInCall(true);
    expect(gate.wantsRunning(late)).toBe(true);
    expect(gate.nextIdleAt(late)).toBeNull();
    gate.setInCall(false);
    expect(gate.wantsRunning(late)).toBe(false);
  });

  test("a page-initiated suspend is respected until the page resumes", () => {
    const gate = new WebAudioIdleGate(0);
    gate.hold(0);
    gate.pageSuspendedContext();
    expect(gate.isPageSuspended()).toBe(true);
    expect(gate.wantsRunning(0)).toBe(false);
    gate.pageResumed(1);
    expect(gate.isPageSuspended()).toBe(false);
    expect(gate.wantsRunning(1)).toBe(true);
  });

  test("keeps suspending even when the page repeatedly re-resumes", () => {
    // Persistent by design: a page that fights back must not switch the gate
    // off, or one stubborn page keeps the audio route forever. Each round still
    // costs a full idle window, so the cycle rate stays bounded.
    const gate = new WebAudioIdleGate(0);
    let now = WEB_AUDIO_IDLE_MS;
    for (let i = 0; i < FIGHT_ROUNDS; i += 1) {
      expect(gate.active()).toBe(true);
      gate.autoSuspended(now);
      now += WEB_AUDIO_PING_PONG_WINDOW_MS / 2;
      gate.pageResumed(now);
      expect(gate.fights()).toBeGreaterThan(0);
      now += WEB_AUDIO_IDLE_MS;
      // Still wants to sleep once the grace window has passed.
      expect(gate.wantsRunning(now)).toBe(false);
    }
    expect(gate.active()).toBe(true);
  });

  test("an explicit giveUp (WebKit refused a resume) does stop the gate", () => {
    const gate = new WebAudioIdleGate(0);
    expect(gate.active()).toBe(true);
    gate.giveUp();
    expect(gate.active()).toBe(false);
  });

  test("a resume well after an automatic suspend resets the fight counter", () => {
    const gate = new WebAudioIdleGate(0);
    let now = WEB_AUDIO_IDLE_MS;
    for (let i = 0; i < FIGHT_ROUNDS; i += 1) {
      gate.autoSuspended(now);
      now += WEB_AUDIO_PING_PONG_WINDOW_MS + 1;
      gate.pageResumed(now);
      now += WEB_AUDIO_IDLE_MS;
    }
    expect(gate.active()).toBe(true);
  });

  test("a closed context never wants to run and is no longer managed", () => {
    const gate = new WebAudioIdleGate(0);
    gate.hold(0);
    gate.pageClosedContext();
    expect(gate.wantsRunning(0)).toBe(false);
    expect(gate.active()).toBe(false);
  });
});
