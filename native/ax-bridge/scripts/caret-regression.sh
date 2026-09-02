#!/usr/bin/env bash
# Live proof that the composer caret fix does what it claims, against a probe this script
# builds, launches, drives and kills.
#
# It touches nothing else — no message app, no browser, no window belonging to the person
# using the machine. `probe/CaretProbe.swift` reproduces the one measured behaviour that
# matters: the first time its field stops being empty it puts the insertion point back at 0,
# exactly as Feishu's contenteditable does when its placeholder disappears.
#
# The test is an A/B on the same element in the same run. `caretRecovery: false` types the
# way the bridge did before, and must reproduce the scramble; the default must not. Without
# both halves, "it works now" is a claim about a string somebody read once.
#
#   scripts/caret-regression.sh
#   OUT_DIR=/somewhere scripts/caret-regression.sh
set -uo pipefail

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPTS/.." && pwd)"
BIN="$ROOT/.build/release/we-ax"
OUT_DIR="${OUT_DIR:-${TMPDIR:-/tmp}/we-ax-caret}"
SAMPLE="we ping"
mkdir -p "$OUT_DIR"
[ -x "$BIN" ] || { echo "missing $BIN — run: swift build -c release" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "caret-regression needs node" >&2; exit 1; }

echo "==> building the probe into $OUT_DIR"
xcrun swiftc -swift-version 5 -O "$SCRIPTS/probe/launch.swift" -o "$OUT_DIR/launch" -framework AppKit
xcrun swiftc -swift-version 5 -O "$SCRIPTS/probe/CaretProbe.swift" -o "$OUT_DIR/CaretProbe" -framework AppKit

APP="$OUT_DIR/CaretProbe.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$OUT_DIR/CaretProbe" "$APP/Contents/MacOS/CaretProbe"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>CaretProbe</string>
  <key>CFBundleIdentifier</key><string>local.weax.caretprobe</string>
  <key>CFBundleName</key><string>CaretProbe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

rm -f "$OUT_DIR/CaretProbe.log"
CARET_LOG="$OUT_DIR/CaretProbe.log" "$OUT_DIR/launch" "$APP" > "$OUT_DIR/launch.out" 2>&1
PROBE_PID="$(sed -n 's/^pid=//p' "$OUT_DIR/launch.out" | head -1)"
[ -n "$PROBE_PID" ] || { echo "probe did not launch:" >&2; cat "$OUT_DIR/launch.out" >&2; exit 1; }
trap 'kill -9 "$PROBE_PID" 2>/dev/null; exit' EXIT
sleep 2

cat > "$OUT_DIR/drive.mjs" <<'DRIVER_EOF'
import { spawn } from 'node:child_process';
const [bin, sample] = process.argv.slice(2);
const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
const pending = new Map();
let nextId = 1;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  const parts = buffer.split('\n');
  buffer = parts.pop() ?? '';
  for (const line of parts) if (line.trim()) { const m = JSON.parse(line); pending.get(m.id)?.(m); pending.delete(m.id); }
});
const call = (op, params = {}) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ id, op, ...params }) + '\n');
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const out = {};
const probe = (await call('apps')).result?.find((a) => a.name === 'CaretProbe');
if (probe === undefined) { console.log(JSON.stringify({ error: 'CaretProbe is not running' })); process.exit(0); }
const windows = await call('windows', { pid: probe.pid, meta: true });
const windowNumber = windows.result?.windows?.[0]?.windowNumber;
const found = await call('find', { pid: probe.pid, selector: { identifier: 'caret-probe-field' } });
const nodeId = found.result?.[0]?.nodeId;
if (nodeId === undefined || windowNumber === undefined) {
  console.log(JSON.stringify({ error: found.error?.code ?? windows.error?.code ?? 'no probe field' }));
  process.exit(0);
}

