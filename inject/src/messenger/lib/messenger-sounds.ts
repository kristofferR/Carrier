/*
 * Messenger's own new-message sound, played in the page by
 * `MWLSChatPopperCommon.playChatTabSound` (the first three messages of a
 * conversation while the window is unfocused, every message while it is
 * focused, when the account's chat sounds are on).
 *
 * Messenger plays it whatever Do Not Disturb says, and while the window is
 * unfocused it plays it next to the notification it raises, which Carrier
 * delivers natively with the system's sound: one message rang twice.
 */

export interface MessageSoundState {
  /** Carrier's Mute or Pause, or Messenger's Do Not Disturb. */
  globallyMuted: boolean;
  /** The message is old news (see isOldNews): it raises no notification either. */
  oldNews: boolean;
  /** The Messenger window has the focus. */
  focused: boolean;
  /** Carrier's notifications play a sound: `notification_sound`, off only when the chosen sound is Off. */
  nativeSoundOn: boolean;
}

/**
 * Whether Messenger's sound plays for a new message. Unfocused, Messenger
 * also notifies, and a native notification that rings is the message's one
 * sound; focused, Messenger raises no notification and its sound is the one.
 */
export function playsMessageSound(state: MessageSoundState): boolean {
  if (state.globallyMuted || state.oldNews) return false;
  return state.focused || !state.nativeSoundOn;
}
