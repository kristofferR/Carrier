#!/bin/sh
# Build and sign "Carrier Share.appex" (Ref #211/#212).
#
# Usage: build.sh <output-dir> [arch] [signing-identity]
#   arch defaults to the host architecture (arm64 or x86_64)
#   signing-identity defaults to ad-hoc ("-")
#
# The result at "<output-dir>/Carrier Share.appex" is ready to be copied into
# Carrier.app/Contents/PlugIns/ before the outer app is signed.
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:?output directory required}"
ARCH="${2:-$(uname -m)}"
IDENTITY="${3:--}"

APPEX="$OUT_DIR/Carrier Share.appex"
rm -rf "$APPEX"
mkdir -p "$APPEX/Contents/MacOS"

cp "$SCRIPT_DIR/Info.plist" "$APPEX/Contents/Info.plist"

xcrun clang \
  -fobjc-arc \
  -fapplication-extension \
  -target "$ARCH-apple-macos12.0" \
  -framework Foundation \
  -framework AppKit \
  -framework CoreServices \
  -Wl,-e,_NSExtensionMain \
  -o "$APPEX/Contents/MacOS/Carrier Share" \
  "$SCRIPT_DIR/main.m"

# Nested code signs before the outer app does. Hardened runtime keeps the
# extension notarizable; the entitlements carry the sandbox + app group.
codesign --force --options runtime --timestamp=none \
  --entitlements "$SCRIPT_DIR/entitlements.plist" \
  --sign "$IDENTITY" \
  "$APPEX"

echo "built: $APPEX"
