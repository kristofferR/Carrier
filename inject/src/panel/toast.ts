export function installToast() {
  let toastEl: HTMLDivElement | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let toastRemoveTimer: ReturnType<typeof setTimeout> | undefined;

  window.__carrierToast = (msg: string, action?: CarrierToastAction) => {
    if (!toastEl) {
      toastEl = document.createElement("div");
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
      document.body.appendChild(toastEl);
    }

    const el = toastEl;
    const message = document.createElement("span");
    message.textContent = msg;
    el.replaceChildren(message);
    el.style.pointerEvents = action ? "auto" : "none";
    if (action) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
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
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        action.onClick();
      });
      el.append(button);
    }

    requestAnimationFrame(() => {
      el.style.opacity = "1";
      el.style.transform = "translateX(-50%) translateY(0)";
    });
    clearTimeout(toastTimer);
    clearTimeout(toastRemoveTimer);
    toastTimer = setTimeout(
      () => {
        el.style.opacity = "0";
        el.style.transform = "translateX(-50%) translateY(8px)";
        toastRemoveTimer = setTimeout(() => {
          if (toastEl === el) {
            el.remove();
            toastEl = null;
          }
        }, 250);
      },
      action ? 6000 : 2600,
    );
  };

  return () => {
    clearTimeout(toastTimer);
    clearTimeout(toastRemoveTimer);
    toastEl?.remove();
    toastEl = null;
    delete window.__carrierToast;
  };
}
