import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import type { initQuickReply } from "../features/quick-reply";
import type { deliverScheduledMessage, initScheduledSend } from "../features/scheduled-send";
import type { ScheduledMessage, ScheduleRequest, ScheduleResponse } from "./scheduled-send";

const chromium =
  process.env.CARRIER_BROWSER_TESTS === "1"
    ? Bun.which("chrome-headless-shell") || Bun.which("chromium") || Bun.which("google-chrome")
    : null;

test.skipIf(!chromium)(
  "schedule composer auto-submits, expires safely, hides for media, and quick reply waits for React",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "carrier-scheduled-send-"));
    try {
      const bundle = await build({
        stdin: {
          contents: `
      import { initQuickReply } from "../features/quick-reply";
      import { initScheduledSend, deliverScheduledMessage } from "../features/scheduled-send";
      (${fixtures.toString()})(initScheduledSend, deliverScheduledMessage, initQuickReply);
    `,
          resolveDir: import.meta.dir,
        },
        bundle: true,
        write: false,
      });
      const css = await readFile(
        join(import.meta.dir, "../../../../src-tauri/inject/messenger.css"),
        "utf8",
      );
      const file = join(directory, "index.html");
      await writeFile(
        file,
        `<!doctype html><style>button,[role=button]{width:32px;height:32px} [contenteditable]{width:250px;min-height:30px} .row{display:flex} img,video{width:100px;height:70px} #region{color:#050505} h2,h3{color:#1c1e21} #emoji-wrapper{margin-left:-12px;padding:0 4px 4px 0} #emoji-wrapper [role=button]{box-sizing:content-box;width:20px;height:20px;padding:8px;margin:-4px;display:flex} :root{--primary-text:#e2e5e9;--card-background:#252728;--secondary-text:#b0b3b8}</style><style>${css}</style><body><main role="main"><div role="log" aria-label="Conversation with Original person"></div><div role="region" id="region"><div class="row"><div contenteditable="true" role="textbox" id="composer"></div><div id="emoji-wrapper"><div role="button" aria-label="Choose an emoji"><svg width="20" height="20" viewBox="0 0 20 20"><path fill="rgb(0, 237, 136)" d="M10 0a10 10 0 1 0 0 20 10 10 0 0 0 0-20"/></svg></div></div></div><button aria-label="Send a like"><img alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"></button></div></main><pre id="result">RUNNING</pre><script>
      var scheduleItems=[]; var replyResults=[]; var warnings=[]; var scheduleOps=[];
      window.__CARRIER_SCHEDULED_SEND_AVAILABLE__=true;
      window.__carrierToast=(message)=>warnings.push(message);
      window.__TAURI_INTERNALS__={invoke:async()=>{}};
      var carrierScheduledSend=async function(request){
        scheduleOps.push(request.op);
        var saved=null;
        if(request.op==='save') {
          saved=request.id || 'saved-fixture';
          if(request.id) {
            scheduleItems.forEach(item=>{if(item.id===request.id){item.due=request.due;item.status=item.status==='draft'||item.status==='missed_draft'?'draft':'scheduled';}});
          } else {
            scheduleItems.push({id:saved,account:request.account,thread:request.thread,text:request.text,due:request.due,status:'draft',toast_seen:false});
          }
        }
        if(request.op==='arm') {
          if(document.querySelector('#composer').innerText.trim()) throw new Error('armed before clearing composer');
          scheduleItems.forEach(item=>{if(item.id===request.id)item.status='scheduled';});
        }
        if(request.op==='list') return {items:scheduleItems,claimed:null,saved:null,error:null,can_deliver:false};
        if(request.op==='seen') {scheduleItems.forEach(item=>{if(item.id===request.id)item.toast_seen=true;});}
        return {items:scheduleItems,claimed:null,saved:saved,error:null,can_deliver:false};
      };
      var carrierReplyResult=async(id,attempt,ok)=>{replyResults.push({id,attempt,ok});};
      requestAnimationFrame=callback=>setTimeout(()=>callback(performance.now()),16);
      ${bundle.outputFiles[0]!.text}
      </script>`,
      );
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(Bun.file(file)),
      });
      try {
        const child = Bun.spawn(
          [
            chromium!,
            "--headless",
            "--disable-gpu",
            "--no-sandbox",
            "--no-first-run",
            `--user-data-dir=${join(directory, "profile")}`,
            "--virtual-time-budget=20000",
            "--dump-dom",
            new URL("/messages/t/456/", server.url).href,
          ],
          { stdout: "pipe", stderr: "pipe", timeout: 50_000, killSignal: "SIGKILL" },
        );
        const [output, errors, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(
          exit,
          exit === 137 ? `Chromium timed out before dumping the DOM\n${errors}` : errors,
        ).toBe(0);
        expect(output.match(/<pre id="result">([^<]+)/)?.[1]).toBe("PASS");
      } finally {
        await server.stop(true);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

async function fixtures(
  init: typeof initScheduledSend,
  deliver: typeof deliverScheduledMessage,
  quickReply: typeof initQuickReply,
) {
  const result = document.querySelector("#result")!;
  const box = document.querySelector<HTMLElement>("#composer")!;
  const region = document.querySelector<HTMLElement>("#region")!;
  const page = window as unknown as {
    scheduleItems: ScheduledMessage[];
    replyResults: { ok: boolean }[];
    warnings: string[];
    scheduleOps: string[];
    carrierScheduledSend: (request: ScheduleRequest) => Promise<ScheduleResponse>;
  };
  const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (name: string, condition: boolean) => {
    if (!condition) throw new Error(name);
  };
  let clicks = 0;
  let delay = 400;
  let changeBeforeSend: (() => void) | undefined;
  const realNow = Date.now;
  const clear = () => {
    box.textContent = "";
    document.querySelector("#send")?.remove();
    box.blur();
  };
  box.addEventListener("input", () => {
    if (!box.innerText.trim().trim()) return;
    setTimeout(() => {
      if (!box.innerText.trim().trim()) return;
      changeBeforeSend?.();
      if (document.querySelector("#send")) return;
      const send = document.createElement("button");
      send.id = "send";
      send.setAttribute("aria-label", "Press Enter to send");
      send.addEventListener("click", () => {
        clicks++;
        box.textContent = "";
        send.remove();
      });
      region.append(send);
    }, delay);
  });
  const message = (): ScheduledMessage => ({
    id: "fixture",
    account: "123",
    thread: "/t/456/",
    text: "Automatic test reply",
    due: Date.now(),
    status: "sending",
    toast_seen: false,
  });
  try {
    // biome-ignore lint/suspicious/noDocumentCookie: Mimic Messenger's account cookie in an isolated fixture.
    document.cookie = "c_user=123; path=/";
    init();
    await settle();
    const icon = () => document.querySelector<HTMLButtonElement>("[data-carrier-schedule]");
    assert("empty composer has no clock", !icon());
    box.textContent = "Draft";
    await settle();
    assert("text reveals clock", !!icon());
    box.firstChild!.textContent = "   ";
    box.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();
    assert("clearing to whitespace hides clock immediately", !icon());
    box.firstChild!.textContent = "Draft";
    box.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();
    assert(
      "clock is immediately left of the smiley wrapper",
      icon()?.nextElementSibling?.id === "emoji-wrapper",
    );
    assert(
      "clock inherits Messenger's icon color",
      getComputedStyle(icon()!).color === "rgb(0, 237, 136)",
    );
    const clockSvg = icon()!.querySelector("svg")!;
    const smileySvg = document.querySelector<SVGSVGElement>("#emoji-wrapper svg")!;
    const clockRect = clockSvg.getBoundingClientRect();
    const smileyRect = smileySvg.getBoundingClientRect();
    const paintedWidth = (svg: SVGSVGElement) =>
      (svg.getBBox().width / svg.viewBox.baseVal.width) * svg.getBoundingClientRect().width;
    assert(
      "clock circle matches smiley diameter",
      paintedWidth(clockSvg) === paintedWidth(smileySvg),
    );
    assert("clock has space before smiley", smileyRect.left - clockRect.right >= 8);
    assert("clock is not dimmed", getComputedStyle(icon()!).opacity === "1");
    for (const tag of ["img", "video"] as const) {
      const media = document.createElement(tag);
      region.append(media);
      await settle();
      assert(`icon hidden for ${tag}`, !icon());
      media.remove();
      await settle();
      assert(`icon restored after ${tag}`, !!icon());
    }
    const preview = document.createElement("button");
    preview.setAttribute("aria-label", "Preview attachment");
    preview.append(document.createElement("img"));
    region.append(preview);
    await settle();
    assert("clickable attachment previews also hide the clock", !icon());
    preview.remove();
    await settle();
    clear();
    box.focus();
    const otherThread = document.createElement("a");
    otherThread.href = "/messages/t/999/";
    otherThread.innerHTML = "<span>Another person</span>";
    let switched = false;
    let updatePathOnClick = false;
    otherThread.addEventListener("click", (event) => {
      event.preventDefault();
      switched = true;
      if (updatePathOnClick) history.pushState(null, "", otherThread.href);
    });
    document.body.append(otherThread);
    assert(
      "focused empty composer prevents cross-thread delivery",
      (await deliver({ ...message(), thread: "/t/999/" }, () => true)) === "defer" &&
        !switched &&
        clicks === 0,
    );
    box.blur();
    switched = false;
    updatePathOnClick = true;
    assert(
      "route change defers until the conversation pane settles",
      (await deliver({ ...message(), thread: "/t/999/" }, () => true)) === "defer" &&
        switched &&
        clicks === 0,
    );
    assert(
      "target route with the old pane still mounted cannot submit",
      (await deliver({ ...message(), thread: "/t/999/" }, () => true)) === "defer" &&
        !box.innerText.trim() &&
        clicks === 0,
    );
    history.replaceState(null, "", "/messages/t/456/");
    otherThread.remove();
    assert(
      "online sends automatically even with the empty composer focused",
      (await deliver(message(), () => true)) === "sent" && clicks === 1,
    );
    clear();
    assert(
      "offline never clicks send",
      (await deliver(message(), () => false)) === "defer" && clicks === 1,
    );
    assert(
      "late messages never enter composer",
      (await deliver({ ...message(), due: Date.now() - 120_001 }, () => true)) === "defer" &&
        !box.innerText.trim() &&
        clicks === 1,
    );
    assert(
      "another account cannot send",
      (await deliver({ ...message(), account: "999" }, () => true)) === "defer" && clicks === 1,
    );
    box.textContent = "Existing draft";
    assert(
      "existing draft preserved",
      (await deliver(message(), () => true)) === "defer" && box.innerText === "Existing draft",
    );
    clear();
    const expiring = message();
    changeBeforeSend = () => {
      Date.now = () => expiring.due + 120_001;
    };
    assert(
      "deadline rechecked after React render",
      (await deliver(expiring, () => true)) === "missed" && clicks === 1 && !box.innerText.trim(),
    );
    Date.now = realNow;
    changeBeforeSend = undefined;
    clear();
    let connected = true;
    changeBeforeSend = () => {
      connected = false;
    };
    assert(
      "connection loss before click restores queue without submitting",
      (await deliver(message(), () => connected)) === "defer" &&
        clicks === 1 &&
        !box.innerText.trim(),
    );
    changeBeforeSend = undefined;
    clear();
    changeBeforeSend = () => {
      // Messenger may submit the inserted text before Carrier clicks Send.
      box.textContent = "";
    };
    assert(
      "externally submitted text is uncertain instead of retryable",
      (await deliver(message(), () => true)) === "uncertain" && clicks === 1,
    );
    changeBeforeSend = undefined;
    clear();
    quickReply();
    delay = 600;
    window.__carrierQuickReply?.("/t/456/", "Quick reply without Enter", 1, 1);
    await settle(1600);
    assert(
      "quick reply waited for delayed control and sent",
      page.replyResults.at(-1)?.ok === true && clicks === 2 && !box.innerText.trim(),
    );
    clear();
    box.textContent = "yesterday";
    window.__carrierQuickReplyDraft?.("/t/456/", "yes", 2, 2);
    await settle();
    assert(
      "fallback appends a short reply despite a substring collision",
      page.replyResults.at(-1)?.ok === true &&
        box.innerText.startsWith("yesterday") &&
        box.innerText.endsWith("yes") &&
        box.innerText !== "yesterday",
    );
    clear();
    box.textContent = "Schedule UI test";
    await settle();
    Date.now = () => new Date(2026, 8, 23, 18, 18).getTime();
    icon()?.click();
    await settle();
    assert("quick choices open", document.querySelectorAll(".carrier-schedule-preset").length >= 3);
    assert(
      "custom picker defaults to ten minutes ahead in 24h format",
      document.querySelector<HTMLInputElement>(".carrier-schedule-fields input[type=text]")
        ?.value === "18:28",
    );
    assert(
      "custom picker defaults to today",
      document.querySelector<HTMLInputElement>(".carrier-schedule-fields input[type=date]")
        ?.value === "2026-09-23",
    );
    Date.now = realNow;
    const panel = document.querySelector<HTMLElement>(".carrier-schedule-panel")!;
    assert(
      "dark popup uses primary text instead of black composer container",
      getComputedStyle(panel).color === "rgb(226, 229, 233)",
    );
    assert(
      "dark heading overrides Messenger's heading color",
      getComputedStyle(panel.querySelector("h2")!).color === "rgb(226, 229, 233)",
    );
    const closeButton = panel.querySelector<HTMLButtonElement>(".carrier-schedule-close")!;
    const closeRect = closeButton.getBoundingClientRect();
    const crossRect = closeButton.querySelector("svg")!.getBoundingClientRect();
    assert(
      "close icon is centered in its button",
      Math.abs(closeRect.left + closeRect.width / 2 - crossRect.left - crossRect.width / 2) < 0.5 &&
        Math.abs(closeRect.top + closeRect.height / 2 - crossRect.top - crossRect.height / 2) < 0.5,
    );
    assert(
      "dark popup has matching surface",
      getComputedStyle(panel).backgroundColor === "rgb(37, 39, 40)",
    );
    document.documentElement.style.setProperty("--primary-text", "#050505");
    document.documentElement.style.setProperty("--card-background", "#ffffff");
    assert(
      "popup follows light theme",
      getComputedStyle(panel).color === "rgb(5, 5, 5)" &&
        getComputedStyle(panel).backgroundColor === "rgb(255, 255, 255)",
    );
    assert(
      "light heading follows light primary text",
      getComputedStyle(panel.querySelector("h2")!).color === "rgb(5, 5, 5)",
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert("Escape closes", !document.querySelector(".carrier-schedule-panel"));
    icon()?.click();
    await settle();
    document.querySelector<HTMLButtonElement>(".carrier-schedule-preset")?.click();
    await settle();
    assert(
      "scheduling durably saves, clears, then arms automatic delivery",
      page.scheduleOps.indexOf("save") < page.scheduleOps.indexOf("arm") &&
        page.scheduleItems[0]?.status === "scheduled" &&
        !box.innerText.trim(),
    );
    assert("saved messages keep the clock available with an empty composer", !!icon());
    box.textContent = "Another draft";
    await settle();
    icon()?.click();
    await settle();
    document.querySelector<HTMLButtonElement>(".carrier-schedule-item-actions button")?.click();
    const opsBeforeReschedule = page.scheduleOps.length;
    document.querySelector<HTMLButtonElement>(".carrier-schedule-primary")?.click();
    await settle();
    assert(
      "rescheduling arms on save without touching the current draft",
      page.scheduleOps.slice(opsBeforeReschedule).join(",") === "save" &&
        page.scheduleItems[0]?.status === "scheduled" &&
        box.innerText === "Another draft",
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    page.scheduleItems = [
      { ...message(), id: "recovered", status: "draft", text: "Recovered draft" },
    ];
    box.textContent = "Recovered draft";
    await settle();
    icon()?.click();
    await settle();
    document.querySelector<HTMLButtonElement>(".carrier-schedule-item-actions button")?.click();
    const opsBeforeRecovered = page.scheduleOps.length;
    document.querySelector<HTMLButtonElement>(".carrier-schedule-primary")?.click();
    await settle();
    assert(
      "recovered draft clears before arming",
      page.scheduleOps.slice(opsBeforeRecovered).join(",") === "save,arm" &&
        page.scheduleItems[0]?.status === "scheduled" &&
        !box.innerText.trim(),
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    page.scheduleItems = [
      { ...message(), id: "expired-draft", status: "missed_draft", text: "Expired draft" },
    ];
    box.textContent = "Expired draft";
    await settle();
    icon()?.click();
    await settle();
    document.querySelector<HTMLButtonElement>(".carrier-schedule-item-actions button")?.click();
    const opsBeforeExpired = page.scheduleOps.length;
    document.querySelector<HTMLButtonElement>(".carrier-schedule-primary")?.click();
    await settle();
    assert(
      "expired unarmed draft clears before arming",
      page.scheduleOps.slice(opsBeforeExpired).join(",") === "save,arm" &&
        page.scheduleItems[0]?.status === "scheduled" &&
        !box.innerText.trim(),
    );
    window.__CARRIER_SETTINGS__ = { multi_instance: true };
    box.textContent = "Another draft";
    await settle();
    const opsBeforeSettingChange = page.scheduleOps.length;
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    assert(
      "pending restart does not stop polling in the current process",
      page.scheduleOps.slice(opsBeforeSettingChange).includes("list"),
    );
    icon()?.click();
    await settle();
    assert(
      "pending restart keeps scheduling available",
      !!document.querySelector(".carrier-schedule-panel"),
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    page.scheduleItems = [{ ...message(), status: "missed", due: Date.now() - 120_001 }];
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    assert(
      "missed sends warn on return and acknowledge the toast",
      page.warnings.some((w) => w.includes("not sent")) &&
        page.scheduleItems[0]?.toast_seen === true,
    );
    clear();
    result.textContent = "PASS";
  } catch (error) {
    result.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    Date.now = realNow;
  }
}
