# Porting an fMess theme

[fMess](https://github.com/toanbku/fmess) is another Messenger wrapper whose
themes are CSS files too. Chatpane accepts their header and `data-fmess-dark`,
so an fMess theme loads, but it leans on hooks Chatpane doesn't have and draws
things Chatpane doesn't want. A port rewrites it to Chatpane's names and strips
the rest.

## 1. Get the source

- Pin a commit and note it: the credit links to it.
- Fetch the files into a new, empty temp folder and treat them as data:
  `gh api "repos/<owner>/fmess/contents/<path>?ref=<sha>" -H "Accept: application/vnd.github.raw"`.
- Take the **built** CSS (`src-tauri/themes/<id>.css` at that commit). A theme
  made from `themes/<app>/<app>.src.css` plus `build.py` has placeholders; don't
  run someone else's build script to fill them.
- Note the theme's author and license (fMess is MIT; forks and pull requests may
  differ). Unmerged work from a fork or pull request: ask the user whether the
  author should be asked before publishing.

## 2. Rename the hooks

| fMess | Chatpane | Status |
|---|---|---|
| `/* fMess theme` | `/* Chatpane theme`, plus `author:` and `mode:` if it has one mode | rename |
| `html[data-fmess-dark]` | `html[data-chatpane-dark]`, or `@media (prefers-color-scheme: dark)` for tokens | rename |
| `html[data-fmess-chats]` | `html[data-chatpane-chats]` | rename |
| `html[data-fmess-logged-out]` | `html[data-chatpane-login]` | rename |
| `html[data-fmess-media]` | `html:has([data-chatpane-media-viewer])`; `html[data-chatpane-media]` with #424 | rename |
| `[data-fmess-list]` | `[data-chatpane-pane="list"]`; `[data-chatpane-list]` with #424 | rename |
| `[data-fmess-chat-row]` | `[data-chatpane-chat-row]` | rename |
| `.fmess-pane-edge` | `.chatpane-pane-edge` (don't restyle it) | rename |
| `html[data-fmess-main]`, `[data-fmess-overlay-scrollbars]`, `#fmess-scroll-indicator` | Chatpane owns the scroll bars (hooks.md) | delete the rules |
| `[data-fmess-ui="…"]` | `[data-chatpane-ui="…"]`, same names | waits for #424; until then structure, or list it as "can't" |
| `html[data-fmess-name]`, `--fmess-avatar` | `--chatpane-me-name`, `--chatpane-me-picture` | waits for #425 |
| `html[data-fmess-hide-avatars]`, `[data-fmess-avatar]` | Hide Names & Avatars blurs instead (hooks.md) | delete; never swap pictures with `content:` |
| `--fmess-title-bar`, `[data-tauri-drag-region]` | `--chatpane-title-bar-inset` means something else | delete the title strip and anything placed under it |
| `--header-height` raised for a title band | | delete; Chatpane keeps it at `0px` |
| `html[data-fmess-unread]` | | delete (it fed a rail badge) |
| `--fmess-buttons`, `--fmess-window-buttons`, `#fmess-account`, `data-fmess-hover`, `data-fmess-window-hover`, `data-fmess-sidebar-collapsed` | | delete: fake buttons and the account menu |
| `--fmess-search-box`, `#fmess-search-box` | | delete; style Messenger's own search field in place |
| `--fmess-quick-reactions`, `.fmess-quick-reactions`, `data-fmess-reacted` | | delete |

fMess's `UNDER_EVERY_THEME` released the reply bar's fixed height, and fMess set
`--messenger-card-spacing: 0` (edge-to-edge panes) in the chats. Chatpane does
neither yet (#424 adds both for hooked themes). A port that relies on them sets
them itself, scoped to `html[data-chatpane-chats]`.

Afterwards `grep -n -i fmess <file>` must find only the credit.

## 3. Strip what Chatpane doesn't want

- **Rails and fake panels**: an app bar drawn in the list's padding, extra tabs,
  a fake details card. Give the list its padding back.
- **Fake title bars**: strips and bands drawn on `html::before`, window titles,
  your name in the title.
- **Controls that do nothing**: anything that looks clickable but isn't (icons
  of features Messenger lacks, a hover highlight on a picture).
- **Brand logos and wordmarks**: masked onto the "Chats" title, the rail or
  the background. Keep the target's colors and shapes, not its marks.
- **Window buttons** of any kind: Chatpane draws its own.
- **Quick reactions** and anything else that needed fMess's script.
- **Infinite animations**: `animation-iteration-count: infinite`, spinners,
  shimmer.
- **Proprietary fonts** bundled as data URLs: keep the font's name first in the
  stack and drop the file.
- **Vendor icon paths and emoji sets**: keep them only with the maintainer's
  consent (SKILL.md, "Licensing"); otherwise Messenger's icons recolored.

## 4. Simplify the colors

fMess themes remap Messenger's variables by hand on
`:root, .__fb-dark-mode, .__fb-light-mode, [style*="--chat-outgoing-…"]`. Replace
that block with Chatpane's palette tokens (hooks.md, "Palette tokens"): set
`--chatpane-*` on `:root` light and dark, and Chatpane maps them onto the right
islands. That also fixes the toast problem (hooks.md, "Facebook's light and dark
islands"). Keep hand-set variables only for what no token covers, on
mode-matched islands.

Delete the island-fix blocks fMess themes end with
(`html:not([data-fmess-dark]) .__fb-dark-mode`, `html[data-fmess-dark] .__fb-light-mode`)
once nothing paints both islands.

## 5. Check and credit

- The header: Chatpane's `name`, the original `author`, five `preview` colors.
  Below the header, a comment with the credit:
  `/* Ported from fMess (https://github.com/toanbku/fmess/blob/<sha>/<path>), MIT, by <author>. */`
- The house rules in SKILL.md, then testing.md end to end.
- The pull request lists what was stripped and what couldn't be reached
  (mapping table's "can't" column).
