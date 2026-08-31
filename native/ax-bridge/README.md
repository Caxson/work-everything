# we-ax — macOS Accessibility bridge (stdio NDJSON)

A deliberately thin Swift executable that exposes the macOS Accessibility (AX) API over
stdin/stdout as newline-delimited JSON. It is the native half of the TypeScript daemon:
the daemon owns all policy, `we-ax` owns nothing but AX calls.

## Build

```bash
swift build -c release        # requires Xcode 15+/Swift 5.9+, macOS 13+
./.build/release/we-ax        # reads NDJSON on stdin, writes NDJSON on stdout
```

Four checks. The first three touch nothing — they read, or they build event plans and
stop. The fourth posts real events, and only ever at a throwaway probe application it
compiles and launches itself:

```bash
OUT_DIR=/tmp/we-ax scripts/smoke.sh                   # AX inspection; defaults to Feishu / Lark
OUT_DIR=/tmp/we-ax scripts/smoke.sh "Safari"
OUT_DIR=/tmp/we-ax scripts/input-regression.sh        # foreground event plans, 21 assertions
OUT_DIR=/tmp/we-ax scripts/background-regression.sh   # background event plans, 37 assertions
OUT_DIR=/tmp/we-ax scripts/live-probe.sh              # end to end against its own probe app
```

`live-probe.sh` is the only one that posts anything. It never points at a message app, a
browser, or any window belonging to the person using the machine: it builds `WeAxProbe`,
opens two windows with a button at the exact centre of each, drives them, and kills it. The
centred button is the test — an activation primer that lands in the middle of a window is
caught by the button's own press counter rather than by inspection. It reports what it
could not check rather than passing it, which matters because two of the states below take
accessibility away entirely.

## Protocol

One JSON object per line, both directions. `stderr` carries diagnostics only — never
protocol traffic.

```jsonc
// request
{"id": 1, "op": "tree", "pid": 65800, "maxDepth": 40}
// success
{"id": 1, "ok": true, "result": [ /* ... */ ]}
// failure
{"id": 1, "ok": false, "error": {"code": "NO_SUCH_PID", "message": "..."}}
// unsolicited event (observers)
{"event": "ax", "subscription": 1, "notification": "AXValueChanged", "nodeId": 42, "pid": 65800}
```

A malformed line answers with `id: -1` and `BAD_REQUEST` rather than crashing or going silent.

### Error codes

| code | meaning |
| --- | --- |
| `NOT_TRUSTED` | the process has no Accessibility permission (see below) |
| `NO_SUCH_PID` | no running application with that pid |
| `NO_SUCH_NODE` | unknown `nodeId` — handles are per-process and die with the bridge |
| `NO_SUCH_SUBSCRIPTION` | unknown `subscription` |
| `AX_ERROR(<n>)` | the AX API failed; `<n>` is the raw `AXError` value, name in `message` |
| `BAD_REQUEST` | missing/ill-typed parameter, unknown op, malformed JSON |
| `NO_FRAME` | the element exposes no usable `AXPosition`/`AXSize` to click |
| `CG_ERROR` / `INTERNAL` | CGEvent construction failure / unexpected Swift error |

`AX_ERROR` is parameterized — the numeric `AXError` is part of the code, so a
client switching on codes must match the prefix rather than the whole string.

### Operations

| op | params | result |
| --- | --- | --- |
| `trusted` | `prompt?: bool` | `{trusted, executable}` — `prompt:true` uses `AXIsProcessTrustedWithOptions` and raises the system dialog |
| `apps` | — | `[{pid, name, bundleId, activationPolicy}]`, GUI apps only |
| `enableAX` | `pid` | `{manualAccessibility:{ok,axError,name}, enhancedUserInterface:{...}}` |
| `windows` | `pid` | `[{index, nodeId, role, subrole, title, frame}]` |
| `tree` | `pid`, `maxDepth?`(12), `maxNodes?`(5000), `windowIndex?`, `meta?` | node array |
| `find` | `pid`, `selector`, `maxDepth?`(60), `maxNodes?`(30000), `windowIndex?`, `meta?` | matching nodes (flat, each with `depth`) |
| `attr` | `nodeId`, `name` | the attribute value, coerced to JSON |
| `setValue` | `nodeId`, `value` | `{nodeId, ok}` |
| `press` | `nodeId`, `action?`(`AXPress`) | `{nodeId, action, ok}` |
| `focus` | `nodeId` | `{nodeId, ok}` |
| `keystroke` | `pid`, `key`, `modifiers?`, `dryRun?` | `{ok, mode, plan}` |
| `click` | `nodeId` \| (`x`,`y`), `button?`(`left`), `clickCount?`(1), `modifiers?`, `dryRun?` | `{ok, plan}` |
| `observe` | `pid`, `nodeId?`, `notifications: string[]` | `{subscription, registered, failed}` |
| `unobserve` | `subscription` | `{subscription, ok}` |
| `shutdown` | — | `{ok}`, then the process exits |

