/**
 * Whether the Mac is locked — asked once, in one place.
 *
 * This is **not a detector**. It is a cache of the bridge's answer, and that
 * distinction is the whole reason the file exists. A locked Mac does not make
 * accessibility fail, it makes it lie: `AXWindows` returns the right count with
 * every entry substituted by the application element, so a second, local
 * detector built on what this side can see is guaranteed to be wrong somewhere
 * the first one is right. This project has already deleted one such duplicate
 * (`reader.ts` records why: it read the same `CGSSessionScreenIsLocked` key the
 * helper reads, so it was a copy, not a second opinion). There is one source of
 * truth — the helper — and it speaks through two channels:
 *
 * - **The poll.** `windowInfo` reports `screen: {locked, lockedSince?}` and is
 *   the one op that never refuses to answer while locked, because withholding
 *   the diagnosis at the moment somebody needs it would be the wrong trade.
 * - **The refusal.** Any op that has to resolve a window answers
 *   `SCREEN_LOCKED`, which reaches this side as an `ActionError`. Feeding those
 *   in means a lock is known the instant something bumps into it, instead of at
 *   the next poll.
 *
 * Both are the helper's verdict. The asymmetry that keeps them from becoming
 * two sources: a refusal may conclude **locked**, but nothing except a poll
 * that came back `locked: false` may conclude **unlocked**. Inferring an unlock
 * from a call that happened to succeed would be exactly the second detector
 * this file exists to avoid.
 *
 * `unknown` is a real state and is treated as unlocked for gating: a daemon
 * that has not managed to ask yet should act and find out, not silently queue
 * everything. The first refusal corrects it.
 */

export const SCREEN_STATES = ['unknown', 'locked', 'unlocked'] as const;
export type ScreenState = (typeof SCREEN_STATES)[number];

/** The helper's `screen` object, as `windowInfo` and `env` both report it. */
export interface ScreenReading {
  readonly locked: boolean;
  readonly lockedSince?: string | undefined;
}

export interface ScreenLockStatus {
  readonly state: ScreenState;
  /** When this side last learned something, epoch ms. 0 before the first. */
  readonly since: number;
  /** How the current state was learned: `poll`, `refusal`, or `none`. */
  readonly learnedFrom: 'poll' | 'refusal' | 'none';
  /** The helper's own lock timestamp, when it supplied one. */
  readonly lockedSince?: string | undefined;
  /** Why the last poll did not answer, if it did not. */
  readonly lastProbeError?: string | undefined;
}

export interface ScreenLockDeps {
  /** Asks the bridge. Throwing is fine and leaves the known state alone. */
  readonly probe: () => Promise<ScreenReading>;
  readonly now?: () => number;
}

export class ScreenLockSensor {
  private status: ScreenLockStatus = { state: 'unknown', since: 0, learnedFrom: 'none' };

  constructor(private readonly deps: ScreenLockDeps) {}

  current(): ScreenLockStatus {
    return this.status;
  }

  /**
   * Whether GUI work must be deferred right now. Only a known lock defers:
   * `unknown` acts, and learns from what happens.
   */
  get locked(): boolean {
    return this.status.state === 'locked';
  }

  /**
   * Ask the bridge. A probe that throws is recorded and changes nothing: the
   * daemon's picture of the screen must not be reset by a helper that is
   * merely busy, and a bridge that has gone away is not evidence of an unlock.
   */
  async refresh(): Promise<ScreenLockStatus> {
    try {
      const reading = await this.deps.probe();
      this.status = {
        state: reading.locked ? 'locked' : 'unlocked',
        since: this.now(),
        learnedFrom: 'poll',
        ...(reading.lockedSince === undefined ? {} : { lockedSince: reading.lockedSince }),
      };
    } catch (error) {
      this.status = { ...this.status, lastProbeError: error instanceof Error ? error.message : String(error) };
    }
    return this.status;
  }

  /**
   * Record that the bridge refused an op because the screen is locked.
   *
   * Only ever moves the state to `locked`. There is no opposite call, by
   * design — see this file's header.
   */
  noteLocked(detail = 'the bridge refused an op with SCREEN_LOCKED'): ScreenLockStatus {
    this.status = { state: 'locked', since: this.now(), learnedFrom: 'refusal', lockedSince: detail };
    return this.status;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

/** One line for `we queue` and the daemon log. */
export function describeScreen(status: ScreenLockStatus): string {
  switch (status.state) {
    case 'locked':
      return `screen: locked (via ${status.learnedFrom})`;
    case 'unlocked':
      return 'screen: unlocked';
    case 'unknown':
      return `screen: not yet known${status.lastProbeError === undefined ? '' : ` (${status.lastProbeError})`}`;
  }
}
