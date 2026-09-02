import { describe, expect, it } from 'vitest';
import { ScreenSensor, describeBlock, describeScreen, type ScreenReading, type ScreenStatus } from '../src/queue/screen.js';

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

const blockers = (status: ScreenStatus): readonly string[] => status.blockers.map((reading) => reading.blocker);

describe('the screen sensor', () => {
  it('starts unknown, and an unknown screen does not defer anything', async () => {
    const sensor = new ScreenSensor({ probe: scripted([{ locked: false }]).probe });
    expect(sensor.current().state).toBe('unknown');
    expect(sensor.blocked).toBe(false);
    expect(describeScreen(sensor.current())).toContain('not yet known');
  });

  it('takes the bridge at its word in both directions', async () => {
    const sensor = new ScreenSensor({ probe: scripted([{ locked: true, lockedSince: '2026-08-31T10:00:00Z' }, { locked: false }]).probe });

    expect((await sensor.refresh()).state).toBe('blocked');
    expect(sensor.current().blockers[0]?.reportedSince).toBe('2026-08-31T10:00:00Z');
    expect(sensor.current().blockers[0]?.learnedFrom).toBe('poll');

    expect((await sensor.refresh()).state).toBe('available');
    expect(sensor.blocked).toBe(false);
  });

  it('learns a lock from a refusal without waiting for the next poll', () => {
    const sensor = new ScreenSensor({ probe: scripted([{ locked: false }]).probe });
    sensor.note('locked', 'the Mac is locked, so no window can be addressed');
    expect(sensor.blocked).toBe(true);
    expect(sensor.current().blockers[0]?.learnedFrom).toBe('refusal');
    expect(describeScreen(sensor.current())).toBe('screen: locked (via refusal)');
  });

  it('never concludes an unlock from anything but a poll that said so', async () => {
    const sensor = new ScreenSensor({ probe: scripted([new Error('bridge exited')]).probe });
    sensor.note('locked', 'the bridge refused an op with SCREEN_LOCKED');

    // A probe that cannot answer is not evidence of an unlock: a bridge that
    // has gone away is the one moment a naive detector would guess wrong.
    await sensor.refresh();
    expect(sensor.blocked).toBe(true);
    expect(sensor.current().lastProbeError).toContain('bridge exited');
  });

  it('a failed probe leaves a known available state alone too', async () => {
    let fail = false;
    const sensor = new ScreenSensor({
      probe: async () => {
        if (fail) throw new Error('op timed out');
        return { locked: false };
      },
    });
    await sensor.refresh();
    expect(sensor.current().state).toBe('available');

    fail = true;
    await sensor.refresh();
    expect(sensor.current().state).toBe('available');
    expect(sensor.current().lastProbeError).toContain('timed out');
  });

  it('a re-lock after an unlock is picked up on the next poll', async () => {
    const sensor = new ScreenSensor({ probe: scripted([{ locked: false }, { locked: true }]).probe, now: () => 42 });
    await sensor.refresh();
    expect(sensor.blocked).toBe(false);
    await sensor.refresh();
    expect(sensor.blocked).toBe(true);
    expect(sensor.current().since).toBe(42);
    expect(describeScreen(sensor.current())).toBe('screen: locked (via poll)');
  });

  it('a poll that confirms a refusal records one blocker, not two', async () => {
    // The refusal lands first and the next poll agrees. Two entries would make
    // every message about the wait say the same thing twice.
    let now = 100;
    const sensor = new ScreenSensor({ probe: scripted([{ locked: true }]).probe, now: () => now });
    sensor.note('locked', 'the bridge refused an op with SCREEN_LOCKED');

    now = 500;
    await sensor.refresh();
    expect(blockers(sensor.current())).toEqual(['locked']);
    expect(sensor.current().blockers[0]?.learnedFrom).toBe('refusal');
    expect(sensor.current().blockers[0]?.since).toBe(100);
    expect(describeScreen(sensor.current())).toBe('screen: locked (via refusal)');
  });

  it('reports a non-Error rejection as a readable probe failure', async () => {
    const sensor = new ScreenSensor({
      probe: async () => {
        throw 'no bridge';
      },
    });
    await sensor.refresh();
    expect(sensor.current().lastProbeError).toBe('no bridge');
    expect(describeScreen(sensor.current())).toContain('no bridge');
  });

  it('describes an available screen plainly', async () => {
    const sensor = new ScreenSensor({ probe: scripted([{ locked: false }]).probe });
    await sensor.refresh();
    expect(describeScreen(sensor.current())).toBe('screen: available');
  });
});

describe('a full-screen Space, which no poll can see', () => {
  // MEASURED: with Chrome full-screen, 飞书 reported 0 accessibility windows
  // against 6 known to the window server; activating it gave 1 addressable
  // window; going back to Chrome took it away again. `env` reports the lock
  // and nothing about Spaces, so the poll must not be able to clear this.

  it('holds even while every poll says the screen is unlocked', async () => {
    const probe = scripted([{ locked: false }]);
    const sensor = new ScreenSensor({ probe: probe.probe });
    await sensor.refresh();
    expect(sensor.blocked).toBe(false);

    sensor.note('fullscreen_space', 'the active Space belongs to a full-screen application (Google Chrome)');
    expect(sensor.blocked).toBe(true);

    await sensor.refresh();
    await sensor.refresh();
    expect(sensor.blocked).toBe(true);
    expect(blockers(sensor.current())).toEqual(['fullscreen_space']);
    expect(describeScreen(sensor.current())).toBe('screen: a full-screen application owns the active Space (via refusal)');
  });

  it('is lifted by a reading that looked for it and did not find it', () => {
    const sensor = new ScreenSensor({ probe: scripted([{ locked: false }]).probe });
    sensor.note('fullscreen_space', 'the active Space belongs to a full-screen application');

    sensor.clear('fullscreen_space');
    expect(sensor.blocked).toBe(false);
    expect(blockers(sensor.current())).toEqual([]);
  });

  it('clearing something that is not in force changes nothing at all', () => {
    const sensor = new ScreenSensor({ probe: scripted([{ locked: false }]).probe });
    const before = sensor.current();
    expect(sensor.clear('fullscreen_space')).toBe(before);
  });

  it('is held separately from the lock, and neither lifts the other', async () => {
    const sensor = new ScreenSensor({ probe: scripted([{ locked: true }, { locked: false }]).probe });
    await sensor.refresh();
    sensor.note('fullscreen_space', 'a full-screen application owns the active Space');
    expect(blockers(sensor.current())).toEqual(['locked', 'fullscreen_space']);
    expect(describeBlock(sensor.current())).toBe(
      'the screen is locked, and a full-screen application owns the active Space, so no other application has a window',
    );

    // The unlock lifts the lock and says nothing about the Space.
    await sensor.refresh();
    expect(blockers(sensor.current())).toEqual(['fullscreen_space']);
    expect(sensor.blocked).toBe(true);

    sensor.clear('fullscreen_space');
    expect(sensor.blocked).toBe(false);
  });

  it('keeps the reading that first found it, however often it is reported again', () => {
    let now = 100;
    const sensor = new ScreenSensor({ probe: scripted([{ locked: false }]).probe, now: () => now });
    sensor.note('fullscreen_space', 'the active Space belongs to a full-screen application (Google Chrome)');

    now = 900_000;
    const again = sensor.note('fullscreen_space', 'the active Space belongs to a full-screen application (Preview)');
    // How long the wait has run is a fact about the wait, not about the last
    // reading to run into it.
    expect(again.blockers[0]?.since).toBe(100);
    expect(again.blockers[0]?.detail).toContain('Google Chrome');
  });
});
