/* ------------------ Messenger's own notifications (#351) ------------------ */
// Enable Messenger's own new-message notifications inside Carrier and record
// the exact conversation of each one. See lib/page-notifications.ts.
import { diag } from "../bridge";
import {
  CHAT_POPPER_MODULE,
  DESKTOP_NOTIFICATIONS_MODULE,
  loadRewrittenScript,
  wrapChatPopperFactory,
  wrapDesktopNotificationsFactory,
} from "../lib/page-notifications";

type Define = (...args: unknown[]) => unknown;
type Factory = (...args: unknown[]) => unknown;

/** Evaluate a rewritten factory as a blob: script, the one form the page's CSP allows. */
function loadRewritten(source: string, ready: (rewritten: Factory) => void) {
  loadRewrittenScript(source, ready, document, globalThis, (outcome) => {
    if (outcome === "loaded")
      diag("notify.page-enabled", "Messenger's own notifications are enabled");
    else if (outcome === "refused") {
      diag("notify.page-rewrite", "the page refused the rewritten notification module");
    } else diag("notify.page-rewrite", "rewritten notification module did not load");
  });
}

/** Wrap Facebook's module registration for the two notification modules. */
export function interceptNotificationModules(define: Define): Define {
  const load = () => (window as unknown as { require?: unknown }).require;
  return new Proxy(define, {
    apply(target, thisArg, args: unknown[]) {
      const name = args[0];
      const factory = args[2];
      if (typeof factory === "function") {
        if (name === CHAT_POPPER_MODULE) {
          args[2] = wrapChatPopperFactory(factory as Factory, loadRewritten, () =>
            diag(
              "notify.page-rewrite",
              "Messenger's notification gate changed; using the fallback",
            ),
          );
        } else if (name === DESKTOP_NOTIFICATIONS_MODULE) {
          args[2] = wrapDesktopNotificationsFactory(factory as Factory, load);
        }
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
}
