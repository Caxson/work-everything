/**
 * Key names in, key events out.
 *
 * The action layer speaks the xdotool-style syntax Codex uses — `"a"`,
 * `"Return"`, `"super+c"`, `"KP_0"` — because that is the vocabulary a model
 * already has; the bridge speaks its own shorter set. This file is the only
 * place the two meet, and it refuses to guess: an unrecognised key name is an
 * error, never a best-effort character. Guessing here means posting the wrong
 * keystroke into somebody's chat window.
 */
import { ActionError } from './errors.js';

export interface KeyChord {
  /** A bridge key name, or a single character. */
  readonly key: string;
  /** Bridge modifier names, deduplicated, in a stable order. */
  readonly modifiers: readonly string[];
}

/** xdotool / X11 modifier spellings → the bridge's four. */
const MODIFIERS: Readonly<Record<string, string>> = {
  super: 'cmd',
  cmd: 'cmd',
  command: 'cmd',
  meta: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
  fn: 'fn',
};

const MODIFIER_ORDER: readonly string[] = ['cmd', 'ctrl', 'alt', 'shift', 'fn'];

/**
 * X11 keysyms → bridge key names. Note `BackSpace` and `Delete`: on a Mac the
 * key labelled Delete erases backwards, and the bridge calls the forward one
 * `forwarddelete`. Mapping them the other way round silently deletes the
 * wrong side of the caret.
 */
const KEYSYMS: Readonly<Record<string, string>> = {
  return: 'return',
  enter: 'return',
  kp_enter: 'return',
  tab: 'tab',
  space: 'space',
  backspace: 'delete',
  delete: 'forwarddelete',
  escape: 'escape',
  esc: 'escape',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  home: 'home',
  end: 'end',
  prior: 'pageup',
  page_up: 'pageup',
  pageup: 'pageup',
  next: 'pagedown',
  page_down: 'pagedown',
  pagedown: 'pagedown',
};

function functionKey(name: string): string | undefined {
  return /^f([1-9]|1[0-2])$/.test(name) ? name : undefined;
}

function numpadKey(name: string): string | undefined {
  const match = /^kp_(\d)$/.exec(name);
  return match?.[1];
}

/** One key name → the bridge's spelling. */
export function resolveKeyName(raw: string): string {
  const name = raw.toLowerCase();
  const known = KEYSYMS[name] ?? functionKey(name) ?? numpadKey(name);
  if (known !== undefined) return known;
  if ([...raw].length === 1) return raw;
  throw new ActionError('BAD_ARGS', `unknown key '${raw}': use a single character or a key name such as Return, Tab, Up, F5, KP_0`);
}

/**
 * `"super+shift+c"` → `{ key: 'c', modifiers: ['cmd', 'shift'] }`.
 *
 * A spec that ends in `+` is naming the plus key, which is also the
 * separator: `"super++"` is command-plus, and `"+"` on its own is the key.
 */
export function parseKeySpec(spec: string): KeyChord {
  const trimmed = spec.trim();
  if (trimmed === '') throw new ActionError('BAD_ARGS', 'press_key needs a key');

  if (trimmed.endsWith('+')) {
    const parts = trimmed.slice(0, -1).split('+');
    return { key: '+', modifiers: toModifiers(parts, spec) };
  }
  const parts = trimmed.split('+');
  const key = parts.pop() ?? '';
  return { key: resolveKeyName(key), modifiers: toModifiers(parts, spec) };
}

/** Modifier spellings → the bridge's names, deduplicated and ordered. */
function toModifiers(parts: readonly string[], spec: string): readonly string[] {
  const found: string[] = [];
  for (const part of parts) {
    if (part === '') continue;
    const modifier = MODIFIERS[part.toLowerCase()];
    if (modifier === undefined) throw new ActionError('BAD_ARGS', `unknown modifier '${part}' in '${spec}': use super, ctrl, alt or shift`);
    if (!found.includes(modifier)) found.push(modifier);
  }
  return MODIFIER_ORDER.filter((name) => found.includes(name));
}
