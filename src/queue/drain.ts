/**
 * Letting the queue out again, once the screen can be driven.
 *
 * Every action here was authorized minutes ago against a world that has since
 * been out of sight. So nothing is simply replayed: each one passes three
 * gates on the way out, in this order, and the order is the design.
 *
 * 1. **TTL.** Cheapest, and the only one that can be answered without touching
 *    anything. An action past its expiry is dropped and never shown to anyone —
 *    there is no point asking a person to approve a reply to a conversation
 *    that moved on half an hour ago.
 * 2. **Premise.** Costs a read of the live world, and runs *before* the trust
 *    gate on purpose. Handing a person an action whose target no longer exists
 *    is worse than dropping it: it asks them to approve something incoherent,
 *    and an approval is exactly the wrong thing to collect for it.
 * 3. **Authority.** Free arithmetic, last, and it never drops anything. An
 *    action that outlived its permission to run unattended is handed back as a
 *    pending confirmation, with its premise already verified, so the question a
 *    person is asked is one that still makes sense.
 *
 * **Order is strict.** The queue drains oldest-first and a premise that is
 * merely `not_yet` — the conversation it answers is not the one on screen —
 * stops the drain rather than being skipped. Skipping would let a later reply
 * into the same conversation overtake an earlier one, which is a visible,
 * confusing reordering in somebody's chat window; a blocked head only delays,
 * and its own TTL bounds how long it can. That trade is made deliberately in
 * favour of order.
 *
 * **Nothing is retried.** An action that came out of the queue, ran, and failed
 * is settled as failed — including when it failed because the screen went away
 * again mid-run. It has already touched the world; putting it back would be the
 * daemon deciding on its own to repeat a write, which is the class of mistake
 * this whole mechanism exists to prevent.
 */
import { executeChain } from '../core/engine.js';
import type { ToolRunner } from '../execution/base.js';
import type { DeferredStore } from '../memory/deferred.js';
import type { DeferralConfig, DeferredAction } from './deferred.js';
import { authorityLapsed, describeAge, describeChain, hasExpired } from './deferred.js';
import type { QueueJournal } from './journal.js';
import type { PreconditionRegistry } from './preconditions.js';
import type { ScreenSensor } from './screen.js';
import { describeBlock, describeScreen } from './screen.js';

export interface DrainReport {
  readonly executed: readonly DeferredAction[];
  readonly discarded: readonly DeferredAction[];
  readonly handedBack: readonly DeferredAction[];
  /** Set when the drain stopped early: the screen went, or the head cannot run yet. */
  readonly stoppedBecause?: string | undefined;
}

const EMPTY_REPORT: DrainReport = { executed: [], discarded: [], handedBack: [] };

export interface QueueDrainerDeps {
  readonly sensor: ScreenSensor;
  readonly store: DeferredStore;
  readonly journal: QueueJournal;
  readonly preconditions: PreconditionRegistry;
  readonly runner: ToolRunner;
  readonly config: DeferralConfig;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly log?: (line: string) => void;
}

export class QueueDrainer {
  private busy = false;

  constructor(private readonly deps: QueueDrainerDeps) {}

  /**
   * Whether a pass is in progress. The gate reads this so live work joins the
   * back of the queue instead of overtaking what has been waiting.
   */
  get draining(): boolean {
    return this.busy;
  }

  /**
   * One pass: ask the bridge about the screen, then drain if it is open.
   *
   * The poll runs **even when the queue is empty**, and that is the point
   * rather than an oversight. This is the only thing that tells the gate the
   * screen is locked *before* an action needs it; skip it while idle and the
   * first action after every lock is admitted against a stale reading, runs,
   * and fails — the exact outcome the queue exists to prevent. One bridge
   * round-trip per interval is what that costs.
   *
   * It answers for the lock and nothing else. A full-screen Space is not
   * reported by any op that takes no window, so it is learned and unlearned
   * from the health monitor's readings instead — see `queue/screen.ts`.
   */
  async tick(): Promise<DrainReport> {
    // A queue switched off still expires what it is holding. Rows queued
    // before the flag was turned off would otherwise sit pending forever,
    // never run and never dropped, with `we queue` still promising they will
    // go out — which is worse than either running them or admitting they are
    // gone. Nothing new is queued and nothing is executed.
    if (!this.deps.config.enabled) return await this.expireOnly();

    await this.deps.sensor.refresh();
    if (this.deps.sensor.blocked) {
      if (this.deps.store.pendingCount() === 0) return EMPTY_REPORT;
      return { ...EMPTY_REPORT, stoppedBecause: `${describeScreen(this.deps.sensor.current())}; nothing that needs a window will run yet` };
    }
    if (this.deps.store.pendingCount() === 0) return EMPTY_REPORT;
    return await this.drain();
  }

  /** Drop what has aged out, without running or even polling anything. */
  private async expireOnly(): Promise<DrainReport> {
    const now = this.now();
    const discarded = this.deps.store
      .pending()
      .filter((action) => hasExpired(action, now))
      .map((action) =>
        this.discard(
          action,
          'expired',
          'dropped without running: it aged out while the queue was switched off (queue.enabled is false)',
          now,
        ),
      );
    return await Promise.resolve({ executed: [], discarded, handedBack: [] });
  }

  /**
   * Run the queue down, oldest first, against a screen believed to be open.
   * Takes the pending list once: anything queued while this is running belongs
   * to the next pass, and must not overtake what is already ahead of it.
   */
  async drain(): Promise<DrainReport> {
    this.busy = true;
    try {
      return await this.pass();
    } finally {
      this.busy = false;
    }
  }

