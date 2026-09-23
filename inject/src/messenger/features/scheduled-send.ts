import { diag, toast } from "../bridge";
import {
  composerControls,
  composerRegion,
  composerText,
  findComposer,
  findSendButton,
  hasComposerMedia,
  replaceComposerText,
} from "../lib/scheduled-composer";
import {
  formatScheduleTime,
  localDateValue,
  localScheduleTime,
  MAX_SCHEDULED_CHARS,
  nextDueMessage,
  type ScheduledMessage,
  type ScheduleRequest,
  type ScheduleResponse,
  SEND_GRACE_MS,
  schedulePresets,
  sendWindow,
  withComposerDelivery,
} from "../lib/scheduled-send";
import { accountScopedStorageKey, threadIdFromHref } from "../lib/threads";
import { buttonByLabel, isShown } from "./conversation-actions";
import { rateLimitRemainingMs } from "./rate-limit";
import { scheduledSendConnectionReady } from "./realtime-health";

const account = () => accountScopedStorageKey("schedule", document.cookie)?.split(":")[1] ?? null;
const thread = () => {
  const id = threadIdFromHref(location.pathname);
  return id ? `/t/${id}/` : null;
};
const loadedThread = thread();
let routeChanged = false;
const pushState = history.pushState.bind(history);
history.pushState = (...args: Parameters<History["pushState"]>) => {
  const previous = thread();
  pushState(...args);
  if (thread() !== previous) routeChanged = true;
};
const replaceState = history.replaceState.bind(history);
history.replaceState = (...args: Parameters<History["replaceState"]>) => {
  const previous = thread();
  replaceState(...args);
  if (thread() !== previous) routeChanged = true;
};
window.addEventListener("popstate", () => {
  routeChanged = true;
});
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 100));
const ready = () =>
  scheduledSendConnectionReady() && rateLimitRemainingMs() <= 0 && !window.__carrierInCall;
const activeTextInput = () =>
  document.hasFocus() &&
  document.activeElement?.matches('input, textarea, [contenteditable="true"][role="textbox"]');
const paneThread = () => {
  const pane = document.querySelector('[role="main"] [role="log"]');
  if (!pane) return null;
  // A title or SPA route can belong to a different, still-mounted conversation.
  const paneId = pane.getAttribute("data-thread-id");
  if (paneId && /^\d+$/.test(paneId)) return `/t/${paneId}/`;
  // A fresh document requested this thread directly. Once the SPA has changed
  // routes, the poller reloads before claiming so this proof is never reused.
  return !routeChanged && loadedThread === thread() ? loadedThread : null;
};

/** A native claim has already been persisted. Only "defer" may be retried, and
 * only when we can prove we never clicked Send or left inserted text behind. */
