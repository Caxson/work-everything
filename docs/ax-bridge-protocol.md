# `we-ax` bridge protocol

The TypeScript client (`src/perception/macos/axBridge.ts`) and the Swift
helper (`native/ax-bridge`) implement this document. It is the contract
between them; neither side may extend it unilaterally.

## Transport

One JSON object per line (NDJSON). UTF-8, `\n` as the delimiter, no framing
headers. Anything the helper writes to stderr is diagnostics, never protocol.

Two ways to carry it, byte for byte identical:

| mode | command | who is served |
|---|---|---|
| stdio | `we-ax` | one client, on the helper's stdin and stdout |
| socket | `we-ax --serve [path]` | many clients, on an `AF_UNIX` stream socket |

A message arriving in either direction may be split across writes; both sides
buffer until a newline. A line the helper cannot parse is answered with a
failure carrying `"id": -1` — it never terminates the connection. The client
skips lines it cannot parse.

### Why the socket exists

macOS attributes an Accessibility grant to the **responsible process**, which
for a spawned helper is whoever launched it — not the helper. So the same
binary answers `trusted: true` when a terminal spawns it and `trusted: false`
when a daemon does, and granting the binary in System Settings changes
neither, because the grant being consulted was never its own. That makes the
spawn transport unusable for an unattended agent: it can only work when a
person starts it from something already granted.

Run as a launchd agent, the binary is responsible for itself. It is granted
once, by hand, and every client that can open its socket borrows that grant.
`native/ax-bridge/scripts/install-service.sh` installs it and prints the
one-time instructions; nothing installs the grant itself, because TCC is
deliberately not programmable.

Default socket path, printed by `we-ax --socket-path`:

```
~/Library/Application Support/work-everything/we-ax.sock
```

The directory is created 0700 and the socket 0600. A socket file left behind
by a process that died is removed on start; one that is still being served is
not, and the second instance refuses with `SOCKET_IN_USE` rather than stealing
the address.

### What belongs to a connection, not to the process

Everything a client can name is **per connection**: `nodeId` handles,
`session` ids, `subscription` ids, and where observer events are delivered.
Two clients both number from 1, and one client's `nodeId: 7` is not the
other's — a shared registry would resolve it to the wrong element and answer
`ok: true`, which is a click on the wrong window.

Losing a connection releases exactly that client's state: its sessions
(including any focus-suppression tap), its observers, its handles.
`shutdown` does the same and is **not** a way to stop the service: over a
socket it ends one client and leaves the bridge running for the rest. Over
stdio it still exits the process, because there is nobody else.

`env` reports `connection` and `transport` so a caller can tell which bridge
answered and see that `sessions` and `nodes` are its own counts.

## Requests (client → helper)

```json
{"id": 1, "op": "tree", "pid": 42, "maxDepth": 40, "maxNodes": 20000}
```

- `id` — positive integer, unique per client process, monotonically increasing.
- `op` — one of the operations below.
- Remaining keys are that op's parameters, inlined at the top level.

## Responses (helper → client)

Exactly one response per request, carrying the request's `id`.

```json
{"id": 1, "ok": true,  "result": []}
{"id": 1, "ok": false, "error": {"code": "NO_SUCH_NODE", "message": "unknown nodeId 42"}}
```

`error.code` is a stable machine-readable token; `error.message` is for a
human and must not contain user data beyond what the caller already supplied.

An error may also carry `error.details`, an object of structured diagnostics —
counts, censuses, what was attempted. It is additive: a client that reads only
`code` and `message` is unaffected, and one that wants the numbers does not have
to parse prose out of a sentence.

`result` is whatever shape the operation defines — an array, an object, or a
bare scalar. It is not always an object.

## Events (helper → client)

Unsolicited, delivered while a subscription is live. No `id`.

```json
{"event": "ax", "subscription": 7, "notification": "AXValueChanged", "nodeId": 11, "pid": 42}
```

## Operations