`meta: true` wraps `tree`/`find` results in `{nodes, nodeCount|visited, truncated, elapsedMs}`
instead of returning the bare array. Off by default so the wire format matches the spec.

### Nodes

```jsonc
{
  "nodeId": 684,                  // process-local handle, stable within one run
  "role": "AXTextArea",
  "subrole": "AXStandardWindow",  // omitted when absent
  "title": "…", "value": "…",     // strings truncated to 200 chars (+ "…")
  "description": "…", "identifier": "…",
  "domId": "…", "domClasses": ["editor-kit-container"],  // Chromium/WebKit only
  "frame": {"x": 792, "y": 979, "w": 434, "h": 22},
  "children": [ /* … */ ]         // absent on `find` results, which carry "depth" instead
}
```

`attr` does not truncate. `attr` with `name: "AXAttributeNames"` is a pseudo-attribute
returning the list of attributes the element actually exposes — the fastest way to explore
an unfamiliar app.

### Selector

All supplied fields must match (AND). At least one is required.

```jsonc
{"role": "AXTextArea", "subrole": "…", "identifier": "…",
 "title": "…", "titleContains": "…",            // exact / case-insensitive substring
 "valueContains": "…", "descriptionContains": "…",
 "domId": "…", "domClass": "editor-kit-container",  // web content: the most stable selector
 "maxResults": 20}
```

### Synthetic input

`key` is a named key (`return`, `enter`, `tab`, `space`, `delete`, `escape`, `left`/`right`/
`up`/`down`, `home`, `end`, `pageup`, `pagedown`, `f1`–`f12`) or a single character on the
US-ANSI layout. Modifiers: `cmd`, `shift`, `alt`/`option`, `ctrl`, `fn`. A character with no
US keycode is sent as a synthesized unicode event, which cannot carry modifiers — the bridge
returns `BAD_REQUEST` rather than dropping them silently.

Three rules govern how events are built and posted. All three come from failures that were
invisible in the code and destructive in production (`spikes/README.md`):

**1. Keyboard goes to the pid; mouse goes to the HID tap.** A key event posted to
`kCGHIDEventTap` reaches an Electron/CEF app's *native* layer only: it fires menu shortcuts
and navigates tabs, but not one character ever reaches the renderer. Keyboard input must use
`CGEventPostToPid`. Mouse input is the exact opposite — the window server routes clicks by
screen coordinate, so a click posted to a pid lands nowhere and focus fails silently. The
asymmetry is deceptive because both failures look like "the element never got focus".

**2. Modifiers are pressed and released, and every event carries an explicit flag mask.**
The event source is `.privateState`, which inherits no modifier state (`.hidSystemState`
does). On top of that, `keystroke` emits real `flagsChanged` events around the key — one per
modifier going down, the mirror sequence coming back up — so the plan always ends on
flags == 0, and unmodified keystrokes are posted with an explicit empty mask rather than
whatever was left over. Masking `.maskCommand` onto a key event without ever releasing it
latches Command inside the target app: the next plain `w` arrives as Cmd+W and closes the
window.

**3. Nothing is typed into an unfocused element.** The bridge does not enforce this — it
cannot know the caller's intent — but callers must. When focus is elsewhere, Chromium eats
each character as a global shortcut and navigates away. Note that `AXFocused = true` does
*not* work on a `contenteditable`; a real click is the only way to focus one, which is what
`click` is for.

## Driving an application in the background

The foreground path above posts to the HID tap, which routes by screen coordinate: it moves
the real pointer and brings the window it lands on to the front. That is correct when a
person asked for it and wrong when an agent is working while somebody else uses the
machine. The background path posts to the process instead, with the window addressed by
number, and does neither.

Measured on macOS 26.3, against a probe that reports its own state: a click reached a window
that was **completely covered** by another one, the covered window registered it, the
covering window did not, the application was never activated, the frontmost application was
unchanged, and the pointer moved zero pixels — while the person at the machine was moving
the mouse 60px per 300ms of their own accord.

`click`, `keystroke` and `scroll` take this path when given `background: true`, a `session`,
or a `windowNumber`. `background: false` forces the old path back. Everything else behaves
exactly as it did.

