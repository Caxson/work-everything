/**
 * A deferred action, and the three clocks that can invalidate it.
 *
 * This file is pure. It owns the shape of a queued action and the arithmetic
 * that decides whether one is still the action it was when it was queued —
 * nothing here reads the world, touches sqlite, or knows what a chat is.
 *
 * **The unit queued is a whole chain, not a step.** A chain that will need the
 * screen does not start behind a lock at all. Deferring per tool call would run
 * a chain's early steps against the pre-lock world, hold the one GUI step, and
 * then send it minutes later carrying arguments rendered from a reading that is
 * no longer true — a half-executed chain whose halves saw different worlds.
 * Nothing runs, and on unlock the chain re-runs from the top, re-reading
 * everything it depends on.
 *
 * The premise the whole queue rests on: **an action that runs much later is not
 * the action a person authorized.** Delay erodes it along three independent
 * axes, and each gets its own gate rather than one fuzzy "is this still fine"
 * test, because they fail for different reasons and the right response to each
 * is different:
 *
 * 1. **Freshness.** A reply to a question asked forty minutes ago is noise even
 *    if every fact around it still holds. Bounded by `expiresAt`; past it the
 *    action is dropped and never offered to anyone.
 * 2. **Premise.** The action was formed against a world — a conversation with a
 *    name, a message that existed. If that world moved, the action is now aimed
 *    at something else. Re-checked at dequeue by a checker registered for its
 *    `precondition.kind` (see `preconditions.ts`), never by anything in here.
 * 3. **Authority.** Running without asking is a permission granted *for now*.
 *    It does not survive an arbitrary wait, so past `trustResetAt` the action is
 *    handed back to a human as `pending_confirm` instead of executed.
 *
 * `trustResetAt` is always at or before `expiresAt` — a reset window longer than
 * the lifetime would be dead code, since anything old enough to lose its
 * authority would already have expired. `enqueue` clamps it rather than trusting
 * the caller, and `config.ts` refuses the configuration outright.
 */
import type { Scenario } from '../core/scenario.js';
import { chainSteps } from '../core/scenario.js';

/** Every state a queued action can be in. `pending` is the only live one. */
export const DEFERRAL_STATUSES = [
  /** Waiting for the screen to unlock. */
  'pending',
  /**
   * Claimed by a drain and currently executing.
   *
   * Written **before** the chain runs, not after, and that ordering is the
   * whole at-most-once guarantee. The queue is durable and the fact that
   * something already ran was not: a process killed between pressing Enter in
   * a chat and recording the outcome would come back to a row still marked
   * pending and send the message a second time. A `running` row found at
   * startup is evidence of exactly that, and is never replayed.
   */
  'running',
  /** Dequeued and run. */
  'executed',
  /** Dequeued and run, and the chain reported a failure. */
  'failed',
  /** Outlived its TTL. Dropped without running and without asking. */
  'expired',
  /** Its premise no longer holds: the world it was aimed at moved. */
  'precondition_broken',
  /** Nothing knows how to re-check its premise, so it was not run. */
  'unverifiable',
  /** Queued too long to still count as authorized; handed back to a human. */
  'trust_reset',
  /** Pushed out of a full queue by newer work. */
  'dropped_for_capacity',
] as const;
export type DeferralStatus = (typeof DEFERRAL_STATUSES)[number];

export function isDeferralStatus(value: string): value is DeferralStatus {
  return (DEFERRAL_STATUSES as readonly string[]).includes(value);
}

/** Statuses that mean the action will never run again. */
export const SETTLED_STATUSES: ReadonlySet<DeferralStatus> = new Set(
  DEFERRAL_STATUSES.filter((status) => status !== 'pending' && status !== 'running'),
);

/** Statuses that are still in play: not settled, not safe to evict. */
export const LIVE_STATUSES: ReadonlySet<DeferralStatus> = new Set<DeferralStatus>(['pending', 'running']);

/**
 * The facts an action was authorized against, and the name of the checker that
 * knows how to read them back. Strings only: this is persisted, and a premise
 * that cannot survive a restart is not a premise.
 */
export interface PreconditionCheck {
  readonly kind: string;
  readonly facts: Readonly<Record<string, string>>;
}

