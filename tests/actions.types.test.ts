import { describe, expect, it } from 'vitest';
import {
  ACTION_NAMES,
  canonicalButton,
  canonicalDirection,
  isActionName,
  parseActionArgs,
} from '../src/actions/types.js';
import { ActionError } from '../src/actions/errors.js';

describe('the action vocabulary', () => {
  it('is the eleven methods Codex ships, under their own names', () => {
    // Copied verbatim from the bundled SKILL.md. Renaming any of these costs a
    // model the vocabulary it already has.
    expect([...ACTION_NAMES]).toEqual([
      'click',
      'drag',
      'get_app_state',
      'list_apps',
      'paste',
      'perform_secondary_action',
      'press_key',
      'scroll',
      'select_text',
      'set_value',
      'type_text',
    ]);
    expect(isActionName('type_text')).toBe(true);
    expect(isActionName('typeText')).toBe(false);
  });

  it('accepts the short spellings of directions and mouse buttons', () => {
    expect(canonicalDirection('d')).toBe('down');
    expect(canonicalDirection('up')).toBe('up');
    expect(canonicalButton('r')).toBe('right');
    expect(canonicalButton('middle')).toBe('middle');
  });
});

describe('argument validation', () => {
  it('rejects an unknown field rather than ignoring it', () => {
    expect(() => parseActionArgs('type_text', { app: 'Notes', text: 'hi', elementIndex: 3 })).toThrow(ActionError);
  });

  it('demands a target for a click: an index, or both coordinates', () => {
    expect(() => parseActionArgs('click', { app: 'Notes' })).toThrow(/element_index, or both x and y/);
    expect(() => parseActionArgs('click', { app: 'Notes', x: 10 })).toThrow(/element_index, or both x and y/);
    expect(parseActionArgs('click', { app: 'Notes', x: 10, y: 20 })).toMatchObject({ x: 10, y: 20 });
  });

  it('will not take an element_index without the reading it came from', () => {
    expect(() => parseActionArgs('click', { app: 'Notes', element_index: 4 })).toThrow(/snapshot_id/);
    expect(() => parseActionArgs('set_value', { app: 'Notes', element_index: 4, value: 'x' })).toThrow(/snapshot_id/);
    expect(() => parseActionArgs('scroll', { app: 'Notes', element_index: 4, direction: 'down' })).toThrow(/snapshot_id/);
    expect(() => parseActionArgs('perform_secondary_action', { app: 'Notes', element_index: 4, action: 'AXShowMenu' })).toThrow(/snapshot_id/);
    expect(parseActionArgs('click', { app: 'Notes', element_index: 4, snapshot_id: 'a#1' })).toMatchObject({ element_index: 4 });
  });

  it('keeps disableDiff spelled the way Codex spells it', () => {
    expect(parseActionArgs('get_app_state', { app: 'Notes', disableDiff: true })).toEqual({ app: 'Notes', disableDiff: true });
    expect(() => parseActionArgs('get_app_state', { app: 'Notes', disable_diff: true })).toThrow(ActionError);
  });

  it('rejects an empty app, a bad direction and a bad paste format', () => {
    expect(() => parseActionArgs('type_text', { app: '', text: 'x' })).toThrow(/bundle identifier/);
    expect(() => parseActionArgs('scroll', { app: 'a', element_index: 0, snapshot_id: 's', direction: 'sideways' })).toThrow(ActionError);
    expect(() => parseActionArgs('paste', { app: 'a', text: 'x', format: 'rtf' })).toThrow(ActionError);
  });

  it('names the action and the field in the message, so a bad call is debuggable', () => {
    try {
      parseActionArgs('press_key', { app: 'Notes' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ActionError);
      expect((error as ActionError).code).toBe('BAD_ARGS');
      expect((error as ActionError).message).toContain('press_key');
      expect((error as ActionError).message).toContain('key');
    }
  });
});