| op | params | result |
|---|---|---|
| `trusted` | `prompt?` | `{"trusted": boolean, "executable": string}` |
| `apps` | — | `[{"pid", "name", "bundleId", "activationPolicy"}]` |
| `enableAX` | `pid` | `{"manualAccessibility": outcome, "enhancedUserInterface": outcome}` |
| `windows` | `pid` | array of nodes, each with `index`, no `children` |
| `tree` | `pid`, `maxDepth?`, `maxNodes?`, `windowIndex?`, `meta?` | array of root nodes |
| `find` | `pid`, `selector`, `maxDepth?`, `maxNodes?`, `windowIndex?`, `meta?` | array of nodes, each with `depth`, no `children` |
| `attr` | `nodeId`, `name` | the attribute value, coerced to JSON |
| `setValue` | `nodeId`, `value` | `{"nodeId", "ok": true}` |
| `press` | `nodeId`, `action?` | `{"nodeId", "action", "ok": true}` |
| `focus` | `nodeId` | `{"nodeId", "ok": true}` |
| `keystroke` | `pid`, `key`, `modifiers?`, `dryRun?` | `{"ok": true, "mode", "plan"}` |
| `click` | `nodeId` \| (`x`, `y`), `button?`, `clickCount?`, `modifiers?`, `dryRun?` | `{"ok": true, "plan"}` |
| `observe` | `pid`, `notifications`, `nodeId?` | `{"subscription", "registered", "failed"}` |
| `unobserve` | `subscription` | `{"subscription", "ok": true}` |
| `env` | — | `{"trusted", "cursor", "frontmost", "spi", "screen", "sessions", "nodes", "connection", "transport"}` |
| `scroll` | `nodeId` \| (`x`, `y`), `deltaX?`, `deltaY?`, `unit?`, + background params | `{"ok": true, "plan"}` |
| `windowInfo` | `pid` | `{"pid", "windows", "diagnosis", "addressable", "windowServer", "desktop", "spi", "screen"}` |
| `awaitTree` | `pid`, `timeoutMs?`, `pollMs?`, `windowIndex?`, `maxNodes?`, `maxDepth?` | `{"ready", "nodes", "webAreas", "polls", "elapsedMs"}` |
| `activate` | `pid`, `windowNumber?` \| `windowIndex?`, `safePoint?`, `fields?` | `{"windowNumber", "primer", "safePoint", "addressing", "invariants"}` |
| `bgSession` | `pid`, `windowNumber?` \| `windowIndex?`, `activate?`, `safePoint?`, `suppressFocus?`, `dropTypes?`, `fields?` | `{"session", "pid", "windowNumber", "suppression", "activation?", "invariants"}` |
| `bgRelease` | `session`, `restore?` | `{"session", "released", "restored", "suppression?"}` |
| `focusAndType` | `nodeId`, `text`, `pid` \| `session`, `windowNumber?`, `focusVia?`, `focusAction?`, `activate?`, `perCharacterMs?`, `caretRecovery?`, `caretTimeoutMs?`, `caretPollMs?`, `dryRun?` | `{"ok", "focused", "typed", "plan", "invariants"}` |
| `shutdown` | — | `{"ok": true}`, then this **client** goes away |

Defaults: `tree` uses `maxDepth` 12 and `maxNodes` 5000; `find` uses 60 and
30000. `press` defaults `action` to `AXPress`. `click` defaults `button` to
`left` and `clickCount` to 1.

`trusted` with `prompt: true` raises the system permission dialog; without it
the check is silent. `executable` is the helper's own path, which is what
makes the responsible-process attribution debuggable (see
`native/ax-bridge/README.md`).

`enableAX` reports each attribute independently as
`{"ok": boolean, "axError": number, "name": string}`. Both failing is normal
and not fatal — some Chromium builds have accessibility on already and refuse
both switches. Callers must not gate on this result.

`observe` returns which notification names were accepted (`registered`) and a
`{name: axError}` map of those that were not (`failed`). The accessibility API
does not validate notification names, so an unknown name is usually accepted
and simply never fires.

## Driving an application in the background

The default input path posts to the global HID tap. The window server routes
those events by screen coordinate, which means they move the real pointer and
bring the window they land on to the front — correct when a person asked for it,
wrong when an agent is working while somebody else uses the machine.

The background path posts to the process instead, with the window addressed by
number. It moves nothing and takes nothing to the front. Measured on macOS 26.3:
a click reached a window that was completely covered by another one, that window
registered it, the covering window did not, the application was never activated,
the frontmost application was unchanged and the pointer moved zero pixels.

`click`, `keystroke` and `scroll` take the background path when asked:

- `background: true` — explicit, always wins.
- `session` or `windowNumber` — either implies it, since neither means anything
  to the foreground path.
