# we-ax — macOS Accessibility bridge (stdio NDJSON)

A deliberately thin Swift executable that exposes the macOS Accessibility (AX) API over
stdin/stdout as newline-delimited JSON. It is the native half of the TypeScript daemon:
the daemon owns all policy, `we-ax` owns nothing but AX calls.

## Build

```bash
swift build -c release        # requires Xcode 15+/Swift 5.9+, macOS 13+
./.build/release/we-ax        # reads NDJSON on stdin, writes NDJSON on stdout
```

Two checks, both read-only — neither mutates a target app, and the input regression
posts no event anywhere:

```bash
OUT_DIR=/tmp/we-ax scripts/smoke.sh              # AX inspection; defaults to Feishu / Lark
OUT_DIR=/tmp/we-ax scripts/smoke.sh "Safari"
OUT_DIR=/tmp/we-ax scripts/input-regression.sh   # keyboard/mouse event plans, 21 assertions
```

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
| `CG_ERROR` / `INTERNAL` | CGEvent construction failure / unexpected Swift error |

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

## A placeholder that looks like a window

When the accessibility server cannot materialise an application's windows, it does **not**
return an empty list. It returns an application-typed placeholder in the window's slot —
`<AXUIElement Application 0x…> {pid=N}`, `CFEqual` to the app element itself, reporting
`AXRole == "AXApplication"` and no frame. `AXWindows`, `AXChildren` and `AXMainWindow` all do
it. Left alone it makes an application its own child, collapses it onto the root's `nodeId`,
and hands callers a frame-less "window" that every click resolves to nothing.

`AXElement.elementList` drops any element that is `CFEqual` to its parent, so these never
reach the wire; `windows` returns `[]` instead. An element that is its own parent is never
legitimate, so the filter is a no-op on a healthy tree.

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
  nodes, all `AXMenuItem`). Nothing is broken — there is simply nothing to read. Check
  `windows` first and treat an empty array as "ask the user to show the window".
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
