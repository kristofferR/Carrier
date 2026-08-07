#!/bin/sh
# Build and sign "Carrier Share.appex" (Ref #211/#212).
#
# Usage: build.sh <output-dir> [arch] [signing-identity] [version]
#   arch defaults to the host architecture (arm64 or x86_64)
#   signing-identity defaults to ad-hoc ("-")
#   version, when set, becomes both appex bundle version fields
#
# The result at "<output-dir>/Carrier Share.appex" is ready to be copied into
# Carrier.app/Contents/PlugIns/ before the outer app is signed.
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:?output directory required}"
ARCH="${2:-$(uname -m)}"
IDENTITY="${3:--}"
VERSION="${4:-}"

# Match the app's minimum macOS (tauri.conf.json: 10.15); arm64 begins at 11.
case "$ARCH" in
  arm64) MIN_MACOS="11.0" ;;
  x86_64) MIN_MACOS="10.15" ;;
  *)
    echo "unsupported macOS architecture: $ARCH" >&2
    exit 1
    ;;
esac

APPEX="$OUT_DIR/Carrier Share.appex"
rm -rf "$APPEX"
mkdir -p "$APPEX/Contents/MacOS"

cp "$SCRIPT_DIR/Info.plist" "$APPEX/Contents/Info.plist"
if [ -n "$VERSION" ]; then
  case "$VERSION" in
    *[!0-9.]*)
      echo "invalid bundle version: $VERSION" >&2
      exit 1
      ;;
  esac
  if ! printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+(\.[0-9]+){2}$'; then
    echo "invalid bundle version: $VERSION" >&2
    exit 1
  fi
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" \
    "$APPEX/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" \
    "$APPEX/Contents/Info.plist"
fi

xcrun clang \
  -fobjc-arc \
  -fapplication-extension \
  -target "$ARCH-apple-macos$MIN_MACOS" \
  -framework Foundation \
  -framework AppKit \
  -framework CoreServices \
  -Wl,-e,_NSExtensionMain \
  -o "$APPEX/Contents/MacOS/Carrier Share" \
  "$SCRIPT_DIR/main.m"

# Nested code signs before the outer app does. Developer ID signatures require
# a trusted timestamp for notarization; ad-hoc development builds cannot use it.
if [ "$IDENTITY" = "-" ]; then
  TIMESTAMP_OPTION="--timestamp=none"
else
  TIMESTAMP_OPTION="--timestamp"
fi
codesign --force --options runtime "$TIMESTAMP_OPTION" \
  --entitlements "$SCRIPT_DIR/entitlements.plist" \
  --sign "$IDENTITY" \
  "$APPEX"

echo "built: $APPEX"
