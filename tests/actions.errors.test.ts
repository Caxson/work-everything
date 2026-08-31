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
