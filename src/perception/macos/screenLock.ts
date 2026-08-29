/**
 * Whether the login session's screen is locked.
 *
 * This matters because a locked Mac makes every GUI app look broken through
 * the accessibility API: the window server stops vending windows, so an app
 * that is running perfectly reports zero `AXWindows` and an empty tree. Told
 * apart from a genuinely wedged app, "the screen is locked" is a wait; not
 * told apart, it reads as a fault and invites a pointless restart of the
 * user's application. It cost this project exactly that mistake once.
 *
 * `ioreg` is used rather than a native binding because the value lives in
 * `IOConsoleUsers` on the IORegistry root and nothing needs to be linked to
 * read it.
 */
import { execFile } from 'node:child_process';

const LOCK_KEY = 'CGSSessionScreenIsLocked';

/** Extracts the flag from an `ioreg -n Root -d1 -w0` dump. Absent means unlocked. */
export function parseScreenLocked(ioregOutput: string): boolean {
  const match = new RegExp(`"?${LOCK_KEY}"?\\s*=\\s*(Yes|No|true|false)`, 'i').exec(ioregOutput);
  if (match === null) return false;
  const value = (match[1] ?? '').toLowerCase();
  return value === 'yes' || value === 'true';
}

export type ScreenLockProbe = () => Promise<boolean>;

/**
 * Reads the live value. Any failure answers "not locked": this only ever
 * downgrades a diagnosis, and guessing "locked" would hide a real fault.
 */
export const isScreenLocked: ScreenLockProbe = () =>
  new Promise<boolean>((resolve) => {
    execFile('ioreg', ['-n', 'Root', '-d1', '-w0'], { timeout: 3_000, maxBuffer: 4_000_000 }, (error, stdout) => {
      resolve(error === null ? parseScreenLocked(stdout) : false);
    });
  });
