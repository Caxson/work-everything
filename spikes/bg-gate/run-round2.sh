#!/usr/bin/env bash
# 第二轮：CEF 边界 ①②③④ + L3 抑制必要性 + contenteditable 可写性 + 私有路径解锁态不变量
# 设计目标：解锁窗口很短（前两轮只有 7 分钟和 15 分钟），全部实验一次跑完、约 90 秒。
#
# 安全：只操作本脚本自己启动的 BgProbeA/B 与独立 profile 的 Chrome。
#      绝不碰用户的飞书/微信/钉钉/Ghostty/Obsidian/TextEdit 或任何真实文档窗口。
#      L3 的抑制 tap 只装在自己的 ProbeA 上，绝不装到用户前台 app 或 loginwindow。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$ROOT/out"; LOGS="$ROOT/logs"; EV="$ROOT/evidence/r2"
BG="$OUT/bgdrive"; AX="$OUT/axact"; JG="$OUT/jget.py"
mkdir -p "$LOGS" "$EV"

say()  { printf '\n=== %s ===\n' "$*"; }
note() { printf '    %s\n' "$*"; }
# JSON 取值一律走 python：sed 的范围匹配会被嵌套对象的 } 截断（实测踩过这个坑）
jget() { python3 "$JG" "$1" "$2"; }
inv()  { note "不变量: frontmostUnchanged=$(jget "$1" frontmostUnchanged) cursorDelta=$(jget "$1" cursorDelta)"; }
# CEF 树读数：--rescan 走"丢弃首次重抓"
cefread() {  # $1=pid $2=outfile $3=label
  "$BG" axread --pid "$1" --window-index 0 --wait-ms 700 --rescan > "$2"
  note "$3 -> $(jget "$2" __cef)"
}

say "S-1 前置检查"
if "$OUT/sess" 2>/dev/null | grep -q "CGSSessionScreenIsLocked"; then
  echo "ABORT(90): 屏幕已锁定。锁屏下 AXWindows 会被 app 元素顶替，本轮全部实验无效。"
  exit 90
fi
[ -x "$BG" ] && [ -x "$AX" ] || { echo "ABORT(91): 先跑 ./build.sh"; exit 91; }
"$BG" env > "$EV/S0-baseline.json"
BASE_FRONT=$(jget "$EV/S0-baseline.json" frontmost)
note "解锁 OK，真实前台 = $BASE_FRONT"

say "S1 启动独立 profile Chrome（先启动 → z 序在探针之下）"
PROF="$ROOT/chrome-profile"; rm -rf "$PROF"; mkdir -p "$PROF"
"$BG" launch --path "/Applications/Google Chrome.app" --new-instance \
     --arg "--user-data-dir=$PROF" --arg "--no-first-run" --arg "--no-default-browser-check" \
     --arg "--window-size=900,600" --arg "file://$ROOT/testpage.html" > "$EV/S1-launchChrome.json"
PC=$(jget "$EV/S1-launchChrome.json" launchedPID)
note "Chrome pid=$PC"
sleep 5
"$BG" windows --pid "$PC" > "$EV/S1-chrome-windows.json"
CFRAME=$(jget "$EV/S1-chrome-windows.json" __frame)
note "Chrome window=$(jget "$EV/S1-chrome-windows.json" windowNumber) frameAX=$CFRAME resolvedBy=$(jget "$EV/S1-chrome-windows.json" resolvedBy)"
note "当前前台=$(jget "$EV/S1-launchChrome.json" frontmost)（应仍是 $BASE_FRONT）"

say "S2【CEF ①】后台 + 未被遮挡"
cefread "$PC" "$EV/S2-cef-unobstructed.json" "unobstructed"

say "S3【CEF ④】激活前后增量"
cefread "$PC" "$EV/S3-cef-before.json" "before-activate"
"$BG" act --pid "$PC" --window-index 0 --activate --primer-point 12,340 --hold-ms 400 \
     --label r2-cef-activate > "$EV/S3-activate.json"
