import { describe, expect, it } from 'vitest';
import { execRunner, pasteboard, withClipboard, type Clipboard, type CommandRunner } from '../src/actions/clipboard.js';

function fakeClipboard(initial: string, options: { readFails?: boolean } = {}): Clipboard & { readonly writes: string[]; current: () => string } {
  const writes: string[] = [];
  let held = initial;
  return {
    writes,
    current: () => held,
    read: async () => {
      if (options.readFails === true) throw new Error('pbpaste is not here');
      return held;
    },
    write: async (text) => {
      writes.push(text);
      held = text;
    },
  };
}

describe('borrowing the clipboard', () => {
  it('puts back what the user had', async () => {
    const clipboard = fakeClipboard('a link they were about to paste');
    await withClipboard(clipboard, 'the reply', async () => undefined);
    expect(clipboard.writes).toEqual(['the reply', 'a link they were about to paste']);
    expect(clipboard.current()).toBe('a link they were about to paste');
  });

  it('puts it back even when the paste failed', async () => {
    // A failed action must not also cost somebody their clipboard.
    const clipboard = fakeClipboard('theirs');
    await expect(
      withClipboard(clipboard, 'ours', async () => {
        throw new Error('keystroke refused');
      }),
    ).rejects.toThrow('keystroke refused');
    expect(clipboard.current()).toBe('theirs');
  });

  it('carries the body result back out', async () => {
    expect(await withClipboard(fakeClipboard(''), 'x', async () => 'done')).toBe('done');
  });

  it('still works when the previous contents could not be read', async () => {
    const clipboard = fakeClipboard('unreadable', { readFails: true });
    await withClipboard(clipboard, 'ours', async () => undefined);
    expect(clipboard.writes).toEqual(['ours', '']);
  });
});

describe('the macOS pasteboard', () => {
  it('reads with pbpaste and writes with pbcopy on stdin', async () => {
    const calls: { command: string; args: readonly string[]; input?: string }[] = [];
    const run: CommandRunner = async (command, args, input) => {
      calls.push({ command, args, ...(input === undefined ? {} : { input }) });
      return 'held text';
    };
    const clipboard = pasteboard(run);
    expect(await clipboard.read()).toBe('held text');
    await clipboard.write('new text');
    expect(calls).toEqual([
      { command: 'pbpaste', args: [] },
      { command: 'pbcopy', args: [], input: 'new text' },
    ]);
  });

  it('names the command that failed', async () => {
    // `false` exits non-zero and reads nothing, so no pasteboard is touched.
    await expect(execRunner('false', [])).rejects.toThrow(/false failed/);
    await expect(execRunner('true', [], 'ignored')).resolves.toBe('');
  });
});