### The operations

| op | what it is for |
|---|---|
| `bgSession` / `bgRelease` | hold a resolved target and field options across ops; optionally activate on open, restore focus on close, and host the suppression layer |
| `activate` | make a background window key and main without putting its application in front |
| `windowInfo` | window numbers, frames, addressability, the resolution chain used, and the diagnosis — the op to reach for when something is wrong, since it answers even when the others cannot |
| `awaitTree` | poll until a CEF window has actually built its accessibility tree, judged by web-area count |
| `focusAndType` | focus an element and type into it — the only route into a web composer |
| `scroll` | wheel events, foreground or background |
| `env` | trust, private-symbol availability, screen state, pointer position, live session and node counts |

and `click` / `keystroke` / `scroll` take `background`, `session`, `windowNumber` and
`fields` as optional additions. Full parameter lists are in
[`docs/ax-bridge-protocol.md`](../../docs/ax-bridge-protocol.md).

### What is required, and what only looks required

| | verdict |
|---|---|
| fields **51 and 58** (private) | **required, no substitute.** Remove them and the event does not go to the wrong window — it disappears |
| field 40 (`eventTargetUnixProcessID`) | not required; `postToPid` already names the process |
| fields 91/92 (window under pointer) | not required |
| `CGEventSetWindowLocation` (SkyLight) | not required *when the screen point falls inside the window*. Kept for when it does not — an off-screen or displaced window — where it is untested and probably still needed |

So the private surface is two field numbers, not a whole subsystem. It also has no graceful
degradation, which is why `plan.addressing.fields` reports what was **actually set** rather
than what was wanted, and why `fields` lets a caller switch each one off and reproduce the
teardown that established this table.

One trap worth naming: `CGEventField(rawValue:)` returns non-nil for *any* number — 40, 51,
58, 88, 91, 92, 99 and 200 all construct. It is not a validity check. Whether a field still
routes can only be answered by a target that reports what it received, which is what
`live-probe.sh` exists for.

**51 and 58 do not steer keyboard events.** A key posted to a pid lands in that
application's own key window whatever the fields say — measured twice, including against
the front window of two. The plan says so as `"windowFieldsSteerKeys": false`. Aiming keys
at a particular window means activating it first.

### Activation is two steps and the second one is a real click

An `appKitDefined` subtype-1 event posted to the pid gets the application to `isActive` and
no further: every window stays not-key. What makes a *window* key is one real click inside
it. There is no substitute — that was measured directly, by sending only the primer.

Subtype 2 is not step three. It is the reverse, for handing focus back at the end of a
session, and posting it during activation undoes the activation.

That click has to land somewhere, and the reference implementation puts it at the centre of
the window. That is measurably wrong: against a probe with a centred button, the primer
pressed it. `activate` instead scores candidate points by clearance from every interactive
element in the window, prefers the title bar, hard-excludes its leftmost 120pt so a primer
can never press a traffic light, and answers `NO_SAFE_POINT` when nothing clears the margin
rather than clicking anyway. A primer that presses a button is worse than a primer that did
not happen.

The state it produces is the definition of background driving, and it reads as a
contradiction: the target reports `isActive`, `isKeyWindow` and `isMainWindow` true while
the frontmost application it can see belongs to somebody else.

### Writing into a web composer needs the private path

Every public way of writing into a `contenteditable` reports success and does nothing.
Measured against one that reported its own DOM events: `AXValue`, `AXFocused`,
`AXSelectedTextRange`, `AXSelectedText`, `AXPress` and `AXConfirm` all returned `success`,
and **not one produced a `beforeinput` or an `input`**. The value read back as changed and
the page never knew — which for a controlled editor means the application's own state never
updated and a message that looks typed is not typed at all. A plain `<input>` accepts
`AXValue` normally, so this is what a `contenteditable` is, not a mistake in addressing.

`focusAndType` is the way in: focus the element, then send keys to the process. An executor
that quietly falls back to `setValue` here reports success and sends nothing.

Focusing is not one mechanism either — a web `contenteditable` advertises `AXPress` and
honours it while ignoring `AXFocused`, a native `AXTextField` is the exact opposite and
answers `actionUnsupported (-25206)` to `AXPress`, and some composers honour neither and
only move the caret for a real click. So `focusVia` defaults to `auto` and tries an
advertised action, then a settable attribute, then a click, reporting which one worked.
Asking what an element advertises before performing an action is the general lesson here: a
real `AXScrollArea` advertises **no actions at all**, so scrolling one through `press` was
never going to work — which is why `scroll` synthesizes a wheel event instead.

