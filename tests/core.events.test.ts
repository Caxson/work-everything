import { describe, expect, it } from 'vitest';
import { eventText, parseEvent, safeParseEvent } from '../src/core/events.js';

const base = { traceId: 't1', source: 'feishu', kind: 'message.received', ts: 1_700_000_000_000 };

describe('events', () => {
  it('parses a valid event and defaults the payload', () => {
    const event = parseEvent(base);
    expect(event.payload).toEqual({});
  });

  it('rejects unknown sources and extra keys', () => {
    expect(() => parseEvent({ ...base, source: 'irc' })).toThrow();
    expect(() => parseEvent({ ...base, surprise: 1 })).toThrow();
  });

  it('reports why an event was rejected without throwing', () => {
    const result = safeParseEvent({ ...base, ts: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('ts');
  });

  it('accepts nested payload values', () => {
    const event = parseEvent({ ...base, payload: { text: 'hi', meta: { tags: ['a', 1, null] } } });
    expect(event.payload['meta']).toEqual({ tags: ['a', 1, null] });
  });

  it('joins known text keys in a fixed order and skips blanks', () => {
    const event = parseEvent({ ...base, payload: { text: 'deploy failed', message: '   ', command: 'npm test', other: 'ignored' } });
    expect(eventText(event)).toBe('deploy failed npm test');
  });

  it('is empty when no text-bearing key is present', () => {
    expect(eventText(parseEvent({ ...base, payload: { pid: 42 } }))).toBe('');
  });
});