- `background: false` — forces the foreground path back, even with a session.

**Anything else keeps the old behaviour exactly.** A `click` with `x`/`y` and no
background parameter still goes to the HID tap and still moves the pointer.

### What actually does the addressing

```jsonc
"plan": {
  "route": "background",
  "target": "postToPid(65800)",
  "window": {"pid": 65800, "windowNumber": 96497, "frame": {}},
  "addressing": {
    "fields": {"40": true, "51": true, "58": true, "91": true, "92": true},
    "windowLocationApplied": true,
    "windowPoint": {"x": 260, "y": 182}
  }
}
```

`addressing.fields` reports the fields that were **actually set**, not the ones
that were wanted. The distinction is the point: `CGEventField(rawValue:)` returns
non-nil for any number at all — 40, 51, 58, 88, 91, 92, 99 and 200 all construct
— so "the field exists" proves nothing and a plan that reported intent would
prove less. These plans come from the same code that posts, minus the posting.

Fields 51 and 58 are private and the mouse path has no substitute for them: with
them removed the event does not go to the wrong window, it disappears. 40, 91/92
and `CGEventSetWindowLocation` were each removed in turn and the click still
landed, so they are not required for a window whose frame agrees with the screen
point — they are kept for the case where it does not. `fields` lets a caller turn
each one off and reproduce that teardown.

**Window fields do not steer keyboard events.** Measured: a key posted to a pid
lands in that application's own key window whatever 51/58 say, including when the
target window is the front one of two. `keystroke` sets the fields anyway, for
symmetry and diagnosis, and says so in its plan as
`"windowFieldsSteerKeys": false`. Aiming keys at a particular window means
activating it first.

### `activate` — making a window key without taking the front

Two steps, both required:

1. An `appKitDefined` event with subtype 1 posted to the pid. This gets the
   application to `isActive` and nothing more — every window stays not-key.
2. One real click inside the window. This is what makes that window key and main.

Subtype 2 is not a third step. It is the reverse — a way to hand focus back when
a session ends — and posting it during activation undoes the activation.

The result is a state that reads as a contradiction and is exactly what
background driving means: the target reports `isActive`, `isKeyWindow` and
`isMainWindow` true while the frontmost application it can see is somebody else's.

The click in step 2 has to land somewhere. `safePoint` says where; without it the
helper picks one by clearance — every interactive element in the window
contributes an exclusion rectangle, candidates are scored by distance to the
nearest, and the title bar is preferred because it is the one region designed to
have nothing behind it. The leftmost 120pt of the title bar is excluded outright
so a primer can never press a traffic light. When nothing clears the margin the
answer is `NO_SAFE_POINT` rather than a click anyway: a primer that presses a
button is worse than a primer that did not happen. Reference implementations
click the centre of the window, which is measurably wrong — against a probe with
a centred button, the primer pressed it.

A window addressed by number while accessibility exposes nothing has no tree to
choose from, so `safePoint` becomes required there.

### `focusAndType` — writing into a web composer

Every public way of writing into a `contenteditable` reports success and does
nothing. Measured against one that reported its own DOM events: `AXValue`,
`AXFocused`, `AXSelectedTextRange`, `AXSelectedText`, `AXPress` and `AXConfirm`
all returned `success`, and not one produced a `beforeinput` or an `input`. The
value read back as changed and the page never knew — which for a controlled
editor means the application's own state never updated and a message that looks
typed is not typed. A plain `<input>` accepts `AXValue` normally, so this is what
a `contenteditable` is, not a mistake in how it was addressed.

What works is focusing the element and then sending keys to the process. That is
this op: accessibility to aim, event dispatch to write.

Focusing is not one mechanism either. A web `contenteditable` advertises
`AXPress` and honours it while ignoring `AXFocused`; a native `AXTextField` is the
opposite and answers `actionUnsupported` to `AXPress`; some composers honour
neither and only move the caret for a real click. So `focusVia` defaults to
`auto`, which tries `press` (only if the element advertises the action), then
`focused` (only if the attribute is settable), then `click`. The result names the
one that worked in `focused.method`. Pin it with `focusVia: "press" | "focused" |
"click"` when you want a specific mechanism and its failure reported.