### Focus suppression is off, on measurement

`bgSession` accepts `suppressFocus: true`, which installs a `CGEvent.tapCreateForPid` on the
previously-frontmost application and drops the `appKitDefined` messages that would tell it
to deactivate. It is **off by default because it was measured to be unnecessary**: with no
tap at all, activating a background window left the frontmost application unchanged,
including with a real user application in front.

It is kept because it cannot be added later under pressure, and because the measurement
covers the applications that were measured. Turning it on taps another process, which is a
real cost — a tap that stalls gets disabled by the system, and one on the wrong process
would interfere with a person's own typing. `bgRelease` tears it down and reports what it
saw; closing stdin does too, because a tap outliving this helper would leave somebody else's
application filtered with nothing left to un-filter it.

### Read-only regression for input

`scripts/input-regression.sh` asserts all of the above **without posting a single event**:
`keystroke` and `click` both accept `"dryRun": true`, which builds the full event plan,
returns it, and stops. The plan carries the routing target, the source state, and the exact
flag mask of every event, so the two expensive bugs above are both statically checkable:

```jsonc
// {"id":1,"op":"keystroke","pid":702,"key":"a","modifiers":["cmd"],"dryRun":true}
{"ok": true, "dryRun": true, "plan": {
  "key": "a", "mode": "keycode", "target": "postToPid(702)", "sourceState": "private",
  "events": [
    {"kind": "flagsChanged", "keyCode": 55, "flags": 1048576, "flagsHex": "0x100000"},
    {"kind": "keyDown",      "keyCode": 0,  "flags": 1048576, "flagsHex": "0x100000"},
    {"kind": "keyUp",        "keyCode": 0,  "flags": 1048576, "flagsHex": "0x100000"},
    {"kind": "flagsChanged", "keyCode": 55, "flags": 0,       "flagsHex": "0x0"}
  ]}}
```

The last event is the one that matters: it is the Command release that was missing when a
stray `w` closed the window. The script checks routing, source state, zero-mask on plain
keys, the full press/release choreography for one and two modifiers, uppercase as Shift+key,
unicode fallback, refusal of modifiers on the unicode path, and `cghidEventTap` routing plus
argument validation for clicks — 21 assertions, no side effects.

## Permissions

Every AX op except `trusted` and `apps` is gated on `AXIsProcessTrusted()` and returns
`NOT_TRUSTED` when the grant is missing.

macOS attributes Accessibility permission to the **responsible process**, not to this
binary. Verified on this machine: an ad-hoc-re-signed copy of `we-ax` at a different path,
run from a detached shell, is still trusted — because its ancestor (the Claude Code
`claude` daemon, itself descended from a granted app) holds the grant. The practical rules:

* spawn `we-ax` from a process whose owning `.app` is already in
  **System Settings → Privacy & Security → Accessibility**, and it inherits the grant;
* spawn it from a differently-parented daemon (a launchd job, another terminal) and it will
  report `trusted: false` until *that* app is granted;
* rebuilding `we-ax` does not revoke anything, since the grant was never attached to it;
* `{"id":1,"op":"trusted","prompt":true}` raises the system dialog, which deep-links to the
  right pane for whichever executable macOS holds responsible.

## Threading

The main thread runs `CFRunLoopRun()` so `AXObserver` run-loop sources can fire. A
background thread does blocking stdin reads and hands each request to the main thread via
`DispatchQueue.main.sync`, which keeps request ordering and lets the element/observer
registries stay lock-free. All stdout writes — responses and events alike — go through one
lock in `Output` and are flushed per line. Closing stdin tears down observers and exits.

Every application element gets a 2 s AX messaging timeout, so a wedged target degrades to
`AX_ERROR(-25204)` instead of hanging the bridge.

## Four ways a window disappears without an error

Each looks like "this app has no window", each has a different remedy, and code that cannot
tell them apart retries forever against the ones it cannot fix. `windows` no longer answers
`[]` for any of them.

**1. A placeholder that looks like a window.** When the accessibility server cannot
materialise an application's windows it does not return an empty list — it returns an
application-typed placeholder in the window's slot: `<AXUIElement Application 0x…> {pid=N}`,
`CFEqual` to the app element itself, reporting `AXRole == "AXApplication"` and no frame.
`AXWindows`, `AXChildren` and `AXMainWindow` all do it. Left alone it makes an application
its own child, collapses it onto the root's `nodeId`, and hands callers a frame-less
"window" that every click resolves to nothing.

