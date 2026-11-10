# What a theme can hook into

Read from `src-tauri/src/themes.rs`, `src-tauri/inject/messenger.css` and
`inject/src/` on 2026-11-09. Chatpane and Facebook both change; re-check with:

```sh
grep -rhoE 'data-chatpane-[a-z-]+|--chatpane-[a-z0-9-]+' inject/src src-tauri/inject/messenger.css | sort | uniq -c
```

## How the CSS reaches the page

- `themes.rs` (`apply_appearance`) puts three `<style>` elements into every
  Messenger window, in this order: `style[data-chatpane-theme]` (the theme),
  `style[data-chatpane-accent]` (Settings' accent color), `style[data-chatpane-font]`
  (Settings' message font). `style[data-chatpane-custom]` (`custom.css`) comes
  last. Later ones win at equal specificity.
- The theme style holds the file, then Chatpane's mapping for the palette tokens
  the file defines (`palette_mapping`). With `mode: light` or `mode: dark` in the
  header, all of it is wrapped in `@media (prefers-color-scheme: …)`.
- The accent color sets `--chatpane-brand`, `--chatpane-out` and
  `--chatpane-out-text` after the theme, so a user's accent beats the theme's.
- The message font is set with `!important` on
  `[role="main"] :is([role="log"], [contenteditable="true"][role="textbox"]) :is(div, span, a, p, li)`
  and the message box. A theme font on a less specific selector is overridden
  by a chosen font in the chat, which is what users expect. `terminal.css`
  sets its font on every element under `html[data-chatpane-chats]`, which
  beats Facebook's `!important` font classes but stays below that selector.
- Call windows (`popup-*`) and the Settings window get no theme.
- Validation (`parse_header`, `check_css`): see `themes/README.md`, "The rules".
  It uses a real CSS tokenizer, so escapes and comments can't get around it.

## Palette tokens

Setting a `--chatpane-*` token is enough: Chatpane writes the matching Messenger
variables with `!important` on `:root`, on each chat's color host
(`[style*="--chat-outgoing-message-bubble-background-color"]`) and on Facebook's
mode islands that match the page (`.__fb-light-mode` while light,
`.__fb-dark-mode` while dark). The table is `PALETTE` in `themes.rs`:

| Token | Messenger variables |
|---|---|
| `wash` | `--web-wash` |
| `chat` | none; `[role="main"] [data-mw-file-dropzone]` gets it as `background-color` |
| `page` | `--surface-background`, `--card-background`, `--messenger-card-background`, `--popover-background`, `--mwp-header-background-color`, `--chat-composer-background-color`, `--reaction-pill-background-color` |
| `field` | `--comment-background`, `--input-background`, `--secondary-button-background`, `--chat-composer-input-background-color`, `--chat-replied-message-background-color`, `--chat-edit-message-overlay-color` |
| `hover` | `--hover-overlay` |
| `line` | `--divider` |
| `text` | `--primary-text`, `--mwp-header-text-color` |
| `text-2` | `--secondary-text`, `--placeholder-text`, `--secondary-icon`, `--placeholder-icon`, `--chat-admin-text-color`, `--mwp-subheader-text-color`, `--chat-scrollbar-thumb-color` |
| `icon` | `--primary-icon` |
| `brand` | `--accent`, `--primary-button-background`, `--mwp-primary-theme-color`, `--blue-link`, `--chat-composer-button-color`, `--chat-composer-caret-color`, `--mwp-header-button-color` |
| `brand-soft` | `--primary-deemphasized-button-background`, `--reaction-pill-multireact-selected-color` |
| `brand-soft-text` | `--primary-deemphasized-button-text` |
| `out` | `--chat-outgoing-message-bubble-background-color`, and `--chat-outgoing-message-background-gradient: initial` |
| `out-text` | `--chat-message-text-color` |
| `in` | `--chat-incoming-message-bubble-background-color` |
| `in-text` | `--chat-incoming-message-text-color` |
| `selection` | `--text-highlight` |

Messenger variables with no token (set them yourself, with `!important`, on the
same selectors the mapping uses):

| Variable | Paints |
|---|---|
| `--notification-badge` | red badges |
| `--focus-ring-blue`, `--focus-ring-shadow-default`, `--focus-ring-shadow-inset`, `--focus-ring-outline-link` | the keyboard focus ring |
| `--chat-bubble-border-radius`, `--chat-bubble-padding-vertical`, `--chat-bubble-padding-horizontal` | bubble shape |
| `--chat-outgoing-message-background-gradient` | a chat's gradient. Chatpane paints it on your bubbles fixed to the window (`lib/chat-gradient.ts`); setting `--chatpane-out` turns it off |
| `--mwp-message-row-background` | the message row (usually `transparent`) |
| `--messenger-card-spacing`, `--messenger-card-corner-radius`, `--messenger-card-box-shadow` | the gaps, corners and shadows of the panes |

`--header-height` is forced to `0px` by `messenger.css` (Facebook's top bar is
hidden). Leave it alone.

## Marks Chatpane puts on the page

| Hook | Where / when | Use it for |
|---|---|---|
| `html[data-chatpane-dark]` | Messenger renders dark (follows `prefers-color-scheme`, which Chatpane sets from the light/dark choice). `data-fmess-dark` is set too, for fMess themes | dark colors when a selector suits better than `@media (prefers-color-scheme: dark)`. It is set by script, so prefer the media query for tokens: it applies from the first paint |
| `html[data-chatpane-chats]` | the path is `/messages…` or `/messenger_media…` | scoping anything drawn on `html`/`body` to the chats |
| `html[data-chatpane-login]` | the login page (Chatpane tidies it; its dark mode is Chatpane's own) | leave the login page alone: scope rules to `[data-chatpane-chats]` |
| `[data-chatpane-media-viewer]` | on the photo/video viewer's `[role="dialog"]` while it is open | `html:has([data-chatpane-media-viewer])` hides what the theme draws over the window |
| `html[data-chatpane-title-bar="macos" \| "windows" \| "linux"]`, `--chatpane-title-bar-inset` | the strip for the window buttons: on macOS they float over the top of the chat list, on Windows and Linux Chatpane draws them at the top right over a strip above the chat. The inset is `0px` when there is no strip (tiling window managers, full screen) | keep that strip clear; never draw window buttons of your own |
| `#chatpane-window-controls`, `#chatpane-title-strip` | Chatpane's own window buttons and drag strip (Windows, Linux) | don't restyle or cover them |
| `[data-chatpane-pane="list"]` | the chat list `[role="navigation"]`, marked once the window has shown the chats (not while it stays hidden) | the list pane |
| `[data-chatpane-chat-row]` | the row holding the chat and its details, once a chat is open; the details are its second child | the details pane: `[data-chatpane-chat-row] > :nth-child(2)` |
| `.chatpane-pane-edge`, `html[data-chatpane-resizing]` | the 9px drag handles between panes, and while one is dragged | don't cover or hide the handles |
| `html[data-chatpane-scrollbars="overlay" \| "classic"]`, `#chatpane-scroll-indicator` | Chatpane owns the scroll bars: thin overlay ones, or hidden ones with a floating indicator in the chats | `--chatpane-text-2` (or `--chat-scrollbar-thumb-color`) is all a theme needs; don't restyle `::-webkit-scrollbar` |
| `html[data-chatpane-hide-names]`, `html[data-chatpane-hide-avatars]`, `[data-chatpane-private-identity]`, `[data-chatpane-private-avatar]`, `[data-chatpane-private-prefix]` | Hide Names & Avatars is on; those elements are blurred with `filter: blur(6px) !important` | never set `filter`, `content` or `-webkit-text-fill-color` on names or pictures, and never show them anywhere else (`attr()`, `content:`). Test with both settings on |
| `html[data-chatpane-system-emoji]`, `[data-chatpane-emoji-sprite]`, `[data-chatpane-system-emoji-glyph]` | System emoji is on: Facebook's emoji pictures are hidden and a text glyph shown | an emoji picture swap (`img[alt] { content: … }`) doesn't apply there |
| `[data-chatpane-settings-button]` | Chatpane's Settings button in the chat list header | may be restyled; keep it visible and clickable |

**Coming with [#424](https://github.com/kristofferR/Chatpane/issues/424) and
[#425](https://github.com/kristofferR/Chatpane/issues/425)** (not on the page
yet; check the issues before using them): `data-chatpane-ui` marks on the
composer and its buttons, the chat header and its buttons, the list header and
the reaction picker; `data-chatpane-list`; `html[data-chatpane-media]`;
per-message `data-chatpane-sender`, `data-chatpane-time` and run marks. They
only run while the theme's CSS mentions them. Until they land, a layout theme
selects by structure (below) and lists what it couldn't reach.

## The selector rule

Facebook translates its labels: a German Facebook says "Suchen", not "Search".
**Mark first, never a translated label alone.** In order of preference:

1. A Chatpane mark (above).
2. Roles, `data-*` attributes Facebook sets for its own use
   (`data-message-id`, `data-scope`, `data-mw-file-dropzone`), `dir`, and
   structure (`>`, `:first-child`).
3. The start of an icon's SVG path: `[role="button"]:has(> svg path[d^="M16,9.1c"])`.
   It breaks when Facebook redraws the icon, so say so in a comment.
4. An English `aria-label` only beside one of the above, never alone:
   `:is([aria-label="Choose an emoji"], <structural selector>)`.

Never select Facebook's generated class names (`.x1n2onr6`): they change with
every deploy.

## Messenger's DOM landmarks

| Selector | What |
|---|---|
| `[role="navigation"][data-chatpane-pane="list"]` | the chat list pane. A bare `[role="navigation"]` matches an empty one first |
| `[role="navigation"] h1` | the "Chats" title |
| `[role="navigation"] a[href="/messages/new/"]` | new message |
| `[role="navigation"] label:has(input[type="search"])` | the search field |
| `[role="navigation"] [role="tablist"]`, `[role="tab"][aria-selected="true"]` | the filters (All, Unread, Groups…) |
| `[role="navigation"] [role="row"] a[role="link"]`, `a[aria-current="page"]` | chat rows, the open chat |
| `[role="main"]` | the chat pane (messages and details) |
| `[role="main"] [data-mw-file-dropzone]` | the message area; the chat background goes here |
| `[data-mw-file-dropzone] [style*="background-image"]:has([role="log"])` | a chat's own background picture |
| `[role="log"]` | the message list |
| `[data-scope="messages_table"]` | a message row |
| `[data-message-id]`, `[data-message-id] [role="presentation"]`, `[data-message-id] [dir="auto"]` | a message, its bubble, its text |
| `[data-scope="messages_table"] h4 span` | the sender's name above a group's messages |
| `[data-scope="date_break"] > span > span` | a date divider |
| `[style*="--chat-outgoing-message-bubble-background-color"]` | a chat's color host: it declares the `--chat-*` colors again |
| `[role="main"] [contenteditable="true"][role="textbox"]` | the message box |
| `[role="tooltip"]` | tooltips; the element itself is a dark island |
| `[role="menu"]`, `[role="menuitem"]`, `[role="menuitemradio"]` | menus and the reaction picker; each item has a `div[role="none"]` hover layer drawn over it with `--hover-overlay` |
| `[role="dialog"]` | dialogs and the photo viewer |
| `.__fb-dark-mode`, `.__fb-light-mode` | Facebook's mode islands: subtrees that declare every color variable again |

Confirm a landmark on the live page before relying on it (testing.md, "Looking
at the page").

## Facebook's light and dark islands

Facebook draws some things in the opposite mode to the page: tooltips are dark
on a light page, and toasts ("Link copied") and some popovers are light on a
dark page. Each island declares every color variable again.

Palette tokens handle this: Chatpane maps them only onto islands that match the
page's mode, so opposite islands keep Facebook's own, readable colors. A theme
that sets Messenger variables itself must do the same. Never put page colors on
both island classes at once (fMess themes do, which is how fMess shipped
white-on-white toasts in dark mode):

```css
@media (prefers-color-scheme: light) {
  :root, .__fb-light-mode { --secondary-button-background: #e8e2d6 !important; }
}
@media (prefers-color-scheme: dark) {
  :root, .__fb-dark-mode { --secondary-button-background: #2e2721 !important; }
}
```

A toast's close button uses `--secondary-button-background`, so check its cross
in both modes after recoloring button faces.

## CSS and performance gotchas

Measured in WebKit by fMess and Chatpane, not guessed:

- **`:has()` left of a combinator** (`pane:has(x) h1`) makes WebKit restyle the
  whole page whenever an `x` appears anywhere. `:has()` in the last compound
  (`a:has(> svg)`) is fine; keep its argument narrow. Where you need the
  descendant form, put a flag on the ancestor and query it:
  ```css
  [data-chatpane-chat-row] > :nth-child(2) { --details: 1; }
  @container style(--details: 1) { h2 { font-size: 16px !important; } }
  ```
- **No `:has()` inside `:has()`.** WebKit drops the whole rule.
- **A picture behind the whole chat** as a background or mask on the scrolling
  area cut scrolling to 7–20 fps. Put it on a `::before` of the dropzone:
  ```css
  [role="main"] [data-mw-file-dropzone] { isolation: isolate; }
  [role="main"] [data-mw-file-dropzone]::before {
    content: ""; position: absolute; inset: 0; z-index: -1;
    background: url("data:image/svg+xml,…"); will-change: transform; pointer-events: none;
  }
  ```
- **No `box-shadow` or `filter` on bubbles**: it leaves ghost boxes and covers
  reactions. Change colors and radius only.
- **No infinite animations**: a looping animation repaints every frame and keeps
  the GPU busy on high-refresh screens.
- **`img[alt="❤"] { content: url(…) }`** swaps that emoji everywhere, in message
  text too.
- **Text a theme writes** (`content: "Contacts"`) is in one language. Write none,
  or only words that are the same in every language.
- **Hit areas**: never hide a button's box to restyle it. Hide its `svg *` and
  paint on the button, so the click target and tooltip stay.
- **Row hover in two tones**: Messenger's hover layer covers only part of a chat
  row. A theme that paints its own row hover sets
  `--hover-overlay: transparent !important` on the row link.
- **Zoom**: people use other page zooms. Measure at 100%, then look at 125%.
