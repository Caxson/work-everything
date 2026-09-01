/**
 * Scenarios — the "muscle" tier.
 *
 * A Scenario is a pre-compiled tool chain: a linear list of entries where
 * each entry is one step or a *parallel group* of independent steps. It
 * carries the anchors that let a request find it, the template variables it
 * needs from outside, and what to do when a step fails. Nothing here calls
 * a model; a Scenario that has been promoted runs at zero model cost.
 */
import { z } from 'zod';

/** Vars the daemon always supplies, so a chain may use them undeclared. */
export const RESERVED_VARS: ReadonlySet<string> = new Set(['event_text', 'event_kind', 'event_source', 'trace_id']);

const VAR_PATTERN = /\$(\w+)/g;

/** Extract `$name` references from a template string. */
export function templateVars(template: string): readonly string[] {
  return [...template.matchAll(VAR_PATTERN)].map((m) => m[1] as string);
}

export const ToolChainStepSchema = z
  .object({
    /** Tool name, resolved against the executor registry at run time. */
    tool: z.string().min(1),
    /** Each value is a `$var` template rendered against the variable bag. */
    args: z.record(z.string()).default({}),
    /** When set, the step's result is stored under this name for later steps. */
    extractTo: z.string().regex(/^\w*$/).default(''),
    /** See `evaluateCondition` for the (deliberately tiny) grammar. */
    condition: z.string().default('always'),
  })
  .strict()
  .readonly();

export type ToolChainStep = z.infer<typeof ToolChainStepSchema>;

/**
 * One entry of a chain: a single step, or a group of steps declared to have
 * no dependencies on each other. Kept as a list-of-lists on purpose — a
 * general DAG would buy nothing the muscle tier needs.
 */
export const ToolChainEntrySchema = z.union([ToolChainStepSchema, z.array(ToolChainStepSchema).min(1).readonly()]);
export type ToolChainEntry = z.infer<typeof ToolChainEntrySchema>;

export const FAILURE_POLICIES = ['fail_fast', 'best_effort'] as const;
export type FailurePolicy = (typeof FAILURE_POLICIES)[number];

export const ScenarioSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().default(''),
    /**
     * Phrasings that should reach this scenario. Promoted scenarios inherit
     * these from the real events that produced them, which are better
     * anchors than anything written by hand.
     */
    triggers: z.array(z.string()).readonly().default([]),
    /** Event kinds this scenario may fire on; empty means any kind. */
    kinds: z.array(z.string()).readonly().default([]),
    chain: z.array(ToolChainEntrySchema).readonly().default([]),
    onFailure: z.enum(FAILURE_POLICIES).default('fail_fast'),
    /** Provenance: hand-written, or promoted from a plan candidate. */
    origin: z.enum(['authored', 'promoted']).default('authored'),
  })
  .strict()
  .readonly();

export type Scenario = z.infer<typeof ScenarioSchema>;

export function parseScenario(raw: unknown): Scenario {
  return ScenarioSchema.parse(raw);
}

/** Flatten a chain into its steps, in declared order; groups expand in place. */
export function chainSteps(chain: readonly ToolChainEntry[]): readonly ToolChainStep[] {
  return chain.flatMap((entry) => [...entrySteps(entry)]);
}

/** Whether an entry is a parallel group rather than a lone step. */
export function isGroup(entry: ToolChainEntry): entry is readonly ToolChainStep[] {
  return Array.isArray(entry);
}

/** Normalize one entry to a group, so callers have a single shape to handle. */
export function entrySteps(entry: ToolChainEntry): readonly ToolChainStep[] {
  return isGroup(entry) ? entry : [entry];
}

/**
 * Variables a chain must be given from outside: every `$name` it mentions,
 * minus the reserved ones and minus anything an earlier step produces.
 */
export function requiredVars(chain: readonly ToolChainEntry[]): readonly string[] {
  const steps = chainSteps(chain);
  const produced = new Set(steps.map((s) => s.extractTo).filter((name) => name !== ''));
  const needed = new Set<string>();
  for (const step of steps) {
    for (const template of [...Object.values(step.args), step.condition]) {
      for (const name of templateVars(template)) {
        if (!RESERVED_VARS.has(name) && !produced.has(name)) needed.add(name);
      }
    }
  }
  return [...needed].sort();
}

/**
 * The text a scenario is retrieved by. Triggers come first and repeat-free
 * because they are the strongest anchors — real phrasings, not prose.
 */
export function scenarioDocument(scenario: Scenario): string {
  return [scenario.id, scenario.name, scenario.description, ...scenario.triggers, ...scenario.kinds]
    .filter((part) => part !== '')
    .join(' ');
}

/** Structural problems that make a scenario unrunnable. Empty means fine. */
export function validateScenario(scenario: Scenario, availableTools: ReadonlySet<string>): readonly string[] {
  const problems: string[] = [];
  const steps = chainSteps(scenario.chain);
  if (steps.length === 0) problems.push('chain has no steps');

  const produced = new Set<string>();
  for (const entry of scenario.chain) {
    const group = entrySteps(entry);
    for (const step of group) {
      if (!availableTools.has(step.tool)) problems.push(`unknown tool '${step.tool}'`);
      for (const template of Object.values(step.args)) {
        for (const name of templateVars(template)) {
          if (!RESERVED_VARS.has(name) && !produced.has(name)) {
            problems.push(`step '${step.tool}' reads '$${name}' before anything produces it`);
          }
        }
      }
    }
    // A group's members run against the same snapshot, so their outputs only
    // become visible to the *next* entry.
    for (const step of group) {
      if (step.extractTo !== '') produced.add(step.extractTo);
    }
  }
  return problems;
}
