#!/usr/bin/env bash
# 后台 computer use 可行性闸门 — 一键复跑
#
# 前置：① 屏幕未锁定（锁屏直接退出，绝不在无效状态下产出"通过"）② AX 已授权 ③ 已跑过 ./build.sh
# 安全：只操作本脚本自己启动的 BgProbeA/BgProbeB 与独立 profile 的 Chrome；
#      所有事件走 postToPid，不经过 .cghidEventTap，因此不动用户真实光标；
#      焦点抑制 tap 只装在自己的 ProbeA 上，绝不装到 loginwindow 或用户 app。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$ROOT/out"; LOGS="$ROOT/logs"; EV="$ROOT/evidence"
BG="$OUT/bgdrive"
mkdir -p "$LOGS" "$EV"

step() { printf '\n########## %s ##########\n' "$*"; }
# 从探针日志读它自报的 windowNumber / frameAX（带外通道，锁屏下 AX 失效时唯一可靠来源）
probe_win()   { grep -m1 "^.* launched " "$LOGS/$1.log" | sed -n "s/.*$2 win=\([0-9]*\).*/\1/p"; }
probe_frame() { grep -m1 "^.* launched " "$LOGS/$1.log" | sed -n "s/.*$2 win=[0-9]* frameAX=\([0-9,.-]*\).*/\1/p"; }

step "S-1 前置检查"
if "$OUT/sess" 2>/dev/null | grep -q "CGSSessionScreenIsLocked"; then
  echo "ABORT: 屏幕已锁定。锁屏下 AXPosition/AXSize 与 _AXUIElementGetWindow 全部失败，"
  echo "       拿不到 windowNumber，窗口寻址无从谈起（见 09 号报告 §0）。解锁后再跑。"
  exit 90
fi
[ -x "$BG" ] || { echo "ABORT: $BG 不存在，先跑 ./build.sh"; exit 91; }
echo "OK: 未锁屏"

step "S0 基线"
"$BG" env | tee "$EV/S0-baseline.json"

step "S1 启动一次性目标（activates=false，不抢前台）"
rm -f "$LOGS"/BgProbe*.log
"$BG" launch --path "$OUT/BgProbeA.app" --log-dir "$LOGS" > "$EV/S1-launchA.json"
"$BG" launch --path "$OUT/BgProbeB.app" --log-dir "$LOGS" > "$EV/S1-launchB.json"
PA=$(sed -n 's/.*"launchedPID" : \([0-9]*\).*/\1/p' "$EV/S1-launchA.json")
PB=$(sed -n 's/.*"launchedPID" : \([0-9]*\).*/\1/p' "$EV/S1-launchB.json")
sleep 1.5
W0=$(probe_win BgProbeB W0);  F0=$(probe_frame BgProbeB W0)
W1=$(probe_win BgProbeB W1);  F1=$(probe_frame BgProbeB W1)
AW0=$(probe_win BgProbeA W0); AF0=$(probe_frame BgProbeA W0)
echo "ProbeA pid=$PA  W0=$AW0 frame=$AF0"
echo "ProbeB pid=$PB  W0=$W0 frame=$F0 | W1=$W1 frame=$F1  (两窗口完全重叠, W1 在前)"

step "S1b【解锁后重点】AX 解析链 vs 探针自报窗口号"
"$BG" windows --pid "$PB" | tee "$EV/S1b-ax-resolution.json"
echo ">>> 核对：上面 axWindows 的 windowNumber 应能覆盖 {$W0, $W1}，resolvedBy 应为 axSPI 而非 fallbackLayer0"

step "S2 纯 postToPid 键盘（不激活）"
"$BG" act --pid "$PB" --force-window-number "$W0" --force-frame "$F0" --type "bg-probe-1" --label S2 > "$EV/S2-keyboard.json"
sleep 0.5; grep -E "field\[|STATE" "$LOGS/BgProbeB.log" | tail -2

step "S2c 键盘窗口寻址判别：寻址 W1(前窗口)，看是否真落到 W1"
"$BG" act --pid "$PB" --force-window-number "$W1" --force-frame "$F1" --type "KEYTOW1" --label S2c > "$EV/S2c-key-to-W1.json"
sleep 0.5; grep -E "field\[" "$LOGS/BgProbeB.log" | tail -1
echo ">>> 2026-08-30 实测：落到 W0 —— 51/58 对键盘无效"

step "S3a 判决实验：点击【被 W1 完全遮住】的后窗口 W0 的正中心按钮"
"$BG" act --pid "$PB" --force-window-number "$W0" --force-frame "$F0" --click 260,182 --label S3a > "$EV/S3a-click-behind.json"
sleep 0.8; grep -E "recv\[|buttonPressed" "$LOGS/BgProbeB.log" | tail -2

step "S3b-e 字段拆解：定位最小必需集"
for spec in "S3b:--no-window-fields" "S3c:--no-window-location" "S3d:--no-mouse-window-fields" \
            "S3e:--no-target-pid --no-mouse-window-fields --no-window-location"; do
  lbl="${spec%%:*}"; flags="${spec#*:}"
  # shellcheck disable=SC2086
  "$BG" act --pid "$PB" --force-window-number "$W0" --force-frame "$F0" --click 260,182 $flags --label "$lbl" > "$EV/$lbl.json"
  sleep 0.6
  echo "$lbl [$flags] -> $(grep -E 'buttonPressed' "$LOGS/BgProbeB.log" | tail -1)"
