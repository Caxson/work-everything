#!/usr/bin/env bash
# Live verification of the background path, against a throwaway probe app this script
# builds and launches itself.
#
# It touches nothing else. No message app, no browser, no window belonging to the person
# using the machine — the only target is WeAxProbe, which is compiled here, launched
# without activating, driven, and killed. That restriction is the reason this is a probe
# app and not "point it at Feishu": a mis-aimed click during a test of clicking is not a
# failed test, it is a message sent.
#
# The probe opens two windows with a button at the exact centre of each, so an activation
# primer that lands in the middle of a window is caught by the button's own press counter
# rather than by inspection.
#
#   scripts/live-probe.sh            evidence in $TMPDIR/we-ax-live-probe
#   OUT_DIR=/somewhere scripts/live-probe.sh
set -euo pipefail

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPTS/.." && pwd)"
OUT_DIR="${OUT_DIR:-${TMPDIR:-/tmp}/we-ax-live-probe}"
mkdir -p "$OUT_DIR"

BIN="$ROOT/.build/release/we-ax"
[ -x "$BIN" ] || { echo "missing $BIN — run: swift build -c release" >&2; exit 1; }

echo "==> building the probe into $OUT_DIR"
xcrun swiftc -swift-version 5 -O "$SCRIPTS/probe/launch.swift" -o "$OUT_DIR/launch" -framework AppKit
xcrun swiftc -swift-version 5 -O "$SCRIPTS/probe/WeAxProbe.swift" -o "$OUT_DIR/WeAxProbe" -framework AppKit

APP="$OUT_DIR/WeAxProbe.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$OUT_DIR/WeAxProbe" "$APP/Contents/MacOS/WeAxProbe"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>WeAxProbe</string>
  <key>CFBundleIdentifier</key><string>local.weax.probe</string>
  <key>CFBundleName</key><string>WeAxProbe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

echo "==> driving"
OUT_DIR="$OUT_DIR" exec /usr/bin/env python3 "$SCRIPTS/live-probe.py" "$BIN"
