#!/usr/bin/env bash
# 第二轮：contenteditable 写入 → L3 抑制必要性 → 私有路径解锁态不变量 → CEF 边界 ②③④
# 一次跑完约 2 分钟。外层 caffeinate 防止中途被自动锁屏打断（不改用户任何系统设置）。
#
# 安全：只操作本脚本自己启动的 BgProbeA/B 与独立 profile 的 Chrome。
#      绝不碰用户的飞书/微信/钉钉/他自己的 Chrome/Ghostty/Obsidian/TextEdit 或任何真实文档窗口。
#      L3 的抑制 tap 只装在自己的 ProbeA 上，绝不装到用户前台 app 或 loginwindow。
set -uo pipefail

# 自我包一层 caffeinate -w $$：只在本脚本存活期间阻止休眠/锁屏，退出即失效
if [ "${BGGATE_CAFFEINATED:-0}" != "1" ]; then
  export BGGATE_CAFFEINATED=1
  caffeinate -dimsu -w $$ &
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$ROOT/out"; LOGS="$ROOT/logs"; EV="$ROOT/evidence/r2"
BG="$OUT/bgdrive"; AX="$OUT/axact"; JG="$OUT/jget.py"
mkdir -p "$LOGS" "$EV"

say()  { printf '\n=== %s ===\n' "$*"; }
note() { printf '    %s\n' "$*"; }
# JSON 取值一律走 python：sed 的范围匹配会被嵌套对象的 } 截断（实测踩过这个坑）
jget() { python3 "$JG" "$1" "$2"; }
inv()  { note "不变量: frontmostUnchanged=$(jget "$1" frontmostUnchanged) cursorDelta=$(jget "$1" cursorDelta)"; }
cefread() { "$BG" axread --pid "$1" --window-index 0 --wait-ms 700 --rescan > "$2"; note "$3 -> $(jget "$2" __cef)"; }
# 页面自己把状态写进 document.title，从窗口标题只读回显，不需要截图
pagestate() { "$BG" windows --pid "$PC" > "$EV/_t.json"; jget "$EV/_t.json" title; }

say "S-1 前置检查"
if "$OUT/sess" 2>/dev/null | grep -q "CGSSessionScreenIsLocked"; then
  echo "ABORT(90): 屏幕已锁定。锁屏下 AXWindows 会被 app 元素顶替，本轮全部实验无效。"
  echo "           注意：caffeinate 只能阻止锁屏，解不开已经锁上的屏——需要 caosen 本人解锁。"
  exit 90
fi
[ -x "$BG" ] && [ -x "$AX" ] || { echo "ABORT(91): 先跑 ./build.sh"; exit 91; }
"$BG" env > "$EV/S0-baseline.json"
BASE_FRONT=$(jget "$EV/S0-baseline.json" frontmost)
note "解锁 OK，真实前台 = $BASE_FRONT；caffeinate 已挂在本进程上"

say "S1 启动独立 profile Chrome（先启动 → z 序在探针之下）"
PROF="$ROOT/chrome-profile"; rm -rf "$PROF"; mkdir -p "$PROF"
"$BG" launch --path "/Applications/Google Chrome.app" --new-instance \
     --arg "--user-data-dir=$PROF" --arg "--no-first-run" --arg "--no-default-browser-check" \
     --arg "--window-size=900,700" --arg "file://$ROOT/testpage.html" > "$EV/S1-launchChrome.json"
PC=$(jget "$EV/S1-launchChrome.json" launchedPID)
sleep 5
"$BG" windows --pid "$PC" > "$EV/S1-chrome-windows.json"
CFRAME=$(jget "$EV/S1-chrome-windows.json" __frame)
note "Chrome pid=$PC window=$(jget "$EV/S1-chrome-windows.json" windowNumber) frameAX=$CFRAME resolvedBy=$(jget "$EV/S1-chrome-windows.json" resolvedBy)"
note "启动后前台=$(jget "$EV/S1-launchChrome.json" frontmost)（应仍是 $BASE_FRONT）"
cefread "$PC" "$EV/S1-cef-tree.json" "首次树"