**Focus is verified by read-back before any key is sent.** A focus call returning
`.success` is a claim — the same claim `AXValue` and `AXFocused` make on a
`contenteditable` while doing nothing. After a strategy reports success the helper
polls `AXFocusedUIElement` and requires it to identify the target element; a
strategy that cannot be proven counts as failed and the next is tried. If none can
be proven the op answers `FOCUS_FAILED` and **sends nothing**:

```jsonc
{"ok": false, "error": {"code": "FOCUS_FAILED",
  "message": "could not put the caret in node 42, so no keys were sent. …",
  "details": {"attempted": ["press", "focused", "click"], "claimedSuccess": ["click"],
              "keysSent": 0,
              "focusActuallyOn": {"role": "AXTextField", "AXIdentifier": "other-field"}}}}
```

On success, `focused` reports how identity was established:
`{"method": "focused", "attempted": ["press","focused"], "verifiedBy": "identity",
"focusedRole": "AXTextField"}`. `verifiedBy` is `identity`, a stable attribute name
(`AXDOMIdentifier`, `AXIdentifier`, `frame`), or one of those with `/ancestorN`
when focus landed on a descendant — focus on a text run inside a composer is focus
on the composer.

Identity is **not** `CFEqual`. Chromium returns a fresh `AXUIElement` from every
`AXFocusedUIElement` read, so pointer equality is false for the same DOM node.
Matching is by stable attributes under two strict rules: any strong key present on
both sides must agree, and at least one must be present on both and agree. When
nothing can be proven either way the op refuses rather than typing.

The strong keys are `AXDOMIdentifier`, `AXIdentifier` and the frame. Measured on a
real CEF composer (Draft.js `public-DraftEditor-content`), **neither identifier is
present** — only a class list and a frame — so the frame is what carries the proof
on web content, not a last resort. The class list is checked for contradiction only:
siblings in a message list share it exactly, so a match proves nothing while a
mismatch proves they are different elements.

The plan carries `"verifiesFocus": true`, so the guarantee is checkable in a dry
run. `dryRun` performs no focus and sends nothing.

#### The composer resets its caret on the first character

Typing `we ping` into Feishu's composer, one unicode key pair per character,
three attempts at each of six intervals:

```
   4ms  ["pingww", "pingwww", "e pingw"]
  12ms  ["e pingw", "e pingw", "e pingw"]
  25ms  40ms  60ms  90ms      all three attempts "e pingw"
```

Everything from 12ms up is stable and **stably wrong**, and that is the whole
finding: a race produces different wreckage every run, this produces the same
string every run. **Widening `perCharacterMs` does not help, because there is
no race to lose.** All it fixes is the 4ms case, where two characters land
inside a single render.

The mechanism reproduces `e pingw` exactly:

```
type w  -> "w"       caret 1
the composer re-renders as it goes from empty to non-empty; the caret returns to 0
type e  -> "ew"      caret 1
type ␣  -> "e w"     caret 2
type p  -> "e pw"    caret 3
type i  -> "e piw" ; n -> "e pinw" ; g -> "e pingw"
```

So the answer is a caret move, not a delay. `focusAndType` types the first
character, **polls the element's own text until that character appears**, puts
the caret back at the end, and types the rest. The wait is a poll rather than a
sleep because "the render finished" is observable and a duration is not; a
`CARET_NOT_SETTLED` error says so honestly, and reports that one character was
sent.

There is no single key for "caret to the end", which is the same shape of
problem `focusVia` solves for focus. Measured against a probe that reproduces
the reset (`scripts/caret-regression.sh`), typing one character and then one
more:

| mechanism | selection after | where the next character went |
|---|---|---|
| nothing | 0 | `"Xw"` — in front |
| `end` (keycode 119) | 0 | `"Xw"` — still in front |
| `cmd`+`right` (124) | 1 | `"wX"` — appended |

In the Cocoa text system `End` is `scrollToEndOfDocument:`: it scrolls the view
and leaves the insertion point where it was. Chromium honours it as a caret
move, which is why it is still tried first — it has no side effect in either
engine, while `Cmd`+`Right` is browser navigation whenever focus is *not* in a
text field. Both are sent in order and **each is read back from
`AXSelectedTextRange` before it is believed**, exactly as focus is. A move that
can be read back and provably did not work answers `CARET_NOT_AT_END` and types
nothing further, because inserting the rest at position 0 is the bug. An element
that reports no selection at all is unknown rather than wrong: every mechanism
is sent, the run continues, and `caretMove.verified` is `false`.

The recovery applies only where the reset does:

