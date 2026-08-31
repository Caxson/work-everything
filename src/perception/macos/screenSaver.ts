/**
 * Whether a screen saver is actually running.
 *
 * This exists because nothing else can see it. Both the session dictionary
 * (`CGSSessionScreenIsLocked`, which is what the helper and the old `ioreg`
 * probe here both read) and every lock check built on it are blind to a
 * screen saver: the session is **not locked** while one runs, and the key is
 * absent throughout. Yet a running screen saver takes accessibility windows
 * away from every application exactly the way a lock does.
 *
 * Measured, on a machine with `legacyScreenSaver` running and the session
 * unlocked: `windows` answered `AX_SEES_NO_WINDOWS_BUT_CG_DOES` with
 * `cgWindows: 5, onScreen: 0, desktopOnScreen: 25, desktopOwnersOnScreen: 8`
 * — and `scope: "application"`, because the helper's rule for "the desktop is
 * not compositing" is `desktopOwnersOnScreen <= 1` and eight processes still
 * had something on screen. So neither the lock state nor `scope` identifies
 * this, and the machine-wide count is no good either: it was measured at 8,
 * 25, 42 and 46 at different moments, healthy and not, so any threshold is a
 * coin toss.
 *
 * Asking whether the process is running is the one direct piece of evidence.
 */
import { execFile } from 'node:child_process';

/** Both spellings: modern engine, and the host for legacy `.saver` bundles. */
const SCREEN_SAVER_PROCESSES = 'ScreenSaverEngine|legacyScreenSaver';

/**
 * Matched against the **process name**, not the command line.
 *
 * `pgrep -f` would also match any process that merely mentions the name —
 * an editor with this file open, a build running these tests — and a false
 * positive here tells somebody to wait for a screen saver that is not there.
 * Verified against a live `legacyScreenSaver` that `-x` matches it, despite
 * the name being displayed truncated to fifteen characters.
 */
const MATCH_PROCESS_NAME = '-x';

export type ScreenSaverProbe = () => Promise<boolean>;

/**
 * Reads the live answer. Any failure answers "not running": this only ever
 * downgrades a diagnosis to the more general one, and claiming a screen saver
 * that is not there would send somebody to wait for nothing.
 */
export const isScreenSaverRunning: ScreenSaverProbe = () =>
  new Promise<boolean>((resolve) => {
    execFile('pgrep', [MATCH_PROCESS_NAME, SCREEN_SAVER_PROCESSES], { timeout: 3_000 }, (error, stdout) => {
      // pgrep exits 1 with no output when nothing matched; that is not a fault.
      resolve(error === null && stdout.trim() !== '');
    });
  });
