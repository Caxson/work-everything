#!/usr/bin/env bash
# Read-only regression for synthetic input. Asserts the *event plans* produced by
# `keystroke` and `click` without posting a single event to any application:
# every request below carries "dryRun": true, so the bridge builds and reports the
# plan and stops there.
#
# Why this exists: the two input bugs that cost the most time in the spike were
# invisible in the code and destructive in production — a HID-tap key event that never
# reaches the CEF renderer, and a Cmd flag that is masked onto a key event but never
# released, so the next plain `w` arrives as Cmd+W and closes the window. Both are
# properties of the event plan, so both can be caught without touching a real app.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/.build/release/we-ax"
OUT_DIR="${OUT_DIR:-${TMPDIR:-/tmp}/we-ax-regression}"
mkdir -p "$OUT_DIR"
[ -x "$BIN" ] || { echo "missing $BIN — run: swift build -c release" >&2; exit 1; }

PASS=0; FAIL=0
check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf 'ok   %s\n' "$1"
  else FAIL=$((FAIL+1)); printf 'FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fi
}

# Any GUI pid works — nothing is ever posted to it.
PID=$(printf '{"id":1,"op":"apps"}\n' | "$BIN" \
  | jq -r '.result[] | select(.name=="Finder") | .pid' | head -1)
[ -n "$PID" ] || PID=$(printf '{"id":1,"op":"apps"}\n' | "$BIN" | jq -r '.result[0].pid')
echo "dry-run pid=$PID (no events are posted)"

{
  printf '{"id":1,"op":"keystroke","pid":%s,"key":"a","dryRun":true}\n' "$PID"
  printf '{"id":2,"op":"keystroke","pid":%s,"key":"a","modifiers":["cmd"],"dryRun":true}\n' "$PID"
  printf '{"id":3,"op":"keystroke","pid":%s,"key":"W","dryRun":true}\n' "$PID"
  printf '{"id":4,"op":"keystroke","pid":%s,"key":"return","modifiers":["cmd","shift"],"dryRun":true}\n' "$PID"
  printf '{"id":5,"op":"keystroke","pid":%s,"key":"中","dryRun":true}\n' "$PID"
  printf '{"id":6,"op":"keystroke","pid":%s,"key":"中","modifiers":["cmd"],"dryRun":true}\n' "$PID"
  printf '{"id":7,"op":"click","x":100,"y":200,"dryRun":true}\n'
  printf '{"id":8,"op":"click","x":100,"y":200,"clickCount":9,"dryRun":true}\n'
  printf '{"id":9,"op":"click","dryRun":true}\n'
  printf '{"id":99,"op":"shutdown"}\n'
} | "$BIN" > "$OUT_DIR/input.ndjson" 2> "$OUT_DIR/input.err"

q() { jq -r --argjson i "$1" "select(.id==\$i) | $2" "$OUT_DIR/input.ndjson"; }

# 1 — keyboard must target the pid, never the HID tap (spike #1).
check "keystroke targets postToPid"        "postToPid($PID)" "$(q 1 '.result.plan.target')"
check "keystroke uses a private source"    "private"         "$(q 1 '.result.plan.sourceState')"

# 2 — an unmodified keystroke carries an explicit zero flag mask, never inherited state.
check "plain key: 2 events"                "2"   "$(q 1 '.result.plan.events|length')"
check "plain key: all flags 0"             "0"   "$(q 1 '[.result.plan.events[].flags]|unique|@csv' | tr -d '"')"

# 3 — modifiers are pressed AND released; the plan ends on flags 0 (spike #2).
check "cmd+a: 4 events"                    "4"   "$(q 2 '.result.plan.events|length')"
check "cmd+a: kinds"                       "flagsChanged,keyDown,keyUp,flagsChanged" \
                                           "$(q 2 '[.result.plan.events[].kind]|join(",")')"
check "cmd+a: cmd held during key"         "0x100000,0x100000,0x100000" \
                                           "$(q 2 '[.result.plan.events[0:3][].flagsHex]|join(",")')"
check "cmd+a: ENDS ON FLAGS 0"             "0"   "$(q 2 '.result.plan.events[-1].flags')"
check "cmd+a: releases the cmd keycode"    "55"  "$(q 2 '.result.plan.events[-1].keyCode')"

# 4 — uppercase is Shift+key, released the same way.
check "uppercase W: keycode is w (13)"     "13"  "$(q 3 '.result.plan.events[1].keyCode')"
check "uppercase W: shift then released"   "0x20000,0"  \
                                           "$(q 3 '[.result.plan.events[1].flagsHex,(.result.plan.events[-1].flags|tostring)]|join(",")')"

# 5 — multiple modifiers unwind in reverse and still land on 0.
check "cmd+shift+return: 6 events"         "6"   "$(q 4 '.result.plan.events|length')"
check "cmd+shift+return: ends on flags 0"  "0"   "$(q 4 '.result.plan.events[-1].flags')"
check "cmd+shift+return: peak flags"       "0x120000" "$(q 4 '.result.plan.events[2].flagsHex')"

# 6 — non-US characters go out as unicode, with no flags and no silent modifier drop.
check "unicode key: mode"                  "unicode" "$(q 5 '.result.plan.mode')"
check "unicode key: flags 0"               "0"       "$(q 5 '[.result.plan.events[].flags]|unique|@csv' | tr -d '"')"
check "unicode + modifier is refused"      "BAD_REQUEST" "$(q 6 '.error.code')"

# 7 — mouse is the mirror image: it must go to the global HID tap (spike #1).
check "click targets the HID tap"          "cghidEventTap" "$(q 7 '.result.plan.tap')"
check "click flags 0"                      "0"             "$(q 7 '.result.plan.flags')"
check "click rejects clickCount 9"         "BAD_REQUEST"   "$(q 8 '.error.code')"
check "click needs a target"               "BAD_REQUEST"   "$(q 9 '.error.code')"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
