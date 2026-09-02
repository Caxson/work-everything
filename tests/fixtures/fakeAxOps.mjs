// The stand-in helper's behaviour, with no transport attached to it.
//
// Extracted so the stdio fixture and the socket fixture answer identically. The client now
// speaks the same protocol two ways, and a fixture that only existed for one of them would
// let the two drift while both suites stayed green.
const node = { nodeId: 10, role: 'AXButton', title: 'Send', frame: { x: 0, y: 0, width: 10, height: 10 }, children: [] };

/**
 * @param req  the decoded request
 * @param io   { send, raw, close, env } — `raw` writes unframed bytes, `close` ends the
 *             channel (the process on stdio, one connection on a socket)
 */
export function handleRequest(req, io) {
  const { send, raw, close } = io;
  const env = io.env ?? process.env;
  switch (req.op) {
    case 'trusted':
      return send({ id: req.id, ok: true, result: { trusted: true } });
    case 'apps':
      return send({ id: req.id, ok: true, result: [{ pid: 42, name: 'Feishu', bundleId: 'com.feishu.app' }] });
    case 'tree':
      return send({ id: req.id, ok: true, result: { ...node, children: [{ nodeId: 11, role: 'AXStaticText', value: 'hi' }] } });
    case 'windows': {
      if (env['FAKE_WINDOWS_LOCKED'] === '1') {
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
    case 'env':
      // Machine-wide, no pid, not gated on trust: the right place to ask
      // whether the Mac is locked, and it keeps working when nothing is running.
      return send({
        id: req.id,
        ok: true,
        result: {
          trusted: env['FAKE_UNTRUSTED'] !== '1',
          screen: env['FAKE_LOCKED'] === '1' ? { locked: true, lockedSince: '2026-08-31 10:00:00 +0000' } : { locked: false },
        },
      });
    case 'windowInfo':
      // The diagnostic op is not gated on the screen being unlocked: it is the
      // one thing that still answers while a lock is in force.
      return send({
        id: req.id,
        ok: true,
        result: {
          pid: req.pid,
          windows: [],
          diagnosis: { code: env['FAKE_LOCKED'] === '1' ? 'SCREEN_LOCKED' : 'OK' },
          screen: env['FAKE_LOCKED'] === '1' ? { locked: true, lockedSince: '2026-08-31 10:00:00 +0000' } : { locked: false },
        },
      });
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
      raw('not json at all\n');
      raw(`${JSON.stringify({ id: req.id, ok: 'maybe' })}\n`);
      return send({ id: req.id, ok: true, result: { fine: true } });
    case 'split': {
      // Deliberately split one message across two writes.
      const payload = JSON.stringify({ id: req.id, ok: true, result: { split: true } });
      raw(payload.slice(0, 8));
      return setTimeout(() => raw(`${payload.slice(8)}\n`), 5);
    }
    case 'boom':
      return send({ id: req.id, ok: false, error: { code: 'ax_error', message: 'element went away' } });
    case 'silent':
      return;
    case 'bye':
      return close();
    default:
      return send({ id: req.id, ok: false, error: { code: 'unknown_op', message: `no op ${req.op}` } });
  }
}