say "S2【最高优先级】contenteditable 写入 —— 逐一试遍所有手段"
"$AX" find --pid "$PC" > "$EV/S2-elements.json"
note "role 分布: $(grep -oE '"role" : "AX[A-Za-z]+"' "$EV/S2-elements.json" | sort | uniq -c | tr '\n' ' ')"
note "aria-label 可见的 desc: $(grep -oE '"desc" : "[^"]+"' "$EV/S2-elements.json" | sort -u | tr '\n' ' ')"

note "--- S2.0 元素诊断（它到底支持什么写入手段）---"
"$AX" probe --pid "$PC" --desc "rich editor" > "$EV/S2-0-probe.json"
if [ "$(jget "$EV/S2-0-probe.json" error)" = "NOT_FOUND" ]; then
  note "按 aria-label 没找到，回退按 role 找。可见 roles: $(jget "$EV/S2-0-probe.json" rolesSeen)"
  SEL=(--role AXTextArea --nth 0)
  "$AX" probe --pid "$PC" "${SEL[@]}" > "$EV/S2-0-probe.json"
else
  SEL=(--desc "rich editor")
fi
note "role=$(jget "$EV/S2-0-probe.json" role) subrole=$(jget "$EV/S2-0-probe.json" subrole) roleDesc=$(jget "$EV/S2-0-probe.json" roleDescription)"
note "actions=$(jget "$EV/S2-0-probe.json" actions)"
note "settable=$(jget "$EV/S2-0-probe.json" settable)"
note "页面初始: $(pagestate)"

trywrite() {  # $1=label $2=outfile ; 其余=axact 参数
  local label="$1"; local of="$2"; shift 2
  "$AX" "$@" --pid "$PC" "${SEL[@]}" > "$of" 2>&1
  note "$label -> settable=$(jget "$of" settable)$(jget "$of" valueSettable) result=$(jget "$of" result)"
  note "    页面: $(pagestate)"
}

trywrite "S2.1 SetAttributeValue(AXValue)"        "$EV/S2-1-axvalue.json"   setattr --attr AXValue --value "V1-axvalue"
trywrite "S2.2 SetAttributeValue(AXFocused=true)" "$EV/S2-2-axfocused.json" setattr --attr AXFocused --value true
trywrite "S2.3 SetAttributeValue(AXSelectedTextRange 0,0)" "$EV/S2-3-range.json" setattr --attr AXSelectedTextRange --range 0,0
trywrite "S2.4 SetAttributeValue(AXSelectedText)" "$EV/S2-4-seltext.json"  setattr --attr AXSelectedText --value "V2-selectedtext"
trywrite "S2.5 PerformAction(AXPress)"            "$EV/S2-5-press.json"    press --action AXPress
trywrite "S2.6 PerformAction(AXConfirm)"          "$EV/S2-6-confirm.json"  press --action AXConfirm

note "--- S2.7 混合路线：AXPress 聚焦 + postToPid 键盘 ---"
"$AX" press --pid "$PC" "${SEL[@]}" --action AXPress > "$EV/S2-7a-focus.json"
CWIN=$(jget "$EV/S1-chrome-windows.json" windowNumber)
"$BG" act --pid "$PC" --force-window-number "$CWIN" --force-frame "$CFRAME" \
     --type "V3-keyboard" --label r2-hybrid > "$EV/S2-7b-type.json"
inv "$EV/S2-7b-type.json"
note "    页面: $(pagestate)"

note "--- S2.8 对照：普通 <input> 的 AXValue 可写性 ---"
"$AX" setvalue --pid "$PC" --role AXTextField --nth 1 --value "PLAIN-INPUT-OK" > "$EV/S2-8-input.json"
note "settable=$(jget "$EV/S2-8-input.json" valueSettable) result=$(jget "$EV/S2-8-input.json" result) readBack=$(jget "$EV/S2-8-input.json" readBack)"
note "    页面: $(pagestate)"

note ">>> 判据：页面 EVENTS 里出现 beforeinput/input 才算真写入；只有 CE_TEXT 变了而无事件 = 受控组件会漏状态"

say "S3 启动双窗口探针"
rm -f "$LOGS"/BgProbe*.log
"$BG" launch --path "$OUT/BgProbeA.app" --log-dir "$LOGS" > "$EV/S3-launchA.json"
"$BG" launch --path "$OUT/BgProbeB.app" --log-dir "$LOGS" > "$EV/S3-launchB.json"
PA=$(jget "$EV/S3-launchA.json" launchedPID); PB=$(jget "$EV/S3-launchB.json" launchedPID)
sleep 1.5
pwin() { grep -m1 " launched " "$LOGS/$1.log" | sed -n "s/.*$2 win=\([0-9]*\).*/\1/p"; }
pfrm() { grep -m1 " launched " "$LOGS/$1.log" | sed -n "s/.*$2 win=[0-9]* frameAX=\([0-9,.-]*\).*/\1/p"; }
PBW0=$(pwin BgProbeB W0); PBF0=$(pfrm BgProbeB W0)
PAW0=$(pwin BgProbeA W0); PAF0=$(pfrm BgProbeA W0)
note "ProbeA pid=$PA W0=$PAW0 | ProbeB pid=$PB W0=$PBW0"
"$BG" windows --pid "$PB" > "$EV/S3-ax-resolution.json"
note "AX 解析链 resolvedBy=$(jget "$EV/S3-ax-resolution.json" resolvedBy)（期望 axSPI）"

say "S4【L3 arm1】不装 tap 时，L2 激活会不会抢走真实前台"
"$BG" act --pid "$PB" --force-window-number "$PBW0" --force-frame "$PBF0" \
     --activate --primer-point 450,250 --hold-ms 600 --label r2-L3-notap > "$EV/S4-L3-notap.json"
inv "$EV/S4-L3-notap.json"
note "探针自报: $(grep -E 'STATE' "$LOGS/BgProbeB.log" | tail -1)"
note ">>> frontmostUnchanged=true 即：激活本身不抢前台，L3 抑制层整层可能不需要"

say "S5【L3 arm2】装 tap（只装自己的 ProbeA）+ 抑制期输入不误伤"
"$BG" act --pid "$PB" --force-window-number "$PBW0" --force-frame "$PBF0" \
     --session --suppress-pid "$PA" --drop-types 13 --mask max \
     --activate --primer-point 450,250 \
     --also-pid "$PA" --also-window-number "$PAW0" --also-frame "$PAF0" \
     --also-type "userA-typing" --hold-ms 900 --restore --label r2-L3-tap > "$EV/S5-L3-tap.json"
note "tapStats: $(jget "$EV/S5-L3-tap.json" tapStats)"
inv "$EV/S5-L3-tap.json"
note "ProbeA 应完整收到 userA-typing: $(grep -E 'field\[' "$LOGS/BgProbeA.log" | tail -1)"

say "S6 私有 postToPid 解锁态不变量（真实前台下的后台点击/键盘）"
"$BG" act --pid "$PB" --force-window-number "$PBW0" --force-frame "$PBF0" \
     --click 260,182 --type "r2-unlocked" --label r2-private > "$EV/S6-private.json"
inv "$EV/S6-private.json"
note "探针自报: $(grep -E 'STATE' "$LOGS/BgProbeB.log" | tail -1)"

say "S7【CEF ④】L2 激活对出树有无增量"
cefread "$PC" "$EV/S7-cef-before.json" "before-activate"
"$BG" act --pid "$PC" --window-index 0 --activate --primer-point 12,600 --hold-ms 400 \
     --label r2-cef-activate > "$EV/S7-activate.json"
inv "$EV/S7-activate.json"
cefread "$PC" "$EV/S7-cef-after.json" "after-activate"
note ">>> 两行相同 ⇒ L2 激活对 CEF 出树零贡献"

say "S8【CEF ②】被完全遮挡"
CX=$(echo "$CFRAME" | cut -d, -f1); CY=$(echo "$CFRAME" | cut -d, -f2)
CW=$(echo "$CFRAME" | cut -d, -f3);  CH=$(echo "$CFRAME" | cut -d, -f4)
"$AX" setwin --pid "$PB" --window-index 0 --position "$CX,$CY" --size "$CW,$CH" > "$EV/S8-cover.json"
MIDX=$(awk -v a="$CX" -v b="$CW" 'BEGIN{printf "%d", a+b/2}')
MIDY=$(awk -v a="$CY" -v b="$CH" 'BEGIN{printf "%d", a+b/2}')
"$AX" hittest --x "$MIDX" --y "$MIDY" > "$EV/S8-hittest.json"
note "hittest($MIDX,$MIDY) -> pid=$(jget "$EV/S8-hittest.json" pid) role=$(jget "$EV/S8-hittest.json" role) [期望 pid=$PB 才算真遮住]"
cefread "$PC" "$EV/S8-cef-occluded.json" "occluded"

say "S9【CEF ③】最小化"
"$AX" setwin --pid "$PC" --window-index 0 --minimized true > "$EV/S9-minimize.json"
note "nowMinimized=$(jget "$EV/S9-minimize.json" nowMinimized) setResult=$(jget "$EV/S9-minimize.json" setMinimized)"
sleep 1
cefread "$PC" "$EV/S9-cef-minimized.json" "minimized"
"$AX" setwin --pid "$PC" --window-index 0 --minimized false > "$EV/S9-restore.json"
sleep 1.5
cefread "$PC" "$EV/S9-cef-restored.json" "restored"

say "S10 清理"
[ -n "${PC:-}" ] && kill "$PC" 2>/dev/null
kill "$PA" "$PB" 2>/dev/null
sleep 1.5
rm -rf "$PROF" "$EV/_t.json"
"$BG" env > "$EV/S10-final.json"
note "基线前台=$BASE_FRONT  收尾前台=$(jget "$EV/S10-final.json" frontmost)"
note "残留进程=$(pgrep -f 'BgProbe|chrome-profile' | wc -l | tr -d ' ')"
if "$OUT/sess" 2>/dev/null | grep -q "CGSSessionScreenIsLocked"; then
  echo "警告：跑完时屏幕已锁定，靠后的步骤可能无效——按凭证时间戳对照锁屏时刻。"
fi
echo
echo "凭证目录: $EV"
