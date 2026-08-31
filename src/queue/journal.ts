/**
 * Every move the queue makes, written into the trajectory.
 *
 * The queue is the one part of the daemon that does something *later*, which
 * means it is the one part whose behaviour cannot be reconstructed from the
 * event that caused it. So each transition gets its own record, on its own
 * tier, keyed by the action's id so several deferrals of the same event never
 * collide on the trajectory's primary key:
 *
 * | tier | what happened |
 * |---|---|
 * | `queued` | the screen was locked, so this was queued instead of run |
 * | `deferred->executed` | the screen unlocked and the chain ran |
 * | `deferred_discarded` | a gate refused it: too old, premise gone, or pushed out |
 * | `pending_confirm` | it waited long enough to need a person again |
 *
 * `queued` and `pending_confirm` record `ok: true` — deferring and handing
 * back are the daemon doing its job. Discards record `ok: false`, because in
 * every one of those cases something the daemon had decided to do did not
 * happen, and that is worth seeing in `we status` without reading reasons.
 */
import type { ChainResult } from '../core/engine.js';
import type { TrajectoryRecord, TrajectoryStore } from '../memory/trajectory.js';
import { stepsOf } from '../memory/trajectory.js';
import type { DeferredAction } from './deferred.js';
import { describeAge, describeChain } from './deferred.js';

/** The source recorded on queue trajectories. Not an event source: no event fired. */
export const QUEUE_SOURCE = 'queue';

export const QUEUE_TIERS = {
  /**
   * The *action* being queued. Distinct from the daemon's own `deferred`
   * record for the *event*, which is a different fact about a different thing:
   * counting both under one tier would report every deferral twice.
   */
  deferred: 'queued',
  executed: 'deferred->executed',
  discarded: 'deferred_discarded',
  pendingConfirm: 'pending_confirm',
} as const;

export class QueueJournal {
  constructor(
    private readonly store: TrajectoryStore,
    private readonly clock: () => number = Date.now,
  ) {}

  /** An action queued because the screen was locked. */
  deferred(action: DeferredAction, reason: string): TrajectoryRecord {
    return this.write(action, {
      suffix: 'deferred',
      kind: 'action.deferred',
      tier: QUEUE_TIERS.deferred,
      ok: true,
      reason,
    });
  }

  /** An action that came back out of the queue and ran. */
  executed(action: DeferredAction, result: ChainResult, premise: string): TrajectoryRecord {
    return this.write(action, {
      suffix: 'drained',
      kind: 'action.drained',
      tier: QUEUE_TIERS.executed,
      ok: result.ok,
      reason: `ran after waiting ${describeAge(action.enqueuedAt, this.clock())} for the screen; ${premise}`,
      durationMs: result.durationMs,
      steps: stepsOf(result),
      ...(result.ok ? {} : { error: `steps failed: ${result.failedTools.join(', ')}` }),
    });
  }

  /** An action a gate refused. `reason` names the gate and says what it saw. */
  discarded(action: DeferredAction, reason: string): TrajectoryRecord {
    return this.write(action, {
      suffix: 'discarded',
      kind: 'action.discarded',
      tier: QUEUE_TIERS.discarded,
      ok: false,
      reason,
      error: reason,
    });
  }

  /**
   * An action whose permission to run unattended lapsed while it waited. It is
   * not run and not dropped: it becomes a pending confirmation, which is where
   * `we status` already looks for things waiting on a person.
   */
  handedBack(action: DeferredAction, reason: string): TrajectoryRecord {
    return this.write(action, {
      suffix: 'pending',
      kind: 'action.pending_confirm',
      tier: QUEUE_TIERS.pendingConfirm,
      ok: true,
      reason,
      needsConfirmation: true,
    });
  }

  private write(action: DeferredAction, over: Partial<TrajectoryRecord> & { readonly suffix: string }): TrajectoryRecord {
    const { suffix, ...fields } = over;
    const record: TrajectoryRecord = {
      traceId: `${action.traceId}:${suffix}:${action.id}`,
      ts: this.clock(),
      source: QUEUE_SOURCE,
      kind: 'action.deferred',
      text: action.purpose,
      payload: {
        actionId: action.id,
        originTraceId: action.traceId,
        chain: describeChain(action),
        scenarioId: action.chain.id,
        purpose: action.purpose,
        preconditionKind: action.precondition.kind,
        enqueuedAt: action.enqueuedAt,
        expiresAt: action.expiresAt,
        trustResetAt: action.trustResetAt,
        status: action.status,
      },
      tier: QUEUE_TIERS.deferred,
      scenarioId: action.chain.id,
      needsConfirmation: false,
      confirmed: null,
      score: 0,
      reason: '',
      considered: [],
      llmCalls: 0,
      durationMs: 0,
      ok: true,
      steps: [],
      ...fields,
    };
    this.store.append(record);
    return record;
  }
}
