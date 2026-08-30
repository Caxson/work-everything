# Background computer-use gate

Answers one question with a measurement: on this macOS, can an agent operate a
window that is not frontmost, without stealing focus or moving the cursor?

    ./build.sh && ./run-gate.sh

`run-gate.sh` checks for a locked screen first and exits rather than produce a
pass it cannot back up — window addressing does not work while the Mac is
locked, and a run that silently skips that is worse than no run.

Targets are the probe app in `probe/`, launched by the harness itself. Nothing
here touches an application the user is running: a chat client or an editor
holding real work is not a test fixture, and an event that misses its target
lands in someone's document.

Results and the reasoning behind each step: [`research/09-bg-gate-result.md`](../../research/09-bg-gate-result.md).