export interface DeferredAction {
  /** Stable identity, used in trajectory ids and by `we queue`. */
  readonly id: string;
  /** Monotonic enqueue order. Ties on `enqueuedAt` still dequeue in order. */
  readonly seq: number;
  /** The event this action answers, so a trajectory can be traced back. */
  readonly traceId: string;
  /** The chain to run, whole. A single tool call is a one-entry chain. */
  readonly chain: Scenario;
  /** The variable bag the chain was to be rendered against, captured verbatim. */
  readonly vars: Readonly<Record<string, string>>;
  /** One sentence a person can read in `we queue` and recognise. */
  readonly purpose: string;
  readonly precondition: PreconditionCheck;
  readonly enqueuedAt: number;
  readonly expiresAt: number;
  readonly trustResetAt: number;
  readonly status: DeferralStatus;
  readonly settledAt?: number | undefined;
  /** Why it is in the status it is in. Empty while pending. */
  readonly detail: string;
}

export interface DeferralConfig {
  /** Whether anything is queued at all. Off means a lock fails calls as before. */
  readonly enabled: boolean;
  /** How long a queued action stays worth running at all. */
  readonly ttlMs: number;
  /** How long its permission to run unattended survives the wait. */
  readonly trustResetMs: number;
  /** Pending actions retained before the oldest is pushed out. */
  readonly capacity: number;
  /** How often the drainer asks the bridge whether the screen is still locked. */
  readonly pollIntervalMs: number;
  /** Settled actions retained for `we queue`, newest first. */
  readonly historyLimit: number;
}

export const DEFAULT_DEFERRAL_CONFIG: DeferralConfig = {
  enabled: true,
  ttlMs: 900_000,
  trustResetMs: 300_000,
  capacity: 100,
  pollIntervalMs: 15_000,
  historyLimit: 200,
};

/** What a queued action needs from its caller. The clocks are derived. */
export interface DeferralRequest {
  readonly traceId: string;
  readonly chain: Scenario;
  readonly vars: Readonly<Record<string, string>>;
  readonly purpose: string;
  readonly precondition: PreconditionCheck;
}

/**
 * Build the record for one action, with its clocks set from `now`.
 *
 * `trustResetAt` is clamped to `expiresAt`: a caller that configures a longer
 * reset window than a lifetime gets a reset that fires at expiry rather than a
 * gate that silently never fires.
 */
export function enqueue(request: DeferralRequest, config: DeferralConfig, now: number, id: string, seq: number): DeferredAction {
  const expiresAt = now + Math.max(0, config.ttlMs);
  return {
    id,
    seq,
    traceId: request.traceId,
    chain: request.chain,
    vars: { ...request.vars },
    purpose: request.purpose,
    precondition: { kind: request.precondition.kind, facts: { ...request.precondition.facts } },
    enqueuedAt: now,
    expiresAt,
    trustResetAt: Math.min(expiresAt, now + Math.max(0, config.trustResetMs)),
    status: 'pending',
    detail: '',
  };
}

/** Settle an action, without mutating the one handed in. */
export function settle(action: DeferredAction, status: DeferralStatus, detail: string, now: number): DeferredAction {
  return { ...action, status, detail, settledAt: now };
}

/** Whether the action has outlived the window in which it still meant something. */
export function hasExpired(action: DeferredAction, now: number): boolean {
  return now > action.expiresAt;
}

/**
 * Whether the permission to run this unattended has lapsed.
 *
 * Everything in the queue was authorized to run at the moment it was queued — it
 * had already passed the daemon's confirmation gate when the lock stopped it.
 * That authorization is what decays here.
 */
export function authorityLapsed(action: DeferredAction, now: number): boolean {
  return now > action.trustResetAt;
}

/** The chain's tools, in order, for `we queue` and for log lines. */
export function describeChain(action: DeferredAction): string {
  const tools = chainSteps(action.chain.chain).map((step) => step.tool);
  return tools.length === 0 ? '(empty chain)' : tools.join(' → ');
}

/** Human-readable age, for `we queue` and for trajectory reasons. */
export function describeAge(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m${seconds % 60}s` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
