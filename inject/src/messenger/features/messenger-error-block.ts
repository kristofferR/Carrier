/* ---------------- Recover from "Couldn't load chats" ---------------- */
// While Messenger shows its load-failure screen, sync recovery reports an
// error page and the native watchdog reloads the page, then rebuilds it if
// the screen comes back. See lib/messenger-error-block.ts.
import { diag } from "../bridge";
import {
  ERROR_BLOCK_MODULE,
  ErrorBlockTracker,
  type ReactLike,
  wrapErrorBlockFactory,
} from "../lib/messenger-error-block";

type Define = (...args: unknown[]) => unknown;
type Factory = (...args: unknown[]) => unknown;

/** Dispatched on window when the screen appears or goes away. */
export const ERROR_BLOCK_EVENT = "chatpane:messenger-error-block";

const tracker = new ErrorBlockTracker((shown, error) => {
  diag("recover.error-block", `${shown ? "shown" : "gone"}: ${error}`);
  window.dispatchEvent(new CustomEvent(ERROR_BLOCK_EVENT));
});

export const messengerErrorBlockShown = () => tracker.isShown;

const react = (): ReactLike | null => {
  try {
    const load = (window as unknown as { require?: (name: string) => unknown }).require;
    const React = load?.("react") as Partial<ReactLike> | undefined;
    return typeof React?.createElement === "function" && typeof React.useEffect === "function"
      ? (React as ReactLike)
      : null;
  } catch {
    return null;
  }
};

/** Wrap Facebook's module registration for the error block. */
export function interceptErrorBlock(define: Define): Define {
  return new Proxy(define, {
    apply(target, thisArg, args: unknown[]) {
      if (args[0] === ERROR_BLOCK_MODULE && typeof args[2] === "function") {
        args[2] = wrapErrorBlockFactory(args[2] as Factory, react, tracker);
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
}
