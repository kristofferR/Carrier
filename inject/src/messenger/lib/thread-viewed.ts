export interface ThreadViewedState {
  visible: boolean;
  threadPath: string | null;
}

export interface ThreadViewedTransition {
  state: ThreadViewedState;
  emit: string | null;
}

export const initialThreadViewedState = (): ThreadViewedState => ({
  visible: false,
  threadPath: null,
});

/**
 * Deduplicate visible-thread reports while re-emitting after focus returns.
 * Native code treats this as a user-view heuristic, not a Messenger read receipt.
 */
export function advanceThreadViewed(
  previous: ThreadViewedState,
  threadPath: string | null,
  visible: boolean,
): ThreadViewedTransition {
  const emit =
    visible && threadPath && (!previous.visible || previous.threadPath !== threadPath)
      ? threadPath
      : null;
  return {
    state: { visible, threadPath },
    emit,
  };
}
