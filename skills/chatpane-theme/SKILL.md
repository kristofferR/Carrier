---
name: chatpane-theme
description: >-
  Make a Chatpane theme end to end: a recolor of Messenger, a look copied from
  another chat app (measured in its web app with the user's consent, or worked
  out from screenshots), or a port of an fMess theme. Covers the header and
  rules, light and dark colors, mapping the target's parts onto Chatpane's
  hooks, testing in the debug build through tauri-mcp, and shipping to the
  themes/ catalog with credit and licensing. Use for "make a Chatpane theme
  like Slack/Discord/Teams", "port the fMess WhatsApp theme", "a theme from
  these screenshots", or when fixing a theme in themes/ or src-tauri/themes/.
---

# Chatpane theme

A Chatpane theme is **one CSS file** that styles Messenger on top of the user's
light or dark choice. Messenger stays underneath: a theme can recolor and
restyle, never add behavior. The user's guide is
[`themes/README.md`](../../themes/README.md); read it first.

Read before writing selectors:

- [hooks.md](hooks.md): palette tokens, Messenger's variables, Chatpane's marks,
  DOM landmarks, the selector rule, CSS and performance gotchas.
- [testing.md](testing.md): trying a theme in the running app without saving it,
  dark mode, other languages, states to undo, scroll fps, restoring.
- [screenshots.md](screenshots.md): measuring a live web app, or working from
  screenshots alone.
- [porting.md](porting.md): turning an fMess theme into a Chatpane one.

