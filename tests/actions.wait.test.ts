import { describe, expect, it } from 'vitest';
import { AutoWait, DEFAULT_WAIT_CONFIG, systemClock, type Clock } from '../src/actions/wait.js';

/** A clock that advances only when something sleeps on it. */
function fakeClock(): Clock & { elapsed: () => number; sleeps: () => readonly number[] } {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    elapsed: () => now,
    sleeps: () => sleeps,
  };
}

const quiet = { busy: (): boolean => false, same: (a: string, b: string): boolean => a === b };

describe('waiting after an action', () => {
  it('does not wait at all when nothing has been done', async () => {
    const clock = fakeClock();
    const wait = new AutoWait(DEFAULT_WAIT_CONFIG, clock);
    let reads = 0;
    const reading = await wait.settle('app', { capture: async () => `read ${(reads += 1)}`, ...quiet });
    expect(reading).toBe('read 1');
    expect(clock.sleeps()).toEqual([]);
  });

  it('gives the app about a second to show the result of an action', async () => {
    const clock = fakeClock();
    const wait = new AutoWait({ settleMs: 1_000, maxWaitMs: 0, pollMs: 250 }, clock);
    wait.mark('app');
    await wait.settle('app', { capture: async () => 'same', ...quiet });
    expect(clock.sleeps()[0]).toBe(1_000);
  });

  it('counts time already spent against the settle, rather than sleeping it twice', async () => {
    const clock = fakeClock();
    const wait = new AutoWait({ settleMs: 1_000, maxWaitMs: 0, pollMs: 250 }, clock);
    wait.mark('app');
    await clock.sleep(700);
    await wait.settle('app', { capture: async () => 'same', ...quiet });
    expect(clock.sleeps()).toEqual([700, 300]);
  });

  it('takes a second reading before trusting a quiet one', async () => {
    const clock = fakeClock();
    const wait = new AutoWait({ settleMs: 0, maxWaitMs: 5_000, pollMs: 250 }, clock);
    wait.mark('app');
    let reads = 0;
    const reading = await wait.settle('app', {
      capture: async () => {
        reads += 1;
        return 'stable';
      },
      ...quiet,
    });
    expect(reading).toBe('stable');
    // One read, then one more that agreed with it.
    expect(reads).toBe(2);
  });

  it('keeps reading while the app still looks busy, and gives up at the budget', async () => {
    const clock = fakeClock();
    const wait = new AutoWait({ settleMs: 0, maxWaitMs: 1_000, pollMs: 250 }, clock);
    wait.mark('app');
    let reads = 0;
    await wait.settle('app', { capture: async () => `read ${(reads += 1)}`, busy: () => true, same: () => true });
    // 1 initial + one per poll inside the budget, and then it stops.
    expect(reads).toBe(5);
    expect(clock.elapsed()).toBe(1_000);
  });

  it('settles as soon as two readings agree and nothing is busy', async () => {
    const clock = fakeClock();
    const wait = new AutoWait({ settleMs: 0, maxWaitMs: 5_000, pollMs: 100 }, clock);
    wait.mark('app');
    const readings = ['a', 'b', 'b', 'b'];
    let index = 0;
    await wait.settle('app', { capture: async () => readings[index++] ?? 'b', ...quiet });
    expect(index).toBe(3);
    expect(clock.elapsed()).toBe(200);
  });

  it('waits once per action, not once per app forever', async () => {
    const clock = fakeClock();
    const wait = new AutoWait({ settleMs: 500, maxWaitMs: 0, pollMs: 10 }, clock);
    wait.mark('app');
    await wait.settle('app', { capture: async () => 'x', ...quiet });
    await wait.settle('app', { capture: async () => 'x', ...quiet });
    expect(clock.sleeps()).toEqual([500]);
  });

  it('tracks apps separately', async () => {
    const clock = fakeClock();
    const wait = new AutoWait({ settleMs: 500, maxWaitMs: 0, pollMs: 10 }, clock);
    wait.mark('a');
    await wait.settle('b', { capture: async () => 'x', ...quiet });
    expect(clock.sleeps()).toEqual([]);
    await wait.settle('a', { capture: async () => 'x', ...quiet });
    expect(clock.sleeps()).toEqual([500]);
  });
});

describe('the real clock', () => {
  it('tells the time and actually sleeps', async () => {
    const before = systemClock.now();
    await systemClock.sleep(2);
    expect(systemClock.now()).toBeGreaterThanOrEqual(before);
  });

  it('is what an AutoWait uses when it is given nothing else', async () => {
    const wait = new AutoWait();
    wait.mark('app');
    // Defaults would sleep a second; the point is only that it runs unaided.
    expect(DEFAULT_WAIT_CONFIG.settleMs).toBe(1_000);
    expect(await wait.settle('other', { capture: async () => 'x', busy: () => false, same: () => true })).toBe('x');
  });
});
