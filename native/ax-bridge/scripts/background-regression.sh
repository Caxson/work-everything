#!/usr/bin/env bash
# Read-only regression for the background input path. Every request carries
# "dryRun": true, so the bridge builds the event, applies the addressing fields, reports
# exactly which ones took, and posts nothing. No application receives anything.
#
# Why a dry run is worth something here: the background path stands on two private field
# numbers, 51 and 58, and `CGEventField(rawValue:)` accepts any number at all — it returns
# non-nil for 40, 51, 58, 88, 91, 92, 99 and 200 alike. So "the field exists" proves
# nothing, and a plan that reports intent proves less. These plans are produced by the same
# code that would post, which is why they can be asserted at all. What they still cannot
# tell you is whether 51/58 *route* on this system; only a real target can, which is what
# scripts/live-probe.sh is for.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/.build/release/we-ax"
OUT_DIR="${OUT_DIR:-${TMPDIR:-/tmp}/we-ax-background}"
mkdir -p "$OUT_DIR"
[ -x "$BIN" ] || { echo "missing $BIN — run: swift build -c release" >&2; exit 1; }

PASS=0; FAIL=0
check() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf 'ok   %s\n' "$1"
  else FAIL=$((FAIL+1)); printf 'FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fi
}

# Any GUI pid works — nothing is posted to it, and the window number below is deliberately
# one that does not exist, so even a bug that ignored dryRun could not land anywhere.
PID=$(printf '{"id":1,"op":"apps"}\n' | "$BIN" | jq -r '.result[] | select(.name=="Finder") | .pid' | head -1)
[ -n "$PID" ] || PID=$(printf '{"id":1,"op":"apps"}\n' | "$BIN" | jq -r '.result[0].pid')
WIN=987654321
echo "dry-run pid=$PID window=$WIN (nothing is posted, this window does not exist)"

{
  printf '{"id":1,"op":"click","pid":%s,"windowNumber":%s,"x":100,"y":200,"dryRun":true}\n' "$PID" "$WIN"
  printf '{"id":2,"op":"click","pid":%s,"windowNumber":%s,"x":100,"y":200,"background":false,"dryRun":true}\n' "$PID" "$WIN"
  printf '{"id":3,"op":"click","x":100,"y":200,"dryRun":true}\n'
  printf '{"id":4,"op":"keystroke","pid":%s,"windowNumber":%s,"key":"a","dryRun":true}\n' "$PID" "$WIN"
  printf '{"id":5,"op":"keystroke","pid":%s,"windowNumber":%s,"key":"a","modifiers":["cmd"],"dryRun":true}\n' "$PID" "$WIN"
  printf '{"id":6,"op":"scroll","pid":%s,"windowNumber":%s,"x":10,"y":20,"deltaY":3,"dryRun":true}\n' "$PID" "$WIN"
  printf '{"id":7,"op":"scroll","pid":%s,"windowNumber":%s,"x":10,"y":20,"dryRun":true}\n' "$PID" "$WIN"
  printf '{"id":8,"op":"click","pid":%s,"windowNumber":%s,"x":1,"y":1,"dryRun":true,"fields":{"privateWindow":false,"mouseWindow":false}}\n' "$PID" "$WIN"
  printf '{"id":9,"op":"focusAndType","pid":%s,"windowNumber":%s,"nodeId":987654321,"text":"x","dryRun":true}\n' "$PID" "$WIN"
  printf '{"id":10,"op":"bgRelease","session":987654321}\n'
  printf '{"id":11,"op":"windowInfo","pid":%s}\n' "$PID"
  printf '{"id":12,"op":"awaitTree","pid":%s,"timeoutMs":1}\n' "$PID"
  printf '{"id":13,"op":"env"}\n'
  printf '{"id":99,"op":"shutdown"}\n'
} | "$BIN" > "$OUT_DIR/background.ndjson" 2> "$OUT_DIR/background.err"

q() { jq -r --argjson i "$1" "select(.id==\$i) | $2" "$OUT_DIR/background.ndjson"; }

# 1 — a window number alone selects the background route; there is no HID tap on it.
check "windowNumber implies background"    "background"     "$(q 1 '.result.plan.route')"
check "no HID tap in a background plan"    "true"           "$(q 1 '.result.plan | has("tap") | not')"
check "aimed with postToPid"               "postToPid($PID)" "$(q 1 '.result.plan.target')"

# 2 — the two fields the mouse path cannot do without.
check "field 51 set"                       "true"  "$(q 1 '.result.plan.addressing.fields["51"]')"
check "field 58 set"                       "true"  "$(q 1 '.result.plan.addressing.fields["58"]')"
check "fields 91/92 set for the mouse"     "true,true" "$(q 1 '[.result.plan.addressing.fields["91"],.result.plan.addressing.fields["92"]]|join(",")')"

# 3 — the caller can always force the old route back, and the old default is untouched.
check "background:false wins"              "foreground"     "$(q 2 '.result.plan.route')"
check "explicit foreground uses HID tap"   "cghidEventTap"  "$(q 2 '.result.plan.tap')"
check "no window number: still foreground" "cghidEventTap"  "$(q 3 '.result.plan.tap')"

# 4 — keys carry the fields but are honest that the fields do not steer them. Measured: a
#     key posted to a pid lands in that app's own key window whatever 51/58 say.
check "key plan is background"             "background" "$(q 4 '.result.plan.route')"
check "key plan sets 51/58"                "true,true"  "$(q 4 '[.result.plan.addressing.fields["51"],.result.plan.addressing.fields["58"]]|join(",")')"
check "key plan admits it cannot steer"    "false"      "$(q 4 '.result.plan.windowFieldsSteerKeys')"
check "background key uses the hid source" "hidSystemState" "$(q 4 '.result.plan.sourceState')"
check "background cmd+a ends on flags 0"   "0"          "$(q 5 '.result.plan.keyEvents[-1].flags')"
check "background cmd+a: 4 events"         "4"          "$(q 5 '.result.plan.keyEvents|length')"

