// A stand-in for the `we-ax` helper: same wire protocol, no accessibility.
// Used to exercise the client's framing, correlation and error paths.
import { createInterface } from 'node:readline';

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const node = { nodeId: 10, role: 'AXButton', title: 'Send', frame: { x: 0, y: 0, width: 10, height: 10 }, children: [] };

createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  switch (req.op) {
    case 'trusted':
      return send({ id: req.id, ok: true, result: { trusted: true } });
    case 'apps':
      return send({ id: req.id, ok: true, result: [{ pid: 42, name: 'Feishu', bundleId: 'com.feishu.app' }] });
    case 'tree':
      return send({ id: req.id, ok: true, result: { ...node, children: [{ nodeId: 11, role: 'AXStaticText', value: 'hi' }] } });
    case 'windows': {
      if (process.env['FAKE_WINDOWS_LOCKED'] === '1') {
        // The dispatch gate refuses a lock-sensitive op before the handler
        // that would have classified it, so even `meta` arrives as an error.
        return send({
          id: req.id,
          ok: false,
          error: { code: 'SCREEN_LOCKED', message: 'the screen is locked', details: { cgWindows: 2, onScreen: 0 } },
        });
      }
      const list = [{ index: 0, nodeId: 10, role: 'AXWindow', title: 'Send', windowNumber: 7, resolvedBy: 'ax', addressable: true }];
      return send({ id: req.id, ok: true, result: req.meta === true ? { windows: list, diagnosis: { code: 'OK', addressable: 1 } } : list });
    }
    case 'locked':
      // The dispatch gate refuses a lock-sensitive op before it runs.
      return send({
        id: req.id,
        ok: false,
        error: { code: 'SCREEN_LOCKED', message: 'the screen is locked', details: { cgWindows: 2, onScreen: 0 } },
      });
    case 'find':
      // `meta: true` asks for the traversal budget alongside the hits.
      return send({ id: req.id, ok: true, result: req.meta === true ? { nodes: [node], visited: 2, truncated: false } : [node] });
    case 'awaitTree':
      return send({ id: req.id, ok: true, result: { ready: true, nodes: 2, webAreas: 1, truncated: false, polls: 1, elapsedMs: 3 } });
    case 'focusAndType':
      return send({ id: req.id, ok: true, result: { ok: true, focused: { action: 'AXPress' }, typed: { characters: String(req.text ?? '').length } } });
    case 'attr':
      return send({ id: req.id, ok: true, result: 'Send' });
    case 'observe':
      send({ id: req.id, ok: true, result: { subscription: 7 } });
      setTimeout(() => send({ event: 'ax', subscription: 7, notification: 'AXValueChanged', nodeId: 11, pid: 42 }), 10);
      return;
    case 'enableAX':
    case 'setValue':
    case 'press':
    case 'focus':
    case 'keystroke':
    case 'click':
    case 'scroll':
    case 'unobserve':
      return send({ id: req.id, ok: true, result: {} });
    case 'malformed':
      // A bad line must not stop the reader; the good reply still arrives.
      process.stdout.write('not json at all\n');
      process.stdout.write(`${JSON.stringify({ id: req.id, ok: 'maybe' })}\n`);
      return send({ id: req.id, ok: true, result: { fine: true } });
    case 'split': {
      // Deliberately split one message across two writes.
      const payload = JSON.stringify({ id: req.id, ok: true, result: { split: true } });
      process.stdout.write(payload.slice(0, 8));
      return setTimeout(() => process.stdout.write(`${payload.slice(8)}\n`), 5);
    }
    case 'boom':
      return send({ id: req.id, ok: false, error: { code: 'ax_error', message: 'element went away' } });
    case 'silent':
      return;
    case 'bye':
      return process.exit(0);
    default:
      return send({ id: req.id, ok: false, error: { code: 'unknown_op', message: `no op ${req.op}` } });
  }
});
