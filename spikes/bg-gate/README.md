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

## Round two

`run-round2.sh` answers what the first round could not, in about ninety
seconds — because both earlier attempts were cut short by the screen locking
itself, one after seven minutes and one after fifteen. Typing the steps by hand
does not fit in that window; a script does.

It settles whether a `contenteditable` composer can be written through
accessibility at all, which decides whether Feishu's composer needs private
dispatch. The test page listens for `input` and `beforeinput` and reports what
it received: a changed read-back does not count as a write, only the events do.

It also measures where a CEF tree stops being available — occluded, minimised —
confirming occlusion by hit-testing the point before reading rather than
assuming a moved window covered anything, and whether activation contributes
anything to that tree at all.

A locked screen makes all of this unmeasurable, so the script exits rather than
pretend otherwise. Run it unlocked.
