import { describe, expect, it } from 'vitest';
import { parseKeySpec, resolveKeyName } from '../src/actions/keys.js';
import { ActionError } from '../src/actions/errors.js';

describe('key names', () => {
  it('speaks the xdotool spellings Codex uses', () => {
    expect(parseKeySpec('Return')).toEqual({ key: 'return', modifiers: [] });
    expect(parseKeySpec('Tab')).toEqual({ key: 'tab', modifiers: [] });
    expect(parseKeySpec('Up')).toEqual({ key: 'up', modifiers: [] });
    expect(parseKeySpec('KP_0')).toEqual({ key: '0', modifiers: [] });
    expect(parseKeySpec('a')).toEqual({ key: 'a', modifiers: [] });
    expect(parseKeySpec('F5')).toEqual({ key: 'f5', modifiers: [] });
  });

  it('maps super to command, which is what a Mac means by it', () => {
    expect(parseKeySpec('super+c')).toEqual({ key: 'c', modifiers: ['cmd'] });
    expect(parseKeySpec('ctrl+alt+Delete')).toEqual({ key: 'forwarddelete', modifiers: ['ctrl', 'alt'] });
  });

  it('keeps backspace and forward delete apart', () => {
    // The Mac key labelled Delete erases backwards; the bridge calls the
    // forward one forwarddelete. Swapping them deletes the wrong side.
    expect(resolveKeyName('BackSpace')).toBe('delete');
    expect(resolveKeyName('Delete')).toBe('forwarddelete');
  });

  it('orders modifiers the same way every time, whatever order they arrive in', () => {
    expect(parseKeySpec('shift+super+a').modifiers).toEqual(['cmd', 'shift']);
    expect(parseKeySpec('super+shift+a').modifiers).toEqual(['cmd', 'shift']);
  });

  it('deduplicates a repeated modifier', () => {
    expect(parseKeySpec('cmd+command+a').modifiers).toEqual(['cmd']);
  });

  it('reads a trailing plus as the plus key, separator or not', () => {
    expect(parseKeySpec('super++')).toEqual({ key: '+', modifiers: ['cmd'] });
    expect(parseKeySpec('+')).toEqual({ key: '+', modifiers: [] });
  });

  it('refuses to guess an unknown key rather than typing something else', () => {
    expect(() => parseKeySpec('Bananas')).toThrow(ActionError);
    expect(() => parseKeySpec('hyper+a')).toThrow(/unknown modifier/);
    expect(() => parseKeySpec('   ')).toThrow(/needs a key/);
  });
});