| composer | plan | why |
|---|---|---|
| empty, text readable | `caretToEnd` | the measured case |
| already has text | `none` | the reset is the empty-to-non-empty edge |
| one character to type | `none` | nothing follows it that could be misplaced |
| no readable text | `none` | the first character landing cannot be observed, and claiming otherwise would turn every write into a timeout |

The decision is taken from the element before anything is focused or typed, so a
dry run reports the decision rather than the mechanism:

```jsonc
"caret": {"recovery": "caretToEnd", "watchesFirstCharacter": true, "verifiesCaret": true,
          "afterCharacters": 1, "budget": {"timeoutMs": 1500, "pollMs": 20, "caretSettleMs": 250},
          "mechanisms": [{"name": "end", "key": "end", "keyCode": 119, "modifiers": []},
                         {"name": "cmdRight", "key": "right", "keyCode": 124, "modifiers": ["cmd"]}]}
```

and a live run adds what happened:

```jsonc
"caret": {"applied": true,
          "firstCharacter": {"landed": true, "polls": 1, "elapsedMs": 4},
          "caretMove": {"movedBy": "cmdRight", "verified": true, "offset": 1,
                        "characters": 1, "attempted": ["end", "cmdRight"]}}
```

`caretRecovery: false` types the way the bridge did before all of this. It exists
for the same reason the `fields` switches do — so the measurement can be
reproduced against the same element in the same run instead of taken on trust —
and for nothing else.

`perCharacterMs` defaults to 4. **That number was chosen, not measured.** It is
there to keep two unicode key pairs from arriving inside one render, and the
table above is what it was measured *not* to fix.

Where focus leaves the caret in a composer that already has text is a separate
question this op has never answered — measured against the probe, typing `tail`
into `seed ` produces `tailseed `. It is untouched here: it is not the reset, and
the send path only ever writes into an empty composer.

### `bgSession` — reusing a target, and the optional suppression layer

A session is a convenience: it holds a resolved target and the field options so
ops do not repeat the resolution, and it gives the focus-suppression layer and
the closing focus-restore somewhere to live. Every background op also works with
a plain `pid` and `windowNumber`, so a session is never required.

`suppressFocus` is **off by default, on measurement**. With no tap installed at
all, activating a background window left the frontmost application unchanged —
including with a real user application in front. The layer is kept because
installing it later under pressure is not a thing anyone should have to do, and
because the measurement covers the applications that were measured. Turning it on
installs a `CGEvent.tapCreateForPid` on another process, which is a real cost: a
tap that stalls gets disabled by the system, and one on the wrong process would
interfere with a person's own typing. `bgRelease` tears it down and reports what
it saw and dropped. Closing stdin or `shutdown` releases every session, because a
tap outliving the helper would leave somebody else's application filtered with
nothing left to un-filter it.

### `invariants`

Every live background result carries the promise it is making, measured:

```jsonc
"invariants": {
  "frontmostUnchanged": true,
  "frontmostBefore": "Google Chrome", "frontmostAfter": "Google Chrome",
  "cursorDelta": 0, "elapsedMs": 66,
  "cursorBefore": {"x": 668, "y": 458}, "cursorAfter": {"x": 668, "y": 458}
}
```

`elapsedMs` is there so `cursorDelta` can be read fairly. A person using the
machine moves the pointer while an op runs — 60px in 300ms is ordinary — so a
non-zero delta means nothing without the span it was measured over. Compare it
against the pointer's own drift across the same duration, which `env` reports the
cursor position for.

### `awaitTree` — a CEF tree is built by reading it

A Chromium tree is not sitting there waiting. The first traversal of a Chrome
window returned 38 nodes and no web area; an immediate second traversal, with
nothing done in between, returned 44 and one. The trigger is a client asking.

Two consequences that silently produce wrong answers:

- The waking is counted **per accessibility client and it decays**. A different
  process's first traversal saw 311 nodes, all menu bar, and a second read 500ms
  later had still not woken it. Discarding the first result is not one-time
  setup; every process pays it, every time it goes cold.
- Readiness is the **web area count**, never the node count. A bare menu bar is
  three hundred nodes and clears any plausible threshold.

So `awaitTree` polls until a web area appears and answers `TREE_NOT_READY` with a
census attached when it does not, rather than handing back a stub. Do not sleep a
fixed interval instead; 500ms was measured to be enough sometimes.

