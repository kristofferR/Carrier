/* Per-conversation mute: whether Messenger has silenced a thread.
 *
 * Facebook's title "(N)" and bold chat rows still count muted chats. Chatpane
 * reads mute from Messenger's database (thread-state.ts) and, where that
 * can't answer, from the muted icon on a chat row, then remembers the thread
 * id while its row is virtualized. Neither depends on the UI language.
 */
import { messengerDndActive } from "./messenger-dnd";

const MUTED_ROW_ICON_SHAPE = 0x774a4a14;
const MUTED_ROW_ICON_PATH_PREFIX = "M2.5 6c0-.322";
// The glyph sits 16px from a read row's right edge; an unread row's dot pushes
// it to 38px. Bound the trailing status column, not one layout of it.
const MUTED_ROW_ICON_MAX_RIGHT_GAP = 64;

const MUTED_THREAD_LIMIT = 500;
const MUTE_ABSENCE_CONFIRM_MS = 1_000;
const MUTE_ABSENCE_MIN_OBSERVATIONS = 2;

/**
 * What happens to conversations muted in Messenger (Ref #259): left out of
 * the badge and notifications, counted on the badge only, or treated like any
 * other chat. Installs from before the choice keep their on/off setting.
 */
export type MutedConversationPolicy = "ignore" | "badge" | "include";

type MutedPolicySettings = {
  ignore_muted_conversations?: boolean;
  muted_conversations?: string | null;
};

export function mutedConversationPolicy(
  settings: MutedPolicySettings | null | undefined,
): MutedConversationPolicy {
  const policy = settings?.muted_conversations;
  if (policy === "ignore" || policy === "badge" || policy === "include") return policy;
  return settings?.ignore_muted_conversations === false ? "include" : "ignore";
}

/** Muted conversations raise no notification (every policy but "include"). */
export function ignoresMutedConversations(
  settings: MutedPolicySettings | null | undefined,
): boolean {
  return mutedConversationPolicy(settings) !== "include";
}

/** Muted conversations stay off the unread badge (only the "ignore" policy). */
export function badgeIgnoresMutedConversations(
  settings: MutedPolicySettings | null | undefined,
): boolean {
  return mutedConversationPolicy(settings) === "ignore";
}

export function suppressMutedDelivery(
  muted: boolean,
  settings: MutedPolicySettings | null | undefined,
): boolean {
  return muted && ignoresMutedConversations(settings);
}

/** Every notification is silenced: Chatpane's Mute Notifications or Messenger's Do Not Disturb. */
export function notificationsGloballyMuted(
  settings:
    | { mute_notifications?: boolean; notifications_paused_until?: number | null }
    | null
    | undefined,
  now = Date.now(),
): boolean {
  const pausedUntil = settings?.notifications_paused_until;
  return (
    settings?.mute_notifications === true ||
    (typeof pausedUntil === "number" && pausedUntil > now) ||
    messengerDndActive(now)
  );
}

export function suppressNotificationDelivery(
  muted: boolean,
  settings: ({ mute_notifications?: boolean } & MutedPolicySettings) | null | undefined,
): boolean {
  return notificationsGloballyMuted(settings) || suppressMutedDelivery(muted, settings);
}

export interface MutedRowIconShape {
  width: number;
  height: number;
  rightGap: number;
  interactive: boolean;
  ariaHidden: boolean;
  viewBox: string;
  pathCount: number;
  shapeHash: number;
  pathPrefixMatched: boolean;
}

/** Messenger's unlabeled, aria-hidden 16px slashed-bell row status icon, read or unread. */
export function isMutedRowIconShape(shape: MutedRowIconShape): boolean {
  return (
    shape.width >= 14 &&
    shape.width <= 18 &&
    shape.height >= 14 &&
    shape.height <= 18 &&
    shape.rightGap >= 8 &&
    shape.rightGap <= MUTED_ROW_ICON_MAX_RIGHT_GAP &&
    !shape.interactive &&
    shape.ariaHidden &&
    shape.viewBox.replace(/\s+/g, " ").trim() === "0 0 16 16" &&
    shape.pathCount === 1 &&
    (shape.shapeHash === MUTED_ROW_ICON_SHAPE || shape.pathPrefixMatched)
  );
}