inv "$EV/S3-activate.json"
cefread "$PC" "$EV/S3-cef-after.json" "after-activate"
note ">>> 若两行 nodes/webAreas 相同，说明 L2 激活对 CEF 出树零贡献"

say "S4 启动双窗口探针（后启动 → z 序在 Chrome 之上，用于构造遮挡）"
rm -f "$LOGS"/BgProbe*.log
"$BG" launch --path "$OUT/BgProbeA.app" --log-dir "$LOGS" > "$EV/S4-launchA.json"
"$BG" launch --path "$OUT/BgProbeB.app" --log-dir "$LOGS" > "$EV/S4-launchB.json"
PA=$(jget "$EV/S4-launchA.json" launchedPID); PB=$(jget "$EV/S4-launchB.json" launchedPID)
sleep 1.5
pwin()  { grep -m1 " launched " "$LOGS/$1.log" | sed -n "s/.*$2 win=\([0-9]*\).*/\1/p"; }
pfrm()  { grep -m1 " launched " "$LOGS/$1.log" | sed -n "s/.*$2 win=[0-9]* frameAX=\([0-9,.-]*\).*/\1/p"; }
PBW0=$(pwin BgProbeB W0); PBF0=$(pfrm BgProbeB W0)
PAW0=$(pwin BgProbeA W0); PAF0=$(pfrm BgProbeA W0)
note "ProbeA pid=$PA W0=$PAW0 frame=$PAF0 | ProbeB pid=$PB W0=$PBW0 frame=$PBF0"

say "S5【AX 解析链】"
"$BG" windows --pid "$PB" > "$EV/S5-ax-resolution.json"
note "resolvedBy=$(jget "$EV/S5-ax-resolution.json" resolvedBy)（期望 axSPI）title=$(jget "$EV/S5-ax-resolution.json" title)"

say "S6【CEF ②】被完全遮挡"
CX=$(echo "$CFRAME" | cut -d, -f1); CY=$(echo "$CFRAME" | cut -d, -f2)
CW=$(echo "$CFRAME" | cut -d, -f3);  CH=$(echo "$CFRAME" | cut -d, -f4)
# 把 ProbeB 的 W0 挪到与 Chrome 窗口完全重合。探针后启动天然在上层，不用 AXRaise（避免抢焦点）
"$AX" setwin --pid "$PB" --window-index 0 --position "$CX,$CY" --size "$CW,$CH" > "$EV/S6-cover.json"
note "遮挡窗口 nowFrame=$(jget "$EV/S6-cover.json" nowFrame)"
# 用公共 AX 命中测试确认谁在上层：返回 pid 应为 ProbeB 才算真遮住
MIDX=$(awk -v a="$CX" -v b="$CW" 'BEGIN{printf "%d", a+b/2}')
MIDY=$(awk -v a="$CY" -v b="$CH" 'BEGIN{printf "%d", a+b/2}')
"$AX" hittest --x "$MIDX" --y "$MIDY" > "$EV/S6-hittest.json"
note "hittest($MIDX,$MIDY) -> pid=$(jget "$EV/S6-hittest.json" pid) role=$(jget "$EV/S6-hittest.json" role)  [期望 pid=$PB 才算遮住]"
cefread "$PC" "$EV/S6-cef-occluded.json" "occluded"

say "S7【CEF ③】最小化"
"$AX" setwin --pid "$PC" --window-index 0 --minimized true > "$EV/S7-minimize.json"
note "nowMinimized=$(jget "$EV/S7-minimize.json" nowMinimized) setResult=$(jget "$EV/S7-minimize.json" setMinimized)"
sleep 1
cefread "$PC" "$EV/S7-cef-minimized.json" "minimized"
"$AX" setwin --pid "$PC" --window-index 0 --minimized false > "$EV/S7-restore.json"
sleep 1.5
cefread "$PC" "$EV/S7-cef-restored.json" "restored"

say "S8【contenteditable 可写性】公共 AX 能否写飞书类富文本输入框"
"$AX" find --pid "$PC" > "$EV/S8-elements.json"
note "web 相关 role 分布："
grep -oE '"role" : "AX(WebArea|TextArea|TextField|Button|Heading|StaticText)"' "$EV/S8-elements.json" \
  | sort | uniq -c | sed 's/^/      /'
