import {
  canActivateMediaPrivacy,
  captureFailureMessage,
  type MediaDevice,
  type MediaPlatform,
  mediaDeviceLabel,
  mediaPrivacyGuidance,
} from "../lib/media-permissions";

type Failure = Parameters<typeof captureFailureMessage>[0];
const names = { camera: "Camera", microphone: "Microphone" };
const icons = {
  camera: '<rect x="3" y="6" width="12" height="12" rx="3"/><path d="m15 10 6-3v10l-6-3"/>',
  microphone:
    '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 10v2a6 6 0 0 0 12 0v-2M12 18v3m-3 0h6"/>',
};

export function showMediaPermissionCard(
  failures: ReadonlyMap<MediaDevice, Failure>,
  dismiss: () => void,
  recovered: () => void,
) {
  const devices = [...failures.keys()];
  const permissionOnly = [...failures.values()].every((failure) => failure === "denied");
  const hasDenial = [...failures.values()].includes("denied");
  const failure: Failure = hasDenial ? "denied" : (failures.values().next().value ?? "other");
  const failureGroups = new Map<Failure, MediaDevice[]>();
  for (const [device, reason] of failures)
    failureGroups.set(reason, [...(failureGroups.get(reason) ?? []), device]);
  const failureDescription = [...failureGroups]
    .map(([reason, group]) => captureFailureMessage(reason, group))
    .join(" ");
  const platform: MediaPlatform = carrierMediaPlatform;
  const host = document.createElement("div");
  host.id = "carrier-media-permission-banner";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    :host { all: initial; position: fixed; bottom: 68px; right: 20px; z-index: 2147483646;
      width: 380px; max-width: calc(100vw - 32px); color-scheme: light dark;
      --surface: #fff; --text: #1c1e21; --muted: #65676b; --border: #d8dbe1;
      --icon: #eef0f3; --amber: #845709; --green: #237644; --focus: #0866ff; }
    @media (prefers-color-scheme: dark) { :host { --surface: #303133; --text: #e4e6eb;
      --muted: #b0b3b8; --border: #4b4d53; --icon: #414347; --amber: #ecc47c; --green: #86d6a4; --focus: #83b2ff; } }
    :host([data-theme="dark"]) { --surface: #303133; --text: #e4e6eb; --muted: #b0b3b8;
      --border: #4b4d53; --icon: #414347; --amber: #ecc47c; --green: #86d6a4; --focus: #83b2ff; }
    :host([data-theme="light"]) { --surface: #fff; --text: #1c1e21; --muted: #65676b;
      --border: #d8dbe1; --icon: #eef0f3; --amber: #845709; --green: #237644; --focus: #0866ff; }
    * { box-sizing: border-box; } section { padding: 16px; border: 1px solid var(--border);
      border-radius: 12px; background: var(--surface); color: var(--text);
      box-shadow: 0 12px 30px #0004; font: 12px/1.5 system-ui, sans-serif;
      max-height: calc(100vh - 100px); overflow-y: auto; }
    h2 { margin: 0 0 5px; font-size: 15px; line-height: 1.4; } p { margin: 0; color: var(--muted); }
    header { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; }
    .header-icon { color: var(--amber); }
    .device { display: flex; align-items: center; gap: 10px;
      padding: 12px 0; border-top: 1px solid var(--border); }
    .icon { width: 30px; height: 30px; flex-shrink: 0; background: var(--icon); border-radius: 8px;
      display: grid; place-items: center; } svg { width: 17px; height: 17px; fill: none;
      stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .info { flex: 1; min-width: 0; } strong { display: block; font-weight: 600; }
    .status { font-size: 11px; color: var(--muted); } .status[data-tone="warning"] { color: var(--amber); }
    .status[data-tone="good"], .check { color: var(--green); } .check { font-size: 18px; padding: 0 8px; }
    button { border: 0; border-radius: 6px; padding: 7px 10px; background: #0866ff; color: white;
      font: 600 11px/1.5 system-ui, sans-serif; cursor: pointer; flex-shrink: 0; }
    button:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
    button:disabled { opacity: .6; cursor: wait; } [hidden] { display: none !important; }
    footer { display: flex; justify-content: space-between; gap: 10px; align-items: center;
      border-top: 1px solid var(--border); padding-top: 10px; font-size: 10px; color: var(--muted); }
    footer button { color: var(--focus); background: transparent; padding: 5px 0 5px 8px; font-weight: 500; }
    .guidance { margin: 0 0 12px; font-size: 11px; }
  </style><section aria-label="Call device recovery">
    <header><span class="icon header-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${icons[devices.includes("camera") ? "camera" : "microphone"]}</svg></span>
      <div><h2 role="alert"></h2><p class="description"></p></div></header>
    <div class="devices"></div><p class="guidance"></p>
    <footer><span></span><button type="button">Dismiss</button></footer>
  </section>`;
  const title = root.querySelector("h2")!;
  const description = root.querySelector<HTMLParagraphElement>(".description")!;
  const guidance = root.querySelector<HTMLParagraphElement>(".guidance")!;
  const footer = root.querySelector("footer span")!;
  let disposed = false;
  let pending = false;
  let snapshot: CarrierMediaPermissionSnapshot = { camera: "unknown", microphone: "unknown" };
  let confirmation: ReturnType<typeof setTimeout> | undefined;
  let actionError = "";
  const rows = (["camera", "microphone"] as const).map((device) => {
    const row = document.createElement("div");
    row.className = "device";
    row.innerHTML = `<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24">${icons[device]}</svg></span>
      <div class="info"><strong>${names[device]}</strong><span class="status"></span></div>
      <span class="check" aria-hidden="true" hidden>✓</span><button type="button" hidden></button>`;
    root.querySelector(".devices")!.append(row);
    const button = row.querySelector("button")!;
    button.addEventListener("click", async (event) => {
      if (!canActivateMediaPrivacy(event.isTrusted, navigator.userActivation?.isActive) || pending)
        return;
      const state = snapshot[device];
      pending = true;
      actionError = "";
      render();
      try {
        if (state === "not-determined" && platform === "macos") {
          accept(await carrierMediaPermissionStatus(device));
        } else {
          await carrierOpenMediaPrivacy(device);
        }
      } catch {
        actionError = `The action could not finish. ${mediaPrivacyGuidance(platform)}`;
      } finally {
        pending = false;
        if (!disposed) {
          render();
          void refresh();
        }
      }
    });
    return {
      device,
      button,
      status: row.querySelector<HTMLElement>(".status")!,
      check: row.querySelector<HTMLElement>(".check")!,
    };
  });
  const render = () => {
    const blocked = devices.filter((device) => snapshot[device] === "denied");
    const restricted = devices.some((device) => snapshot[device] === "restricted");
    title.textContent = confirmation
      ? "Access updated"
      : failure === "denied"
        ? blocked.length === 1
          ? `${names[blocked[0]!]} access is blocked`
          : "Call access needs attention"
        : "Your call could not start";
    description.textContent = confirmation
      ? "Try your call again in Messenger."
      : permissionOnly && blocked.length
        ? `Allow Carrier to use your ${mediaDeviceLabel(blocked)} for calls.`
        : failureDescription;
    guidance.textContent =
      actionError ||
      (failure === "denied" && !confirmation
        ? restricted
          ? "Access is restricted by system policy. Check with the person who manages this Mac."
          : devices.every((device) => snapshot[device] === "allowed")
            ? "macOS allows access. Check Messenger’s call settings and try again."
            : mediaPrivacyGuidance(platform)
        : "");
    guidance.hidden = !guidance.textContent;
    for (const { device, button, status, check } of rows) {
      const state = snapshot[device];
      status.textContent =
        state === "allowed"
          ? "Allowed by macOS"
          : state === "denied"
            ? "Blocked in macOS Settings"
            : state === "restricted"
              ? "Restricted by system policy"
              : state === "not-determined"
                ? "Not requested yet"
                : "Status unavailable";
      status.dataset.tone =
        state === "allowed"
          ? "good"
          : state === "denied" || state === "restricted"
            ? "warning"
            : "neutral";
      check.hidden = state !== "allowed";
      const allow =
        state === "not-determined" &&
        platform === "macos" &&
        failures.get(device) === "denied" &&
        devices.includes(device);
      const settings =
        (state === "denied" && failures.get(device) === "denied") ||
        (state === "unknown" &&
          failures.get(device) === "denied" &&
          devices.includes(device) &&
          platform !== "linux");
      button.hidden = !allow && !settings;
      button.textContent = allow ? "Allow access" : "Open Settings";
      button.setAttribute(
        "aria-label",
        `${allow ? "Allow access to" : "Open settings for"} ${device}`,
      );
      button.disabled = pending;
    }
    footer.textContent = pending
      ? "Checking access…"
      : platform === "macos"
        ? "Rechecks when you return"
        : "OS permission status unavailable";
  };
  const accept = (next: CarrierMediaPermissionSnapshot) => {
    if (disposed) return;
    const changed = devices.some(
      (device) => snapshot[device] === "denied" || snapshot[device] === "not-determined",
    );
    snapshot = next;
    if (!devices.every((device) => next[device] === "allowed")) {
      clearTimeout(confirmation);
      confirmation = undefined;
    }
    if (changed && devices.every((device) => next[device] === "allowed") && permissionOnly) {
      clearTimeout(confirmation);
      confirmation = setTimeout(recovered, 5000);
    }
  };
  const refresh = async () => {
    if (disposed || pending || platform !== "macos" || document.visibilityState === "hidden")
      return;
    pending = true;
    render();
    try {
      accept(await carrierMediaPermissionStatus());
    } catch {
      accept({ camera: "unknown", microphone: "unknown" });
    } finally {
      pending = false;
      if (!disposed) render();
    }
  };
  const theme = () => {
    host.dataset.theme = window.__CARRIER_SETTINGS__?.theme ?? "system";
  };
  const onFocus = () => {
    void refresh();
  };
  root.querySelector("footer button")!.addEventListener("click", dismiss);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onFocus);
  window.addEventListener("carrier:settings", theme);
  theme();
  render();
  (document.body ?? document.documentElement).append(host);
  void refresh();
  return () => {
    disposed = true;
    clearTimeout(confirmation);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onFocus);
    window.removeEventListener("carrier:settings", theme);
    host.remove();
  };
}
