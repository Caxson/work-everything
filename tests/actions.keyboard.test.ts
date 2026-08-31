import { describe, expect, it } from 'vitest';
import { bridgeKeyboardRoute, unavailableKeyboardRoute, type FocusAndTypeTransport } from '../src/actions/keyboard.js';
import type { ActionError} from '../src/actions/errors.js';
import { isRetryable } from '../src/actions/errors.js';
import { AxBridgeError } from '../src/perception/macos/axBridge.js';

describe('the write route into web content', () => {
  it('passes the request through when the bridge has it', async () => {
    const seen: unknown[] = [];
    const transport: FocusAndTypeTransport = {
      focusAndType: async (request) => {
        seen.push(request);
        return { focused: true };
      },
    };
    await bridgeKeyboardRoute(transport).focusAndType({ pid: 1, nodeId: 2, text: 'hi', replace: true });
    expect(seen).toEqual([{ pid: 1, nodeId: 2, text: 'hi', replace: true }]);
  });

  it('treats a bridge that reports unlanded focus as a failure, not a success', async () => {
    const transport: FocusAndTypeTransport = { focusAndType: async () => ({ focused: false }) };
    await expect(bridgeKeyboardRoute(transport).focusAndType({ pid: 1, text: 'hi', replace: false })).rejects.toThrow(/sent no keystrokes/);
  });

  it('accepts a bridge that answers with nothing in particular', async () => {
    const transport: FocusAndTypeTransport = { focusAndType: async () => undefined };
    await expect(bridgeKeyboardRoute(transport).focusAndType({ pid: 1, text: 'hi', replace: false })).resolves.toBeUndefined();
  });

  it('reads an unknown op as the route being absent, not as a transient fault', async () => {
    const transport: FocusAndTypeTransport = {
      focusAndType: () => Promise.reject(new AxBridgeError("unsupported op 'focusAndType'", 'BAD_REQUEST')),
    };
    try {
      await bridgeKeyboardRoute(transport).focusAndType({ pid: 1, text: 'hi', replace: false });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ActionError).code).toBe('HYBRID_ROUTE_UNAVAILABLE');
      expect(isRetryable(error)).toBe(false);
    }
  });

  it('passes a real bridge failure through with its own meaning', async () => {
    const transport: FocusAndTypeTransport = { focusAndType: () => Promise.reject(new AxBridgeError('locked', 'SCREEN_LOCKED')) };
    await expect(bridgeKeyboardRoute(transport).focusAndType({ pid: 1, text: 'x', replace: false })).rejects.toMatchObject({ code: 'SCREEN_LOCKED' });
  });

  it('has no fallback that types nothing and reports success', async () => {
    // There is deliberately no third implementation. `setValue` on a
    // contenteditable is the one that lies, and it is not reachable from here.
    try {
      await unavailableKeyboardRoute().focusAndType({ pid: 1, text: 'x', replace: false });
      expect.unreachable('the missing route must never resolve');
    } catch (error) {
      expect((error as ActionError).code).toBe('HYBRID_ROUTE_UNAVAILABLE');
      expect((error as Error).message).toContain('Nothing was typed');
    }
    await expect(unavailableKeyboardRoute('bridge is old').focusAndType({ pid: 1, text: 'x', replace: false })).rejects.toThrow('bridge is old');
  });
});
