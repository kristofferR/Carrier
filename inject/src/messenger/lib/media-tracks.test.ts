import { describe, expect, test } from "bun:test";
import { LiveMediaTrackCounter, type TrackLike } from "./media-tracks";

class FakeTrack implements TrackLike {
  readyState = "live";
  stopCalls = 0;
  private endedListeners: (() => void)[] = [];

  addEventListener(type: "ended", listener: () => void) {
    if (type === "ended") this.endedListeners.push(listener);
  }

  stop() {
    this.stopCalls += 1;
    this.readyState = "ended";
  }

  endExternally() {
    this.readyState = "ended";
    for (const listener of this.endedListeners) listener();
  }
}

describe("LiveMediaTrackCounter", () => {
  test("normal stop clears call state even though it emits no ended event", () => {
    const states: boolean[] = [];
    const counter = new LiveMediaTrackCounter<FakeTrack>((active) => states.push(active));
    const track = new FakeTrack();

    counter.add(track);
    track.stop();

    expect(track.stopCalls).toBe(1);
    expect(counter.count()).toBe(0);
    expect(states).toEqual([true, false]);
  });

  test("overlapping streams stay active until every track ends", () => {
    const states: boolean[] = [];
    const counter = new LiveMediaTrackCounter<FakeTrack>((active) => states.push(active));
    const first = new FakeTrack();
    const second = new FakeTrack();

    counter.add(first);
    counter.add(second);
    first.stop();

    expect(counter.count()).toBe(1);
    expect(states.at(-1)).toBe(true);

    second.endExternally();
    expect(counter.count()).toBe(0);
    expect(states.at(-1)).toBe(false);
  });

  test("ended and stop cleanup cannot double-decrement", () => {
    const counter = new LiveMediaTrackCounter<FakeTrack>(() => {});
    const track = new FakeTrack();

    counter.add(track);
    track.endExternally();
    track.stop();
    counter.add(track);

    expect(counter.count()).toBe(0);
  });
});
