import { describe, expect, it } from 'vitest';
import { ActionError, TERMINAL_ACTION_CODES, isRetryable, toActionError } from '../src/actions/errors.js';
import { AxBridgeError } from '../src/perception/macos/axBridge.js';

describe('what is worth trying again', () => {
  it('never retries a locked screen: only a person can change that', () => {
    const error = toActionError(new AxBridgeError('windows are not addressable', 'SCREEN_LOCKED'), 'mac_ax.click');
    expect(error.code).toBe('SCREEN_LOCKED');
    expect(isRetryable(error)).toBe(false);
    expect(error.message).toContain('locked');
    expect(error.message).toContain('not retried');
    expect(TERMINAL_ACTION_CODES.has('SCREEN_LOCKED')).toBe(true);
  });

  it('never retries a missing write path, an unsupported action or a stale index', () => {
    for (const code of ['HYBRID_ROUTE_UNAVAILABLE', 'UNSUPPORTED_ACTION', 'STALE_SNAPSHOT', 'NOT_TRUSTED', 'APP_NOT_RUNNING'] as const) {
      expect(isRetryable(new ActionError(code, 'x'))).toBe(false);
    }
  });

  it('never retries a failed focus, because repeating it is not free', () => {
    // The only member of this set that is here for causing harm rather than
    // for being hopeless: establishing focus ends in a real click, so a retry
    // loop clicks into the window again on every pass.
    expect(isRetryable(new ActionError('FOCUS_FAILED', 'no keys were sent'))).toBe(false);
    expect(TERMINAL_ACTION_CODES.has('FOCUS_FAILED')).toBe(true);
  });

  it('does retry a timeout, a transport fault and an app that is still loading', () => {
    expect(isRetryable(new ActionError('DRIVER_ERROR', 'timed out'))).toBe(true);
    expect(isRetryable(new ActionError('TREE_NOT_READY', 'stub'))).toBe(true);
    expect(isRetryable(new ActionError('NOT_CONNECTED', 'no socket'))).toBe(true);
    expect(isRetryable(new Error('something else'))).toBe(true);
  });

  it('maps the bridge codes that mean something specific', () => {
    expect(toActionError(new AxBridgeError('no permission', 'NOT_TRUSTED'), 'x').code).toBe('NOT_TRUSTED');
    expect(toActionError(new AxBridgeError('gone', 'NO_SUCH_PID'), 'x').code).toBe('APP_NOT_RUNNING');
    expect(toActionError(new AxBridgeError('stub', 'tree_not_ready'), 'x').code).toBe('TREE_NOT_READY');
    expect(toActionError(new AxBridgeError('no focus', 'FOCUS_FAILED'), 'x').code).toBe('FOCUS_FAILED');
  });

  it('keeps an ActionError as it is, and names the context on anything else', () => {
    const original = new ActionError('BAD_ARGS', 'nope');
    expect(toActionError(original, 'ctx')).toBe(original);
    expect(toActionError(new Error('boom'), 'mac_ax.click').message).toBe('mac_ax.click: boom');
    expect(toActionError('boom', 'ctx').code).toBe('DRIVER_ERROR');
  });
});