const value = async () => (await call('attr', { nodeId, name: 'AXValue' })).result;
const clear = async () => { await call('setValue', { nodeId, value: '' }); await wait(150); };
const type = async (caretRecovery) => {
  await clear();
  const reply = await call('focusAndType', { pid: probe.pid, windowNumber, nodeId, text: sample, activate: true, caretRecovery });
  await wait(300);
  return { text: await value(), caret: reply.result?.typed?.caret, error: reply.error?.code };
};

// The decision has to be visible without typing anything.
await clear();
out.dryEmpty = (await call('focusAndType', { pid: probe.pid, windowNumber, nodeId, text: sample, dryRun: true })).result?.plan?.caret;
await call('setValue', { nodeId, value: 'already here' });
await wait(150);
out.dryNonEmpty = (await call('focusAndType', { pid: probe.pid, windowNumber, nodeId, text: sample, dryRun: true })).result?.plan?.caret;
out.dryOff = (await call('focusAndType', { pid: probe.pid, windowNumber, nodeId, text: sample, dryRun: true, caretRecovery: false })).result?.plan?.caret;

out.without = await type(false);
out.with = await type(true);

// A single character has nothing after it to scramble, so it must not pay for the move.
await clear();
const one = await call('focusAndType', { pid: probe.pid, windowNumber, nodeId, text: 'z', activate: false });
await wait(250);
out.single = { text: await value(), caret: one.result?.typed?.caret };

// Grapheme clusters have to survive the boundary too.
await clear();
await call('focusAndType', { pid: probe.pid, windowNumber, nodeId, text: '中文 abc', activate: false });
await wait(400);
out.unicode = await value();

await clear();
await call('shutdown');
console.log(JSON.stringify(out));
process.exit(0);
DRIVER_EOF

node "$OUT_DIR/drive.mjs" "$BIN" "$SAMPLE" > "$OUT_DIR/caret.json" 2> "$OUT_DIR/drive.err"
[ -s "$OUT_DIR/caret.json" ] || { echo "driver produced nothing:" >&2; cat "$OUT_DIR/drive.err" >&2; exit 1; }

PASS=0; FAIL=0
check() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf 'ok   %s\n' "$1"
  else FAIL=$((FAIL+1)); printf 'FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fi
}
q() { jq -r "$1" "$OUT_DIR/caret.json"; }

ERR="$(q '.error // empty')"
[ -z "$ERR" ] || { echo "could not reach the probe: $ERR" >&2; exit 1; }

# 1 — the plan says what will happen, before anything is typed.
check "empty composer plans the move"    "caretToEnd" "$(q '.dryEmpty.recovery')"
check "and says it watches the first"    "true"       "$(q '.dryEmpty.watchesFirstCharacter')"
check "and that it verifies the caret"   "true"       "$(q '.dryEmpty.verifiesCaret')"
check "mechanisms are end then cmd+right" "end,cmdRight" "$(q '[.dryEmpty.mechanisms[].name]|join(",")')"
check "with their keycodes"              "119,124"    "$(q '[.dryEmpty.mechanisms[].keyCode]|join(",")')"
check "a composer with text plans none"  "none"       "$(q '.dryNonEmpty.recovery')"
check "and caretRecovery:false too"      "none"       "$(q '.dryOff.recovery')"

# 2 — the A/B. Without the fix the probe must produce the measured scramble; with it, the
#     text. If the first of these ever passes, the probe stopped reproducing the bug and
#     the second proves nothing.
check "without the fix: scrambled"       "e pingw"    "$(q '.without.text')"
check "with the fix: the text"           "we ping"    "$(q '.with.text')"
check "and the caret move is verified"   "true"       "$(q '.with.caret.caretMove.verified')"
check "after trying end first"           "end"        "$(q '.with.caret.attempted[0] // .with.caret.caretMove.attempted[0]')"
check "the first character was watched"  "true"       "$(q '.with.caret.firstCharacter.landed')"

# 3 — the boundaries the recovery must stay out of.
check "one character skips the move"     "none"       "$(q '.single.caret.recovery')"
check "and still lands"                  "z"          "$(q '.single.text')"
check "grapheme clusters survive"        "中文 abc"    "$(q '.unicode')"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