  private async pass(): Promise<DrainReport> {
    const executed: DeferredAction[] = [];
    const discarded: DeferredAction[] = [];
    const handedBack: DeferredAction[] = [];
    let stoppedBecause: string | undefined;

    for (const action of this.deps.store.pending()) {
      if (this.deps.sensor.blocked) {
        stoppedBecause = `the screen went away again mid-drain (${describeBlock(this.deps.sensor.current())}); the rest stays queued`;
        break;
      }

      const outcome = await this.release(action);
      if (outcome.kind === 'blocked') {
        stoppedBecause = outcome.detail;
        break;
      }
      if (outcome.kind === 'executed') executed.push(outcome.action);
      else if (outcome.kind === 'handed_back') handedBack.push(outcome.action);
      else discarded.push(outcome.action);
    }

    if (stoppedBecause !== undefined) this.log(`[queue] ${stoppedBecause}`);
    return { executed, discarded, handedBack, ...(stoppedBecause === undefined ? {} : { stoppedBecause }) };
  }

  /** Run the loop until the signal aborts. Exceptions are logged, never fatal. */
  async run(signal?: AbortSignal): Promise<void> {
    // Read through a function, not a narrowed expression: an `await` in this
    // loop is exactly when the signal changes, and the compiler cannot see it.
    const aborted = (): boolean => signal?.aborted === true;
    while (!aborted()) {
      try {
        await this.tick();
      } catch (error) {
        this.log(`[queue] drain failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (aborted()) break;
      await this.sleep(Math.max(1, this.deps.config.pollIntervalMs), signal);
    }
  }

  // --- one action ----------------------------------------------------------

  private async release(action: DeferredAction): Promise<ReleaseOutcome> {
    const now = this.now();

    if (hasExpired(action, now)) {
      const detail =
        `dropped without running: it waited ${describeAge(action.enqueuedAt, now)} for a screen it could use, past the ` +
        'point where it was still the action that was authorized';
      return { kind: 'discarded', action: this.discard(action, 'expired', detail, now) };
    }

    const premise = await this.deps.preconditions.check(action.precondition);
    if (premise.state === 'broken') {
      const detail = `dropped without running: ${premise.detail}`;
      const status = this.deps.preconditions.knows(action.precondition.kind) ? 'precondition_broken' : 'unverifiable';
      return { kind: 'discarded', action: this.discard(action, status, detail, now) };
    }
    if (premise.state === 'not_yet') {
      return { kind: 'blocked', detail: `holding '${action.purpose}' at the head of the queue: ${premise.detail}` };
    }

    if (authorityLapsed(action, now)) {
      const detail =
        `waited ${describeAge(action.enqueuedAt, now)}, longer than the window in which it counted as already ` +
        `approved, so it is not running on its own; its premise still holds (${premise.detail})`;
      const settled = this.deps.store.settle(action, 'trust_reset', detail, now, this.deps.config.historyLimit);
      this.deps.journal.handedBack(settled, detail);
      this.log(`[queue] ${settled.id} needs confirming again: ${action.purpose}`);
      return { kind: 'handed_back', action: settled };
    }

    // The premise check reads the live world and can take seconds. Ask the
    // clock once more at the door: an action must not start because it was
    // fresh when the check began.
    const atTheDoor = this.now();
    if (hasExpired(action, atTheDoor)) {
      const detail =
        `dropped without running: it expired while its premise was being re-checked, after waiting ` +
        `${describeAge(action.enqueuedAt, atTheDoor)} for a screen it could use`;
      return { kind: 'discarded', action: this.discard(action, 'expired', detail, atTheDoor) };
    }

    return { kind: 'executed', action: await this.execute(action, premise.detail) };
  }

  private async execute(action: DeferredAction, premise: string): Promise<DeferredAction> {
    // Claimed before it runs. A process that dies after this line comes back
    // to a `running` row, which is never replayed — see `recoverInterrupted`.
    const claimed = this.deps.store.claim(action, this.now());
    const result = await executeChain(claimed.chain, { runner: this.deps.runner, vars: claimed.vars });
    this.deps.journal.executed(claimed, result, premise);

    const lostTheScreen = !result.ok && this.deps.sensor.blocked;
    const detail = result.ok
      ? `ran '${describeChain(claimed)}' once the screen was usable again`
      : lostTheScreen
        ? `the screen went away again while it was running (${describeBlock(this.deps.sensor.current())}); failed at ` +
          `${result.failedTools.join(', ') || 'an unknown step'} and was not put back, because part of it may already have happened`
        : `failed at ${result.failedTools.join(', ') || 'an unknown step'}`;
    const settled = this.deps.store.settle(action, result.ok ? 'executed' : 'failed', detail, this.now(), this.deps.config.historyLimit);
    this.log(`[queue] ${result.ok ? 'ran' : 'failed'} ${settled.id}: ${action.purpose}`);
    return settled;
  }

  private discard(action: DeferredAction, status: 'expired' | 'precondition_broken' | 'unverifiable', detail: string, now: number): DeferredAction {
    const settled = this.deps.store.settle(action, status, detail, now, this.deps.config.historyLimit);
    this.deps.journal.discarded(settled, detail);
    this.log(`[queue] discarded ${settled.id} (${status}): ${action.purpose}`);
    return settled;
  }

  // --- plumbing ------------------------------------------------------------

  private log(line: string): void {
    this.deps.log?.(line);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.deps.sleep !== undefined) return this.deps.sleep(ms, signal);
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

type ReleaseOutcome =
  | { readonly kind: 'executed'; readonly action: DeferredAction }
  | { readonly kind: 'discarded'; readonly action: DeferredAction }
  | { readonly kind: 'handed_back'; readonly action: DeferredAction }
  | { readonly kind: 'blocked'; readonly detail: string };