`AXManualAccessibility` and `AXEnhancedUserInterface` are both refused on macOS
26.3 and the tree arrives regardless. `enableAX` remains available and must not
be treated as a precondition for anything.

### Three ways a window list comes back empty

`windows` used to answer `[]` for all of them. It no longer does, because an
empty array reads the same in every case and sends a caller into a retry loop
against two it cannot fix. Each leaves as its own error:

| code | what happened | what helps |
|---|---|---|
| `SCREEN_LOCKED` | the count is right and every entry is the application element itself | only a person unlocking the machine |
| `AX_SEES_NO_WINDOWS_BUT_CG_DOES` | accessibility returns success with nothing, while the window server has windows for this process and none on screen | nothing in code; the window never reached the screen |
| `NO_WINDOW` | there genuinely is no window — a menu-bar agent, an app closed to the tray | showing the window |
| `FULLSCREEN_SPACE` | the active Space belongs to a full-screen application, so every application on the other Spaces reads as having no window | waiting until the person leaves full screen, or addressing an application on this Space |

The classification runs on the **unfiltered** window list. The self-referential
placeholders that make an application its own child have to be filtered out
before a tree can be walked, and those same placeholders are the entire evidence
for the first case — so the diagnosis is taken first and filtering happens after.

Both carry a whole-machine census in `details`, because one application with no
on-screen window is that application's problem while *nothing* on screen anywhere
means the desktop is not compositing at all. A running screen saver does the
latter with the session still unlocked, taking accessibility windows away from
every application at once — measured on this machine, with
`CGSSessionScreenIsLocked` false throughout. Checking the lock alone is not
enough.

The census counts **windows**, not owners. `desktopOwnersOnScreen <= 1` used to
stand in for "the desktop is not compositing", and a single full-screen
application produces exactly that reading: measured with Chrome full-screen at
1728x1003 and a person actively typing, the helper reported a machine that was
drawing nothing. `scope` is now `desktop` only when `desktopOnScreen` is zero,
and the full-screen case has a code of its own.

`FULLSCREEN_SPACE` carries `details.space`: `fullScreen`, the `evidence` that
said so, and — when the private Space list is readable — `spaces`,
`currentSpaceType` and `frontmostApp`. Two independent signals are consulted
because each alone has a hole. `AXFullScreen` on the frontmost application's
windows is public API but sees only the frontmost application; the managed Space
list is authoritative about which Space is current but is private, and a macOS
that stops vending it must degrade to the public signal rather than to a wrong
answer. Measured: with Chrome full-screen, 飞书 exposed zero accessibility
windows and six CGWindows with none on screen; activating it produced exactly one
addressable window of 1397x937; returning Chrome to the front removed it again.

`windows` with `"meta": true` returns `{"windows": [], "diagnosis": {}}` instead
of throwing, for a caller that would rather branch than catch. Neither form can
return an unexplained empty list. `windowInfo` never throws for these states at
all — it is the diagnostic op, and withholding the evidence at the one moment
somebody wants it would be the wrong trade — so its `diagnosis` field carries the
same classification, with `code: "OK"` when there is nothing wrong.

`windows` results now also carry `windowNumber`, `resolvedBy` and `addressable`
alongside the node fields. `resolvedBy` names which link of the resolution chain
answered: `axSPI` (`_AXUIElementGetWindow`, the precise one), then `frameMatch`,
`titleMatch`, `titleMatchLoose`, `fallbackLayer0`. A caller that needs precision
can refuse anything below `axSPI`.

### `meta`

`tree` and `find` return a bare array by default. With `"meta": true` the
result is wrapped so the caller can see the traversal budget:

```json
{"nodes": [], "nodeCount": 742, "truncated": false, "elapsedMs": 105}
{"nodes": [], "visited": 950, "truncated": false, "elapsedMs": 141}
```

`truncated` means a depth or node budget was hit and the answer is partial.

### Node

```json
{
  "nodeId": 11,
  "role": "AXButton",
  "subrole": "AXCloseButton",
  "title": "Send",
  "value": "hello",
  "description": "Send message",
  "identifier": "_NS:1091",
  "domId": "composer",
  "domClasses": ["editor-kit-container", "js-composer"],
  "frame": {"x": 0, "y": 0, "w": 80, "h": 24},
  "children": []
}
```

