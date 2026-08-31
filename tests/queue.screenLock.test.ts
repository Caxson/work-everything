import { describe, expect, it } from 'vitest';
import { ScreenLockSensor, describeScreen, type ScreenReading } from '../src/queue/screenLock.js';

/** A probe whose answers are scripted, so nothing here reads a real screen. */
function scripted(answers: readonly (ScreenReading | Error)[]): { probe: () => Promise<ScreenReading>; calls: () => number } {
  let index = 0;
  return {
    probe: async () => {
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      if (answer instanceof Error) throw answer;
      return answer ?? { locked: false };
    },
    calls: () => index,
  };
}

describe('the screen lock sensor', () => {
  it('starts unknown, and an unknown screen does not defer anything', async () => {
    const sensor = new ScreenLockSensor({ probe: scripted([{ locked: false }]).probe });
    expect(sensor.current().state).toBe('unknown');
    expect(sensor.locked).toBe(false);
    expect(describeScreen(sensor.current())).toContain('not yet known');
  });

  it('takes the bridge at its word in both directions', async () => {
    const sensor = new ScreenLockSensor({ probe: scripted([{ locked: true, lockedSince: '2026-08-31T10:00:00Z' }, { locked: false }]).probe });

    expect((await sensor.refresh()).state).toBe('locked');
    expect(sensor.current().lockedSince).toBe('2026-08-31T10:00:00Z');
    expect(sensor.current().learnedFrom).toBe('poll');

    expect((await sensor.refresh()).state).toBe('unlocked');
    expect(sensor.locked).toBe(false);
  });

  it('learns a lock from a refusal without waiting for the next poll', () => {
    const sensor = new ScreenLockSensor({ probe: scripted([{ locked: false }]).probe });
    sensor.noteLocked('the Mac is locked, so no window can be addressed');
    expect(sensor.locked).toBe(true);
    expect(sensor.current().learnedFrom).toBe('refusal');
    expect(describeScreen(sensor.current())).toBe('screen: locked (via refusal)');
  });

  it('never concludes an unlock from anything but a poll that said so', async () => {
    const sensor = new ScreenLockSensor({ probe: scripted([new Error('bridge exited')]).probe });
    sensor.noteLocked();

    // A probe that cannot answer is not evidence of an unlock: a bridge that
    // has gone away is the one moment a naive detector would guess wrong.
    await sensor.refresh();
    expect(sensor.locked).toBe(true);
    expect(sensor.current().lastProbeError).toContain('bridge exited');
  });

  it('a failed probe leaves a known unlocked state alone too', async () => {
    let fail = false;
    const sensor = new ScreenLockSensor({
      probe: async () => {
        if (fail) throw new Error('op timed out');
        return { locked: false };
      },
    });
    await sensor.refresh();
    expect(sensor.current().state).toBe('unlocked');

    fail = true;
    await sensor.refresh();
    expect(sensor.current().state).toBe('unlocked');
    expect(sensor.current().lastProbeError).toContain('timed out');
  });

  it('a re-lock after an unlock is picked up on the next poll', async () => {
    const sensor = new ScreenLockSensor({ probe: scripted([{ locked: false }, { locked: true }]).probe, now: () => 42 });
    await sensor.refresh();
    expect(sensor.locked).toBe(false);
    await sensor.refresh();
    expect(sensor.locked).toBe(true);
    expect(sensor.current().since).toBe(42);
    expect(describeScreen(sensor.current())).toBe('screen: locked (via poll)');
  });

  it('reports a non-Error rejection as a readable probe failure', async () => {
    const sensor = new ScreenLockSensor({
      probe: async () => {
        throw 'no bridge';
      },
    });
    await sensor.refresh();
    expect(sensor.current().lastProbeError).toBe('no bridge');
    expect(describeScreen(sensor.current())).toContain('no bridge');
  });

  it('describes an unlocked screen plainly', async () => {
    const sensor = new ScreenLockSensor({ probe: scripted([{ locked: false }]).probe });
    await sensor.refresh();
    expect(describeScreen(sensor.current())).toBe('screen: unlocked');
  });
});