export async function deliverScheduledMessage(
  message: ScheduledMessage,
  connectionReady: () => boolean = ready,
): Promise<"sent" | "missed" | "uncertain" | "defer"> {
  if (
    !connectionReady() ||
    account() !== message.account ||
    sendWindow(message.due, Date.now()) !== "due"
  )
    return "defer";
  const existing = findComposer();
  if (existing && (composerText(existing).trim() || hasComposerMedia(existing))) return "defer";
  if (thread() !== message.thread && activeTextInput()) return "defer";
  if (thread() !== message.thread) {
    // A hard navigation discards the running claim. Prefer the existing SPA
    // row; navigation fallback is handled before claiming by the poller.
    const link = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/t/"]')].find(
      (a) => threadIdFromHref(a.getAttribute("href")) === threadIdFromHref(message.thread),
    );
    if (!link) return "defer";
    link.click();
    // The URL can change before Messenger replaces the conversation pane.
    return "defer";
  }
  const deadline = Math.min(message.due + SEND_GRACE_MS, Date.now() + 12_000);
  let box: HTMLElement | null = null;
  let inserted = false;
  let clicked = false;
  let cleared = false;
  let interrupted = false;
  let controls = new Map<HTMLElement, string>();
  const onInput = (event: Event) => {
    if (event.isTrusted) interrupted = true;
  };
  document.addEventListener("pointerdown", onInput, true);
  document.addEventListener("keydown", onInput, true);
  try {
    while (Date.now() <= deadline) {
      if (interrupted || account() !== message.account || !connectionReady()) break;
      const current = findComposer();
      if (thread() !== message.thread) {
        if (inserted) break;
        await pause();
        continue;
      }
      if (!current || hasComposerMedia(current)) {
        if (inserted) break;
        await pause();
        continue;
      }
      if (paneThread() !== message.thread) return "defer";
      if (!inserted) {
        if (composerText(current).trim()) return "defer";
        box = current;
        controls = composerControls(box);
        if (!replaceComposerText(box, message.text)) break;
        inserted = true;
        await pause(); // Let Lexical/React render the send control.
        continue;
      }
      if (current !== box || composerText(current) !== message.text) break;
      const send = findSendButton(current, controls);
      if (!send) {
        await pause();
        continue;
      }
      // No await between the final guards and Messenger's own submit action.
      if (
        Date.now() > message.due + SEND_GRACE_MS ||
        account() !== message.account ||
        !connectionReady()
      )
        break;
      clicked = true;
      send.click();
      const confirmUntil = Date.now() + 5_000;
      while (Date.now() < confirmUntil) {
        if (thread() !== message.thread || account() !== message.account || !box.isConnected)
          return "uncertain";
        if (!composerText(box).trim()) return "sent";
        await pause();
      }
      return "uncertain";
    }
  } finally {
    document.removeEventListener("pointerdown", onInput, true);
    document.removeEventListener("keydown", onInput, true);
    // Undo only our exact unsent text, never a user's intervening edits.
    if (
      !clicked &&
      inserted &&
      box?.isConnected &&
      thread() === message.thread &&
      account() === message.account &&
      composerText(box) === message.text
    )
      cleared = replaceComposerText(box, "");
  }
  if (clicked) return "uncertain";
  if (inserted && !cleared && (!box?.isConnected || !composerText(box).trim())) return "uncertain";
  if (inserted && box?.isConnected && composerText(box).trim()) return "missed";
  return sendWindow(message.due, Date.now()) === "missed" ? "missed" : "defer";
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
const action = (label: string, run: () => void, className = "carrier-schedule-action") => {
  const button = element("button", className, label);
  button.type = "button";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    run();
  });
  return button;
};

