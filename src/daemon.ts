/**
 * The daemon: one event in, one trajectory out.
 *
 * Everything interesting is decided elsewhere — this file's job is to hold
 * the loop honest. Each event is routed once, gated by trust once, executed
 * on exactly one tier, and recorded exactly once, including when the tier it
 * chose could not run and it fell through to a slower one.
 *
 * The one rule worth stating out loud: a chain whose template variables
 * cannot be filled without a model is *not* muscle, whatever the router
 * said. It is demoted to the fast tier and the model call is recorded, so
 * "zero model calls" in the trajectory always means zero.
 */
import type { Event } from './core/events.js';
import { eventText } from './core/events.js';
import type { Scenario } from './core/scenario.js';
import { RESERVED_VARS, requiredVars } from './core/scenario.js';
import type { ChainResult, VarBag } from './core/engine.js';
import { executeChain } from './core/engine.js';
import type { RouteDecision, RouterConfig } from './core/router.js';
import { route } from './core/router.js';
import type { LightModel, PlannerConfig, ToolSchema } from './core/planner.js';
import { generatePlan } from './core/planner.js';
import type { PlanCandidate, PromotionConfig } from './core/promotion.js';
import { createCandidate, makePlanId, observe, promotionReadiness, recordRun, toScenario } from './core/promotion.js';
import type { TrustConfig, TrustOutcome, TrustState } from './core/trust.js';
import { applyOutcome, initialTrust } from './core/trust.js';
import type { ToolRunner } from './execution/base.js';
import type { SlowThinker } from './hosts/base.js';
import type { Perceiver } from './perception/base.js';
import { mergeEvents } from './perception/base.js';
import type { TrajectoryRecord, TrajectoryStep } from './memory/trajectory.js';
import type { TrajectoryStore } from './memory/trajectory.js';
import type { Registry } from './memory/registry.js';

/** Asked before an untrusted chain runs. `false` sends the event to slow thinking. */
export type ConfirmFn = (request: { readonly event: Event; readonly decision: RouteDecision; readonly chain: Scenario }) => Promise<boolean>;

export interface DaemonOptions {
  readonly store: TrajectoryStore;
  readonly registry: Registry;
  readonly runner: ToolRunner;
  readonly tools: readonly ToolSchema[];
  readonly router: RouterConfig;
  readonly trust: TrustConfig;
  readonly promotion: PromotionConfig;
  readonly planner: PlannerConfig;
  readonly perceivers?: readonly Perceiver[];
  readonly lightModel?: LightModel | undefined;
  readonly host?: SlowThinker | undefined;
  /** Omitted means nobody is watching: untrusted chains stay unconfirmed. */
  readonly confirm?: ConfirmFn | undefined;
}

export class Daemon {
  private scenarios: readonly Scenario[];
  private candidates: readonly PlanCandidate[];
  private trust: Map<string, TrustState>;

  constructor(private readonly options: DaemonOptions) {
    this.scenarios = options.registry.scenarios();
    this.candidates = options.registry.candidates();
    this.trust = new Map(options.registry.trust());
  }

  /** Consume every perceiver until the signal aborts or all sources end. */
  async run(signal?: AbortSignal): Promise<void> {
    const perceivers = this.options.perceivers ?? [];
    for await (const event of mergeEvents(perceivers, signal, (name, error) => {
      console.error(`[daemon] perceiver '${name}' failed: ${error instanceof Error ? error.message : String(error)}`);
    })) {
      if (signal?.aborted === true) break;
      await this.handle(event);
    }
  }

  async handle(event: Event): Promise<TrajectoryRecord> {
    const started = Date.now();
    const text = eventText(event);
    const decision = route({
      event,
      scenarios: this.scenarios,
      candidates: this.candidates,
      trust: this.trust,
      config: this.options.router,
    });

    const outcome = await this.dispatch(event, text, decision);
    const record: TrajectoryRecord = {
      traceId: event.traceId,
      ts: event.ts,
      source: event.source,
      kind: event.kind,
      text,
      payload: event.payload,
      tier: outcome.tier,
      scenarioId: outcome.scenarioId,
      planId: outcome.planId,
      needsConfirmation: outcome.needsConfirmation,
      confirmed: outcome.confirmed,
      score: decision.score,
      reason: outcome.reason,
      considered: decision.considered,
      llmCalls: outcome.llmCalls,
      durationMs: Date.now() - started,
      ok: outcome.ok,
      error: outcome.error,
      steps: outcome.steps,
    };
    this.options.store.append(record);
    return record;
  }

