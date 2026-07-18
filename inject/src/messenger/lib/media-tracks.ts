export interface TrackLike {
  readonly readyState: string;
  stop(): void;
  addEventListener(type: "ended", listener: () => void, options?: { once?: boolean }): void;
}

/**
 * Counts live camera/microphone tracks across overlapping getUserMedia calls.
 *
 * MediaStreamTrack.stop() deliberately does not fire `ended`, so every tracked
 * instance gets an idempotent stop wrapper in addition to its `ended` listener.
 */
export class LiveMediaTrackCounter<T extends TrackLike = TrackLike> {
  private readonly tracked = new WeakSet<T>();
  private live = 0;

  constructor(private readonly onChange: (inCall: boolean) => void) {}

  add(track: T) {
    if (this.tracked.has(track) || track.readyState === "ended") return;
    this.tracked.add(track);

    let active = true;
    const finish = () => {
      if (!active) return;
      active = false;
      this.live = Math.max(0, this.live - 1);
      this.onChange(this.live > 0);
    };

    this.live += 1;
    this.onChange(true);
    track.addEventListener("ended", finish, { once: true });

    const originalStop = track.stop.bind(track);
    track.stop = () => {
      try {
        originalStop();
      } finally {
        finish();
      }
    };
  }

  count() {
    return this.live;
  }
}