Only `nodeId` and `role` are always present; every other field is omitted when
the element does not expose it. `frame` uses **`w`/`h`**, not `width`/`height`.

`domId` and `domClasses` come from `AXDOMIdentifier` and `AXDOMClassList`,
which Chromium and WebKit expose on web content. Inside an Electron/CEF app
they are the most stable selectors available — far more so than titles or
child ordering.

`children` is present only in `tree` results, where it is always an array and
is empty at the depth or node limit. `find` and `windows` results carry no
`children`; `find` adds `depth` and `windows` adds `index` instead.

String fields in nodes are truncated to 200 characters with a trailing `…`.
`attr` does not truncate.

`nodeId` is a handle allocated by the helper. It is meaningful only to the
**connection** that issued it and only for that connection's lifetime — over
stdio those are the same thing as the process, over a socket they are not. The
same element always receives the same handle within one connection, across ops.
A handle says nothing about whether the underlying element still exists — an op
naming a stale node returns an error, it does not crash.

### Selector

```json
{
  "role": "AXTextArea",
  "subrole": "AXStandardWindow",
  "title": "Send",
  "titleContains": "sen",
  "identifier": "send-button",
  "valueContains": "draft",
  "descriptionContains": "message",
  "domId": "composer",
  "domClass": "editor-kit-container",
  "maxResults": 20
}
```

Every field is optional but at least one must be present, otherwise the helper
answers `BAD_REQUEST`. Fields present are combined with AND.

`role`, `subrole`, `title`, `identifier` and `domId` match exactly.
`domClass` matches when the name appears anywhere in the element's
`domClasses`. The `*Contains` fields are case-insensitive substring matches.
`maxResults` caps the returned array and defaults to 50.

### Synthetic input

`key` is a single character or a named key: `return`/`enter`, `tab`, `space`,
`delete`/`backspace`, `escape`/`esc`, `forwarddelete`, `up`, `down`, `left`,
`right`, `home`, `end`, `pageup`, `pagedown`, `f1`…`f12`. `modifiers` is any of
`cmd` (`command`, `meta`), `shift`, `alt` (`option`, `opt`), `ctrl`
(`control`), `fn`.

`mode` is `keycode` when the key resolved on the US-ANSI layout, or `unicode`
when it was sent as a synthesized character. The unicode path cannot carry
modifiers; combining them returns `BAD_REQUEST` rather than dropping them.

Routing is asymmetric and both sides depend on it: keyboard events are posted
to the target pid, mouse events to the global HID tap. `plan.target` and
`plan.tap` report which was used, so the client can assert it.

With `"dryRun": true` the helper builds the full event plan, returns it, and
posts nothing. This is what makes input testable without side effects:

```json
{"ok": true, "dryRun": true, "plan": {
  "key": "a", "mode": "keycode", "target": "postToPid(702)", "sourceState": "private",
  "events": [
    {"kind": "flagsChanged", "keyCode": 55, "flags": 1048576, "flagsHex": "0x100000"},
    {"kind": "keyDown",      "keyCode": 0,  "flags": 1048576, "flagsHex": "0x100000"},
    {"kind": "keyUp",        "keyCode": 0,  "flags": 1048576, "flagsHex": "0x100000"},
    {"kind": "flagsChanged", "keyCode": 55, "flags": 0,       "flagsHex": "0x0"}
  ]}}
```

Every event carries an explicit flag mask and modifiers are always released,
so a plan ends on `flags: 0`. A client may assert that invariant.

`click` targets either an existing `nodeId` — the helper clicks the centre of
its frame — or an explicit screen point. An element with no usable
`AXPosition`/`AXSize` returns `NO_FRAME`. Its plan reports `tap`, `x`, `y`,
`button`, `clickCount`, `flags` and the ordered `events`
(`mouseMoved`, `leftMouseDown`, `leftMouseUp`).

## Error codes

