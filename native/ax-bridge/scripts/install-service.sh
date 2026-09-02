#!/usr/bin/env bash
# Installs we-ax as a launchd user agent that owns its own Accessibility grant.
#
# The problem this solves: macOS attributes an Accessibility grant to the *responsible
# process*, which for a spawned helper is whatever launched it — not the helper. So the same
# binary reads `trusted: true` when a terminal spawns it and `trusted: false` when an agent
# does, and granting the binary in System Settings changes neither, because the grant being
# consulted was never its own. Under launchd the binary is responsible for itself: it is
# granted once, by hand, and every client that connects to its socket borrows that grant.
#
# What this does NOT do is grant anything. TCC cannot be given programmatically by design;
# the one-time step at the end is a person clicking a checkbox, and there is no way around
# it. Everything else — where the binary lives, where the socket lives, keeping it running —
# is what this script removes from the loop.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.work-everything.ax-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/work-everything"

# Where the running copy lives. Deliberately not .build/release: that directory is wiped by
# `swift build --clean`, and a launchd job whose program has vanished fails on every restart.
PREFIX="${WE_AX_PREFIX:-$HOME/.work-everything/bin}"
BINARY="$PREFIX/we-ax"
SOURCE="${1:-$ROOT/.build/release/we-ax}"

say() { printf '%s\n' "$*"; }

# --- build if needed -------------------------------------------------------------------
if [ ! -x "$SOURCE" ]; then
  say "building $SOURCE"
  (cd "$ROOT" && swift build -c release)
fi
[ -x "$SOURCE" ] || { say "no we-ax binary at $SOURCE" >&2; exit 1; }

SOCKET="${WE_AX_SOCKET:-$("$SOURCE" --socket-path)}"

# --- install ---------------------------------------------------------------------------
mkdir -p "$PREFIX" "$LOG_DIR" "$(dirname "$SOCKET")" "$HOME/Library/LaunchAgents"
chmod 700 "$(dirname "$SOCKET")"

# Replacing the file in place would rewrite the bytes of a running program. Install beside
# it and rename, which is atomic and leaves the old inode to the process still using it.
cp "$SOURCE" "$BINARY.new"
chmod 755 "$BINARY.new"
mv -f "$BINARY.new" "$BINARY"

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$(xml_escape "$BINARY")</string>
		<string>--serve</string>
		<string>$(xml_escape "$SOCKET")</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>5</integer>
	<!-- Interactive keeps App Nap and the timer coalescer off it. A bridge that is being
	     throttled answers late, and late is indistinguishable from wedged to a caller
	     holding a request timeout. -->
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>StandardOutPath</key>
	<string>$(xml_escape "$LOG_DIR/we-ax.out.log")</string>
	<key>StandardErrorPath</key>
	<string>$(xml_escape "$LOG_DIR/we-ax.err.log")</string>
</dict>
</plist>
PLIST_EOF

# --- (re)start -------------------------------------------------------------------------
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true

# `bootout` returns before launchd has finished unloading the job, and bootstrapping a label
# that is still registered fails with `Bootstrap failed: 5: Input/output error` — which reads
# like a disk fault and is a race. Wait for the label to actually be gone, then retry anyway.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
  sleep 0.3
done

BOOTSTRAPPED=no
for _ in 1 2 3 4 5; do
  if launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then BOOTSTRAPPED=yes; break; fi
  sleep 0.5
done
[ "$BOOTSTRAPPED" = yes ] || { launchctl bootstrap "$DOMAIN" "$PLIST"; }

launchctl enable "$DOMAIN/$LABEL"
launchctl kickstart -k "$DOMAIN/$LABEL"

# --- report ----------------------------------------------------------------------------
say ""
say "installed:"
say "  binary  $BINARY"
say "  plist   $PLIST"
say "  socket  $SOCKET"
say "  logs    $LOG_DIR/we-ax.{out,err}.log"

# The socket file existing is not the same as somebody serving it — a restart unlinks the
# old one and binds a new one, and the window between those is exactly when this runs. So
# the probe is a connection attempt, retried, rather than a stat.
TRUSTED="unknown"
if command -v nc >/dev/null 2>&1; then
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    REPLY_LINE="$(printf '{"id":1,"op":"trusted"}\n' | nc -U "$SOCKET" 2>/dev/null | head -1 || true)"
    case "$REPLY_LINE" in
      *'"trusted":true'*) TRUSTED="yes"; break ;;
      *'"trusted":false'*) TRUSTED="no"; break ;;
    esac
    sleep 0.3
  done
fi
say "  trusted $TRUSTED"
say ""

if [ "$TRUSTED" = "yes" ]; then
  say "The service is running and already holds the Accessibility grant. Point the daemon at"
  say "it with:"
  say ""
  say "    \"axBridge\": { \"socketPath\": \"$SOCKET\" }"
  say ""
  exit 0
fi

cat <<GRANT_EOF
ONE-TIME AUTHORIZATION — this is the part no script can do for you.

macOS will not hand out an Accessibility grant programmatically, and it will not accept one
on this binary's behalf from anything else. Grant it by hand, once:

  1. Open System Settings > Privacy & Security > Accessibility.
  2. Click +, press Cmd+Shift+G, and paste this path:

         $BINARY

     (The Finder dialog hides dot-directories; Cmd+Shift+G is how you reach one.)
  3. Turn its switch ON. If "we-ax" is already listed but off, turn it on; if it is listed
     from an older build, remove it with - first and add it again.
  4. Restart the service so it picks the grant up:

         launchctl kickstart -k gui/$(id -u)/$LABEL

  5. Check it took:

         printf '{"id":1,"op":"trusted"}\n' | nc -U "$SOCKET"

Then point the daemon at the socket instead of letting it spawn its own helper:

    "axBridge": { "socketPath": "$SOCKET" }

Two things worth knowing before you are surprised by them:

  * The grant is keyed to this binary at this path. Reinstalling a **rebuilt** we-ax changes
    its code signature, and macOS may show it as still enabled while refusing it. If
    trusted goes false after a rebuild, remove the entry with - and add it again.
  * Nothing else needs granting after this. The point of the service is that callers stop
    needing a grant of their own — they connect to the socket and use this one.
GRANT_EOF