  // --- tiers ---------------------------------------------------------------

  private async dispatch(event: Event, text: string, decision: RouteDecision): Promise<TierOutcome> {
    if (decision.tier === 'muscle' && decision.scenarioId !== undefined) {
      const scenario = this.scenarios.find((candidate) => candidate.id === decision.scenarioId);
      if (scenario !== undefined) {
        if (openVars(scenario).length === 0) return await this.runDeterministic(event, decision, scenario, {}, 0);
        // Needs values only a model can pull out of this phrasing.
        return await this.runFast(event, text, { ...decision, tier: 'fast', reason: `${decision.reason}; slots need filling` });
      }
    }
    if (decision.tier === 'fast') return await this.runFast(event, text, decision);
    return await this.runSlow(text, decision.reason, 'slow');
  }

  private async runFast(event: Event, text: string, decision: RouteDecision): Promise<TierOutcome> {
    const cached = decision.planId === undefined ? undefined : this.candidates.find((candidate) => candidate.planId === decision.planId);
    if (cached !== undefined && openVars(chainAsScenario(cached)).length === 0) {
      return await this.runDeterministic(event, decision, chainAsScenario(cached), {}, 0, cached);
    }

    const model = this.options.lightModel;
    if (model === undefined) return await this.runSlow(text, `${decision.reason}; no LIGHT model configured`, 'fast');

    const planned = await generatePlan({ request: text, tools: this.options.tools, model, config: this.options.planner });
    if (!planned.ok) return await this.runSlow(text, `planning failed: ${planned.reason}`, 'fast', 1);

    const observation = { query: text, slots: planned.plan.slots, kind: event.kind };
    // Same tool chain, whatever the phrasing: regenerations fold into one
    // candidate so successes accumulate instead of scattering.
    const planId = makePlanId(planned.plan.intent, planned.plan.chain);
    const existing = this.candidates.find((candidate) => candidate.planId === planId);
    const candidate =
      existing === undefined
        ? createCandidate(
            { intent: planned.plan.intent, description: planned.plan.description, chain: planned.plan.chain, slotNames: Object.keys(planned.plan.slots) },
            observation,
          )
        : observe(existing, observation);

    return await this.runDeterministic(event, { ...decision, planId: candidate.planId }, chainAsScenario(candidate), planned.plan.slots, 1, candidate);
  }

  private async runDeterministic(
    event: Event,
    decision: RouteDecision,
    chain: Scenario,
    slots: Readonly<Record<string, string>>,
    llmCalls: number,
    candidate?: PlanCandidate,
  ): Promise<TierOutcome> {
    const subjectId = candidate?.planId ?? chain.id;
    const trust = this.trustFor(subjectId, chain.origin);
    const needsConfirmation = decision.needsConfirmation;

    if (needsConfirmation) {
      const confirm = this.options.confirm;
      if (confirm === undefined) {
        // Nobody to ask. Record the request and let the host handle it.
        const fallback = await this.runSlow(eventText(event), `${decision.reason}; awaiting confirmation`, decision.tier, llmCalls);
        return { ...fallback, needsConfirmation: true, confirmed: null, scenarioId: decision.scenarioId, planId: decision.planId };
      }
      const approved = await confirm({ event, decision, chain });
      if (!approved) {
        this.saveTrust(applyOutcome(trust, 'rejected'));
        const fallback = await this.runSlow(eventText(event), `${decision.reason}; declined by operator`, decision.tier, llmCalls);
        return { ...fallback, needsConfirmation: true, confirmed: false, scenarioId: decision.scenarioId, planId: decision.planId };
      }
    }

    const vars = this.baseVars(event, slots);
    const result = await executeChain(chain, { runner: this.options.runner, vars });
    this.saveTrust(applyOutcome(trust, verdict(needsConfirmation, result.ok)));
    if (candidate !== undefined) this.remember(recordRun(candidate, result.ok));

    return {
      tier: decision.tier,
      scenarioId: decision.scenarioId,
      planId: candidate?.planId ?? decision.planId,
      needsConfirmation,
      confirmed: needsConfirmation ? true : null,
      llmCalls,
      ok: result.ok,
      reason: decision.reason,
      error: result.ok ? undefined : `steps failed: ${result.failedTools.join(', ')}`,
      steps: toSteps(result),
    };
  }

