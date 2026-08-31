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
    await bridgeKeyboardRoute(transport).focusAndType({ pid: 1, nodeId: 2, text: 'hi' });
    expect(seen).toEqual([{ pid: 1, nodeId: 2, text: 'hi' }]);
  });

  it('treats a bridge that reports unlanded focus as a failure, not a success', async () => {
    const transport: FocusAndTypeTransport = { focusAndType: async () => ({ focused: false }) };
    await expect(bridgeKeyboardRoute(transport).focusAndType({ pid: 1, nodeId: 5, text: 'hi' })).rejects.toMatchObject({ code: 'FOCUS_FAILED' });
  });

  it('says what a failed focus already did, instead of only what it did not do', async () => {
    // `keysSent: 0` is true and reads too generously. The auto order is press,
    // then the focused attribute, then a real click — so a failure means a
    // click has already landed at the element centre. In a chat window that
    // can hit a message or a link, and a caller told only "no keys were sent"
    // will happily retry it.
    const transport: FocusAndTypeTransport = {
      focusAndType: () =>
        Promise.reject(
          new AxBridgeError('could not put the caret in node 5, so no keys were sent', 'FOCUS_FAILED', {
            attempted: ['press', 'focused', 'click'],
            keysSent: 0,
          }),
        ),
    };
    try {
      await bridgeKeyboardRoute(transport).focusAndType({ pid: 1, nodeId: 5, text: 'hi' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const failure = error as ActionError;
      expect(failure.message).toContain('no keys were sent');
      expect(failure.message).toContain('real mouse click at the element centre');
      expect(failure.message).toContain('Not retried');
      // And the marker a retry loop has to respect.
      expect(isRetryable(failure)).toBe(false);
    }
  });

  it('does not claim a click happened when the helper says it never tried one', async () => {
    // An explicit `focusVia` never reaches the click strategy, so the warning
    // would be false. Saying it anyway would make it noise everyone learns to
    // ignore, including in the case where it is true.
    const transport: FocusAndTypeTransport = {
      focusAndType: () =>
        Promise.reject(new AxBridgeError('focusVia=press only, and it did not apply', 'FOCUS_FAILED', { attempted: ['press'], keysSent: 0 })),
    };
    try {
      await bridgeKeyboardRoute(transport).focusAndType({ pid: 1, nodeId: 5, text: 'hi' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ActionError).message).not.toContain('real mouse click');
      expect((error as ActionError).code).toBe('FOCUS_FAILED');
    }
  });

  it('accepts a bridge that answers with nothing in particular', async () => {
    const transport: FocusAndTypeTransport = { focusAndType: async () => undefined };
    await expect(bridgeKeyboardRoute(transport).focusAndType({ pid: 1, nodeId: 5, text: 'hi' })).resolves.toBeUndefined();
  });

  it('reads an unknown op as the route being absent, not as a transient fault', async () => {
    const transport: FocusAndTypeTransport = {
      focusAndType: () => Promise.reject(new AxBridgeError("unsupported op 'focusAndType'", 'BAD_REQUEST')),
    };
    try {
      await bridgeKeyboardRoute(transport).focusAndType({ pid: 1, nodeId: 5, text: 'hi' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ActionError).code).toBe('HYBRID_ROUTE_UNAVAILABLE');
      expect(isRetryable(error)).toBe(false);
    }
  });

  it('carries the helper’s proof that nothing was typed, as a fact and not as prose', async () => {
    // `keysSent: 0` is checkable; "sent no keystrokes" in a sentence is not.
    const transport: FocusAndTypeTransport = {
      focusAndType: () =>
        Promise.reject(
          new AxBridgeError('could not put the caret in node 5, so no keys were sent', 'FOCUS_FAILED', {
            attempted: ['press', 'focused', 'click'],
            claimedSuccess: ['press'],
            keysSent: 0,
          }),
        ),
    };
    try {
      await bridgeKeyboardRoute(transport).focusAndType({ pid: 1, nodeId: 5, text: 'hi' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ActionError).code).toBe('FOCUS_FAILED');
      expect((error as ActionError).details).toMatchObject({ keysSent: 0, claimedSuccess: ['press'] });
    }
  });

  it('passes a real bridge failure through with its own meaning', async () => {
    const transport: FocusAndTypeTransport = { focusAndType: () => Promise.reject(new AxBridgeError('locked', 'SCREEN_LOCKED')) };
    await expect(bridgeKeyboardRoute(transport).focusAndType({ pid: 1, nodeId: 5, text: 'x' })).rejects.toMatchObject({ code: 'SCREEN_LOCKED' });
  });

  it('has no fallback that types nothing and reports success', async () => {
    // There is deliberately no third implementation. `setValue` on a
    // contenteditable is the one that lies, and it is not reachable from here.
    try {
      await unavailableKeyboardRoute().focusAndType({ pid: 1, nodeId: 5, text: 'x' });
      expect.unreachable('the missing route must never resolve');
    } catch (error) {
      expect((error as ActionError).code).toBe('HYBRID_ROUTE_UNAVAILABLE');
      expect((error as Error).message).toContain('Nothing was typed');
    }
    await expect(unavailableKeyboardRoute('bridge is old').focusAndType({ pid: 1, nodeId: 5, text: 'x' })).rejects.toThrow('bridge is old');
  });
});
