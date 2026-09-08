/** Load the website's English-only fictional fixture into an isolated debug window. */
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { resolve } from "node:path";

const socketPath = process.argv[2];
const theme = process.argv[3] ?? "light";
if (!socketPath || socketPath === "/tmp/tauri-mcp.sock" || !["light", "dark"].includes(theme)) {
  throw new Error(
    "Usage: bun packaging/screenshots/inject-demo.ts <isolated-mcp-socket> [light|dark]",
  );
}
const root = resolve(import.meta.dir, "../..");
const html = await readFile(resolve(root, "docs/index.html"), "utf8");
const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
const start = html.indexOf('<div class="win-body">');
const end = html.indexOf("<!-- notification toasts", start);
if (!css || start < 0 || end < 0)
  throw new Error("Website demo structure changed; inspect it before capturing.");
const bodyFragment = html.slice(start, end);
const avatars = {
  mom: "mom",
  alex: "alex",
  nana: "nana",
  sam: "sam",
  dad: "dad",
  crew: "maya",
  book: "ben",
};
let avatarCss = "";
for (const [className, person] of Object.entries(avatars)) {
  const portrait = await readFile(resolve(root, `docs/avatars/en/${person}.webp`));
  avatarCss += `.av-${className} { background-image: url(data:image/webp;base64,${portrait.toString("base64")})!important; }`;
}
// Parse only the English static markup. No site script, locale switch, analytics,
// network request, or real Messenger DOM is carried into the fixture.
const code = `(() => {
  window.stop();
  const lastTimer = setTimeout(() => {}, 0);
  for (let id = 1; id <= lastTimer; id++) { clearTimeout(id); clearInterval(id); }
  const parsed = new DOMParser().parseFromString(${JSON.stringify(bodyFragment)}, 'text/html');
  const demo = parsed.querySelector('.win-body');
  if (!demo) throw new Error('Missing English demo');
  const head = document.createElement('head');
  const policy = document.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-eval'";
  head.append(policy);
  const style = document.createElement('style');
  style.textContent = ${JSON.stringify(css)} + '\\nhtml, body { margin:0!important; padding:0!important; width:100%; height:100%; overflow:hidden!important; background:var(--w-window); } body { display:block!important; } .win { width:993px; border-radius:0; box-shadow:none; transform:none!important; } .win-body { height:620px; } *, *::before, *::after { animation:none!important; transition:none!important; }';
  style.textContent += ${JSON.stringify(avatarCss)};
  head.append(style);
  const body = document.createElement('body');
  const stage = document.createElement('div');
  stage.className = 'win-stage';
  stage.dataset.winTheme = ${JSON.stringify(theme)};
  const win = document.createElement('div');
  win.className = 'win';
  win.append(demo);
  stage.append(win);
  body.append(stage);
  document.documentElement.replaceChildren(head, body);
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
  document.title = 'Carrier';
  const bodyTop = demo.getBoundingClientRect().top;
  win.querySelectorAll('.msg.out').forEach(bubble => {
    bubble.style.backgroundPosition = '0 ' + (-Math.round(bubble.getBoundingClientRect().top - bodyTop)) + 'px';
  });
  window.__carrierHeartbeat = id => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {
    event:'carrier:webview-heartbeat', payload:{id, protected:false, content_present:true}
  });
  window.__carrierStoreDemo = { language:'en', theme:${JSON.stringify(theme)}, source:'docs/index.html', fictional:true };
  return { ...window.__carrierStoreDemo, width:innerWidth, height:innerHeight, images:document.images.length, externalResources:document.querySelectorAll('script, iframe, link, img[src^="http"]').length };
})()`;
const authToken = (await readFile(`${socketPath}.token`, "utf8")).trim();
const result = await new Promise<unknown>((resolveResult, reject) => {
  const socket = createConnection(socketPath);
  let buffer = "";
  socket.setTimeout(15000, () => socket.destroy(new Error("MCP timed out")));
  socket.on("error", reject);
  socket.on("connect", () =>
    socket.write(
      `${JSON.stringify({ id: "store-demo", command: "execute_js", payload: { window_label: "main", code }, authToken })}\n`,
    ),
  );
  socket.on("data", (data) => {
    buffer += data.toString();
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    socket.end();
    const response = JSON.parse(buffer.slice(0, newline));
    if (!response.success) reject(new Error(response.error));
    else resolveResult(response.data);
  });
});
console.log(result);
