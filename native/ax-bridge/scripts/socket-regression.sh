#!/usr/bin/env bash
# Regression for serve mode: the socket transport, and the client isolation it has to give.
#
# It starts a bridge of its own on a throwaway socket, drives it with several concurrent
# clients, and stops it. Nothing is posted to any application: every op used here either
# reads (`apps`, `env`, `tree` at depth 0, `attr`) or is expected to fail (`bgRelease` on a
# session nobody opened).
#
# The isolation assertions are the reason this exists. Two clients sharing one process both
# number their handles from 1, and a bridge that let client A's `nodeId: 1` resolve to
# client B's element would not report an error — it would click the wrong window and answer
# `ok: true`. So the test mints a handle in each of two connections against *different*
# applications and reads the titles back.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/.build/release/we-ax"
OUT_DIR="${OUT_DIR:-${TMPDIR:-/tmp}/we-ax-socket}"
mkdir -p "$OUT_DIR"
[ -x "$BIN" ] || { echo "missing $BIN — run: swift build -c release" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "socket-regression needs node" >&2; exit 1; }

SOCKET="$OUT_DIR/we-ax-test.sock"
rm -f "$SOCKET"
"$BIN" --serve "$SOCKET" > "$OUT_DIR/serve.out" 2> "$OUT_DIR/serve.err" &
SERVER_PID=$!
trap 'kill -TERM "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; exit' EXIT

for _ in 1 2 3 4 5 6 7 8 9 10; do [ -S "$SOCKET" ] && break; sleep 0.2; done
[ -S "$SOCKET" ] || { echo "server never bound $SOCKET" >&2; cat "$OUT_DIR/serve.err" >&2; exit 1; }

cat > "$OUT_DIR/drive.mjs" <<'DRIVER_EOF'
import net from 'node:net';
const socket = process.argv[2];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  return new Promise((resolve, reject) => {
    const replies = new Map();
    const c = net.connect(socket);
    let buffer = '';
    c.on('data', (d) => {
      buffer += d.toString('utf8');
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) if (line.trim()) { const m = JSON.parse(line); replies.set(m.id, m); }
    });
    c.on('error', reject);
    c.on('connect', () => resolve({
      c, replies,
      send: (o) => c.write(JSON.stringify(o) + '\n'),
      get: (id) => replies.get(id),
    }));
  });
}

const out = {};
const a = await client();
const b = await client();

a.send({ id: 1, op: 'env' });
b.send({ id: 1, op: 'env' });
a.send({ id: 2, op: 'apps' });
b.send({ id: 2, op: 'bgRelease', session: 987654321 });
b.send({ id: 3, op: 'not-an-op' });
await wait(500);

out.aTransport = a.get(1)?.result?.transport;
out.aConnection = a.get(1)?.result?.connection;
out.bConnection = b.get(1)?.result?.connection;
out.distinctConnections = out.aConnection !== out.bConnection;
out.unknownSession = b.get(2)?.error?.code;
out.unknownOp = b.get(3)?.error?.code;

// `apps` is the largest reply this protocol produces on a normal machine — a few
// kilobytes, more than one socket write. It is asserted on its own because a channel
// that dies part-way through a long reply looks exactly like a client that went quiet,
// and that is precisely how a non-blocking accepted socket failed here once.
const apps = a.get(2)?.result ?? [];
out.appsReplied = Array.isArray(apps) && apps.length > 0;
const first = apps[0];
const second = apps.find((x) => x.pid !== first?.pid);
if (first && second) {
  a.send({ id: 3, op: 'tree', pid: first.pid, maxDepth: 0 });
  b.send({ id: 4, op: 'tree', pid: second.pid, maxDepth: 0 });
  await wait(700);
  out.aRootNodeId = a.get(3)?.result?.[0]?.nodeId ?? a.get(3)?.error?.code;
  out.bRootNodeId = b.get(4)?.result?.[0]?.nodeId ?? b.get(4)?.error?.code;
  a.send({ id: 5, op: 'attr', nodeId: 1, name: 'AXTitle' });
  b.send({ id: 6, op: 'attr', nodeId: 1, name: 'AXTitle' });
  await wait(700);
  const aTitle = a.get(5)?.result ?? a.get(5)?.error?.code;
  const bTitle = b.get(6)?.result ?? b.get(6)?.error?.code;
  out.handlesResolveApart = aTitle !== bTitle;
  out.aTitle = aTitle;
  out.bTitle = bTitle;
}

// One client leaving must not take the others with it.
b.send({ id: 9, op: 'shutdown' });
await wait(400);
out.shutdownAck = b.get(9)?.ok === true;
a.send({ id: 10, op: 'env' });
await wait(400);
out.survivorAnswers = a.get(10)?.ok === true;

const c = await client();
c.send({ id: 1, op: 'env' });
await wait(400);
out.newClientConnection = c.get(1)?.result?.connection;
out.newClientAfterShutdown = out.newClientConnection > out.bConnection;

a.c.destroy();
c.c.destroy();
console.log(JSON.stringify(out));
process.exit(0);
DRIVER_EOF

node "$OUT_DIR/drive.mjs" "$SOCKET" > "$OUT_DIR/socket.json" 2> "$OUT_DIR/drive.err"
[ -s "$OUT_DIR/socket.json" ] || { echo "driver produced nothing:" >&2; cat "$OUT_DIR/drive.err" >&2; exit 1; }

PASS=0; FAIL=0
check() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf 'ok   %s\n' "$1"
  else FAIL=$((FAIL+1)); printf 'FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fi
}
q() { jq -r "$1" "$OUT_DIR/socket.json"; }

# 1 — the transport answers, and says which one it is.
check "serve mode answers env"          "socket" "$(q '.aTransport')"
check "first client is connection 1"    "1"      "$(q '.aConnection')"
check "second client is a different id" "true"   "$(q '.distinctConnections')"

# 2 — the same protocol, including the errors. A socket client must not get a different
#     answer to the same bad request than a stdio client does.
check "unknown session still refused"   "NO_SUCH_SESSION" "$(q '.unknownSession')"
check "unknown op still refused"        "BAD_REQUEST"     "$(q '.unknownOp')"

# 3 — a reply bigger than one socket write has to arrive whole.
check "a multi-kilobyte reply arrives" "true" "$(q '.appsReplied')"

# 4 — handles are per connection. Both clients hold nodeId 1 and they are different
#     elements; a shared registry would make one of these titles the other's.
if [ "$(q '.aRootNodeId')" = "NOT_TRUSTED" ]; then
  printf 'skip handle isolation: this bridge is not trusted for Accessibility\n'
else
  check "each client mints nodeId 1"      "1,1"  "$(q '[.aRootNodeId,.bRootNodeId]|join(",")')"
  check "nodeId 1 means different things" "true" "$(q '.handlesResolveApart')"
fi

# 5 — shutdown ends one client, not the service.
check "shutdown is acknowledged"        "true" "$(q '.shutdownAck')"
check "other clients keep working"      "true" "$(q '.survivorAnswers')"
check "the service still accepts"       "true" "$(q '.newClientAfterShutdown')"

# 6 — SIGTERM is how launchd stops a job; it must not leave the address bound.
kill -TERM "$SERVER_PID" 2>/dev/null
wait "$SERVER_PID" 2>/dev/null
trap - EXIT
if [ -S "$SOCKET" ]; then check "SIGTERM removes the socket file" "gone" "still there"
else check "SIGTERM removes the socket file" "gone" "gone"; fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