const svgShapeHash = (svg: Element): number => {
  let shapeText = "";
  for (const shape of svg.querySelectorAll("path, line, polyline, circle")) {
    shapeText += `${shape.tagName}:${shape.getAttribute("d") || ""}:${shape.getAttribute("points") || ""}:${shape.getAttribute("cx") || ""}:${shape.getAttribute("cy") || ""};`;
  }
  let hash = 2166136261;
  for (let index = 0; index < shapeText.length; index++) {
    hash ^= shapeText.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

export function hasMutedRowIcon(root: ParentNode): boolean {
  if (!(root instanceof Element)) return false;
  const rootRect = root.getBoundingClientRect();
  for (const svg of root.querySelectorAll("svg")) {
    const rect = svg.getBoundingClientRect();
    if (
      isMutedRowIconShape({
        width: rect.width,
        height: rect.height,
        rightGap: rootRect.right - rect.right,
        interactive: !!svg.closest(
          'button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="switch"]',
        ),
        ariaHidden: svg.getAttribute("aria-hidden") === "true",
        viewBox: svg.getAttribute("viewBox") || "",
        pathCount: svg.querySelectorAll("path").length,
        shapeHash: svgShapeHash(svg),
        pathPrefixMatched:
          svg
            .querySelector("path[d]")
            ?.getAttribute("d")
            ?.replace(/\s+/g, " ")
            .trim()
            .startsWith(MUTED_ROW_ICON_PATH_PREFIX) === true,
      })
    ) {
      return true;
    }
  }
  return false;
}

export class MutedThreadStore {
  private readonly states = new Map<string, boolean>();
  private readonly rowAbsences = new Map<string, { since: number; observations: number }>();

  observe(id: string, muted: boolean | undefined): void {
    if (!id || muted === undefined) return;
    this.rowAbsences.delete(id);
    if (this.states.has(id)) this.states.delete(id);
    this.states.set(id, muted);
    if (this.states.size > MUTED_THREAD_LIMIT) {
      const oldest = this.states.keys().next().value!;
      this.states.delete(oldest);
      this.rowAbsences.delete(oldest);
    }
  }

  observeMountedRow(id: string, muted: boolean | undefined, observedAt = Date.now()): void {
    if (!id) return;
    if (muted !== undefined) {
      this.observe(id, muted);
      return;
    }
    if (!this.isMuted(id)) {
      this.rowAbsences.delete(id);
      return;
    }
    const absence = this.rowAbsences.get(id);
    if (absence === undefined || observedAt < absence.since) {
      this.rowAbsences.set(id, { since: observedAt, observations: 1 });
      return;
    }
    absence.observations += 1;
    if (
      observedAt - absence.since >= MUTE_ABSENCE_CONFIRM_MS &&
      absence.observations >= MUTE_ABSENCE_MIN_OBSERVATIONS
    ) {
      this.observe(id, false);
    }
  }

  isMuted(id: string): boolean {
    return this.states.get(id) === true;
  }

  invalidateMute(id: string): void {
    if (id) this.observe(id, false);
  }

  knownMutedUnread(unreadIds: Iterable<string>): boolean {
    for (const id of unreadIds) {
      if (this.states.get(id) === true) return true;
    }
    return false;
  }
}

/** Shared across the unread badge and the notification scanner. */
export const mutedThreads = new MutedThreadStore();

/** A mounted chat row: its muted icon, or that icon's lasting absence. */
export function observeConversationMute(id: string, root: ParentNode): boolean {
  mutedThreads.observeMountedRow(id, hasMutedRowIcon(root) ? true : undefined);
  return mutedThreads.isMuted(id);
}

/** Messenger's own database answered: it outranks any rendered evidence. */
export function observeDatabaseMute(id: string, muted: boolean): boolean {
  mutedThreads.observe(id, muted);
  return muted;
}