Adapted from fMess's `fmess-theme` skill
(https://github.com/toanbku/fmess/tree/0cc6ecf/.claude/skills/fmess-theme, MIT).

## 0. What, from where, for whom

Ask once, in one message, for whatever the user hasn't said:

| Question | Options |
|---|---|
| What kind | **Recolor**: Messenger's layout in new colors (palette tokens, maybe radius and font). **Copy of an app**: another app's look. **Port**: an existing fMess theme (porting.md) |
| From where | **A.** the live web app, signed in, measured with their consent. **B.** screenshots only (screenshots.md) |
| For whom | **Just them**: Add theme file…. **The catalog**: a pull request to `themes/` |
| Which systems | macOS, Windows, Linux: what they can test on |

A recolor needs no measuring and no mapping table beyond the tokens it sets.

## Where things are

| What | Path |
|---|---|
| Header parsing, checks, palette mapping, preview | `src-tauri/src/themes.rs` (`parse_header`, `check_css`, `PALETTE`, `palette_mapping`, `preview`) |
| Built-in palette themes (ship with the app) | `src-tauri/themes/<id>.css`, listed in `BUILT_IN` |
| The catalog (downloaded by the app) | `themes/` ([#426](https://github.com/kristofferR/Chatpane/issues/426)): `<id>.css`, `previews/<id>-light.png` and `-dark.png`, `index.json` |
| Chatpane's page CSS and marks | `src-tauri/inject/messenger.css`, `inject/src/messenger/` |
| Dev bridge (debug builds) | `src-tauri/inject/mcp-bridge.js` |
| The user's themes | `<config>/themes/<id>.css` (testing.md lists `<config>` per system) |

## House rules

Every theme meets these. Check them before testing and again before shipping.

- **Light and dark**, unless the header's `mode` limits it to one. Every color is
  a token with both values.
- **Nothing on screen that does nothing**: no rails, fake title bars or panels,
  no buttons a theme draws, no window buttons.
- **No brand logos or wordmarks.** A copied look keeps colors, shapes and type.
- **No infinite animations.**
- **No shadows or filters on bubbles.**
- **Whole-chat pictures on a `::before` layer** of the message area, never on
  the scrolling element (hooks.md).
- **`:has()` never left of a combinator and never inside another `:has()`.**
- **Facebook's light and dark islands keep readable text**: tooltips, toasts,
  popovers (hooks.md).
- **Mark first, never a translated label alone** (hooks.md, "The selector
  rule"). No generated class names.
- **Hide Names & Avatars still hides**: never undo its blur or show names and
  pictures elsewhere.
- **The rules in themes/README.md**: 2 MB, no `@import`, only `data:` URLs.

## 1. Measure the target (copy of an app)

From the live app (screenshots.md, A) or screenshots (screenshots.md, B), into a
temp folder outside the repo: colors light and dark, type, sizes per region,
and a reference picture at about 880×600. Measurements from a real account
never go into the repo.

## 2. Map it → a mapping table

One row per region of the target: **target region → Chatpane hook → technique
→ can't**. Start from this (hooks.md has the selectors):

| Target region | Hook | Notes |
|---|---|---|
| Window and pane backgrounds | `--chatpane-wash`, `--chatpane-page`, `--chatpane-chat` | |
| Chat list | `[data-chatpane-pane="list"]`, rows `[role="row"] a[role="link"]`, `[aria-current="page"]` | own row hover: `--hover-overlay: transparent` on the row link |
| Search, filters | `label:has(input[type="search"])`, `[role="tablist"]`, `[role="tab"][aria-selected]` | can't add filters Messenger lacks |
| Sidebar or app rail | none | can't: a rail would do nothing |
| Chat header | `--mwp-header-*` variables | its buttons get marks with #424 |
| Chat background or pattern | `--chatpane-chat`; a pattern on `[data-mw-file-dropzone]::before` | |
| Bubbles | `--chatpane-out`, `--chatpane-in` and their `-text`, `--chat-bubble-border-radius` | no first/last-in-group mark: no tails |
| Group sender names, date dividers | `[data-scope="messages_table"] h4 span`, `[data-scope="date_break"] > span > span` | |
| Message lines without bubbles (IRC, Slack) | per-message marks with #425 | can't until then |
| Reactions | `--reaction-pill-*` variables | |
| Composer | `--chat-composer-*` variables, `[role="main"] [contenteditable="true"][role="textbox"]` | buttons get marks with #424 |
| Details pane | `[data-chatpane-chat-row] > :nth-child(2)` | |
| Tooltips, menus, popovers | `[role="tooltip"]`, `[role="menu"]`, `--popover-background` | mode-matched islands only |
| Type | font stack on the message selector (hooks.md) | only openly licensed fonts bundled |
| Title bar, window buttons, logo | none | can't, by the house rules |

## 3. Build

**Recolor:** copy `src-tauri/themes/warm.css` (light and dark) or `terminal.css`
(dark only), rename it in the header, set the tokens and the five preview
colors. The file is the theme.

**Copy of an app or a port:** one file, in this order:

1. The header and a credit comment.
2. `@font-face` from a data URL, only for an openly licensed font.
3. Palette tokens on `:root`, then the dark values in
   `@media (prefers-color-scheme: dark)`.
4. Messenger variables no token covers, on mode-matched islands.
5. Region by region, in the mapping table's order, each scoped to
   `html[data-chatpane-chats]` when it styles more than Messenger's own parts.

Values come from the measurements, not memory. Where one is missing, choose and
leave `/* UNMEASURED: … */`. Keep it well under 2 MB.

## 4. Test

testing.md, end to end: preview without saving, light and dark, every chat
kind, the states to undo, another language, scroll fps against Default, Hide
Names & Avatars on, and restore the user's app.

## 5. Ship

**For the user only:** Add theme file… in Settings. Tell them where the copy
lives, that editing it and reloading shows changes, and that Remove takes it
away.

**To the catalog** (a pull request; open it only when the user says so):

1. `themes/<id>.css`, `<id>` in lowercase letters, digits and dashes.
2. `themes/previews/<id>-light.png` and `-dark.png`, about 640×400, from a demo
   account or chats showing no one else (screenshots.md, "Pictures that leave
   the machine"). Only the modes the theme has.
3. Once the catalog is live (#426): the theme's `index.json` entry, with
   `version` bumped on every change to its CSS, then `bun run build:themes` for
   the hashes.
4. The pull request says what it copies, what it can't (the mapping table's
   "can't" column), where fonts and pictures come from and their licenses, and
   which systems it was tested on.

Built-in palette themes in `src-tauri/themes/` also need an entry in `BUILT_IN`,
a translated name (`theme.name.<id>` in all 30 locales, see AGENTS.md) and
`cargo test --lib themes`. New themes go to the catalog instead.

## 6. Licensing and credit

- **Credit** the original author in the header (`author:`) and in a comment
  below it with the source, its commit and license. Ported fMess themes keep
  fMess's MIT notice.
- **Fonts**: OFL or Apache fonts may be bundled. Never bundle proprietary ones
  (Segoe UI, SF Pro, vendor fonts): name them first in the stack instead.
- **Icons and emoji sets**: a vendor's own icon paths only with the
  maintainer's consent, said in the pull request. Otherwise openly licensed
  sets (Fluent UI System Icons, MIT; Material Symbols, Apache 2.0) or
  Messenger's own icons recolored. Never trace icons or logos from a picture.
- **Logos and wordmarks**: none, by the house rules.
- **Pictures**: no vendor screenshots or marketing pictures in the repo.

## Done when

- [ ] Header with name, author and preview colors; passes the checks
- [ ] Every house rule holds
- [ ] Light and dark match the reference region by region (or as closely as
      screenshots allow), and the mapping table's "can't" column is honest
- [ ] Every chat kind in testing.md checked, toasts and tooltips readable
- [ ] No selector depends on a translated label alone
- [ ] Scroll fps within about 10% of Default
- [ ] Hide Names & Avatars still hides
- [ ] The user's app restored: preview off, `theme-preview.css` deleted, nothing
      left open
- [ ] Shipping: the file, previews, credit and licenses in place
