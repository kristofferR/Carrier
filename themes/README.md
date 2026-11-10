# Making a Chatpane theme

A Chatpane theme is one CSS file. It recolors Messenger, and can restyle it
further, on top of the light or dark choice in Settings. You add it with
**Settings → Appearance → Add theme file…**.

Coding agents can use the [`chatpane-theme` skill](../skills/chatpane-theme/SKILL.md),
which covers building, porting, testing and shipping a theme end to end.

## The header

Every theme starts with a comment like this:

```css
/* Chatpane theme
   name: Fjord
   author: ingrid
   mode: dark
   preview: #242933 #2e3440 #2e3440 #5e81ac #3b4252
*/
```

- The first line ends in `theme`. Headers written for other Messenger apps
  with the same shape (`/* fMess theme`) work too.
- `name` is required and shown in Settings (at most 60 characters).
- `author` is optional and shown as "by …".
- `mode` is optional: `light` or `dark` limits the theme to that mode. In the
  other mode Messenger's own colors show. Leave it out when the theme has both.
- `preview` is five `#rrggbb` colors for the card in Settings: the window, the
  chat list, the chat, your messages, theirs. Without it the card has no
  colors.

## The rules

Chatpane refuses a file that breaks one of these, and says which line:

- At most 2 MB.
- No `@import`.
- `url()` and `src()` only with `data:` URLs. A theme can't load or send
  anything, so pictures and fonts go in as data URLs.
- No `image()`, `image-set()`, `cross-fade()`, `element()` or `expression()`.
- Valid CSS, nested at most 64 levels deep.

## Recoloring with palette tokens

The easiest theme sets Chatpane's palette tokens. Chatpane maps each one onto
Messenger's own CSS variables, including the places Facebook declares them
again (tooltips, the photo viewer, each chat's own colors), so a token reaches
everywhere its color shows.

| Token | Paints |
|---|---|
| `--chatpane-wash` | the window behind the panes |
| `--chatpane-page` | panes, cards, menus, the chat header and composer bar |
| `--chatpane-chat` | behind the messages |
| `--chatpane-field` | text fields, grey buttons, the quoted message in a reply |
| `--chatpane-hover` | the hover tint (keep it translucent) |
| `--chatpane-line` | dividers |
| `--chatpane-text` | main text |
| `--chatpane-text-2` | secondary text, placeholders, secondary icons, scroll bars |
| `--chatpane-icon` | icons |
| `--chatpane-brand` | buttons, links, the caret, accent icons |
| `--chatpane-brand-soft` / `--chatpane-brand-soft-text` | soft buttons and the selected filter |
| `--chatpane-out` / `--chatpane-out-text` | your bubbles and their text (also turns off a chat's gradient) |
| `--chatpane-in` / `--chatpane-in-text` | their bubbles and text |
| `--chatpane-selection` | selected text |

Set only the tokens you want to change. Put the dark values in a media query:

```css
:root {
  --chatpane-page: #faf6ef;
  --chatpane-out: #c4623a;
  --chatpane-out-text: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --chatpane-page: #1f1a16;
    --chatpane-out: #d9774c;
  }
}
```

`html[data-chatpane-dark]` is there too when you need a selector rather than a
media query. The built-in themes in
[`src-tauri/themes/`](../src-tauri/themes/) are complete examples: `warm.css`
covers light and dark, `terminal.css` is dark only and sets a monospace
font across the chats.

## Beyond colors

A theme can style anything with plain CSS. Facebook's class names are
generated and change often, and its labels are translated, so select by roles
and structure (`[role="main"]`, `[role="log"]`, `[data-message-id]`), never by
class names or English labels alone. The skill's
[hooks reference](../skills/chatpane-theme/hooks.md) lists what is stable.

Keep these in mind:

- Light and dark both, unless the header's `mode` says otherwise.
- Nothing on screen that does nothing: no fake buttons, title bars or panels.
- No brand logos or wordmarks, and no animations that run forever.
- No shadows or filters on message bubbles.
- A picture behind the whole chat goes on a `::before` layer, not on the
  scrolling area.
- Never `:has()` to the left of a combinator, and never `:has()` inside
  another `:has()`.
- Facebook draws some things in the opposite mode to the page (tooltips,
  toasts). Their text must stay readable in both modes.
- Hide Names & Avatars blurs names and pictures. A theme must not undo that
  blur or show names and pictures anywhere else.

What the user picks in Settings comes after the theme: the accent color
replaces `--chatpane-brand` and your bubble colors, and a message font
replaces the theme's message font. `custom.css` (Settings → Advanced) applies
last of all.

## Trying it

1. **Add theme file…** checks the file and keeps a copy in the themes folder
   (**Open themes folder** shows it).
2. Edit that copy, then reload Chatpane (Cmd+R on macOS, Ctrl+R on Windows and
   Linux). If the theme disappears, the file broke a rule: add it again to see
   which.
3. Check light and dark, a group chat, a reply, the photo viewer, menus and
   tooltips.

Adding a file with the same file name and the same `name` again replaces the
earlier copy.

## Submitting a theme

Themes are being moved into a catalog in this folder that Chatpane downloads
from ([#426](https://github.com/kristofferR/Chatpane/issues/426)). To submit
one, open a pull request that adds:

- `themes/<id>.css`, where `<id>` is lowercase letters, digits and dashes;
- `themes/previews/<id>-light.png` and `<id>-dark.png`: about 640×400, showing
  only a demo account or chats with no one else's names, pictures or messages
  in them (leave out the mode the theme doesn't have);
- once the catalog is live, its entry in `themes/index.json`.

Credit anyone whose work the theme builds on in its header and in the pull
request, with their license. Only bundle fonts and pictures whose license
allows it.
