/**
 * The router — one pure function from an observed event to which tier
 * handles it.
 *
 *   muscle — a scenario already covers this. Deterministic, no model call.
 *   fast   — no scenario yet, but the shape is plannable: reuse a cached
 *            plan (no model call), or spend one LIGHT call to make one.
 *   slow   — hand it to the host and let it reason.
 *
 * This is a pure function on purpose. Every input it needs — the scenario
 * pool, the trust states, the plan candidates — is passed in, so a routing
 * decision can be re-derived later from a stored trajectory and compared
 * against what actually happened.
 */
import type { Event } from './events.js';
import { eventText } from './events.js';
import type { Scenario } from './scenario.js';
import { scenarioDocument } from './scenario.js';
import { lexicalRank, tokenize, topCandidates } from './prefilter.js';
import type { PlanCandidate } from './promotion.js';
import { matchCandidate } from './promotion.js';
import type { TrustState } from './trust.js';
import { initialTrust, isEligible, needsConfirmation } from './trust.js';

export const TIERS = ['muscle', 'fast', 'slow'] as const;
export type Tier = (typeof TIERS)[number];

export interface RouterConfig {
  /**
   * Retrieval score a scenario must clear to take the muscle path. Above
   * this the chain runs without a model ever seeing the event, so the bar is
   * set to be crossed by real overlap, not by one shared token.
   */
  readonly muscleThreshold: number;
  /** Anchor coverage a cached plan needs before it is reused. */
  readonly planMatchThreshold: number;
  /** How many scenarios are examined in detail per event. */
  readonly topK: number;
  /** Whether the fast tier may spend a LIGHT call on an unseen shape. */
  readonly planningEnabled: boolean;
  /** Event kinds that always go straight to the slow tier. */
  readonly alwaysSlowKinds: readonly string[];
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  muscleThreshold: 0.35,
  planMatchThreshold: 0.6,
  topK: 8,
  planningEnabled: true,
  alwaysSlowKinds: [],
};

export interface RouterInput {
  readonly event: Event;
  readonly scenarios: readonly Scenario[];
  readonly candidates: readonly PlanCandidate[];
  /** Trust states by subject id. A missing entry gets the origin default. */
  readonly trust: ReadonlyMap<string, TrustState>;
  readonly config: RouterConfig;
}

export interface RouteDecision {
  readonly tier: Tier;
  /** Set on the muscle tier: the scenario that will run. */
  readonly scenarioId?: string;
  /** Set on the fast tier when a cached plan is being reused instead of planned. */
  readonly planId?: string;
  /** Whether the trust gate wants a human before this runs. */
  readonly needsConfirmation: boolean;
  readonly score: number;
  /** Why this tier, in one line — stored on the trajectory. */
  readonly reason: string;
  /** Scenario ids the prefilter surfaced, best first. */
  readonly considered: readonly string[];
}

const SLOW = (reason: string, considered: readonly string[] = []): RouteDecision => ({
  tier: 'slow',
  needsConfirmation: false,
  score: 0,
  reason,
  considered,
});

export function route(input: RouterInput): RouteDecision {
  const { event, config } = input;
  const text = eventText(event);

  if (config.alwaysSlowKinds.includes(event.kind)) return SLOW(`kind '${event.kind}' is pinned to slow`);
  if (tokenize(text).length === 0) return SLOW('event carries no routable text');

  const eligible = input.scenarios.filter(
    (scenario) =>
      scenario.chain.length > 0 &&
      (scenario.kinds.length === 0 || scenario.kinds.includes(event.kind)) &&
      isEligible(trustFor(input, scenario)),
  );

  const docs = new Map(eligible.map((scenario) => [scenario.id, scenarioDocument(scenario)]));
  const ranked = lexicalRank(text, docs);
  const considered = topCandidates(ranked, config.topK);
  const best = ranked[0];

  if (best !== undefined && best.score >= config.muscleThreshold) {
    const scenario = eligible.find((s) => s.id === best.id);
    if (scenario !== undefined) {
      return {
        tier: 'muscle',
        scenarioId: scenario.id,
        needsConfirmation: needsConfirmation(trustFor(input, scenario)),
        score: best.score,
        reason: `scenario '${scenario.id}' matched at ${best.score.toFixed(2)}`,
        considered,
      };
    }
  }

  const eligibleCandidates = input.candidates.filter((candidate) => isEligible(candidateTrust(input, candidate)));
  const reuse = matchCandidate(text, eligibleCandidates, config.planMatchThreshold);
  if (reuse !== undefined) {
    return {
      tier: 'fast',
      planId: reuse.candidate.planId,
      needsConfirmation: needsConfirmation(candidateTrust(input, reuse.candidate)),
      score: reuse.score,
      reason: `plan '${reuse.candidate.planId}' covers this phrasing at ${reuse.score.toFixed(2)}`,
      considered,
    };
  }

  if (config.planningEnabled) {
    return {
      tier: 'fast',
      // A freshly planned chain has never been vouched for by anyone.
      needsConfirmation: true,
      score: best?.score ?? 0,
      reason: 'no scenario or cached plan matched; planning a chain',
      considered,
    };
  }

  return SLOW('planning disabled; nothing deterministic matched', considered);
}

function trustFor(input: RouterInput, scenario: Scenario): TrustState {
  return input.trust.get(scenario.id) ?? initialTrust(scenario.id, scenario.origin);
}

function candidateTrust(input: RouterInput, candidate: PlanCandidate): TrustState {
  return input.trust.get(candidate.planId) ?? initialTrust(candidate.planId, 'promoted');
}
