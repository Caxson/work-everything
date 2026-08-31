/**
 * The system pasteboard, borrowed and given back.
 *
 * `paste` exists because typing is the wrong tool for long or multi-line
 * text: every newline sent to a message composer is a send. Codex's version
 * restores whatever the user had on the clipboard afterwards, and so does
 * this one — the clipboard belongs to the person at the keyboard, not to the
 * daemon.
 */
import { execFile } from 'node:child_process';

export interface Clipboard {
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

/** Runs one command, optionally feeding it stdin. Injectable so a test never
 *  reaches for the real pasteboard, which belongs to whoever is at the Mac. */
export type CommandRunner = (command: string, args: readonly string[], input?: string) => Promise<string>;

export const execRunner: CommandRunner = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(command, [...args], { timeout: 5_000, maxBuffer: 4_000_000 }, (error, stdout) => {
      if (error === null) resolve(stdout);
      else reject(new Error(`${command} failed: ${error.message}`));
    });
    if (input !== undefined) child.stdin?.end(input);
  });

/** The macOS pasteboard, through the two commands that have always spoken it. */
export function pasteboard(run: CommandRunner = execRunner): Clipboard {
  return {
    read: () => run('pbpaste', []),
    write: async (text) => {
      await run('pbcopy', [], text);
    },
  };
}

export const systemClipboard: Clipboard = pasteboard();

/**
 * Do `body` with `text` on the clipboard, then put back what was there.
 * The restore runs even when the body throws: a failed paste must not also
 * cost the user their clipboard.
 */
export async function withClipboard<T>(clipboard: Clipboard, text: string, body: () => Promise<T>): Promise<T> {
  const previous = await clipboard.read().catch(() => '');
  await clipboard.write(text);
  try {
    return await body();
  } finally {
    await clipboard.write(previous).catch(() => undefined);
  }
}
