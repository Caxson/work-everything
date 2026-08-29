/**
 * The trust gate.
 *
 * Nothing earns the right to run unattended by being generated; it earns it
 * by being watched. A subject (a promoted scenario, or a plan candidate)
 * starts as a candidate, spends its first N runs asking a human to confirm,
 * and only then runs on its own. A failure costs it that standing
 * immediately, and a run of failures takes it out of rotation entirely.
 *
 * The stage is *derived* from the counters rather than stored beside them,
 * so the machine cannot end up in a state its history does not justify.
 * Every function here returns a new state; none mutates its input.
 */

export const TRUST_STAGES = ['candidate', 'confirming', 'auto', 'quarantined'] as const;
export type TrustStage = (typeof TRUST_STAGES)[number];

export interface TrustConfig {
  /** Consecutive confirmed successes needed before running unattended. */
  readonly required: number;
  /** Consecutive failures that take a subject out of rotation. */
  readonly quarantineAfter: number;
}

export const DEFAULT_TRUST_CONFIG: TrustConfig = { required: 3, quarantineAfter: 2 };

export interface TrustState {
  readonly subjectId: string;
  /** Consecutive human-confirmed successes; any failure resets it to zero. */
  readonly confirmations: number;
  readonly successes: number;
  readonly failures: number;
  readonly consecutiveFailures: number;
  readonly quarantined: boolean;
  readonly config: TrustConfig;
  readonly updatedAt: number;
}

/**
 * A run's verdict. `confirmed` runs were signed off by a human before
 * executing; `auto` runs were not. Only confirmed successes advance the
 * gate — an unattended success cannot vote itself more autonomy.
 */
export type TrustOutcome = 'confirmed_success' | 'confirmed_failure' | 'auto_success' | 'auto_failure' | 'rejected';

export function createTrust(subjectId: string, config: TrustConfig = DEFAULT_TRUST_CONFIG, now: number = Date.now()): TrustState {
  return {
    subjectId,
    confirmations: 0,
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
    quarantined: false,
    config: normalizeConfig(config),
    updatedAt: now,
  };
}

/**
 * A hand-written scenario starts already trusted: a human wrote its chain,
 * which is the same signal the gate spends N runs collecting. A promoted one
 * starts from zero — nobody has vouched for it yet.
 */
export function initialTrust(
  subjectId: string,
  origin: 'authored' | 'promoted',
  config: TrustConfig = DEFAULT_TRUST_CONFIG,
  now: number = Date.now(),
): TrustState {
  const base = createTrust(subjectId, config, now);
  return origin === 'authored' ? { ...base, confirmations: base.config.required } : base;
}

function normalizeConfig(config: TrustConfig): TrustConfig {
  return {
    required: Math.max(1, Math.trunc(config.required)),
    quarantineAfter: Math.max(1, Math.trunc(config.quarantineAfter)),
  };
}

export function stageOf(state: TrustState): TrustStage {
  if (state.quarantined) return 'quarantined';
  if (state.confirmations >= state.config.required) return 'auto';
  return state.confirmations > 0 ? 'confirming' : 'candidate';
}

/** May this subject be chosen at all? Quarantine is the only hard stop. */
export function isEligible(state: TrustState): boolean {
  return !state.quarantined;
}

/** Must a human sign off before this run? True for everything below `auto`. */
export function needsConfirmation(state: TrustState): boolean {
  return stageOf(state) !== 'auto';
}

/** How far along the gate a subject is, as `n/N`, for status output. */
export function progress(state: TrustState): string {
  return `${Math.min(state.confirmations, state.config.required)}/${state.config.required}`;
}

export function applyOutcome(state: TrustState, outcome: TrustOutcome, now: number = Date.now()): TrustState {
  switch (outcome) {
    case 'confirmed_success':
      return { ...state, confirmations: state.confirmations + 1, successes: state.successes + 1, consecutiveFailures: 0, updatedAt: now };
    case 'auto_success':
      // Counted, but it buys no additional autonomy.
      return { ...state, successes: state.successes + 1, consecutiveFailures: 0, updatedAt: now };
    case 'confirmed_failure':
    case 'auto_failure':
      return afterFailure(state, now);
    case 'rejected':
      // A human looked at it and said no. Same standing cost as a failure.
      return afterFailure(state, now);
  }
}

function afterFailure(state: TrustState, now: number): TrustState {
  const consecutiveFailures = state.consecutiveFailures + 1;
  return {
    ...state,
    // Demotion is the whole point: an auto subject that fails is back to
    // asking, and it starts the count over rather than resuming it.
    confirmations: 0,
    failures: state.failures + 1,
    consecutiveFailures,
    quarantined: state.quarantined || consecutiveFailures >= state.config.quarantineAfter,
    updatedAt: now,
  };
}

/** Explicit human override: back in rotation, but back at the start of the gate. */
export function reinstate(state: TrustState, now: number = Date.now()): TrustState {
  return { ...state, quarantined: false, consecutiveFailures: 0, confirmations: 0, updatedAt: now };
}