  private async runSlow(text: string, reason: string, tier: string, llmCallsSoFar = 0): Promise<TierOutcome> {
    const host = this.options.host;
    if (host === undefined) {
      return { tier: 'slow', needsConfirmation: false, confirmed: null, llmCalls: llmCallsSoFar, ok: false, reason, error: 'no slow-thinking host configured', steps: [] };
    }
    const result = await host.think({ prompt: text });
    return {
      tier: tier === 'slow' ? 'slow' : `${tier}->slow`,
      needsConfirmation: false,
      confirmed: null,
      llmCalls: llmCallsSoFar + result.llmCalls,
      ok: result.ok,
      reason,
      error: result.error,
      steps: [],
    };
  }

  // --- state ---------------------------------------------------------------

  private baseVars(event: Event, slots: Readonly<Record<string, string>>): VarBag {
    return { event_text: eventText(event), event_kind: event.kind, event_source: event.source, trace_id: event.traceId, ...slots };
  }

  private trustFor(subjectId: string, origin: 'authored' | 'promoted'): TrustState {
    return this.trust.get(subjectId) ?? initialTrust(subjectId, origin, this.options.trust);
  }

  private saveTrust(state: TrustState): void {
    this.trust = new Map(this.trust).set(state.subjectId, state);
    this.options.registry.saveTrust(state);
  }

  /** Persist a candidate and promote it when both gates agree. */
  private remember(candidate: PlanCandidate): void {
    const readiness = promotionReadiness(candidate, this.trustFor(candidate.planId, 'promoted'), this.options.promotion);
    const promoted = readiness.rule ? { ...candidate, promoted: true } : candidate;
    this.candidates = [...this.candidates.filter((existing) => existing.planId !== promoted.planId), promoted];
    this.options.registry.saveCandidate(promoted);
    if (!readiness.rule) return;
    const scenario = toScenario(promoted);
    this.scenarios = [...this.scenarios.filter((existing) => existing.id !== scenario.id), scenario];
    this.options.registry.saveScenario(scenario);
  }

  /** The manual promotion track, used by `we promote <id>`. */
  promote(planId: string): { readonly ok: boolean; readonly reason: string } {
    const candidate = this.candidates.find((existing) => existing.planId === planId);
    if (candidate === undefined) return { ok: false, reason: `no plan candidate '${planId}'` };
    const readiness = promotionReadiness(candidate, this.trustFor(planId, 'promoted'), this.options.promotion);
    if (!readiness.manual) return { ok: false, reason: readiness.reason };
    const promoted = { ...candidate, promoted: true };
    const scenario = toScenario(promoted);
    this.candidates = [...this.candidates.filter((existing) => existing.planId !== planId), promoted];
    this.scenarios = [...this.scenarios.filter((existing) => existing.id !== scenario.id), scenario];
    this.options.registry.saveCandidate(promoted);
    this.options.registry.saveScenario(scenario);
    return { ok: true, reason: `promoted '${planId}' to a scenario` };
  }

  knownScenarios(): readonly Scenario[] {
    return this.scenarios;
  }

  knownCandidates(): readonly PlanCandidate[] {
    return this.candidates;
  }
}

interface TierOutcome {
  readonly tier: string;
  readonly scenarioId?: string | undefined;
  readonly planId?: string | undefined;
  readonly needsConfirmation: boolean;
  readonly confirmed: boolean | null;
  readonly llmCalls: number;
  readonly ok: boolean;
  readonly reason: string;
  readonly error?: string | undefined;
  readonly steps: readonly TrajectoryStep[];
}

/** Template vars a chain needs that the daemon cannot supply by itself. */
function openVars(scenario: Scenario): readonly string[] {
  return requiredVars(scenario.chain).filter((name) => !RESERVED_VARS.has(name));
}

function chainAsScenario(candidate: PlanCandidate): Scenario {
  return {
    id: candidate.planId,
    name: candidate.intent,
    description: candidate.description,
    triggers: candidate.sourceQueries,
    kinds: candidate.kinds,
    chain: candidate.chain,
    onFailure: 'fail_fast',
    origin: 'promoted',
  };
}

function verdict(confirmed: boolean, ok: boolean): TrustOutcome {
  if (confirmed) return ok ? 'confirmed_success' : 'confirmed_failure';
  return ok ? 'auto_success' : 'auto_failure';
}

function toSteps(result: ChainResult): readonly TrajectoryStep[] {
  return result.steps.map((step) => ({
    entryIndex: step.entryIndex,
    tool: step.tool,
    args: step.args,
    ok: step.result.ok,
    value: step.result.value,
    error: step.result.error,
    durationMs: step.result.durationMs,
  }));
}
