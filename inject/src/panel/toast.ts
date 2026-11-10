import { language, t } from "../i18n";

/** Only a browser-generated activation of Chatpane's own button may reveal. */
export const canActivateToastAction = (eventIsTrusted: boolean, userActivationIsActive: boolean) =>
  eventIsTrusted && userActivationIsActive;

export function installToast() {
  const toastEl = document.createElement("div");
  toastEl.setAttribute("role", "status");
  toastEl.setAttribute("aria-live", "polite");
  toastEl.setAttribute("aria-atomic", "true");
  // Chatpane's language, whatever direction Facebook lays its page out in.
  Object.assign(toastEl, language());
  Object.assign(toastEl.style, {
    position: "fixed",
    bottom: "24px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 2147483647,
    display: "flex",
    alignItems: "center",
    gap: "12px",
    background: "#242526",
    color: "#e4e6eb",
    padding: "10px 16px",
    borderRadius: "10px",
    boxShadow: "0 8px 28px rgba(0,0,0,.45)",
    font: "13px -apple-system, system-ui, sans-serif",
    opacity: "0",
    transition: "opacity .2s, transform .2s",
    pointerEvents: "none",
    maxWidth: "80vw",
  });
  const message = document.createElement("span");
  const button = document.createElement("button");
  button.type = "button";
  Object.assign(button.style, {
    border: "0",
    padding: "0",
    background: "transparent",
    color: "#8ab4ff",
    font: "inherit",
    fontWeight: "600",
    whiteSpace: "nowrap",
    cursor: "pointer",
  });

  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "✕";
  close.setAttribute("aria-label", t("page.window.close"));
  Object.assign(close.style, {
    border: "0",
    padding: "0 2px",
    background: "transparent",
    color: "#b0b3b8",
    font: "inherit",
    cursor: "pointer",
  });

  let mounted = false;
  let action: ChatpaneToastAction | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let toastRemoveTimer: ReturnType<typeof setTimeout> | undefined;

  // Register the capability-bearing handler before Facebook's scripts run.
  // Later toast calls cross the page-visible hook as inert data only; no
  // reveal callback or authorization secret is ever handed to that hook.
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (
      !action ||
      !canActivateToastAction(event.isTrusted, navigator.userActivation?.isActive === true)
    ) {
      return;
    }
    if (action.kind === "reveal-download") chatpaneRevealDownload(action.url)?.catch?.(() => {});
    else if (action.kind === "open-download-privacy")
      chatpaneOpenDownloadPrivacy()?.catch?.(() => {});
    else if (action.kind === "star-github") chatpaneStarPrompt("star")?.catch?.(() => {});
    hide();
  });
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    hide();
  });

  const hide = () => {
    clearTimeout(toastTimer);
    clearTimeout(toastRemoveTimer);
    action = undefined;
    toastEl.style.pointerEvents = "none";
    toastEl.style.opacity = "0";
    toastEl.style.transform = "translateX(-50%) translateY(8px)";
    toastRemoveTimer = setTimeout(() => {
      toastEl.remove();
      mounted = false;
      action = undefined;
    }, 250);
  };
  const scheduleHide = (ms: number) => {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hide, ms);
  };
  // Hovering holds an interactive toast open; leaving gives a moment to go.
  toastEl.addEventListener("mouseenter", () => clearTimeout(toastTimer));
  toastEl.addEventListener("mouseleave", () => {
    if (mounted) scheduleHide(2600);
  });

  const showToast = (
    msg: string,
    nextAction?: ChatpaneToastAction,
    options?: ChatpaneToastOptions,
  ) => {
    if (!mounted) {
      document.body.appendChild(toastEl);
      mounted = true;
    }

    action = nextAction;
    toastEl.setAttribute("role", options?.warning ? "alert" : "status");
    toastEl.setAttribute("aria-live", options?.warning ? "assertive" : "polite");
    toastEl.style.border = options?.warning ? "1px solid #b58130" : "none";
    toastEl.style.bottom = `${options?.bottom ?? 24}px`;
    message.textContent = msg;
    toastEl.replaceChildren(message);
    toastEl.style.pointerEvents = action || options?.closable ? "auto" : "none";
    if (action) {
      button.textContent = action.label;
      toastEl.append(button);
    }
    if (options?.closable) toastEl.append(close);

    requestAnimationFrame(() => {
      toastEl.style.opacity = "1";
      toastEl.style.transform = "translateX(-50%) translateY(0)";
    });
    clearTimeout(toastRemoveTimer);
    scheduleHide(options?.duration ?? (options?.warning ? 8000 : action ? 6000 : 2600));
  };

  Object.defineProperty(window, "__chatpaneToast", {
    value: showToast,
    writable: false,
    configurable: false,
  });

  return () => {
    clearTimeout(toastTimer);
    clearTimeout(toastRemoveTimer);
    toastEl.remove();
    mounted = false;
    action = undefined;
  };
}
