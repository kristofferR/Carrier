# Testing a theme in the real app

Chatpane runs in the user's real Messenger account. Everything you do there is
**read-only**: never send, react, call, type into a message box, open an unread
chat, or change a Messenger or Facebook setting. Open a menu or picker only to
look at it, then close it.

Screenshots show real chats. Keep them in a temp folder outside the repo, never
commit or upload them, and name chats only by kind ("a group chat") in reports.

## Quick loop (any system, the installed app)

1. Settings → Appearance → **Add theme file…** checks the file, copies it into
   the themes folder and selects it. The copy is `<config>/themes/<id>.css`:

   | System | `<config>` |
   |---|---|
   | macOS | `~/Library/Application Support/app.chatpane.Chatpane` |
   | Windows | `%APPDATA%\app.chatpane.Chatpane` |
   | Linux | `~/.config/app.chatpane.Chatpane` |

   `<id>` is the file name in lowercase, with anything but letters and digits
   turned into dashes. A built-in's id gets `-imported`.
2. Edit that copy and reload (Cmd+R on macOS, Ctrl+R on Windows and Linux).
   Chatpane reads it again on every page load. If the theme disappears, the file
   broke a rule: add it again to read the reason, or read the log (`theme <id>
   was not applied`).
3. You can't see the window from here without the debug build: ask the user for
   screenshots, light and dark.

This changes the user's selected theme. Tell them, and put their theme back in
Settings when you're done.

## Debug loop (tauri-mcp)

A debug build with the `diagnostics` (or `mcp`) feature runs a tauri-mcp server
and the dev bridge (`src-tauri/inject/mcp-bridge.js`). On the maintainer's
machines the installed Chatpane is always such a build (AGENTS.md). Elsewhere:

```sh
bun install
bun run tauri build --debug --features diagnostics --bundles app
```

The window title reads "Chatpane (debug)". `.mcp.json` registers the
`tauri-mcp` server; `query_page` with `mode: "app_info"` tells you whether it
connects. Facebook's page blocks arbitrary `execute_js`; the bridge answers a set
of named commands instead, used below.

### Apply a theme without saving it

The preview never touches `settings.json` or the themes folder:

1. Write the theme to `<config>/theme-preview.css` (folder above).
2. `execute_js` with `__chatpane_mcp_theme_preview__:on`. Every Messenger window
   shows the preview instead of the chosen theme, also after a reload. Send it
   again after each edit of the file.
3. `__chatpane_mcp_theme_preview__:dark` and `:light` render the windows in that
   mode without changing the user's light/dark setting.
4. **Always finish with `__chatpane_mcp_theme_preview__:off`**, also after a
   failure: it puts the saved theme and mode back. Then delete
   `theme-preview.css`.

A file that breaks a rule shows Messenger's own look; the reason is in the log:
`query_logs` and search for `theme preview`. Bracket each step with `log_mark`
and read `query_logs({between: id})` to see only what it produced.

`:dark` and `:light` also set the page's own copy of the light/dark choice (in
memory, again after each reload), so Facebook's classes match. If the user
changes a setting while you preview, Chatpane re-applies their mode; send
`:dark` or `:light` again.

### Looking at the page

- `take_screenshot` needs the window on screen, and fails while the Linux screen
  saver is up. Look at it at the window's usual size and at 100% zoom first.
- `query_page` with `mode: "html"` returns the whole DOM into a file. Count
  selector hits in it with shell tools; never print message text or names.
- `query_page` with `mode: "map"` and a narrow `scope_selector` works on the page.
  `scope_selector: "h1"` gives the "Chats" heading, which tells Facebook's
  language without showing any chat.
- `__chatpane_mcp_design_probe__`: geometry and computed colors of the chat UI,
  sanitized.
- `__chatpane_mcp_privacy_probe__`: what Hide Names & Avatars blurs, sanitized.

### States to open and undo

`__chatpane_mcp_message_probe__:<n>:<step>` works on the nth-newest message:
`shape`, `hover` (its toolbar), `more` (its menu), `react` (the reaction picker),
`escape` (closes what is open). Never click an item in a menu or picker.

| State | Open | Undo |
|---|---|---|
| hover toolbar | `:1:hover` | move the pointer away |
| message menu | `:1:more` | `:1:escape` |
| reaction picker | `:1:react` | `:1:escape` |
| reply bar | the toolbar's Reply button (`click`) | the bar's ✕ (`click`) or Escape; the box must be empty again |
| photo viewer | `click` a photo in a read chat | `press_key` Escape |
| details pane | the header's info button | the same button |
| tooltip | `mouse_action` hover on a header button | move away |

After each one, check that nothing is left open and the message box is empty.

### Dark mode

Use `__chatpane_mcp_theme_preview__:dark` (above). `__chatpane_mcp_theme_set__`
only flips Facebook's class, and Facebook doesn't restyle what it already drew,
so it is no substitute.

### Another Facebook language

Facebook translates every label, so a theme that leans on an English
`aria-label` breaks for most users.

1. Read every attribute selector in the theme: each `aria-label`, `title` or
   `placeholder` selector must sit beside a mark or structural selector
   (hooks.md, "The selector rule").
2. If the user's Facebook isn't English (`scope_selector: "h1"`), look at the
   theme there. If it is English, ask before switching it: Settings → General →
   Facebook language opens Facebook's own language page, and the language is an
   account setting. Switch it back afterwards.

### Scroll performance

`__chatpane_mcp_scroll_fps__` scrolls the open chat by up to 1200px (up when
there is room) and back over two seconds, then puts it back. It reports `fps`,
`p95Ms`, `longestMs` and `scrolledPx`. The window must be on screen.

1. Baseline with Messenger's own look, whatever theme the user picked: write a
   `theme-preview.css` that is only a header (`/* Chatpane theme` and
   `name: Default`), send `:on`, open a long read chat and run the probe three
   times.
2. Write the theme into `theme-preview.css`, send `:on` again, and run it three
   times in the same chat at the same scroll position.
3. The theme should stay within about 10% of the baseline. Never compare with a
   fixed number: refresh rates differ.

Do it on macOS and Linux when you can; WebKit differs between them.

### Every chat kind

[#436](https://github.com/kristofferR/Chatpane/issues/436) adds a chat check
that runs every theme across chat kinds, Messenger chat themes and light/dark,
and checks the pixels. Until it lands, go through the matrix by hand, in light
and dark: an encrypted chat, a chat that isn't encrypted, a group chat, a chat
with Messenger's gradient theme, one with a color or wallpaper theme. In each:

- a bubble from each side is visible against the chat background, and its text
  is readable (contrast at least 3);
- a reply's quote is readable inside its bubble;
- an emoji-only message has no bubble;
- a toast (scrolling the chat list to its end shows "All chats loaded.") has
  readable text and a visible ✕.

## What to look at

Light and dark, region by region: the chat list (header, search, filters, rows:
hover, selected, unread), the chat header, the chat background, bubbles (yours,
theirs, a reply, emoji only, a link preview, a photo), date dividers, reaction
pills, the composer (empty, with the reply bar), the details pane. Then: a
tooltip, a menu, the reaction picker, a toast, the photo viewer (nothing the
theme draws over it), Hide Names & Avatars on (still blurred), the window
buttons (macOS over the list, Windows and Linux at the top right), and 125%
zoom.

## Restore

Before you report, whatever happened:

- `__chatpane_mcp_theme_preview__:off`, and delete `theme-preview.css`;
- no menu, picker, viewer or reply bar left open, the message box empty;
- Facebook's language as it was;
- if you used the quick loop, the user's own theme selected again;
- screenshots kept only in your temp folder.
