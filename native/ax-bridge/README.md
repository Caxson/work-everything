# we-ax — macOS Accessibility bridge (stdio NDJSON)

A deliberately thin Swift executable that exposes the macOS Accessibility (AX) API over
stdin/stdout as newline-delimited JSON. It is the native half of the TypeScript daemon:
the daemon owns all policy, `we-ax` owns nothing but AX calls.

## Build

```bash
swift build -c release        # requires Xcode 15+/Swift 5.9+, macOS 13+
./.build/release/we-ax        # reads NDJSON on stdin, writes NDJSON on stdout
```

Smoke test (read-only, never mutates the target app):

```bash
OUT_DIR=/tmp/we-ax-smoke scripts/smoke.sh          # defaults to Feishu / Lark
OUT_DIR=/tmp/we-ax-smoke scripts/smoke.sh "Safari"
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
| `keystroke` | `pid`, `key`, `modifiers?` | `{ok, mode, keyCode?}` |
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

### Keystrokes

`key` is a named key (`return`, `enter`, `tab`, `space`, `delete`, `escape`, `left`/`right`/
`up`/`down`, `home`, `end`, `pageup`, `pagedown`, `f1`–`f12`) or a single character on the
US-ANSI layout. Modifiers: `cmd`, `shift`, `alt`/`option`, `ctrl`, `fn`. A character with no
US keycode is sent as a synthesized unicode event, which cannot carry modifiers — the bridge
returns `BAD_REQUEST` rather than silently dropping them. Events go to the target via
`CGEvent.postToPid`, so the app does not need to be frontmost, but it does need focus for
text to land anywhere useful.

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