"$AX" setvalue --pid "$PC" --role AXTextArea --nth 0 --value "hello-contenteditable" > "$EV/S8-ce.json"
note "contenteditable: settable=$(jget "$EV/S8-ce.json" valueSettable) result=$(jget "$EV/S8-ce.json" result) readBack=$(jget "$EV/S8-ce.json" readBack)"
"$AX" setvalue --pid "$PC" --role AXTextField --nth 1 --value "hello-plain-input" > "$EV/S8-input.json"
note "plain <input>: settable=$(jget "$EV/S8-input.json" valueSettable) result=$(jget "$EV/S8-input.json" result) readBack=$(jget "$EV/S8-input.json" readBack)"
"$AX" press --pid "$PC" --title ClickMe > "$EV/S8-press.json"
note "AXPress(ClickMe): $(jget "$EV/S8-press.json" result)"
inv "$EV/S8-press.json"
"$AX" find --pid "$PC" > "$EV/S8-after.json"
note "页面自报 ce 事件: $(grep -o 'ce-events: [a-z,]*' "$EV/S8-after.json" | head -1)  [有 input/beforeinput 才算真写入]"
note "h1 现在: $(grep -o '"text" : "CLICKED"' "$EV/S8-after.json" | head -1)  [出现即 AXPress 触发了真实 JS]"

say "S9【L3 arm1】不装 tap 时，激活会不会抢走真实前台"
"$BG" act --pid "$PB" --force-window-number "$PBW0" --force-frame "$PBF0" \
     --activate --primer-point 450,250 --hold-ms 600 --label r2-L3-notap > "$EV/S9-L3-notap.json"
inv "$EV/S9-L3-notap.json"
note "激活后前台=$(jget "$EV/S9-L3-notap.json" after | python3 -c 'import json,sys;print(json.load(sys.stdin)["frontmost"])' 2>/dev/null)"
note "探针自报: $(grep -E 'STATE' "$LOGS/BgProbeB.log" | tail -1)"
note ">>> frontmostUnchanged=true 即：激活本身不抢前台，L3 抑制层可能整层不需要"

say "S10【L3 arm2】装 tap（只装自己的 ProbeA）+ 抑制期输入不误伤"
"$BG" act --pid "$PB" --force-window-number "$PBW0" --force-frame "$PBF0" \
     --session --suppress-pid "$PA" --drop-types 13 --mask max \
     --activate --primer-point 450,250 \
     --also-pid "$PA" --also-window-number "$PAW0" --also-frame "$PAF0" \
     --also-type "userA-typing" --hold-ms 900 --restore --label r2-L3-tap > "$EV/S10-L3-tap.json"
note "tapStats: $(jget "$EV/S10-L3-tap.json" tapStats)"
inv "$EV/S10-L3-tap.json"
note "ProbeA 应完整收到 userA-typing: $(grep -E 'field\[' "$LOGS/BgProbeA.log" | tail -1)"

say "S11【私有路径解锁态不变量】真实前台下的后台点击/键盘"
"$BG" act --pid "$PB" --force-window-number "$PBW0" --force-frame "$PBF0" \
     --click 260,182 --type "r2-unlocked" --label r2-private > "$EV/S11-private.json"
inv "$EV/S11-private.json"
note "探针自报: $(grep -E 'STATE' "$LOGS/BgProbeB.log" | tail -1)"

say "S12 清理"
[ -n "${PC:-}" ] && kill "$PC" 2>/dev/null
kill "$PA" "$PB" 2>/dev/null
sleep 1.5
rm -rf "$PROF"
"$BG" env > "$EV/S12-final.json"
note "基线前台=$BASE_FRONT  收尾前台=$(jget "$EV/S12-final.json" frontmost)"
note "残留进程=$(pgrep -f 'BgProbe|chrome-profile' | wc -l | tr -d ' ')"
echo
echo "凭证目录: $EV"
