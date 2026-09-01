/**
 * Promotion — how a plan that keeps working becomes muscle.
 *
 * Two things have to be true before a generated chain is allowed to become a
 * Scenario, and they are gated separately:
 *
 *   reuse    — may this chain be matched against future events at all?
 *   promote  — may it become a registered Scenario, routed like any other?
 *
 * Each gate has two tracks. The rule track advances on evidence (clean runs
 * through the trust gate). The manual track is a person deciding. Neither
 * can be skipped by the other: the rule track never promotes something the
 * trust gate has not cleared, and a manual promotion still refuses a
 * quarantined chain.
 *
 * The other half of this file is anchor normalization. Two events that mean
 * the same thing rarely share a string: "查一下 CI 为什么挂了" and "查一下
 * 构建为什么挂了" overlap almost nowhere once the differing value perturbs
 * every bigram around it. So a candidate remembers its phrasings with the
 * slot *values* removed, and matching runs against those skeletons.
 */
import type { Scenario, ToolChainEntry } from './scenario.js';
import { chainSteps, entrySteps } from './scenario.js';
import { anchorCoverage } from './prefilter.js';
import type { TrustState } from './trust.js';
import { isEligible, stageOf } from './trust.js';

/** Phrasings kept per candidate: enough to match on, few enough to read. */
export const MAX_ANCHORS = 8;

export interface PlanCandidate {
  readonly planId: string;
  readonly intent: string;
  readonly description: string;
  readonly chain: readonly ToolChainEntry[];
  readonly slotNames: readonly string[];
  /** Event kinds this candidate has been produced by. */
  readonly kinds: readonly string[];
  /** Real event texts, verbatim — these become the promoted triggers. */
  readonly sourceQueries: readonly string[];
  /** The same texts with slot values stripped — these are what we match on. */
  readonly anchors: readonly string[];
  readonly successes: number;
  readonly failures: number;
  readonly promoted: boolean;
}

export interface Observation {
  readonly query: string;
  readonly slots: Readonly<Record<string, string>>;
  readonly kind: string;
}

/**
 * Remove slot *values* from a phrasing, leaving its reusable skeleton.
 * Longest first so overlapping values ("北京市" before "北京") strip
 * cleanly, and each is replaced by a space so no bigram survives across the
 * removal point.
 */
export function stripSlotValues(text: string, slots: Readonly<Record<string, string>>): string {
  const values = Object.values(slots)
    .filter((value) => value !== '')
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of values) out = out.split(value).join(' ');
  return out.replace(/\s+/g, ' ').trim();
}

/** Canonical signature of a chain: tools and argument *names*, never values. */
export function planShape(chain: readonly ToolChainEntry[]): string {
  return chain
    .map((entry) =>
      entrySteps(entry)
        .map((step) => `${step.tool}(${Object.keys(step.args).sort().join(',')})>${step.extractTo}`)
        .join('&'),
    )
    .join('|');
}

/** Stable id from intent plus shape, so a regenerated chain dedupes into one. */
export function makePlanId(intent: string, chain: readonly ToolChainEntry[]): string {
  let hash = 2166136261;
  for (const char of planShape(chain)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `plan_${intent}_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function createCandidate(
  input: { readonly intent: string; readonly description: string; readonly chain: readonly ToolChainEntry[]; readonly slotNames: readonly string[] },
  observation: Observation,
): PlanCandidate {
  const base: PlanCandidate = {
    planId: makePlanId(input.intent, input.chain),
    intent: input.intent,
    description: input.description,
    chain: input.chain,
    slotNames: [...input.slotNames].sort(),
    kinds: [],
    sourceQueries: [],
    anchors: [],
    successes: 0,
    failures: 0,
    promoted: false,
  };
  return observe(base, observation);
}

/** Record one more real phrasing of this chain. Deduped and capped. */
export function observe(candidate: PlanCandidate, observation: Observation): PlanCandidate {
  const anchor = stripSlotValues(observation.query, observation.slots);
  const known = candidate.sourceQueries.includes(observation.query);
  const full = candidate.sourceQueries.length >= MAX_ANCHORS;
  return {
    ...candidate,
    kinds: candidate.kinds.includes(observation.kind) ? candidate.kinds : [...candidate.kinds, observation.kind],
    sourceQueries: known || full || observation.query === '' ? candidate.sourceQueries : [...candidate.sourceQueries, observation.query],
    anchors: known || full || anchor === '' ? candidate.anchors : [...candidate.anchors, anchor],
  };
}

export function recordRun(candidate: PlanCandidate, ok: boolean): PlanCandidate {
  return ok ? { ...candidate, successes: candidate.successes + 1 } : { ...candidate, failures: candidate.failures + 1 };
}

export interface CandidateMatch {
  readonly candidate: PlanCandidate;
  readonly score: number;
  readonly anchor: string;
}

/**
 * Best candidate whose anchor the query covers. Deliberately conservative:
 * a false match runs the *wrong* tools, while a miss only costs one planning
 * call. Already-promoted candidates are skipped — the scenario path serves
 * those now.
 */
export function matchCandidate(query: string, candidates: readonly PlanCandidate[], threshold: number): CandidateMatch | undefined {
  let best: CandidateMatch | undefined;
  for (const candidate of candidates) {
    if (candidate.promoted) continue;
    for (const anchor of candidate.anchors) {
      const score = anchorCoverage(query, anchor);
      if (score >= threshold && (best === undefined || score > best.score)) best = { candidate, score, anchor };
    }
  }
  return best;
}

export interface PromotionConfig {
  /** Clean successes required before the rule track will promote. */
  readonly promoteAfter: number;
}

export const DEFAULT_PROMOTION_CONFIG: PromotionConfig = { promoteAfter: 3 };

export interface PromotionReadiness {
  /** The rule track would promote this now, without asking. */
  readonly rule: boolean;
  /** A person may promote this now, if they choose to. */
  readonly manual: boolean;
  readonly reason: string;
}

export function promotionReadiness(
  candidate: PlanCandidate,
  trust: TrustState,
  config: PromotionConfig = DEFAULT_PROMOTION_CONFIG,
): PromotionReadiness {
  if (candidate.promoted) return { rule: false, manual: false, reason: 'already promoted' };
  if (!isEligible(trust)) return { rule: false, manual: false, reason: 'quarantined after repeated failures' };
  if (candidate.failures > 0) return { rule: false, manual: true, reason: `${candidate.failures} failed run(s): rule track withheld` };
  if (stageOf(trust) !== 'auto') return { rule: false, manual: true, reason: `trust gate at ${stageOf(trust)}` };
  const enough = candidate.successes >= Math.max(1, config.promoteAfter);
  return {
    rule: enough,
    manual: true,
    reason: enough ? 'clean runs through the trust gate' : `${candidate.successes}/${config.promoteAfter} clean runs`,
  };
}

/**
 * The promotion artifact. The triggers are the phrasings that actually
 * produced this chain, which anchor retrieval better than any description
 * written before the fact.
 */
export function toScenario(candidate: PlanCandidate): Scenario {
  return {
    id: candidate.planId,
    name: candidate.intent,
    description: candidate.description === '' ? `Promoted from ${candidate.planId}` : candidate.description,
    triggers: [...candidate.sourceQueries],
    kinds: [...candidate.kinds],
    chain: candidate.chain,
    onFailure: 'fail_fast',
    origin: 'promoted',
  };
}

/** Steps a candidate would run, for `we scenarios` and confirmation prompts. */
export function describeCandidate(candidate: PlanCandidate): string {
  return chainSteps(candidate.chain)
    .map((step) => step.tool)
    .join(' -> ');
}