done
echo ">>> 2026-08-30 实测：只有 S3b(去 51/58) 命中失败，其余全部命中 —— 最小必需集 = 51+58"

step "S4a 后台激活（完整两步，center primer 会误触正中心按钮）"
"$BG" act --pid "$PB" --force-window-number "$W1" --force-frame "$F1" --activate --label S4a > "$EV/S4a-activate.json"
sleep 1; grep -E "note\[|buttonPressed|STATE" "$LOGS/BgProbeB.log" | tail -4

step "S4b 只发 appKitDefined primer（验证能否省掉 center primer）"
"$BG" act --pid "$PB" --force-window-number "$W0" --force-frame "$F0" --activate --no-center-primer --label S4b > "$EV/S4b-primer-only.json"
sleep 1; grep -E "STATE" "$LOGS/BgProbeB.log" | tail -1
echo ">>> 2026-08-30 实测：只给 app 级 isActive，拿不到窗口级 isKey/isMain"

step "S4c primer 改点窗口内空白区（零误触方案）"
"$BG" act --pid "$PB" --force-window-number "$W0" --force-frame "$F0" --activate --primer-point 450,250 --label S4c > "$EV/S4c-safe-primer.json"
sleep 1; grep -E "note\[|buttonPressed|STATE" "$LOGS/BgProbeB.log" | tail -3
echo ">>> 2026-08-30 实测：正常变 key/main，clicks 无变化 —— §9.5 缓解方向 1 成立"

step "S4d 激活后键盘能否落到指定窗口"
"$BG" act --pid "$PB" --force-window-number "$W1" --force-frame "$F1" --activate --primer-point 450,250 --type "AFTERACT" --label S4d > "$EV/S4d-activate-then-type.json"
sleep 1; grep -E "field\[" "$LOGS/BgProbeB.log" | tail -1

step "S7【解锁后重点】L3 焦点抑制：tap 装在自己的 ProbeA 上，同时向 ProbeA 投递输入"
"$BG" act --pid "$PB" --force-window-number "$W1" --force-frame "$F1" \
     --session --suppress-pid "$PA" --drop-types 13 --mask max \
     --activate --primer-point 450,250 \
     --also-pid "$PA" --also-window-number "$AW0" --also-frame "$AF0" \
     --also-type "userA-typing" --also-click 450,250 \
     --hold-ms 900 --restore --label S7 > "$EV/S7-suppression.json"
sleep 0.6
grep -A22 '"tapStats"' "$EV/S7-suppression.json"
echo "--- ProbeA 应完整收到 userA-typing（抑制不误伤）---"
grep -E "field\[" "$LOGS/BgProbeA.log" | tail -1
echo ">>> 解锁后重点看 dropped：若真实前台被 deactivate，previous tap 应出现被丢弃的 type 13"

step "S5 CEF：独立 profile 的 Chrome"
CHROME="/Applications/Google Chrome.app"
PC=""
if [ -d "$CHROME" ]; then
  PROF="$ROOT/chrome-profile"; rm -rf "$PROF"; mkdir -p "$PROF"
  "$BG" launch --path "$CHROME" --new-instance \
        --arg "--user-data-dir=$PROF" --arg "--no-first-run" --arg "--no-default-browser-check" \
        --arg "--window-size=900,600" \
        --arg 'data:text/html,<h1>bggate</h1><button id=b>ClickMe</button><input id=i>' \
        > "$EV/S5-launchChrome.json"
  PC=$(sed -n 's/.*"launchedPID" : \([0-9]*\).*/\1/p' "$EV/S5-launchChrome.json")
  echo "Chrome pid=$PC"; sleep 4
  "$BG" windows --pid "$PC" > "$EV/S5-chrome-windows.json"
  "$BG" axread --pid "$PC" > "$EV/S5-chrome-before.json"
  "$BG" axread --pid "$PC" --enable-ax --observer --wait-ms 800 --rescan > "$EV/S5-chrome-enableax.json"
  grep -E '"nodes"|"webAreas"|"AXManualAccessibility"|"AXEnhancedUserInterface"|"registered"|"usedRemoteSPI"' "$EV/S5-chrome-enableax.json"
  echo ">>> 解锁后重点：pass2 的 nodes 应远大于 pass1，且 webAreas > 0"
else
  echo "SKIP: 本机无 Google Chrome"
fi

step "清理"
[ -n "$PC" ] && kill "$PC" 2>/dev/null
kill "$PA" "$PB" 2>/dev/null
sleep 1.5
rm -rf "$ROOT/chrome-profile"
"$BG" env > "$EV/S8-final.json"
echo "基线 vs 收尾（frontmost / cursor 应完全一致）："
grep -E '"frontmost"|"cursor"' -A2 "$EV/S0-baseline.json" | head -6
grep -E '"frontmost"|"cursor"' -A2 "$EV/S8-final.json" | head -6
echo
echo "不变量汇总："
grep -h -E '"frontmostUnchanged"|"cursorDelta"' "$EV"/S2*.json "$EV"/S3*.json "$EV"/S4*.json "$EV"/S7*.json | sort | uniq -c
echo
echo "凭证目录: $EV"
echo "探针日志: $LOGS"
