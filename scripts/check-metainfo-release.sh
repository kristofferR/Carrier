#!/usr/bin/env bash
# Fail unless the AppStream metainfo's newest <release> is the app version (or
# the version given), so Linux software centers always show current release
# notes. Usage: scripts/check-metainfo-release.sh [version]
set -euo pipefail

cd "$(dirname "$0")/.."
metainfo=src-tauri/linux/app.chatpane.Chatpane.metainfo.xml
version=${1:-$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml | head -n 1)}
newest=$(grep -o '<release version="[^"]*"' "$metainfo" | head -n 1 | cut -d '"' -f 2)

if [ "$newest" != "$version" ]; then
  echo "::error file=$metainfo::The newest metainfo <release> is ${newest:-missing}, not $version. Add <release version=\"$version\" date=\"YYYY-MM-DD\"> with a short summary of the release notes at the top of <releases>."
  exit 1
fi
echo "Metainfo lists release $version."
