import { describe, expect, it } from 'vitest';
import { isScreenSaverRunning } from '../src/perception/macos/screenSaver.js';

describe('the screen saver probe', () => {
  it('answers a boolean whatever the machine is doing, and never throws', async () => {
    // Whether a screen saver is running on the machine running these tests is
    // not the test — both answers are correct, and asserting either would make
    // the suite fail for a reason that has nothing to do with the code. What
    // is asserted is the contract every caller depends on: it resolves, it
    // resolves to a boolean, and a probe that cannot run answers `false`
    // rather than rejecting into the middle of a health check.
    expect(typeof (await isScreenSaverRunning())).toBe('boolean');
  });

  it('answers the same way twice, so a health check cannot flap on it', async () => {
    const [first, second] = await Promise.all([isScreenSaverRunning(), isScreenSaverRunning()]);
    expect(first).toBe(second);
  });
});