| code | meaning |
|---|---|
| `NOT_TRUSTED` | accessibility permission has not been granted |
| `BAD_REQUEST` | malformed JSON, unknown op, missing or ill-typed parameter |
| `NO_SUCH_PID` | no running application with that pid |
| `NO_SUCH_NODE` | the `nodeId` is unknown to this helper process |
| `NO_SUCH_SUBSCRIPTION` | the `subscription` is unknown |
| `AX_ERROR(<n>)` | the accessibility API refused; `<n>` is the raw `AXError` |
| `NO_FRAME` | the element exposes no usable position/size to click |
| `CG_ERROR` | a CoreGraphics event could not be constructed |
| `INTERNAL` | an unexpected helper-side error |
| `SCREEN_LOCKED` | the screen is locked; accessibility substitutes the application element for every window. Only a person can clear it — do not retry |
| `AX_SEES_NO_WINDOWS_BUT_CG_DOES` | accessibility exposes no window while the window server has them and none on screen. `details` says whether it is this application or the whole desktop |
| `NO_WINDOW` | the application genuinely has no window, or the named `windowNumber` is not one of its |
| `FULLSCREEN_SPACE` | the active Space belongs to a full-screen application; applications on the other Spaces are not composited and expose no accessibility window. Wait, do not retry |
| `NO_SAFE_POINT` | no point in the window is clear of something clickable, so activation refused to click at all. Pass an explicit `safePoint` |
| `TREE_NOT_READY` | no `AXWebArea` appeared within the timeout; `details` carries the node and web-area counts that were seen |
| `NO_SUCH_SESSION` | the `session` is unknown or already released |
| `TAP_FAILED` | a per-process event tap could not be created (`suppressFocus` only) |
| `FOCUS_FAILED` | every focus mechanism was tried and none applied; `details` lists what was attempted and what the element advertises |
| `CARET_NOT_SETTLED` | the first character never appeared in the element within the budget, so the caret could not be put back and the rest was not typed. One character was sent |
| `CARET_NOT_AT_END` | the caret move was read back and provably did not work, so the rest was not typed. One character was sent |
| `SOCKET_IN_USE` | `--serve` found another we-ax already serving that path and refused to take it over |
| `SOCKET_PATH_TOO_LONG` / `SOCKET_BIND_FAILED` / `SOCKET_LISTEN_FAILED` / `SOCKET_DIR_FAILED` | `--serve` could not bind; the message carries the path and the errno |

`AX_ERROR` is **parameterized**: the code carries the numeric `AXError` inside
parentheses, e.g. `AX_ERROR(-25205)` for `attributeUnsupported`. Clients that
switch on codes must match the prefix, not the whole string. The symbolic name
is in `error.message`.

Every op except `trusted`, `apps`, `env` and `shutdown` is gated on accessibility
permission and answers `NOT_TRUSTED` when it is missing.

Ops that have to *find* a window or an element are additionally gated on the
screen being unlocked and answer `SCREEN_LOCKED`. Dispatch that was **given** a
window number is deliberately not gated: the event channel survives a lock — a
click posted to a pid with fields 51/58 still lands, measured — and that is the
one capability a locked screen leaves standing. Refusing it would cost the only
thing that still works and protect nobody.

The client adds `binary_missing`, `not_running`, `timeout`, `write_failed`,
`spawn_failed`, `bridge_exited`, `service_unavailable` and `socket_failed`
locally; the helper never sends those. `service_unavailable` is the socket
transport's, and it names the remedy rather than the errno — a socket that is
not there means the service was never installed, a socket that refuses means it
is installed and stopped, and the two send somebody to different places.

## Lifecycle

1. The client spawns the helper and sends `trusted`.
2. If untrusted, the client stops and tells the user to grant permission. The
   helper prompts only when explicitly asked with `{"op": "trusted", "prompt": true}`.
3. `apps` resolves the target pid. `enableAX` is best-effort and may be skipped.
4. `windows` before any `windowIndex`-scoped traversal. It no longer returns `[]`
   for a window-less application — see "Three ways a window list comes back
   empty" — so a `windowIndex` scope inherits that classification instead of
   silently walking the menu bar.
5. `observe` returns a subscription id; events flow until `unobserve` or exit.
6. `shutdown` answers, then releases this client's sessions, observers and
   handles. Closing the helper's stdin — or dropping the socket — does the same.
   Over stdio the process then exits; over a socket the service stays up for
   every other client. Any request still unanswered when the channel closes is
   failed locally with `bridge_exited`.

A socket client never needs steps 1 and 2 to install anything: the service is
already running and already granted, so `trusted` is a check, not a setup step.
If it answers `false`, somebody has to grant the binary
`~/.work-everything/bin/we-ax` in System Settings once — see
`native/ax-bridge/scripts/install-service.sh`, which prints the exact path and
the `launchctl kickstart` line that picks the grant up.