# 5 — scroll takes the same route and refuses a no-op.
check "scroll plan is background"          "background" "$(q 6 '.result.plan.route')"
check "scroll sets 51/58"                  "true,true"  "$(q 6 '[.result.plan.addressing.fields["51"],.result.plan.addressing.fields["58"]]|join(",")')"
check "scroll with no delta is refused"    "BAD_REQUEST" "$(q 7 '.error.code')"

# 6 — the field switches exist so the teardown that established the minimum set is
#     reproducible. Turning 51/58 off must actually turn them off.
check "51/58 can be switched off"          "false,false" "$(q 8 '[.result.plan.addressing.fields["51"],.result.plan.addressing.fields["58"]]|join(",")')"
check "40 survives on its own"             "true"        "$(q 8 '.result.plan.addressing.fields["40"]')"

# 7 — errors, including the ones a caller must be able to tell apart.
check "unknown node is refused"            "NO_SUCH_NODE"    "$(q 9 '.error.code')"
check "unknown session is refused"         "NO_SUCH_SESSION" "$(q 10 '.error.code')"

# 8 — a window list that cannot be trusted is reported as such, never as an empty list.
#     Whichever of these three the machine is in right now, none of them may answer "ok
#     with no windows" and let a caller retry forever.
check "windowInfo always answers"             "true" "$(q 11 '.ok')"
check "windowInfo carries the desktop census" "true" "$(q 11 '.result.desktop | has("onScreenOwners")')"
check "windowInfo carries the SPI census"     "true" "$(q 11 '.result.spi | has("axGetWindow")')"
check "windowInfo carries a diagnosis"        "true" "$(q 11 '.result.diagnosis | has("code")')"
WI_CODE=$(q 11 '.result.diagnosis.code')
case "$WI_CODE" in
  OK|SCREEN_LOCKED|AX_SEES_NO_WINDOWS_BUT_CG_DOES|NO_WINDOW)
    check "diagnosis is one of the known states" "$WI_CODE" "$WI_CODE" ;;
  *) check "diagnosis is one of the known states" \
           "OK|SCREEN_LOCKED|AX_SEES_NO_WINDOWS_BUT_CG_DOES|NO_WINDOW" "$WI_CODE" ;;
esac
if [ "$WI_CODE" != "OK" ]; then
  check "a failing diagnosis explains itself"  "true" "$(q 11 '.result.diagnosis | has("message")')"
  check "and shows the AX window census"       "true" "$(q 11 '.result.diagnosis.details | has("axWindows") or has("cgWindows")')"
fi

# 9 — a tree that is not ready is an error with a census attached, never a stub returned
#     as if it were complete. A native app has no web area at all, which is the same shape
#     as a CEF app that has not woken up yet.
AT_OK=$(q 12 '.ok')
if [ "$AT_OK" = "false" ]; then
  check "awaitTree fails loudly"           "TREE_NOT_READY" "$(q 12 '.error.code')"
  check "and says what it did see"         "true"           "$(q 12 '.error.details | has("nodes") and has("webAreas")')"
else
  check "awaitTree only passes on a web area" "true" "$(q 12 '.result.webAreas > 0')"
fi

check "env reports the private symbols"    "true" "$(q 13 '.result.spi | has("setWindowLocation")')"
check "env reports the screen state"       "true" "$(q 13 '.result.screen | has("locked")')"

# 10 — an empty window list must never come back unexplained. Three states produce one,
#      two of them cannot be recovered from by retrying, and an empty array reads the same
#      in all three. The bare form throws; the meta form carries the classification.
{
  printf '{"id":20,"op":"windows","pid":%s}\n' "$PID"
  printf '{"id":21,"op":"windows","pid":%s,"meta":true}\n' "$PID"
  printf '{"id":99,"op":"shutdown"}\n'
} | "$BIN" > "$OUT_DIR/windows.ndjson" 2>> "$OUT_DIR/background.err"
w() { jq -r --argjson i "$1" "select(.id==\$i) | $2" "$OUT_DIR/windows.ndjson"; }

BARE_OK=$(w 20 '.ok')
BARE_LEN=$(w 20 'if .ok then (.result|length) else -1 end')
if [ "$BARE_OK" = "true" ]; then
  check "a non-empty window list is returned" "true" "$([ "$BARE_LEN" -gt 0 ] && echo true || echo false)"
  check "windows carry their window number"   "true" "$(w 20 '.result[0] | has("windowNumber")')"
  check "windows say how they were resolved"  "true" "$(w 20 '.result[0] | has("resolvedBy")')"
  check "meta form agrees"                    "OK"   "$(w 21 '.result.diagnosis.code')"
else
  CODE=$(w 20 '.error.code')
  case "$CODE" in
    SCREEN_LOCKED|AX_SEES_NO_WINDOWS_BUT_CG_DOES|NO_WINDOW)
      check "empty list is thrown as a classified error" "$CODE" "$CODE" ;;
    *) check "empty list is thrown as a classified error" \
             "SCREEN_LOCKED|AX_SEES_NO_WINDOWS_BUT_CG_DOES|NO_WINDOW" "$CODE" ;;
  esac
  check "meta form carries the same diagnosis" "$CODE" "$(w 21 '.result.diagnosis.code')"
  check "meta form still answers ok"           "true" "$(w 21 '.ok')"
  check "and the diagnosis explains itself"    "true" "$(w 21 '.result.diagnosis | has("message")')"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
