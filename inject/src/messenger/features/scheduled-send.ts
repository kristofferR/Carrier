import { formatLocale, language, t, tn } from "../../i18n";
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
  timeZoneLabel,
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
  scheduledSendConnectionReady() && rateLimitRemainingMs() <= 0 && !window.__chatpaneInCall;
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
const action = (label: string, run: () => void, className = "chatpane-schedule-action") => {
  const button = element("button", className, label);
  button.type = "button";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    run();
  });
  return button;
};

/** Stroke icons on a 24px grid; CSS draws them in the text color. */
const ICONS = {
  soon: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 10v3.5l2.5 2M10 3h4M12 3v3"/>',
  hour: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  evening: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z"/>',
  morning: '<path d="M3 18h18M7 18a5 5 0 0 1 10 0M12 6v3M5.6 11.6l1.8 1.8M18.4 11.6l-1.8 1.8"/>',
  calendar:
    '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  next: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  close: '<path d="M7 7l10 10M17 7 7 17"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  zone: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  warning: '<path d="M12 4 2.5 20h19Z"/><path d="M12 10v4M12 17h.01"/>',
};
type IconName = keyof typeof ICONS;
const icon = (name: IconName, className = "") => {
  const wrapper = element("span", `chatpane-schedule-icon ${className}`.trim());
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`;
  return wrapper;
};
const note = (name: IconName, text: string) => {
  const paragraph = element("p", "chatpane-schedule-note");
  paragraph.append(icon(name), element("span", "", text));
  return paragraph;
};
/** A full-width menu row: icon, label, then any trailing parts. */
const menuRow = (name: IconName, label: string, run: () => void, ...trailing: Node[]) => {
  const row = action("", run, "chatpane-schedule-row");
  row.append(icon(name), element("span", "chatpane-schedule-label", label), ...trailing);
  return row;
};

/** The main menu, the custom date and time form, and the scheduled-message list. */
type Page = "main" | "custom" | "list";

export function initScheduledSend() {
  let rows: ScheduledMessage[] = [];
  let owner: string | null = null;
  let polling = false;
  let busy = false;
  let panel: HTMLDivElement | null = null;
  let panelThread: string | null = null;
  let page: Page = "main";
  /** The scheduled message the custom page reschedules, if any. */
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
    if (!current) throw new Error(t("page.schedule.sign_in"));
    const response = await chatpaneScheduledSend({ ...operation, account: current });
    if (account() !== current) throw new Error(t("page.schedule.account_changed"));
    if (response.error) throw new Error(response.error);
    owner = current;
    rows = response.items;
    canDeliver = response.can_deliver;
    ensureButton();
    return response;
  };
  const failed = (error: unknown) => {
    toast(error instanceof Error ? error.message : t("page.schedule.update_failed"));
    diag("scheduled-send.action", "schedule operation failed");
  };
  const warning = async () => {
    if (document.hidden || !window.__chatpaneToast) return;
    const missed = rows.filter(
      (row) =>
        (row.status === "missed" || row.status === "missed_draft" || row.status === "uncertain") &&
        !row.toast_seen,
    );
    if (!missed.length) return;
    toast(
      missed.some((row) => row.status === "uncertain")
        ? t("page.schedule.unconfirmed_warning")
        : t("page.schedule.missed_warning"),
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
    const glyph = emoji.querySelector("svg path") || emoji.querySelector("svg");
    const fill = glyph ? getComputedStyle(glyph).fill : "";
    // A gradient fill is a url(), which can't color text or a button.
    const accent = fill && CSS.supports("color", fill) ? fill : getComputedStyle(emoji).color;
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
      toast(t("page.schedule.length", { max: MAX_SCHEDULED_CHARS }));
      return;
    }
    if (
      !editing &&
      (!sourceBox?.isConnected ||
        composerText(sourceBox) !== sourceText ||
        hasComposerMedia(sourceBox))
    ) {
      toast(t("page.schedule.draft_changed_reopen"));
      close();
      return;
    }
    if (due <= Date.now()) {
      toast(t("page.schedule.future_time"));
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
      toast(t("page.schedule.open_original"));
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
          throw new Error(t("page.schedule.unconfirmed"));
        }
        result = {
          items: rows,
          saved: saved.id,
          claimed: null,
          error: null,
          can_deliver: canDeliver,
        };
      }
      if (!result.saved) throw new Error(t("page.schedule.not_saved"));
      if (!editingItem || recoveredDraft) {
        // Never clear a changed draft; cancel the persisted schedule instead.
        const textToClear = recoveredDraft ? (editingItem?.text ?? "") : expectedText;
        const unchanged =
          expectedBox?.isConnected &&
          thread() === expectedThread &&
          account() === current &&
          composerText(expectedBox) === textToClear &&
          !hasComposerMedia(expectedBox);
        if (!unchanged || !expectedBox) {
          if (!editingItem) await request({ op: "cancel", id: result.saved });
          throw new Error(t("page.schedule.draft_changed"));
        }
        const sameComposer = () =>
          expectedBox.isConnected &&
          findComposer() === expectedBox &&
          thread() === expectedThread &&
          account() === current &&
          !hasComposerMedia(expectedBox);
        replaceComposerText(expectedBox, "");
        // Messenger applies editor changes asynchronously, after execCommand returns.
        for (let attempt = 0; attempt < 10; attempt++) {
          await pause();
          if (!sameComposer() || composerText(expectedBox) !== textToClear) break;
        }
        if (!sameComposer() || composerText(expectedBox).trim()) {
          // Keep the saved copy unarmed if the editor's outcome is uncertain.
          close();
          throw new Error(t("page.schedule.clear_unconfirmed"));
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
            throw new Error(t("page.schedule.unconfirmed"));
          }
        }
      }
      close();
      toast(t("page.schedule.scheduled", { time: formatScheduleTime(due) }));
    } catch (error) {
      failed(error);
    } finally {
      busy = false;
    }
  };
  const hasDraft = () => sourceText.trim() !== "";
  /** Switch pages, then focus `returnTo`'s row (going back) or the page's first control. */
  const show = (next: Page, item: ScheduledMessage | null = null, returnTo?: Page) => {
    page = next;
    editing = item;
    render();
    if (!panel) return;
    const target =
      (returnTo &&
        panel.querySelector<HTMLElement>(`[data-chatpane-schedule-page="${returnTo}"]`)) ||
      panel.querySelector<HTMLElement>("[data-autofocus]") ||
      panel.querySelector<HTMLElement>("button");
    target?.focus();
  };
  /** One level up: rescheduling returns to the list, other pages to the main menu. */
  const back = () => {
    if (editing) show("list");
    else if (page !== "main" && hasDraft()) show("main", null, page);
    else return false;
    return true;
  };
  const heading = (title: string, canGoBack: boolean) => {
    const row = element("div", "chatpane-schedule-heading");
    if (canGoBack) {
      const backButton = action("", back, "chatpane-schedule-icon-button chatpane-schedule-back");
      backButton.setAttribute("aria-label", t("page.schedule.back"));
      backButton.append(icon("back"));
      row.append(backButton);
    }
    const closeButton = action(
      "",
      () => close(true),
      "chatpane-schedule-icon-button chatpane-schedule-close",
    );
    closeButton.setAttribute("aria-label", t("page.schedule.close"));
    closeButton.append(icon("close"));
    row.append(element("h2", "", title), closeButton);
    return row;
  };
  const pageRow = (name: IconName, label: string, target: Page, count = 0) => {
    const row = menuRow(
      name,
      label,
      () => show(target),
      ...(count
        ? [element("span", "chatpane-schedule-count", count.toLocaleString(formatLocale()))]
        : []),
      icon("next", "chatpane-schedule-chevron"),
    );
    row.dataset.chatpaneSchedulePage = target;
    return row;
  };
  const mainPage = (container: HTMLElement) => {
    container.append(heading(t("page.schedule.schedule_send"), false));
    const now = Date.now();
    for (const preset of schedulePresets(now)) {
      const choice = menuRow(
        preset.id,
        preset.label,
        () => {
          // The menu may have stayed open; count from the click, not from rendering.
          const current = schedulePresets(Date.now()).find((p) => p.id === preset.id);
          if (current) void save(current.due);
        },
        element("span", "chatpane-schedule-time", formatScheduleTime(preset.due, now)),
      );
      choice.classList.add("chatpane-schedule-preset");
      container.append(choice);
    }
    container.querySelector(".chatpane-schedule-preset")?.setAttribute("data-autofocus", "");
    container.append(
      element("div", "chatpane-schedule-separator"),
      pageRow("calendar", t("page.schedule.choose_date_time"), "custom"),
    );
    if (rows.length)
      container.append(pageRow("list", t("page.schedule.scheduled_messages"), "list", rows.length));
    container.append(note("info", t("page.schedule.sends_while_running")));
  };
  const customPage = (container: HTMLElement) => {
    const item = editing;
    container.append(
      heading(
        item ? t("page.schedule.reschedule_message") : t("page.schedule.choose_date_time"),
        true,
      ),
    );
    if (item) {
      container.append(element("p", "chatpane-schedule-preview", item.text));
      if (item.status === "uncertain")
        container.append(
          element("p", "chatpane-schedule-warning", t("page.schedule.uncertain_note")),
        );
    }
    const due = item ? Math.max(item.due, Date.now() + 15 * 60_000) : Date.now() + 10 * 60_000;
    const fields = element("div", "chatpane-schedule-fields");
    const dateLabel = element("label", "", t("page.schedule.date"));
    const date = element("input", "");
    date.type = "date";
    date.value = localDateValue(due);
    date.min = localDateValue(Date.now());
    date.required = true;
    date.dataset.autofocus = "";
    const timeLabel = element("label", "", t("page.schedule.time_24h"));
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
      "",
      () => {
        if (!date.reportValidity() || !time.reportValidity()) return;
        const value = localScheduleTime(date.value, time.value);
        if (value === null) {
          toast(t("page.schedule.invalid_time"));
          return;
        }
        void save(value);
      },
      "chatpane-schedule-primary",
    );
    // Name the exact send time once the fields hold a future one.
    const label = () => {
      const value = localScheduleTime(date.value, time.value);
      confirm.textContent =
        value !== null && value > Date.now()
          ? t("page.schedule.schedule_for", { time: formatScheduleTime(value) })
          : item
            ? t("page.schedule.reschedule_message")
            : t("page.schedule.schedule_message");
    };
    // Some WebKit date pickers report a pick only as "change".
    for (const field of [date, time])
      for (const type of ["input", "change"]) field.addEventListener(type, label);
    label();
    container.append(fields, note("zone", timeZoneLabel()), confirm);
  };
  const listPage = (container: HTMLElement) => {
    container.append(heading(t("page.schedule.scheduled_messages"), hasDraft()));
    for (const row of [...rows].sort((a, b) => a.due - b.due)) {
      const item = element("div", "chatpane-schedule-item");
      const time = formatScheduleTime(row.due);
      const problem =
        row.status === "missed" || row.status === "missed_draft" || row.status === "uncertain";
      const status = problem
        ? row.status === "uncertain"
          ? t("page.schedule.status.unconfirmed", { time })
          : t("page.schedule.status.not_sent", { time })
        : row.status === "sending"
          ? t("page.schedule.status.submitting", { time })
          : row.status === "draft"
            ? t("page.schedule.status.not_scheduled", { time })
            : t("page.schedule.status.scheduled", { time });
      const meta = element("div", "chatpane-schedule-meta");
      if (problem) meta.append(icon("warning", "chatpane-schedule-warning"));
      meta.append(element("strong", problem ? "chatpane-schedule-warning" : "", status));
      item.append(
        meta,
        element(
          "span",
          "chatpane-schedule-conversation",
          row.thread === thread()
            ? t("page.schedule.this_conversation")
            : t("page.schedule.another_conversation"),
        ),
        element("p", "chatpane-schedule-preview", row.text),
      );
      const actions = element("div", "chatpane-schedule-item-actions");
      if (row.status !== "sending")
        actions.append(
          action(
            row.status === "scheduled"
              ? t("page.schedule.edit_time")
              : t("page.schedule.reschedule"),
            () => show("custom", row),
          ),
        );
      actions.append(
        action(t("page.schedule.copy_text"), () => {
          void navigator.clipboard
            .writeText(row.text)
            .then(() => toast(t("page.schedule.copied")))
            .catch(() => toast(t("page.schedule.copy_failed")));
        }),
      );
      if (row.status !== "sending")
        actions.append(
          action(t("page.schedule.cancel"), () => {
            void request({ op: "cancel", id: row.id })
              .then(() => {
                if (page === "list") show("list");
              })
              .catch(failed);
          }),
        );
      item.append(actions);
      container.append(item);
    }
    if (!hasDraft()) container.append(note("info", t("page.schedule.write_text")));
  };
  const render = () => {
    if (!panel) return;
    // An emptied list falls back to the menu, or closes when there is no draft to schedule.
    if (page === "list" && !rows.length) {
      if (!hasDraft()) {
        close(true);
        return;
      }
      page = "main";
    }
    panel.replaceChildren();
    if (page === "custom") customPage(panel);
    else if (page === "list") listPage(panel);
    else mainPage(panel);
    syncColors();
    positionPanel();
  };
  const open = async () => {
    if (panel) {
      close(true);
      return;
    }
    if (window.__CHATPANE_SCHEDULED_SEND_AVAILABLE__ === false) {
      toast(t("page.schedule.unavailable"));
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
    panel = element("div", "chatpane-schedule-panel");
    panel.id = "chatpane-schedule-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", t("page.schedule.schedule_send"));
    Object.assign(panel, language());
    document.body.append(panel);
    button?.setAttribute("aria-expanded", "true");
    // With nothing to schedule, the clock only leads to the saved messages.
    show(hasDraft() ? "main" : "list");
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
        "chatpane-schedule-button",
      );
      button.setAttribute("data-chatpane-schedule", "");
      button.setAttribute("aria-label", t("page.schedule.schedule_send"));
      button.setAttribute("aria-haspopup", "dialog");
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-controls", "chatpane-schedule-panel");
      button.title = t("page.schedule.schedule_send");
      // Even-odd hands punch through the filled clock to the actual composer.
      button.innerHTML =
        '<svg viewBox="2 2 20 20" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1 4h2v5.4l3.5 2-.9 1.8L11 12.6Z"/></svg>';
    }
    if (button.parentElement !== parent || button.nextElementSibling !== before)
      parent.insertBefore(button, before);
    button.dataset.queued = String(rows.length > 0);
    button.title = rows.length
      ? tn("page.schedule.button_saved", rows.length)
      : t("page.schedule.schedule_send");
    syncColors();
  }
  const poll = async () => {
    if (polling || busy || !account() || window.__CHATPANE_SCHEDULED_SEND_AVAILABLE__ === false)
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
            if (activeTextInput() && !panel?.contains(document.activeElement)) return false;
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
              (r.target.closest(".chatpane-schedule-panel") || r.target === button)) ||
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
          if (!back()) close(true);
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
    window.addEventListener("chatpane:settings", scheduleMount);
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
