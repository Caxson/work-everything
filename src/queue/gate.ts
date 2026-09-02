/**
 * The admission gate: what happens to an action when the screen cannot be
 * driven — because the Mac is locked, or because a full-screen application
 * owns the active Space and every other application reads as having no window.
 *
 * The daemon asks this before it runs a chain, and the only two answers are
 * "go ahead" and "not now, I have kept it". There is no third answer where the
 * chain runs and fails, and that is the point: neither state is a failing
 * scenario. Letting the run proceed would spend a trust demotion — and, after
 * a few of them, a quarantine — on a machine that was working perfectly and a
 * person who was at lunch or reading something full screen. Refusing admission
 * costs the scenario nothing, because nothing about it was tried.
 *
 * What is *not* deferred matters as much as what is. A chain with no
 * screen-bound tool in it runs normally throughout: shell work, reading,
 * anything that never asks the window server for a window. Perception is
 * untouched by this file entirely — it never passes through here. An
 * unavailable screen stops the daemon from *acting*, not from *watching*,
 * which is the whole shape of the policy.
 *
 * The gate refuses in two different ways, and the difference is deliberate:
 *
 * - **Queued.** The action's premise could be captured, so it is stored with
 *   the facts needed to re-check it later.
 * - **Dropped as unverifiable.** Nothing could say what this action assumed
 *   about the world. It is recorded as a discard rather than queued, because a
 *   premise-free action is exactly the thing that must not be replayed after an
 *   unknown wait — and queueing it would only park it until a dequeue-time
 *   check refused it anyway, with the reason arriving later and less clearly.
 */
import type { Scenario } from '../core/scenario.js';
import { chainSteps } from '../core/scenario.js';
import type { DeferredStore } from '../memory/deferred.js';
import type { DeferralConfig, DeferredAction, PreconditionCheck } from './deferred.js';
import { describeChain } from './deferred.js';
import type { QueueJournal } from './journal.js';
import type { ScreenSensor } from './screen.js';
import { describeBlock } from './screen.js';

/** What the daemon wants to run. */
export interface AdmissionRequest {
  readonly traceId: string;
  readonly chain: Scenario;
  /** The rendered variable bag; the deferred chain is replayed against it. */
  readonly vars: Readonly<Record<string, string>>;
}

/** The premise and purpose of one action, as its owner describes it. */
export interface DeferralCapture {
  readonly purpose: string;
  readonly precondition: PreconditionCheck;
}

/**
 * Says what an action is for and what it assumed. `undefined` means "I cannot
 * describe this one", which is a refusal to let it be replayed later.
 */
export type CaptureFn = (request: AdmissionRequest) => DeferralCapture | undefined;

export type Admission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: string; readonly action?: DeferredAction | undefined };

/** The seam the daemon holds. Implemented here; injected there. */
export interface ExecutionGate {
  admit(request: AdmissionRequest): Promise<Admission>;
  /**
   * Whether the screen is unavailable *now*.
   *
   * Asked after a chain has already failed, to decide whose fault it was. The
   * screen is learned about between actions, so there is a window between a
   * Mac locking — or somebody going full screen — and this side hearing about
   * it, in which a chain is admitted, runs, and fails on a screen that went
   * away underneath it. The bridge's refusal closes the window for every action
   * after that one, but the one caught inside it must still not be charged for
   * it, because a demotion there is a scenario losing standing over the user
   * pressing a key.
   */
  screenIsUnavailable(): boolean;
}

export interface ActionGateDeps {
  readonly sensor: ScreenSensor;
  /**
   * Whether a drain is in progress. Defaults to never.
   *
   * The daemon and the drainer are two async loops over one runner, and during
   * a drain the screen is available — so without this a freshly-arrived reply is
   * admitted and races ahead of replies that have been waiting minutes, which
   * is the visible reordering the queue exists to prevent. Queueing it instead
   * puts it at the back, where it belongs.
   */
  readonly busy?: () => boolean;
  readonly store: DeferredStore;
  readonly journal: QueueJournal;
  /** Tools that cannot run while the screen is unavailable. Others may. */
  readonly screenBound: ReadonlySet<string>;
  readonly capture: CaptureFn;
  readonly config: DeferralConfig;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export class ActionGate implements ExecutionGate {
  constructor(private readonly deps: ActionGateDeps) {}

  async admit(request: AdmissionRequest): Promise<Admission> {
    if (!this.deps.config.enabled) return { admitted: true };
    if (!this.needsScreen(request.chain)) return { admitted: true };
    if (!this.deps.sensor.blocked && this.deps.busy?.() !== true) return { admitted: true };
    return this.defer(request);
  }

  screenIsUnavailable(): boolean {
    return this.deps.sensor.blocked;
  }

  /** Whether any step of this chain has to address a window to do its work. */
  needsScreen(chain: Scenario): boolean {
    return chainSteps(chain.chain).some((step) => this.deps.screenBound.has(step.tool));
  }

  private defer(request: AdmissionRequest): Admission {
    const now = this.now();
    const capture = this.deps.capture(request);
    if (capture === undefined) {
      return this.dropUndescribable(request, now);
    }

    const { action, dropped } = this.deps.store.add(
      { traceId: request.traceId, chain: request.chain, vars: request.vars, purpose: capture.purpose, precondition: capture.precondition },
      this.deps.config,
      now,
    );
    this.recordEvictions(dropped);

    // The sensor's own words for whatever is in force, so a new blocker is
    // explained by the thing that knows about it rather than named here.
    const cause = this.deps.sensor.blocked
      ? describeBlock(this.deps.sensor.current())
      : 'the queue is draining, and this must not overtake what is already waiting';
    const reason =
      `${cause}, so '${describeChain(action)}' was queued as ${action.id} instead of run; ` +
      `it will be re-checked and executed in order, and discarded if it is still waiting in ` +
      `${Math.round((action.expiresAt - now) / 1000)}s`;
    this.deps.journal.deferred(action, reason);
    this.log(`[queue] deferred ${action.id}: ${capture.purpose}`);
    return { admitted: false, reason, action };
  }

  /**
   * Record an undescribable action as a discard. It goes through the store so
   * `we queue` shows it beside everything else that did not happen, rather than
   * existing only as a line in the trajectory.
   */
  private dropUndescribable(request: AdmissionRequest, now: number): Admission {
    const detail =
      `nothing could say what '${request.chain.id}' assumed about the world, so it was not queued: ` +
      'an action whose premise cannot be re-checked must not be replayed after an unknown wait';
    const { action, dropped } = this.deps.store.add(
      {
        traceId: request.traceId,
        chain: request.chain,
        vars: request.vars,
        purpose: `${request.chain.name} (no premise captured)`,
        precondition: { kind: '', facts: {} },
      },
      this.deps.config,
      now,
    );
    // Recorded even here. This action is about to be refused, but it still
    // passed through the capacity check on its way in, and anything it pushed
    // out is a real queued action that will never run.
    this.recordEvictions(dropped);
    const settled = this.deps.store.settle(action, 'unverifiable', detail, now, this.deps.config.historyLimit);
    this.deps.journal.discarded(settled, detail);
    this.log(`[queue] refused ${settled.id}: ${detail}`);
    return { admitted: false, reason: detail, action: settled };
  }

  /** Every action a full queue pushed out, in the trajectory and in the log. */
  private recordEvictions(dropped: readonly DeferredAction[]): void {
    for (const evicted of dropped) {
      this.deps.journal.discarded(evicted, evicted.detail);
      this.log(`[queue] dropped '${evicted.purpose}' — ${evicted.detail}`);
    }
  }

  private log(line: string): void {
    this.deps.log?.(line);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
