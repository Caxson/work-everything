# `we-ax` bridge protocol

The TypeScript client (`src/perception/macos/axBridge.ts`) and the Swift
helper (`native/ax-bridge`) implement this document. It is the contract
between them; neither side may extend it unilaterally.

## Transport

One JSON object per line (NDJSON) over the helper's stdin and stdout. UTF-8,
`\n` as the delimiter, no framing headers. Anything the helper writes to
stderr is diagnostics, never protocol.

A message arriving in either direction may be split across pipe writes; both
sides buffer until a newline. A line the helper cannot parse is answered with
a failure carrying `"id": -1` — it never terminates the connection. The client
skips lines it cannot parse.

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
| `shutdown` | — | `{"ok": true}`, then the helper exits |

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

`nodeId` is a handle allocated by the helper process. It is meaningful only to
the helper that issued it and only for the lifetime of that process. The same
element always receives the same handle within one process, across ops. A
handle says nothing about whether the underlying element still exists — an op
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

`AX_ERROR` is **parameterized**: the code carries the numeric `AXError` inside
parentheses, e.g. `AX_ERROR(-25205)` for `attributeUnsupported`. Clients that
switch on codes must match the prefix, not the whole string. The symbolic name
is in `error.message`.

Every op except `trusted`, `apps` and `shutdown` is gated on accessibility
permission and answers `NOT_TRUSTED` when it is missing.

The client adds `binary_missing`, `not_running`, `timeout`, `write_failed`,
`spawn_failed` and `bridge_exited` locally; the helper never sends those.

## Lifecycle

1. The client spawns the helper and sends `trusted`.
2. If untrusted, the client stops and tells the user to grant permission. The
   helper prompts only when explicitly asked with `{"op": "trusted", "prompt": true}`.
3. `apps` resolves the target pid. `enableAX` is best-effort and may be skipped.
4. `windows` before any `windowIndex`-scoped traversal: an application with no
   AX-materialised window returns `[]`, and the tree is then just its menu bar.
5. `observe` returns a subscription id; events flow until `unobserve` or exit.
6. `shutdown` answers, releases observers and exits. Closing the helper's stdin
   does the same. Any request still unanswered when the pipe closes is failed
   locally with `bridge_exited`.
