/**
 * Whether the screen can be driven at all — asked once, in one place.
 *
 * This is **not a detector**. It is a cache of the bridge's answers, and that
 * distinction is the whole reason the file exists. Neither state it holds is
 * visible from this side. A locked Mac does not make accessibility fail, it
 * makes it lie: `AXWindows` returns the right count with every entry
 * substituted by the application element. A Space owned by a full-screen
 * application is not exposed to the applications that are not on it at all —
 * macOS composites no window that lives on another Space and accessibility
 * follows the compositor, so with Chrome full-screen 飞书 read 0 windows
 * against 6 known to the window server. A second, local detector built on what
 * this side can see is guaranteed to be wrong somewhere the helper is right,
 * and this project has already deleted one such duplicate (`reader.ts` records
 * why: it read the same `CGSSessionScreenIsLocked` key the helper reads, so it
 * was a copy, not a second opinion).
 *
 * Both states are the same kind of thing — a working machine somebody is
 * using, not a fault, cleared by that person and by nothing else — so both are
 * blockers here rather than one being a special case of the other. Each is set
 * by whatever notices it and cleared only by a reading that looked for it and
 * did not find it, never by a call that happened to succeed:
 *
 * | blocker | set by | cleared by |
 * |---|---|---|
 * | `locked` | the `env` poll, every `SCREEN_LOCKED` refusal, the health verdict | the poll, and nothing else |
 * | `fullscreen_space` | every `FULLSCREEN_SPACE` refusal, the health verdict | a window diagnosis that looked and found no full-screen Space |
 *
 * The asymmetry is not a preference: it is what the two channels can answer.
 * `env` reports `screen: {locked}` and says nothing about Spaces, because the
 * helper takes a Space census only when it has to explain an application's
 * empty window list — `SpaceCensus.read()` is called from `diagnoseEmpty`
 * alone. So the Space's only reading is a window diagnosis, which is what a
 * health verdict carries, and `refresh` can conclude nothing about it either
 * way. That is why `clear` exists and why its type admits only the blockers no
 * poll answers for.
 *
 * `unknown` is a real state and is treated as clear for gating: a daemon that
 * has not managed to ask yet should act and find out, not silently queue
 * everything. The first refusal corrects it.
 */

/** Blockers the `env` poll answers for. `refresh` both sets and clears these. */
export const POLLED_BLOCKERS = ['locked'] as const;

/** Blockers no poll reports. Learned, and unlearned, from readings of an app. */
export const OBSERVED_BLOCKERS = ['fullscreen_space'] as const;

export const SCREEN_BLOCKERS = [...POLLED_BLOCKERS, ...OBSERVED_BLOCKERS] as const;
export type ScreenBlocker = (typeof SCREEN_BLOCKERS)[number];

/** What `clear` may lift. The type carries the rule, so it cannot be misused. */
export type ObservedBlocker = (typeof OBSERVED_BLOCKERS)[number];

export const SCREEN_STATES = ['unknown', 'available', 'blocked'] as const;
export type ScreenState = (typeof SCREEN_STATES)[number];

/** What each blocker is, in the words a held action carries out to a person. */
const CAUSE: Readonly<Record<ScreenBlocker, string>> = {
  locked: 'the screen is locked',
  fullscreen_space: 'a full-screen application owns the active Space, so no other application has a window',
};

/** The same, shortened, for the one-line status. */
const SHORT: Readonly<Record<ScreenBlocker, string>> = {
  locked: 'locked',
  fullscreen_space: 'a full-screen application owns the active Space',
};

/** The helper's `screen` object, as `windowInfo` and `env` both report it. */
export interface ScreenReading {
  readonly locked: boolean;
  readonly lockedSince?: string | undefined;
}

/** One blocker, in force. */
export interface ScreenBlockerReading {
  readonly blocker: ScreenBlocker;
  /** When this side learned it, epoch ms. */
  readonly since: number;
  /** `poll` when it was asked for; `refusal` when something bumped into it. */
  readonly learnedFrom: 'poll' | 'refusal';
  /** The helper's own words about it, for the log and the queued reason. */
  readonly detail: string;
  /** The helper's own clock, when it supplied one. */
  readonly reportedSince?: string | undefined;
}

export interface ScreenStatus {
  readonly state: ScreenState;
  /** Everything in force, oldest first. Empty is not the same as `available`. */
  readonly blockers: readonly ScreenBlockerReading[];
  /** When this side last learned something, epoch ms. 0 before the first. */
  readonly since: number;
  /** Why the last poll did not answer, if it did not. */
  readonly lastProbeError?: string | undefined;
}

