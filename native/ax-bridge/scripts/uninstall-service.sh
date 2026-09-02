#!/usr/bin/env bash
# Removes the launchd agent installed by install-service.sh.
#
# Stops the job, removes the plist and the socket, and leaves two things alone on purpose:
# the logs in ~/Library/Logs/work-everything, because they are the record of whatever went
# wrong, and the Accessibility entry in System Settings, because only a person can remove
# that and removing it is usually not what somebody reinstalling wants.
set -euo pipefail

LABEL="com.work-everything.ax-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PREFIX="${WE_AX_PREFIX:-$HOME/.work-everything/bin}"
BINARY="$PREFIX/we-ax"
DOMAIN="gui/$(id -u)"

SOCKET="${WE_AX_SOCKET:-}"
if [ -z "$SOCKET" ] && [ -x "$BINARY" ]; then SOCKET="$("$BINARY" --socket-path)"; fi

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
[ -n "$SOCKET" ] && rm -f "$SOCKET"

printf '%s\n' "removed job $LABEL and $PLIST"
[ -n "$SOCKET" ] && printf '%s\n' "removed socket $SOCKET"
printf '%s\n' "kept:    $BINARY (delete it yourself if you want the Accessibility entry to go stale)"
printf '%s\n' "kept:    $HOME/Library/Logs/work-everything"
printf '%s\n' ""
printf '%s\n' "The daemon will fall back to spawning its own helper once axBridge.socketPath is"
printf '%s\n' "removed from the config — with the responsible-process problem that comes back with it."
