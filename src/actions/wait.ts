/**
 * Waiting after an action, so the next reading is of the app's new state.
 *
 * The alternative — letting the caller decide when to look again — produces
 * either a sleep in every call site or a reading of the UI as it was before
 * the click. Codex puts this in the runtime: about a second after an action,
 * plus up to five more while the app still looks busy. That is copied here,
 * with the busy test supplied by the driver rather than assumed, because what
 * "still working" looks like is a property of the reading, not of time.
 */
export interface WaitConfig {
  /** Minimum quiet time between an action and the reading that follows it. */
  readonly settleMs: number;
  /** Extra budget spent only while the app still looks busy or is changing. */
  readonly maxWaitMs: number;
  /** Gap between re-reads while waiting for the app to settle. */
  readonly pollMs: number;
}

export const DEFAULT_WAIT_CONFIG: WaitConfig = { settleMs: 1_000, maxWaitMs: 5_000, pollMs: 250 };

export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

export interface SettleRequest<T> {
  /** Take one reading. Called at least once, more while the app is settling. */
  readonly capture: () => Promise<T>;
  /** Whether this reading shows work still in progress. */
  readonly busy: (reading: T) => boolean;
  /** Whether two consecutive readings are the same. */
  readonly same: (a: T, b: T) => boolean;
}

/**
 * Tracks which apps have been acted on and holds the reading back until the
 * result of that action is on screen.
 */
export class AutoWait {
  private pending: ReadonlyMap<string, number> = new Map();

  constructor(
    private readonly config: WaitConfig = DEFAULT_WAIT_CONFIG,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Record that something was just done to `app`. */
  mark(app: string): void {
    this.pending = new Map(this.pending).set(app, this.clock.now());
  }

  private clear(app: string): void {
    const next = new Map(this.pending);
    next.delete(app);
    this.pending = next;
  }

  /**
   * One settled reading of `app`. With no action outstanding this is a single
   * capture and no delay at all — reading is not slowed down by a policy that
   * exists for writing.
   */
  async settle<T>(app: string, request: SettleRequest<T>): Promise<T> {
    const actedAt = this.pending.get(app);
    if (actedAt === undefined) return await request.capture();
    this.clear(app);

    const quiet = this.config.settleMs - (this.clock.now() - actedAt);
    if (quiet > 0) await this.clock.sleep(quiet);

    let reading = await request.capture();
    const deadline = this.clock.now() + this.config.maxWaitMs;
    // A quiet reading is only trusted once a second one agrees with it: a
    // click that has been accepted but not yet rendered looks exactly like a
    // click that changed nothing.
    while (this.clock.now() < deadline) {
      await this.clock.sleep(this.config.pollMs);
      const again = await request.capture();
      const settled = !request.busy(again) && request.same(reading, again);
      reading = again;
      if (settled) return reading;
    }
    return reading;
  }
}
