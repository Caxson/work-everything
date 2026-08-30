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

## Public AX and private dispatch are not an either/or

Codex reaches background windows through public accessibility APIs alone, and
its coordinate clicks turn out to be `AXUIElementCopyElementAtPosition` — a
hit-test to an element, then an action on it, never a synthetic event. That is
the better default: nothing private, nothing that a system update can quietly
take away.

It is not sufficient on its own, and the reason is the lock. Measured on this
machine: **while the screen is locked, public AX collapses** — window elements
come back as the application element itself, hit-testing fails outright, and
the tree is reduced to a menu bar — **while private dispatch keeps landing its
clicks.** The private path is weakest exactly where it is least needed, and
strongest where nothing else works.

So: public AX as the default path, private dispatch kept for the gaps it alone
covers — free-form dragging (AX has no drag action), custom-drawn elements that
expose no action, and clicking into a CEF app that refuses
`AXManualAccessibility`. That narrows the private surface to two field numbers,
detectable by behaviour, with a whole-path fallback when they stop working.

That missing piece has since been measured, and it favours the public path.
With the screen unlocked, Feishu — a CEF app, not frontmost, never activated —
exposes its window and both web areas on a plain read: the conversation list,
the open chat, and a complete parse of the chat on screen. Being refused
`AXManualAccessibility` turns out not to matter, which contradicts the spec's
claim that asserting those two attributes is a prerequisite; the measurement
wins. The earlier reading of a tree that was nothing but menu items was the
lock, not the app.

Acting on it may not either. `AXPress` on a `<button onclick>` inside a
background Chrome page ran the page's own JavaScript — the heading changed —
while the frontmost application stayed exactly where the user left it and the
cursor did not move a pixel. Public accessibility reaches into web content, not
just native controls.

Two things about CEF trees are worth writing into any implementation. The tree
is built by the *first traversal itself*: a first read returned 38 nodes and no
web area, an immediate second read returned 44 and one, with nothing done in
between. And that waking is counted per accessibility client and decays — a
separate process's first traversal saw 311 nodes, all menu bar. So discarding
the first result and reading again is not one-time setup; every new process
pays it, and a fixed sleep is not enough. Poll until a web area appears.

Asserting `AXManualAccessibility` and `AXEnhancedUserInterface` is not part of
this. Both are refused on 26.3 and the tree is there regardless.

What is still unmeasured: whether the tree survives the window being fully
occluded, minimised, or closed to the tray — and, the one that decides the
shape of the executor, whether text can be written into a `contenteditable`
composer through accessibility at all. Feishu's is almost certainly one, and
`AXValue` is typically not settable on them.

## The constraint that matters most

**A locked screen takes window addressing away entirely.** The mechanism is
specific: `AXWindows` still returns the right *count*, but every entry is the
application element itself — `CFEqual(item, appElement)` holds for each one.
That single substitution explains everything downstream: titles equal to the
app name, `AXPosition` and `AXSize` failing, `_AXUIElementGetWindow` failing,
and a walk from a "window" arriving in the menu bar. The event channel itself
keeps working, and `CGWindowList` still answers. This lands directly on the premise that the computer can be left
alone to work — a locked screen is exactly when that is supposed to happen.
Unresolved, and tracked in `docs/TODO.md`.

Three things stayed unmeasured for the same reason (the machine locked itself
mid-run): the AX parsing chain, whether focus suppression is needed at all,
and whether a CEF app exposes its tree once activated. Re-run unlocked with
`spikes/bg-gate/run-gate.sh`; it refuses to run locked rather than report a
false pass.
