#!/usr/bin/env bash
# we-ax smoke test — READ ONLY. Never sends setValue / press / keystroke to the target.
#
#   scripts/smoke.sh [target-app-name-regex]
#
# Default target is Feishu / Lark. Raw responses land in $OUT_DIR as NDJSON.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/.build/release/we-ax"
OUT_DIR="${OUT_DIR:-${TMPDIR:-/tmp}/we-ax-smoke}"
TARGET="${1:-Feishu|Lark|飞书}"

mkdir -p "$OUT_DIR"
[ -x "$BIN" ] || { echo "missing $BIN — run: swift build -c release" >&2; exit 1; }
say() { printf '\n=== %s ===\n' "$1"; }

# ---------- phase 1: trust + app inventory ----------
say "phase 1: trusted / apps"
printf '%s\n' '{"id":1,"op":"trusted"}' '{"id":2,"op":"apps"}' \
  | "$BIN" > "$OUT_DIR/phase1.ndjson" 2> "$OUT_DIR/phase1.err"

jq -c 'select(.id==1) | .result' "$OUT_DIR/phase1.ndjson"
TRUSTED=$(jq -r 'select(.id==1) | .result.trusted' "$OUT_DIR/phase1.ndjson")
echo "trusted=$TRUSTED  gui_apps=$(jq -r 'select(.id==2)|.result|length' "$OUT_DIR/phase1.ndjson")"
[ "$TRUSTED" = "true" ] || echo "WARNING: not trusted — every AX op below will return NOT_TRUSTED" >&2

PID=$(jq -r --arg re "$TARGET" \
  'select(.id==2) | .result[] | select((.name|test($re;"i")) and .activationPolicy=="regular") | .pid' \
  "$OUT_DIR/phase1.ndjson" | head -1)
[ -n "$PID" ] || { echo "no GUI app matching /$TARGET/ is running" >&2; exit 2; }
echo "target pid=$PID"

# ---------- phase 2: read-only inspection ----------
say "phase 2: enableAX / windows / tree / find"
{
  printf '{"id":10,"op":"enableAX","pid":%s}\n' "$PID"
  printf '{"id":11,"op":"windows","pid":%s}\n' "$PID"
  # As specified by the protocol doc — shallow, catches the app chrome only.
  printf '{"id":12,"op":"tree","pid":%s,"maxDepth":8,"maxNodes":2000,"meta":true}\n' "$PID"
  # Electron reality: web content starts around depth 10, so a deep pass is the useful one.
  printf '{"id":13,"op":"tree","pid":%s,"windowIndex":0,"maxDepth":40,"maxNodes":20000,"meta":true}\n' "$PID"
  printf '{"id":14,"op":"find","pid":%s,"selector":{"role":"AXTextArea","maxResults":20},"maxDepth":60,"maxNodes":50000,"meta":true}\n' "$PID"
  printf '{"id":15,"op":"find","pid":%s,"selector":{"role":"AXWebArea","maxResults":10},"maxDepth":60,"maxNodes":50000,"meta":true}\n' "$PID"
  printf '{"id":99,"op":"shutdown"}\n'
} | "$BIN" > "$OUT_DIR/phase2.ndjson" 2> "$OUT_DIR/phase2.err"

jq -c 'select(.id==10) | .result' "$OUT_DIR/phase2.ndjson"
WINDOWS=$(jq -r 'select(.id==11)|.result|length' "$OUT_DIR/phase2.ndjson")
echo "windows=$WINDOWS"
jq -c 'select(.id==11) | .result[] | {index,role,subrole,title,frame}' "$OUT_DIR/phase2.ndjson"
[ "$WINDOWS" = "0" ] && echo "WARNING: no AX windows — the app has no VISIBLE window (tray/hidden). Only the menu bar is reachable." >&2

for pass in 12 13; do
  say "tree (id=$pass)"
  jq -c --argjson i "$pass" 'select(.id==$i) | {ok, nodeCount:.result.nodeCount, truncated:.result.truncated, elapsedMs:.result.elapsedMs, error:.error}' "$OUT_DIR/phase2.ndjson"
  jq -r --argjson i "$pass" 'select(.id==$i) | .result.nodes' "$OUT_DIR/phase2.ndjson" > "$OUT_DIR/tree-$pass.json"
  jq -r '[..|objects|select(has("role")).role]|group_by(.)|map({r:.[0],n:length})|sort_by(-.n)|.[:10]|.[]|"\(.n)\t\(.r)"' \
    "$OUT_DIR/tree-$pass.json" 2>/dev/null
done

say "find AXTextArea"
jq -c 'select(.id==14) | {ok, n:(.result.nodes|length), visited:.result.visited, elapsedMs:.result.elapsedMs, error:.error}' "$OUT_DIR/phase2.ndjson"
jq -c 'select(.id==14) | .result.nodes[] | {nodeId,depth,title,identifier,value,frame}' "$OUT_DIR/phase2.ndjson"

say "find AXWebArea"
jq -c 'select(.id==15) | {ok, n:(.result.nodes|length), visited:.result.visited, elapsedMs:.result.elapsedMs}' "$OUT_DIR/phase2.ndjson"
jq -c 'select(.id==15) | .result.nodes[] | {nodeId,depth,title,frame}' "$OUT_DIR/phase2.ndjson"

say "artifacts in $OUT_DIR"
ls -1 "$OUT_DIR"