export interface ScreenSensorDeps {
  /** Asks the bridge. Throwing is fine and leaves the known state alone. */
  readonly probe: () => Promise<ScreenReading>;
  readonly now?: () => number;
}

export class ScreenSensor {
  private status: ScreenStatus = { state: 'unknown', blockers: [], since: 0 };
  private answered = false;

  constructor(private readonly deps: ScreenSensorDeps) {}

  current(): ScreenStatus {
    return this.status;
  }

  /**
   * Whether screen-bound work must be deferred right now. Only a known
   * blocker defers: `unknown` acts, and learns from what happens.
   */
  get blocked(): boolean {
    return this.status.state === 'blocked';
  }

  /**
   * Ask the bridge about the blockers it can be asked about. A probe that
   * throws is recorded and changes nothing: the daemon's picture of the screen
   * must not be reset by a helper that is merely busy, and a bridge that has
   * gone away is not evidence that anything cleared.
   */
  async refresh(): Promise<ScreenStatus> {
    try {
      const reading = await this.deps.probe();
      this.answered = true;
      this.status = reading.locked
        ? this.settle(
            this.plus({
              blocker: 'locked',
              since: this.now(),
              learnedFrom: 'poll',
              detail: CAUSE.locked,
              ...(reading.lockedSince === undefined ? {} : { reportedSince: reading.lockedSince }),
            }),
          )
        : this.settle(this.minus('locked'));
    } catch (error) {
      this.status = { ...this.status, lastProbeError: error instanceof Error ? error.message : String(error) };
    }
    return this.status;
  }

  /**
   * Record that something bumped into a blocker: a refusal from the bridge, or
   * a health verdict that named it. Only ever adds, and a blocker already in
   * force keeps the reading that first found it — how long the wait has run is
   * a fact about the wait, not about the last thing to run into it.
   */
  note(blocker: ScreenBlocker, detail: string): ScreenStatus {
    if (this.status.blockers.some((reading) => reading.blocker === blocker)) return this.status;
    this.status = this.settle(this.plus({ blocker, since: this.now(), learnedFrom: 'refusal', detail }));
    return this.status;
  }

  /**
   * Record a reading that looked for a blocker and did not find it.
   *
   * Only for the blockers no poll answers for — the parameter type is the
   * rule. The caller must have *looked*: a call that happened to succeed is
   * not evidence, and treating it as evidence is the second detector this file
   * exists to avoid. Clearing something that was not in force is a no-op, so a
   * stream of healthy readings costs nothing.
   */
  clear(blocker: ObservedBlocker): ScreenStatus {
    if (!this.status.blockers.some((reading) => reading.blocker === blocker)) return this.status;
    this.status = this.settle(this.minus(blocker));
    return this.status;
  }

  /**
   * Adding a blocker already in force keeps the reading that first found it: a
   * poll that confirms what a refusal already reported is a second sighting of
   * one state, not a second state, and the wait began when the refusal landed.
   */
  private plus(reading: ScreenBlockerReading): readonly ScreenBlockerReading[] {
    if (this.status.blockers.some((existing) => existing.blocker === reading.blocker)) return this.status.blockers;
    return [...this.status.blockers, reading];
  }

  private minus(blocker: ScreenBlocker): readonly ScreenBlockerReading[] {
    return this.status.blockers.filter((reading) => reading.blocker !== blocker);
  }

  private settle(blockers: readonly ScreenBlockerReading[]): ScreenStatus {
    const state: ScreenState = blockers.length > 0 ? 'blocked' : this.answered ? 'available' : 'unknown';
    return { state, blockers, since: this.now() };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

/** One line for `we queue` and the daemon log. */
export function describeScreen(status: ScreenStatus): string {
  if (status.blockers.length > 0) {
    return `screen: ${status.blockers.map((reading) => `${SHORT[reading.blocker]} (via ${reading.learnedFrom})`).join('; ')}`;
  }
  if (status.state === 'unknown') return `screen: not yet known${status.lastProbeError === undefined ? '' : ` (${status.lastProbeError})`}`;
  return 'screen: available';
}

/** Why work is being held, as a clause. Empty when nothing is blocking it. */
export function describeBlock(status: ScreenStatus): string {
  return status.blockers.map((reading) => CAUSE[reading.blocker]).join(', and ');
}
