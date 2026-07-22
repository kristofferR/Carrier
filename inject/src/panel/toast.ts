/** Only a browser-generated activation of Carrier's own button may reveal. */
export const canActivateToastAction = (eventIsTrusted: boolean, userActivationIsActive: boolean) =>
  eventIsTrusted && userActivationIsActive;

export function installToast() {
  const toastEl = document.createElement("div");
  toastEl.setAttribute("role", "status");
  toastEl.setAttribute("aria-live", "polite");
  toastEl.setAttribute("aria-atomic", "true");
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

  let mounted = false;
  let action: CarrierToastAction | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let toastRemoveTimer: ReturnType<typeof setTimeout> | undefined;

  // Register the capability-bearing handler before Facebook's scripts run.
  // Later toast calls cross the page-visible hook as inert data only; no
  // reveal callback or authorization secret is ever handed to that hook.
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (
      action?.kind !== "reveal-download" ||
      !canActivateToastAction(event.isTrusted, navigator.userActivation?.isActive === true)
    ) {
      return;
    }
    carrierRevealDownload(action.url)?.catch?.(() => {});
  });

  const showToast = (msg: string, nextAction?: CarrierToastAction) => {
    if (!mounted) {
      document.body.appendChild(toastEl);
      mounted = true;
    }

    action = nextAction;
    message.textContent = msg;
    toastEl.replaceChildren(message);
    toastEl.style.pointerEvents = action ? "auto" : "none";
    if (action) {
      button.textContent = action.label;
      toastEl.append(button);
    }

    requestAnimationFrame(() => {
      toastEl.style.opacity = "1";
      toastEl.style.transform = "translateX(-50%) translateY(0)";
    });
    clearTimeout(toastTimer);
    clearTimeout(toastRemoveTimer);
    toastTimer = setTimeout(
      () => {
        toastEl.style.opacity = "0";
        toastEl.style.transform = "translateX(-50%) translateY(8px)";
        toastRemoveTimer = setTimeout(() => {
          toastEl.remove();
          mounted = false;
          action = undefined;
        }, 250);
      },
      action ? 6000 : 2600,
    );
  };

  Object.defineProperty(window, "__carrierToast", {
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