export function initScheduledSend() {
  let rows: ScheduledMessage[] = [];
  let owner: string | null = null;
  let polling = false;
  let busy = false;
  let panel: HTMLDivElement | null = null;
  let panelThread: string | null = null;
  let editing: ScheduledMessage | null = null;
  let sourceBox: HTMLElement | null = null;
  let sourceText = "";
  let button: HTMLButtonElement | null = null;
  let emoji: HTMLElement | null = null;
  let cachedBox: HTMLElement | null = null;
  let framePending = false;
  let canDeliver = false;

  const close = (focus = false) => {
    panel?.remove();
    panel = null;
    editing = null;
    button?.setAttribute("aria-expanded", "false");
    if (focus) button?.focus();
  };
  const request = async (
    operation: Omit<ScheduleRequest, "account">,
  ): Promise<ScheduleResponse> => {
    const current = account();
    if (!current) throw new Error("Sign in to schedule a message.");
    const response = await carrierScheduledSend({ ...operation, account: current });
    if (account() !== current) throw new Error("The signed-in account changed.");
    if (response.error) throw new Error(response.error);
    owner = current;
    rows = response.items;
    canDeliver = response.can_deliver;
    ensureButton();
    return response;
  };
  const failed = (error: unknown) => {
    toast(error instanceof Error ? error.message : "Could not update scheduled messages.");
    diag("scheduled-send.action", "schedule operation failed");
  };
  const warning = async () => {
    if (document.hidden || !window.__carrierToast) return;
    const missed = rows.filter(
      (row) =>
        (row.status === "missed" || row.status === "missed_draft" || row.status === "uncertain") &&
        !row.toast_seen,
    );
    if (!missed.length) return;
    toast(
      missed.some((row) => row.status === "uncertain")
        ? "⚠ Scheduled send could not be confirmed. It will not be retried. Open Schedule send to review."
        : "⚠ Scheduled message not sent: its time window passed. Open Schedule send to reschedule.",
      undefined,
      { warning: true },
    );
    for (const row of missed) await request({ op: "seen", id: row.id });
  };
  const positionPanel = () => {
    if (!panel || !button) return;
    const anchor = button.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(innerWidth - panel.offsetWidth - 8, anchor.right - panel.offsetWidth))}px`;
    panel.style.bottom = `${Math.max(8, innerHeight - anchor.top + 10)}px`;
    panel.style.maxHeight = `${Math.max(120, anchor.top - 20)}px`;
  };
  const syncColors = () => {
    if (!button || !emoji) return;
    const icon = emoji.querySelector("svg path") || emoji.querySelector("svg");
    const fill = icon ? getComputedStyle(icon).fill : "";
    const accent = fill && fill !== "none" ? fill : getComputedStyle(emoji).color;
    button.style.color = accent;
    if (!panel) return;
    panel.style.setProperty("--schedule-accent", accent);
  };
  const save = async (due: number) => {
    if (busy) return;
    const current = account();
    if (!current || current !== owner || thread() !== panelThread) {
      close();
      return;
    }
    const text = editing?.text ?? sourceText;
    if (!text.trim() || [...text].length > MAX_SCHEDULED_CHARS) {
      toast("Use 1–2,000 characters for a scheduled message.");
      return;
    }
    if (
      !editing &&
      (!sourceBox?.isConnected ||
        composerText(sourceBox) !== sourceText ||
        hasComposerMedia(sourceBox))
    ) {
      toast("Your draft changed. Reopen Schedule send.");
      close();
      return;
    }
    if (due <= Date.now()) {
      toast("Choose a future date and time.");
      return;
    }
    busy = true;
    const editingItem = editing;
    const expectedBox = sourceBox;
    const expectedThread = panelThread;
    const expectedText = sourceText;
    const recoveredDraft =
      editingItem?.status === "draft" || editingItem?.status === "missed_draft";
    if (
      recoveredDraft &&
      (editingItem.thread !== expectedThread ||
        !expectedBox?.isConnected ||
        composerText(expectedBox) !== editingItem.text ||
        hasComposerMedia(expectedBox))
    ) {
      busy = false;
      toast("Open the original conversation with its unchanged draft to schedule this message.");
      return;
    }
    try {
      let result: ScheduleResponse;
      try {
        result = await request({
          op: "save",
          ...(editingItem ? { id: editingItem.id } : {}),
          thread: editingItem?.thread ?? expectedThread ?? undefined,
          text,
          due,
        });
      } catch (error) {
        if (!editingItem || recoveredDraft) throw error;
        let saved: ScheduledMessage | undefined;
        try {
          saved = (await request({ op: "list" })).items.find((row) => row.id === editingItem.id);
        } catch {
          // A second lost reply leaves the durable outcome unknown.
        }
        if (
          saved?.status !== "scheduled" ||
          saved.account !== current ||
          saved.thread !== editingItem.thread ||
          saved.text !== text ||
          saved.due !== due
        ) {
          if (saved && (saved.due !== due || saved.status !== "scheduled")) throw error;
          throw new Error(
            "Scheduling could not be confirmed. Check Schedule send before retrying.",
          );
        }
        result = {
          items: rows,
          saved: saved.id,
          claimed: null,
          error: null,
          can_deliver: canDeliver,
        };
      }
      if (!result.saved) throw new Error("Message was not saved.");
      if (!editingItem || recoveredDraft) {
        // Never clear a changed draft; cancel the persisted schedule instead.
        const textToClear = recoveredDraft ? (editingItem?.text ?? "") : expectedText;
        const unchanged =
          expectedBox?.isConnected &&
          thread() === expectedThread &&
          account() === current &&
          composerText(expectedBox) === textToClear &&
          !hasComposerMedia(expectedBox);
        if (
          !unchanged ||
          !expectedBox ||
          !replaceComposerText(expectedBox, "") ||
          composerText(expectedBox).trim()
        ) {
          if (!editingItem) await request({ op: "cancel", id: result.saved });
          throw new Error("Draft changed or could not be cleared. The message was not scheduled.");
        }
      }
      // Recovered drafts also need the composer-clear handshake before arming.
      if (!editingItem || recoveredDraft) {
        try {
          await request({ op: "arm", id: result.saved });
        } catch (error) {
          // The native store may have committed even if the signed reply was lost.
          let status: ScheduledMessage["status"] | undefined;
          try {
            status = (await request({ op: "list" })).items.find(
              (row) => row.id === result.saved,
            )?.status;
          } catch {
            // A second lost reply leaves the durable outcome unknown.
          }
          if (status !== "scheduled") {
            if (status === "draft" || status === "missed_draft") throw error;
            throw new Error(
              "Scheduling could not be confirmed. Check Schedule send before retrying.",
            );
          }
        }
      }
      close();
      toast(`Message scheduled for ${formatScheduleTime(due, true)}. It will send automatically.`);
    } catch (error) {
      failed(error);
    } finally {
      busy = false;
    }
  };
  const customPicker = (container: HTMLElement, due = Date.now() + 10 * 60_000) => {
    const fields = element("div", "carrier-schedule-fields");
    const dateLabel = element("label", "", "Date");
    const date = element("input", "");
    date.type = "date";
    date.value = localDateValue(due);
    date.min = localDateValue(Date.now());
    date.required = true;
    const timeLabel = element("label", "", "Time (24h)");
    const time = element("input", "");
    time.type = "text";
    time.inputMode = "numeric";
    time.placeholder = "HH:mm";
    time.pattern = "([01][0-9]|2[0-3]):[0-5][0-9]";
    time.required = true;
    const local = new Date(due);
    time.value = `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
    dateLabel.append(date);
    timeLabel.append(time);
    fields.append(dateLabel, timeLabel);
    const confirm = action(
      editing ? "Reschedule message" : "Schedule message",
      () => {
        if (!date.reportValidity() || !time.reportValidity()) return;
        const value = localScheduleTime(date.value, time.value);
        if (value === null) {
          toast("Choose a valid local time in HH:mm format.");
          return;
        }
        void save(value);
      },
      "carrier-schedule-primary",
    );
    container.append(fields, confirm);
  };
  const render = () => {
    if (!panel) return;
    panel.replaceChildren();
    const heading = element("div", "carrier-schedule-heading");
    const closeButton = action("", () => close(true), "carrier-schedule-close");
    closeButton.setAttribute("aria-label", "Close scheduling");
    closeButton.innerHTML =
      '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 4 12 12M16 4 4 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    heading.append(
      element("h2", "", editing ? "Reschedule message" : "Schedule send"),
      closeButton,
    );
    panel.append(heading);
    if (editing) {
      panel.append(element("p", "carrier-schedule-preview", editing.text));
      if (editing.status === "uncertain")
        panel.append(
          element(
            "p",
            "carrier-schedule-warning",
            "Check the conversation before rescheduling. Messenger may already have accepted this message.",
          ),
        );
      customPicker(panel, Math.max(editing.due, Date.now() + 15 * 60_000));
    } else if (sourceText.trim()) {
      for (const preset of schedulePresets(Date.now())) {
        const choice = action(
          "",
          () => {
            const updated = schedulePresets(Date.now()).find((p) => p.label === preset.label);
            if (updated) void save(updated.due);
          },
          "carrier-schedule-preset",
        );
        choice.append(
          element("span", "", preset.label),
          element("span", "carrier-schedule-time", formatScheduleTime(preset.due)),
        );
        panel.append(choice);
      }
      const details = element("details", "carrier-schedule-custom");
      details.append(element("summary", "", "Choose date & time"));
      customPicker(details);
      details.addEventListener("toggle", positionPanel);
      panel.append(details);
    } else
      panel.append(element("p", "carrier-schedule-note", "Write a text message to schedule it."));
    panel.append(
      element(
        "p",
        "carrier-schedule-note",
        `${Intl.DateTimeFormat().resolvedOptions().timeZone} · 24-hour time`,
      ),
      element(
        "p",
        "carrier-schedule-note carrier-schedule-divider",
        "Sends automatically while Carrier is running and connected.",
      ),
    );
    if (rows.length && !editing) {
      panel.append(element("h3", "carrier-schedule-divider", "Scheduled messages"));
      for (const row of [...rows].sort((a, b) => a.due - b.due)) {
        const item = element("div", "carrier-schedule-item");
        const status =
          row.status === "missed" || row.status === "missed_draft"
            ? "Not sent"
            : row.status === "uncertain"
              ? "Send unconfirmed"
              : row.status === "sending"
                ? "Submitting…"
                : row.status === "draft"
                  ? "Not scheduled"
                  : "Scheduled";
        item.append(
          element(
            "strong",
            row.status === "missed" || row.status === "missed_draft" || row.status === "uncertain"
              ? "carrier-schedule-warning"
              : "",
            `${status} · ${formatScheduleTime(row.due, true)}`,
          ),
          element(
            "small",
            "carrier-schedule-note",
            row.thread === thread() ? "This conversation" : "Another conversation",
          ),
          element("p", "carrier-schedule-preview", row.text),
        );
        const actions = element("div", "carrier-schedule-item-actions");
        if (row.status !== "sending") {
          actions.append(
            action(row.status === "scheduled" ? "Edit time" : "Reschedule", () => {
              editing = row;
              render();
            }),
            action("Cancel", () => {
              void request({ op: "cancel", id: row.id }).then(render).catch(failed);
            }),
          );
        }
        actions.append(
          action("Copy text", () => {
            void navigator.clipboard
              .writeText(row.text)
              .then(() => toast("Message copied"))
              .catch(() => toast("Could not copy the message"));
          }),
        );
        item.append(actions);
        panel.append(item);
      }
    }
    syncColors();
    positionPanel();
  };
  const open = async () => {
    if (panel) {
      close(true);
      return;
    }
    if (window.__CARRIER_SCHEDULED_SEND_AVAILABLE__ === false) {
      toast("Scheduled sending is unavailable with multiple app instances enabled.");
      return;
    }
    const box = findComposer();
    if (!box || hasComposerMedia(box) || !thread()) return;
    sourceBox = box;
    sourceText = composerText(box);
    panelThread = thread();
    try {
      await request({ op: "list" });
    } catch (error) {
      failed(error);
      return;
    }
    if (findComposer() !== box || thread() !== panelThread || hasComposerMedia(box)) return;
    panel = element("div", "carrier-schedule-panel");
    panel.id = "carrier-schedule-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Schedule send");
    document.body.append(panel);
    button?.setAttribute("aria-expanded", "true");
    render();
    panel.querySelector<HTMLButtonElement>("button")?.focus();
  };
  function ensureButton() {
    const box = cachedBox?.isConnected && isShown(cachedBox) ? cachedBox : findComposer();
    cachedBox = box;
    const region = box && composerRegion(box);
    if (owner && owner !== account()) {
      rows = [];
      owner = null;
      close();
    }
    if (panel && (thread() !== panelThread || !box || hasComposerMedia(box))) close();
    if (
      !box ||
      !region ||
      !thread() ||
      hasComposerMedia(box) ||
      (!composerText(box).trim() && !rows.length && !panel)
    ) {
      button?.remove();
      return;
    }
    const nextEmoji =
      emoji?.isConnected && region.contains(emoji)
        ? emoji
        : (buttonByLabel(["choose an emoji", "emoji"], region) ??
          [
            ...(box.parentElement?.querySelectorAll<HTMLElement>('button, [role="button"]') ?? []),
          ].find(
            (candidate) =>
              (box.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
              isShown(candidate) &&
              !!candidate.querySelector("svg"),
          ));
    if (!nextEmoji) {
      button?.remove();
      return;
    }
    emoji = nextEmoji;
    // Find the common composer row; insert beside the emoji's wrapper, never
    // into the contenteditable or Messenger's own button.
    let before: HTMLElement = emoji;
    while (before.parentElement && !before.parentElement.contains(box))
      before = before.parentElement;
    const parent = before.parentElement;
    if (!parent || parent === region) {
      button?.remove();
      return;
    }
    if (!button) {
      button = action(
        "",
        () => {
          void open();
        },
        "carrier-schedule-button",
      );
      button.setAttribute("data-carrier-schedule", "");
      button.setAttribute("aria-label", "Schedule send");
      button.setAttribute("aria-haspopup", "dialog");
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-controls", "carrier-schedule-panel");
      button.title = "Schedule send";
      // Even-odd hands punch through the filled clock to the actual composer.
      button.innerHTML =
        '<svg viewBox="2 2 20 20" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1 4h2v5.4l3.5 2-.9 1.8L11 12.6Z"/></svg>';
    }
    if (button.parentElement !== parent || button.nextElementSibling !== before)
      parent.insertBefore(button, before);
    button.dataset.queued = String(rows.length > 0);
    button.title = rows.length ? `Schedule send · ${rows.length} saved` : "Schedule send";
    syncColors();
  }
  const poll = async () => {
    if (polling || busy || !account() || window.__CARRIER_SCHEDULED_SEND_AVAILABLE__ === false)
      return;
    polling = true;
    try {
      await request({ op: "list" });
      await warning();
      while (canDeliver && ready()) {
        const due = nextDueMessage(rows, Date.now());
        if (!due) break;
        const finished = await withComposerDelivery(async () => {
          const box = findComposer();
          if (box && (composerText(box).trim() || hasComposerMedia(box))) return false;
          if (
            thread() !== due.thread &&
            activeTextInput() &&
            !panel?.contains(document.activeElement)
          )
            return false;
          // A fresh document ties the mounted pane to the requested thread.
          // SPA route changes can leave a previous conversation's composer up.
          if (routeChanged || loadedThread !== due.thread) {
            location.href = `https://www.facebook.com/messages${due.thread}`;
            return false;
          }
          const claimed = await request({ op: "claim", id: due.id });
          if (claimed.claimed !== due.id) return false;
          const job = claimed.items.find((row) => row.id === due.id && row.status === "sending");
          if (!job) return false;
          if (panel) close();
          let outcome: "sent" | "missed" | "uncertain" | "defer" = "uncertain";
          try {
            outcome = await deliverScheduledMessage(job);
          } finally {
            if (account() === job.account) await request({ op: outcome, id: job.id, due: job.due });
          }
          return outcome !== "defer";
        });
        if (!finished) break;
      }
    } catch {
      diag("scheduled-send.poll", "schedule check failed");
    } finally {
      polling = false;
    }
  };
  const scheduleMount = () => {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      ensureButton();
    });
  };
  const start = () => {
    ensureButton();
    new MutationObserver((records) => {
      if (
        records.every(
          (r) =>
            (r.target instanceof Element &&
              (r.target.closest(".carrier-schedule-panel") || r.target === button)) ||
            (r.type === "childList" &&
              [...r.addedNodes, ...r.removedNodes].every((n) => n === button)),
        )
      )
        return;
      scheduleMount();
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "src", "aria-label", "aria-disabled"],
    });
    document.addEventListener("change", scheduleMount, true);
    document.addEventListener("input", scheduleMount, true);
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && panel) {
          event.stopPropagation();
          close(true);
        }
      },
      true,
    );
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (
          panel &&
          event.target instanceof Node &&
          !panel.contains(event.target) &&
          !button?.contains(event.target)
        )
          close();
      },
      true,
    );
    window.addEventListener("resize", positionPanel);
    window.addEventListener("online", () => {
      void poll();
    });
    document.addEventListener("visibilitychange", () => {
      void poll();
    });
    window.addEventListener("carrier:settings", scheduleMount);
    new MutationObserver(scheduleMount).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    setInterval(() => {
      scheduleMount();
      void poll();
    }, 5_000);
    void poll();
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
