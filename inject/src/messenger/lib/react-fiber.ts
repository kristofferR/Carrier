/*
 * Which of Messenger's components rendered a page element, read from React's
 * own records. Labels are translated; component identity is not, so menus can
 * be read the same way in every language.
 */

export type Load = (name: string) => unknown;

/** The parts of a React fiber Chatpane reads. */
export interface Fiber {
  type?: unknown;
  elementType?: unknown;
  memoizedProps?: unknown;
  stateNode?: unknown;
  return?: Fiber | null;
}

/**
 * The fiber React keeps for a DOM node. Messenger's React build keeps host
 * fibers in a WeakMap, and the first of ReactDOM's internal event accessors
 * reads that map without changing React or invoking a component.
 */
export function fiberOf(node: Element, load: Load | null): Fiber | null {
  try {
    const reactDOM = load?.("ReactDOM") as
      | { __DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: { Events?: unknown } }
      | undefined;
    const events = reactDOM?.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?.Events;
    if (!Array.isArray(events) || typeof events[0] !== "function") return null;
    const fiber: unknown = events[0](node);
    if (!fiber || typeof fiber !== "object") return null;
    return (fiber as Fiber).stateNode === node ? (fiber as Fiber) : null;
  } catch {
    return null;
  }
}

/** The fiber and its ancestors, nearest first. */
export function* ancestors(fiber: Fiber | null, limit = 60): Generator<Fiber> {
  for (let depth = 0; fiber && depth < limit; depth++) {
    yield fiber;
    fiber = fiber.return ?? null;
  }
}

/** Whether a fiber renders `component`, plain or wrapped in memo or forwardRef. */
export function renders(fiber: Fiber, component: unknown): boolean {
  if (component == null) return false;
  if (fiber.type === component || fiber.elementType === component) return true;
  if (typeof component !== "object") return false;
  const inner = component as { type?: unknown; render?: unknown };
  return (
    (inner.type != null && fiber.type === inner.type) ||
    (inner.render != null && fiber.type === inner.render)
  );
}

/**
 * A module's export: its default unless `member` is named, or undefined.
 * Facebook's `require` already hands back a module's default export when it
 * has one, and the exports object otherwise.
 */
export function moduleExport(load: Load | null, name: string, member?: string): unknown {
  try {
    const value = load?.(name) as Record<string, unknown> | null | undefined;
    if (value == null) return undefined;
    if (member) return value[member];
    return typeof value === "object" && "default" in value ? value.default : value;
  } catch {
    // Not loaded yet, or renamed.
    return undefined;
  }
}

export const propsOf = (fiber: Fiber) =>
  fiber.memoizedProps && typeof fiber.memoizedProps === "object"
    ? (fiber.memoizedProps as Record<string, unknown>)
    : {};
