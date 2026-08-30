# Research

Findings that decide how this project's execution layer is built. Each report
is the write-up of work done against this machine, not a literature summary.

| | |
|---|---|
| [07-bg-computeruse-spec.md](07-bg-computeruse-spec.md) | Implementation spec derived from reading [kwwk-computer-use-core](https://github.com/EYHN/kwwk-computer-use-core) (MIT). Background input dispatch, background window activation, focus suppression. Corrects several claims in the article that inspired it — source wins over prose. |
| [08-codex-computeruse.md](08-codex-computeruse.md) | What OpenAI actually ships. Symbol-level inspection of the signed Codex bundle on this machine: **no SkyLight, no `CGEventPost`, no IOHID, no private entitlements** — only public `AXUIElement*` and ScreenCaptureKit. Its background reach comes from AX semantic actions, not synthetic event injection. Also: the 11-method action space, verbatim, and a four-tier confirmation policy. |
| [09-bg-gate-result.md](09-bg-gate-result.md) | The feasibility gate, measured on macOS 26.3 / arm64. **Passed.** |

## What the gate settled

A probe app opened two exactly overlapping windows and the **occluded** one was
addressed and clicked: it registered the click, the window covering it did not,
and the app was never activated. Twelve actions ran with the frontmost
application unchanged and the real cursor moved by zero pixels.

So the thing this project needs is real: **an agent can drive an app while the
person keeps using the computer.**

Field-by-field teardown narrowed the private surface to **two field numbers,
51 and 58**. `CGEventSetWindowLocation` (a SkyLight symbol), 40 and 91/92 all
turned out to be unnecessary for the case measured — but 51/58 have no
fallback at all: without them the event does not go to the wrong window, it
disappears.

## The constraint that matters most

**A locked screen takes window addressing away entirely.** `AXPosition`,
`AXSize` and `_AXUIElementGetWindow` fail for every app while the Mac is
locked; the event channel itself keeps working, and `CGWindowList` still
answers. This lands directly on the premise that the computer can be left
alone to work — a locked screen is exactly when that is supposed to happen.
Unresolved, and tracked in `docs/TODO.md`.

Three things stayed unmeasured for the same reason (the machine locked itself
mid-run): the AX parsing chain, whether focus suppression is needed at all,
and whether a CEF app exposes its tree once activated. Re-run unlocked with
`spikes/bg-gate/run-gate.sh`; it refuses to run locked rather than report a
false pass.
