export interface ThreadViewedState {
  visible: boolean;
  threadPath: string | null;
  lastReportedAt: number | null;
}

export interface ThreadViewedTransition {
  state: ThreadViewedState;
  emit: string | null;
}

export const initialThreadViewedState = (): ThreadViewedState => ({
  visible: false,
  threadPath: null,
  lastReportedAt: null,
});

export const THREAD_VIEW_RECHECK_MS = 5_000;

/**
 * Deduplicate visible-thread reports while re-emitting after focus returns and
 * periodically while the user stays put, so newly arrived native notifications
 * are cleared too. Native code treats this as a user-view heuristic, not a
 * Messenger read receipt.
 */
export function advanceThreadViewed(
  previous: ThreadViewedState,
  threadPath: string | null,
  visible: boolean,
  now: number,
): ThreadViewedTransition {
  const active = visible && threadPath !== null;
  const changed = !previous.visible || previous.threadPath !== threadPath;
  const recheckDue =
    active &&
    previous.lastReportedAt !== null &&
    Number.isFinite(now) &&
    now >= previous.lastReportedAt + THREAD_VIEW_RECHECK_MS;
  const emit = active && (changed || recheckDue) ? threadPath : null;
  return {
    state: {
      visible,
      threadPath,
      lastReportedAt: emit ? now : active ? previous.lastReportedAt : null,
    },
    emit,
  };
}
