# Where the look comes from

## A. A live web app the user is signed in to

Measuring gives exact values, but it happens in the user's real account in that
app. Before you start:

- **Ask first**, naming the app and what you'll do: open it in your own browser
  tab, read colors, sizes and fonts, look at menus. Wait for a yes.
- If it isn't signed in, stop and ask the user to sign in. Never type
  credentials.
- **Read-only**: never send, react, call, type into a message box, change a
  setting, or click a menu item. Open only read chats. Press Escape after
  opening anything.
- **Send nothing**: nothing you measure leaves the machine. Don't paste the
  app's pages, screenshots or messages into a web service, an issue or a pull
  request.
- Work only in a tab you opened, and close it at the end.

What to collect, into a temp folder outside the repo:

1. The window at about 880×600 and 100% zoom, light and dark if dark can be
   seen without changing a setting.
2. Stable selectors and the app's token system (`--colorNeutralBackground1`,
   `--md-sys-…`): the computed values, light and dark.
3. Per region (sidebar, list, header, messages, composer, details): background,
   text colors, font family and sizes, radii, heights.
4. Icons: only note which ones the app uses. Copying a vendor's icon paths needs
   the maintainer's consent (SKILL.md, "Licensing").

Write `UNMEASURED: <why>` for anything you couldn't reach.

## B. Screenshots only

For a desktop-only app, a look that no longer exists, or no browser tools.
Everything taken from pictures is an estimate: mark it `screenshot`, never pass
it off as measured.

Ask the user once, in one message, for:

1. The main window in light: the chat list and an open chat with messages from
   both sides. The same in dark.
2. Close-ups if they have them: the composer with text in it, a reply, a
   reaction, a menu or tooltip, a group chat.
3. PNG files, not resized or compressed, and the screen's scale (2 on a Retina
   Mac or a 200% Windows screen). Photos of a screen don't work.
4. Pictures of a chat they don't mind you seeing. They stay on their machine.

Then:

1. **Scale**: picture width ÷ window width in CSS pixels. Over 2000px wide for a
   normal window is almost always 2. Check against something of known size (a
   40px avatar).
2. **Colors**: sample a small box per region with any image tool (ImageMagick
   `magick light.png -crop 40x16+600+400 -format %c histogram:info:-`). The most
   common color is the background; for text, box a few letters and take the
   darkest frequent color. On macOS convert to sRGB first
   (`sips -m "/System/Library/ColorSync/Profiles/sRGB Profile.icc"`).
3. **Sizes**: read edges, divide by the scale, round to whole pixels.
4. **Type**: a picture can't name a font. Use the app's known font first in its
   usual fallback stack. Cap height is about 0.7 × the font size.
5. **Dark mode** without a dark picture: derive it (dark surfaces, light text,
   the brand color lifted for contrast), mark it `derived`, and tell the user.
6. **Hover, menus, tooltips** with no picture: keep Messenger's own, in the
   theme's colors, and say so in the mapping table.
7. **Icons**: a picture has no SVG paths. Keep Messenger's icons in the theme's
   colors. Never trace a vendor's icons or logo from a picture.

## Pictures that leave the machine

Previews for `themes/previews/` and pictures in a pull request show a demo
account, or the user's own test chats with no one else's names, pictures or
messages. Never a reference screenshot of the target app.