**2. A locked screen.** The count comes back right and **every** entry is that placeholder.
Titles equal the application name, `AXPosition`/`AXSize` fail, `_AXUIElementGetWindow`
fails, and a walk from a "window" arrives in the menu bar. Nothing reports an error at any
point. → `SCREEN_LOCKED`, and only a person can clear it.

**3. The desktop is not compositing.** Accessibility returns *success* with a count of zero
while `CGWindowList(.optionAll)` shows the windows and `.optionOnScreenOnly` shows none.
Measured on this machine: a running screen saver does this with the session still unlocked
and `CGSSessionScreenIsLocked` false throughout, and it takes accessibility windows away
from **every** application at once — 45 applications with windows, one of them on screen.
`orderFrontRegardless()` does not fix it; it is the desktop's state, not the app's. →
`AX_SEES_NO_WINDOWS_BUT_CG_DOES`, with a whole-machine census in `details` so a caller can
tell "this app is off screen" from "nothing is on screen". Checking the lock alone is not
enough.

**4. There genuinely is no window.** A menu-bar agent, or an application closed to the tray.
→ `NO_WINDOW`.

The order these are checked in is load-bearing. The placeholder filter that makes a tree
safe to walk removes exactly the evidence for case 2, so **the diagnosis runs on the
unfiltered census and filtering happens after it** — the other way round and a locked Mac
arrives downstream as a harmless empty array. `AXElement.elementCensus` is the unfiltered
read; `elementList` is the filtered view built on top of it.

The private dispatch path is unaffected by cases 2 and 3, which is the reason it is worth
keeping: with a window number obtained some other way, clicks and keys still land. Ops that
have to *find* a window are gated on the lock; ops that were *given* a window number are
deliberately not.

## Notes on the historical placeholder behaviour

When the accessibility server cannot materialise an application's windows, it does **not**
return an empty list. It returns an application-typed placeholder in the window's slot —
`<AXUIElement Application 0x…> {pid=N}`, `CFEqual` to the app element itself, reporting
`AXRole == "AXApplication"` and no frame. `AXWindows`, `AXChildren` and `AXMainWindow` all do
it. Left alone it makes an application its own child, collapses it onto the root's `nodeId`,
and hands callers a frame-less "window" that every click resolves to nothing.

`elementList` drops any element that is `CFEqual` to its parent, so these never reach the
wire. An element that is its own parent is never legitimate, so the filter is a no-op on a
healthy tree — but see above for why the filter must not run before the diagnosis.

Worth knowing because the degraded state is easy to misread as a bridge bug: it can appear
machine-wide, with `AXIsProcessTrusted()` still returning `true` while every real query
fails. The tell is the system-wide element — when
`AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute)`
returns `-25204 cannotComplete` and *every* application reduces to its menu bar, the problem
is the machine's accessibility state, not the target app and not this bridge.

## Electron / Feishu notes

Measured against Lark 7.x (Chromium 143, bundle `com.bytedance.macos.feishu`):

* **The window must be visible.** With Feishu closed to the tray its five `CGWindow`s are
  all `onscreen=false`, `AXWindows` is `[]`, and `tree` returns only the menu bar (~187
  nodes, all `AXMenuItem`). Nothing is broken — there is simply nothing to read. `windows`
  now classifies this rather than returning an empty array; see the four cases above.
* **`enableAX` fails and that is fine.** Lark answers `attributeUnsupported (-25205)` for
  `AXManualAccessibility` and `notImplemented (-25208)` for `AXEnhancedUserInterface`, yet
  *reading* `AXEnhancedUserInterface` returns `true`: Chromium accessibility is already on.
  Call `enableAX` opportunistically, never gate on its result.
* **`maxDepth: 8` finds nothing.** The first `AXWebArea` sits at depth 10 and real content
  at depth 20–45. Use `maxDepth: 40`+ for `tree` and the default 60 for `find`.
* **Prefer `domClass` over `title`.** Feishu ships semantic CSS classes
  (`a11y_feed_card_item`, `editor-kit-container`); native Chromium views expose their C++
  view names (`BrowserView`, `TabContentsView`). Both arrive as `domClasses`.
* **Web areas are titled.** The messenger tab exposes `AXWebArea` "messenger" (conversation
  list) and "messenger-chat" (open conversation); other tabs expose their own, e.g.
  "history-list". Which ones exist depends on the active sidebar tab, so resolve the web
  area by title each time rather than caching a `nodeId` across tab switches.
* Costs on this machine: full app tree at depth 8 ≈ 35 ms / 187 nodes; the messenger window
  at depth 40 ≈ 124 ms / 761 nodes; a `find` sweeping 969 nodes ≈ 140 ms.
