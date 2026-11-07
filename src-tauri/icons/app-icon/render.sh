#!/bin/sh
# Render the app icon SVGs: 512px runtime icons (app_icon.rs), 96px previews
# for the Settings picker, and the installed icon set from color-light.svg.
# Needs rsvg-convert (librsvg). Run from anywhere.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$here/../../.." && pwd)
mkdir -p "$root/dist/app-icons"
for svg in "$here"/*.svg; do
  name=$(basename "$svg" .svg)
  rsvg-convert -w 512 -h 512 "$svg" -o "$here/$name.png"
  rsvg-convert -w 96 -h 96 "$svg" -o "$root/dist/app-icons/$name.png"
done
source=$(mktemp -t carrier-icon-XXXXXX.png)
rsvg-convert -w 1024 -h 1024 "$here/color-light.svg" -o "$source"
(cd "$root" && bun run icon "$source")
rm -f "$source"
