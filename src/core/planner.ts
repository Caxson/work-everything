/**
 * Fast thinking — one LIGHT model call, then determinism.
 *
 * Slow thinking decides each step after seeing the last one, which costs a
 * model call per step. Planning spends one call to write the whole chain up
 * front, then hands it to the same engine that runs muscle. That trade is
 * only worth taking when the result is *templated*: values the user supplied
 * are pulled out as slots, so one plan covers every phrasing of the same
 * request and can later become a Scenario without being rewritten.
 *
 * Anything unparsable, invalid, or referencing a tool that does not exist is
 * not a failure to recover from — it is a plan that never happens, and the
 * event falls through to slow thinking.
 */
import type { ToolChainEntry, ToolChainStep } from './scenario.js';
import { entrySteps, RESERVED_VARS, templateVars } from './scenario.js';

/** What the planner is allowed to reach for, rendered into the prompt. */
export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly params: readonly string[];
}

/** The one model call the fast tier is allowed to make. */
export type LightModel = (prompt: string, signal?: AbortSignal) => Promise<string>;

export interface GeneratedPlan {
  readonly intent: string;
  readonly description: string;
  readonly chain: readonly ToolChainEntry[];
  /** This event's values for the plan's slots — not part of the template. */
  readonly slots: Readonly<Record<string, string>>;
}

export interface PlannerConfig {
  readonly maxSteps: number;
}

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = { maxSteps: 5 };

const INTENT_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;

export const PLAN_PROMPT = [
  'You are a tool-call planner. Decide whether the request below can be served by a FIXED,',
  'LINEAR sequence of the tools listed — no branching, no decisions that depend on a result.',
  '',
  'Available tools:',
  '{tools}',
  '',
  'Request: {request}',
  '',
  'If plannable, reply with ONLY a JSON object:',
  '{"intent": "<short_snake_case>", "description": "<one line>", "steps": [{"tool": "<name>",',
  '"args": {"param": "$slot_or_$var"}, "extractTo": "<var_name_optional>"}],',
  '"slots": {"slot": "<value copied verbatim from the request>"}}',
  'Rules:',
  '- Use ONLY the listed tools, at most {maxSteps} steps.',
  '- Parameterize request-specific values as $slots; a later step may read an earlier',
  '  step\'s extractTo var as $var.',
  '- A slot value must be the shortest literal span copied verbatim from the request.',
  '  If a needed value is not stated, the request is NOT plannable.',
  '- If not confidently plannable, reply with exactly: {"intent": null}',
].join('\n');

export function buildPlanPrompt(request: string, tools: readonly ToolSchema[], config: PlannerConfig = DEFAULT_PLANNER_CONFIG): string {
  const toolLines = tools.map((tool) => `- ${tool.name}(${tool.params.join(', ')}): ${tool.description}`).join('\n');
  return PLAN_PROMPT.replace('{tools}', toolLines === '' ? '(none)' : toolLines)
    .replace('{request}', request)
    .replace('{maxSteps}', String(config.maxSteps));
}

/** Pull the first JSON object out of possibly-noisy model output. */
export function extractJsonObject(raw: string): unknown {
  const text = raw.trim();
  const direct = tryParse(text);
  if (direct !== undefined) return direct;

  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text);
  if (fenced !== null) {
    const parsed = tryParse(fenced[1] as string);
    if (parsed !== undefined) return parsed;
  }

  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return tryParse(text.slice(start, i + 1));
    }
  }
  return undefined;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sanitizeIntent(intent: string): string {
  const candidate = intent
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return INTENT_PATTERN.test(candidate) ? candidate : 'plan';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asStringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(asRecord(value))) {
    const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
    if (text !== '') out[key] = text;
  }
  return out;
}

/** Parse model output into a plan. `undefined` means "not plannable". */
export function parsePlan(raw: string): GeneratedPlan | undefined {
  const data = asRecord(extractJsonObject(raw));
  const intent = data['intent'];
  if (typeof intent !== 'string' || intent.trim() === '') return undefined;

  const rawSteps = Array.isArray(data['steps']) ? (data['steps'] as unknown[]) : [];
  const chain: ToolChainEntry[] = [];
  for (const rawStep of rawSteps) {
    const step = asRecord(rawStep);
    const tool = typeof step['tool'] === 'string' ? step['tool'].trim() : '';
    if (tool === '') return undefined;
    const extractTo = typeof step['extractTo'] === 'string' ? step['extractTo'].replace(/\W/g, '') : '';
    const parsed: ToolChainStep = {
      tool,
      args: asStringMap(step['args'] ?? step['kwargs']),
      extractTo,
      condition: 'always',
    };
    chain.push(parsed);
  }

  return {
    intent: sanitizeIntent(intent),
    description: typeof data['description'] === 'string' ? data['description'] : '',
    chain,
    slots: asStringMap(data['slots']),
  };
}

/** Problems that make a plan unrunnable. Empty means it is safe to execute. */
export function validatePlan(plan: GeneratedPlan, availableTools: ReadonlySet<string>, config: PlannerConfig = DEFAULT_PLANNER_CONFIG): readonly string[] {
  const problems: string[] = [];
  if (plan.chain.length === 0) problems.push('plan has no steps');
  if (plan.chain.length > config.maxSteps) problems.push(`plan has ${plan.chain.length} steps (max ${config.maxSteps})`);

  const produced = new Set<string>();
  for (const [index, entry] of plan.chain.entries()) {
    const steps = entrySteps(entry);
    for (const step of steps) {
      if (!availableTools.has(step.tool)) problems.push(`step ${index + 1} uses unknown tool '${step.tool}'`);
      for (const template of Object.values(step.args)) {
        for (const name of templateVars(template)) {
          if (!RESERVED_VARS.has(name) && !(name in plan.slots) && !produced.has(name)) {
            problems.push(`step ${index + 1} reads undefined '$${name}'`);
          }
        }
      }
      if (step.extractTo !== '') produced.add(step.extractTo);
    }
  }
  return problems;
}

/** Slot names the plan needs supplied from outside — its template signature. */
export function planSlotNames(plan: GeneratedPlan): readonly string[] {
  return Object.keys(plan.slots).sort();
}

export type PlanOutcome =
  | { readonly ok: true; readonly plan: GeneratedPlan; readonly raw: string }
  | { readonly ok: false; readonly reason: string; readonly raw: string };

/**
 * The whole fast tier in one call: prompt, model, parse, validate. Every
 * exit that is not `ok` is the caller's cue to fall through to slow thinking.
 */
export async function generatePlan(args: {
  readonly request: string;
  readonly tools: readonly ToolSchema[];
  readonly model: LightModel;
  readonly config?: PlannerConfig;
  readonly signal?: AbortSignal;
}): Promise<PlanOutcome> {
  const config = args.config ?? DEFAULT_PLANNER_CONFIG;
  const prompt = buildPlanPrompt(args.request, args.tools, config);

  let raw: string;
  try {
    raw = await args.model(prompt, args.signal);
  } catch (error) {
    return { ok: false, reason: `planning call failed: ${error instanceof Error ? error.message : 'unknown error'}`, raw: '' };
  }

  const plan = parsePlan(raw);
  if (plan === undefined) return { ok: false, reason: 'model judged the request not plannable', raw };

  const problems = validatePlan(plan, new Set(args.tools.map((tool) => tool.name)), config);
  if (problems.length > 0) return { ok: false, reason: problems.join('; '), raw };

  return { ok: true, plan, raw };
}
