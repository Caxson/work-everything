# `we-ax` bridge protocol

The TypeScript client (`src/perception/macos/axBridge.ts`) and the Swift
helper (`native/ax-bridge`) implement this document. It is the contract
between them; neither side may extend it unilaterally.

## Transport

One JSON object per line (NDJSON) over the helper's stdin and stdout. UTF-8,
`\n` as the delimiter, no framing headers. Anything the helper writes to
stderr is diagnostics, never protocol.

A message arriving in either direction may be split across pipe writes; both
sides buffer until a newline. A line that is not valid JSON, or does not
validate against the shapes below, is logged and skipped — it never
terminates the connection.

## Requests (client → helper)

```json
{"id": 1, "op": "tree", "pid": 42, "maxDepth": 8, "maxNodes": 2000}
```

- `id` — positive integer, unique per client process, monotonically increasing.
- `op` — one of the operations below.
- Remaining keys are that op's parameters, inlined at the top level.

## Responses (helper → client)

Exactly one response per request, carrying the request's `id`.

```json
{"id": 1, "ok": true,  "result": { }}
{"id": 1, "ok": false, "error": {"code": "ax_error", "message": "element went away"}}
```

`error.code` is a stable machine-readable token; `error.message` is for a
human and must not contain user data beyond what the caller already supplied.

## Events (helper → client)

Unsolicited, delivered while a subscription is live. No `id`.

```json
{"event": "ax", "subscription": 7, "notification": "AXValueChanged", "nodeId": 11, "pid": 42}
```

## Operations

| op | params | result |
|---|---|---|
| `trusted` | — | `{"trusted": boolean}` |
| `apps` | — | `[{"pid": number, "name": string, "bundleId": string}]` |
| `enableAX` | `pid` | `{}` |
| `tree` | `pid`, `maxDepth`, `maxNodes` | one node (see below) |
| `find` | `pid`, `selector` | array of nodes |
| `attr` | `nodeId`, `name` | the attribute value |
| `setValue` | `nodeId`, `value` | `{}` |
| `press` | `nodeId` | `{}` |
| `focus` | `nodeId` | `{}` |
| `keystroke` | `pid`, `key`, `modifiers?` | `{}` |
| `observe` | `pid`, `notifications`, `nodeId?` | `{"subscription": number}` |
| `unobserve` | `subscription` | `{}` |

### Node

```json
{
  "nodeId": 11,
  "role": "AXButton",
  "subrole": "AXCloseButton",
  "title": "Send",
  "value": "hello",
  "description": "Send message",
  "identifier": "send-button",
  "frame": {"x": 0, "y": 0, "width": 80, "height": 24},
  "children": []
}
```

Only `nodeId` and `role` are required; every other field is omitted when the
element does not expose it. `children` is omitted at the depth or node limit.

`nodeId` is a handle allocated by the helper process. It is meaningful only to
the helper that issued it, only for the lifetime of that process, and it says
nothing about whether the underlying element still exists — an op naming a
stale node returns an error, it does not crash.

### Selector

```json
{"role": "AXButton", "title": "Send", "identifier": "send-button", "valueContains": "draft", "maxResults": 20}
```

Every field is optional; those present are combined with AND. `title` and
`identifier` match exactly, `valueContains` is a substring match, `maxResults`
caps the returned array.

### Keystroke

`key` is a single character or a named key (`return`, `tab`, `escape`,
`space`, `delete`, `up`, `down`, `left`, `right`, `f1`…`f12`). `modifiers` is
any of `cmd`, `shift`, `alt`, `ctrl`, `fn`.

## Error codes

| code | meaning |
|---|---|
| `not_trusted` | accessibility permission has not been granted |
| `unknown_op` | the op is not in this document |
| `bad_params` | a required parameter is missing or the wrong type |
| `no_such_process` | no running process with that pid |
| `no_such_node` | the `nodeId` is unknown or its element is gone |
| `ax_error` | the accessibility API refused the operation |
| `unsupported` | the element does not support the requested action |

The client adds `binary_missing`, `not_running`, `timeout`, `write_failed`,
`spawn_failed` and `bridge_exited` locally; the helper never sends those.

## Lifecycle

1. The client spawns the helper and sends `trusted`.
2. If untrusted, the client stops and tells the user to grant permission; the
   helper does not prompt on its own.
3. `apps` and `enableAX` before any per-process op.
4. `observe` returns a subscription id; events flow until `unobserve` or exit.
5. On SIGTERM the helper releases its observers and exits. Any request still
   unanswered when the pipe closes is failed locally with `bridge_exited`.
