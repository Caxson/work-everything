#!/usr/bin/env bash
# 构建后台驱动闸门 probe：bgdrive（驱动）+ BgProbeA/B.app（一次性目标 app）
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$ROOT/out"
mkdir -p "$OUT"

echo "==> building bgdrive"
xcrun swiftc -swift-version 5 -O \
  "$ROOT/driver/SPI.swift" \
  "$ROOT/driver/WindowResolve.swift" \
  "$ROOT/driver/Dispatch.swift" \
  "$ROOT/driver/Session.swift" \
  "$ROOT/driver/main.swift" \
  -o "$OUT/bgdrive" \
  -framework AppKit -framework ApplicationServices

echo "==> building probe executable"
xcrun swiftc -swift-version 5 -O "$ROOT/probe/main.swift" -o "$OUT/BgProbe" -framework AppKit

for key in A B; do
  name="BgProbe${key}"
  app="$OUT/${name}.app"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS"
  cp "$OUT/BgProbe" "$app/Contents/MacOS/$name"
  chmod +x "$app/Contents/MacOS/$name"
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n'
    printf '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    printf '<plist version="1.0"><dict>\n'
    printf '  <key>CFBundleExecutable</key><string>%s</string>\n' "$name"
    printf '  <key>CFBundleIdentifier</key><string>local.bggate.%s</string>\n' "$(echo "$key" | tr 'A-Z' 'a-z')"
    printf '  <key>CFBundleName</key><string>%s</string>\n' "$name"
    printf '  <key>CFBundleDisplayName</key><string>%s</string>\n' "$name"
    printf '  <key>CFBundlePackageType</key><string>APPL</string>\n'
    printf '  <key>CFBundleVersion</key><string>1</string>\n'
    printf '  <key>CFBundleShortVersionString</key><string>1.0</string>\n'
    printf '  <key>LSMinimumSystemVersion</key><string>14.0</string>\n'
    printf '  <key>NSHighResolutionCapable</key><true/>\n'
    printf '</dict></plist>\n'
  } > "$app/Contents/Info.plist"
  echo "    built $app"
done
echo "==> ok"
