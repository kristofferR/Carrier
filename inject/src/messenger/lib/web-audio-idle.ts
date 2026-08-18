/**
 * Decides whether a Web Audio context should be running right now.
 *
 * Messenger creates an AudioContext at page load and leaves it running for the
 * life of the page. A running context keeps a real-time CoreAudio output
 * client rendering silence and, on macOS, holds a Bluetooth audio session that
 * competes with other apps for the route and can trip a HAL overload that
 * stalls the shared output device (#232 second half — the foreground failure,
 * distinct from the hidden-window suspend/resume flip fixed by
 * background_throttling). This gate keeps the context awake only while
 * something can actually produce sound: a scheduled source between start() and
 * `ended`, a playing media element, a live MediaStream input, an active call,
 * or a short grace after any such activity — so an idle Messenger tab holds no
 * audio route and renders no silence.
 *
 * Pure: the caller supplies timestamps (performance.now()) and applies the
 * verdict to the real context.
 */
export const WEB_AUDIO_IDLE_MS = 5_000;
/** A page resume this soon after an automatic suspend counts as fighting it (observability only). */
export const WEB_AUDIO_PING_PONG_WINDOW_MS = 2_000;

export class WebAudioIdleGate {
  private holds = 0;
  private inCall = false;
  private lastActivityAt: number;
  private lastAutoSuspendAt = Number.NEGATIVE_INFINITY;
  private pingPongs = 0;
  private givenUp = false;
  private pageSuspended = false;
  private weSuspended = false;
  private closed = false;

  constructor(
    _createdAt: number,
    private readonly idleMs = WEB_AUDIO_IDLE_MS,
  ) {
    // A freshly created context has produced nothing. Creation is NOT activity:
    // treating it as such made the gate resume a context the page had left
    // suspended, switching on audio hardware Facebook never asked for.
    this.lastActivityAt = Number.NEGATIVE_INFINITY;
  }

  /** Something touched the graph; keep the context awake for the grace window. */
  activity(now: number) {
    if (now > this.lastActivityAt) this.lastActivityAt = now;
  }

  /** Keep the context awake until the returned release runs (idempotent). */
  hold(now: number): () => void {
    this.activity(now);
    this.holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds = Math.max(0, this.holds - 1);
    };
  }

  setInCall(inCall: boolean) {
    this.inCall = inCall;
  }

  /** The page called resume() itself. */
  pageResumed(now: number) {
    this.pageSuspended = false;
    this.weSuspended = false;
    if (now - this.lastAutoSuspendAt < WEB_AUDIO_PING_PONG_WINDOW_MS) {
      this.pingPongs += 1;
    } else {
      this.pingPongs = 0;
    }
    // Deliberately persistent: a page that re-resumes does NOT switch the gate
    // off. Each cycle still costs a full idle window (WEB_AUDIO_IDLE_MS), so
    // the worst case is bounded and the session spends most of its time
    // released. `giveUp()` remains for the case where WebKit refuses a resume.
    this.activity(now);
  }

  /** How many times the page re-resumed right after an automatic suspend. */
  fights() {
    return this.pingPongs;
  }

  /** The page called suspend() itself; never auto-resume over it. */
  pageSuspendedContext() {
    this.pageSuspended = true;
  }

  pageClosedContext() {
    this.closed = true;
  }

  /** Record that the caller just suspended the context on the gate's verdict. */
  autoSuspended(now: number) {
    this.lastAutoSuspendAt = now;
    this.weSuspended = true;
  }

  /** True when the current suspended state was produced by this gate. */
  autoSuspendedByUs() {
    return this.weSuspended;
  }

  /** The gate's own resume took effect; a later suspend is not ours to undo. */
  autoResumed() {
    this.weSuspended = false;
  }

  /** Stop intervening; the page keeps full control from now on. */
  giveUp() {
    this.givenUp = true;
  }

  /** False once the gate should no longer touch the context at all. */
  active() {
    return !this.givenUp && !this.closed;
  }

  /** Whether the page itself has suspended the context. */
  isPageSuspended() {
    return this.pageSuspended;
  }

  wantsRunning(now: number) {
    if (this.closed || this.pageSuspended) return false;
    return this.holds > 0 || this.inCall || now - this.lastActivityAt < this.idleMs;
  }

  /**
   * When the grace window ends, if that is what currently keeps the context
   * awake; null when it should not run, or when a hold or call keeps it awake
   * (those release through their own events).
   */
  nextIdleAt(now: number): number | null {
    if (!this.wantsRunning(now) || this.holds > 0 || this.inCall) return null;
    return this.lastActivityAt + this.idleMs;
  }
}
