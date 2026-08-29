/**
 * Deterministic chain engine — the one execution path.
 *
 * Both tiers that do not think run through here: a promoted Scenario and a
 * freshly planned chain are the same object by the time they arrive, so
 * there is exactly one place where conditions are evaluated, parallel groups
 * are fanned out, variables are rendered and failures are policed.
 *
 * The variable bag is never mutated. Each entry produces a new bag, so a
 * step can never observe a sibling's output and the trajectory can record
 * any intermediate state without worrying about it changing later.
 */
import type { Scenario, ToolChainStep } from './scenario.js';
import { entrySteps } from './scenario.js';
import type { ToolResult, ToolRunner } from '../execution/base.js';

export type VarBag = Readonly<Record<string, string>>;

export interface StepRecord {
  readonly tool: string;
  readonly args: Readonly<Record<string, string>>;
  readonly result: ToolResult;
  /** Index of the entry (not the step) this ran in — parallel members share it. */
  readonly entryIndex: number;
}

export interface ChainResult {
  readonly ok: boolean;
  readonly vars: VarBag;
  readonly steps: readonly StepRecord[];
  readonly skipped: readonly string[];
  readonly failedTools: readonly string[];
  readonly durationMs: number;
}

export interface ExecuteOptions {
  readonly runner: ToolRunner;
  /** Seed variables: reserved event vars plus any extracted slots. */
  readonly vars: VarBag;
  readonly signal?: AbortSignal;
  /** Observability seam; a throwing observer must not break the chain. */
  readonly onStep?: (record: StepRecord) => void;
}

/**
 * Substitute `$name` against the bag. An unknown variable is left as the
 * literal template — the same rule the planner validates against, so an
 * undeclared var shows up as a wrong argument, never as a silent empty
 * string that a tool might happily accept.
 */
export function renderTemplate(template: string, vars: VarBag): string {
  return template.replace(/\$(\w+)/g, (whole, name: string) => vars[name] ?? whole);
}

export function renderArgs(step: ToolChainStep, vars: VarBag): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(step.args).map(([key, template]) => [key, renderTemplate(template, vars)]));
}

/**
 * The whole condition grammar, deliberately tiny — no expression language:
 *   `always` / ``  → run;  `never` → skip
 *   `$var`         → run when the var is set and not empty
 *   `!$var`        → run when the var is missing or empty
 *   `$var == lit`  / `$var != lit` → string comparison against the bag
 * Anything unrecognized runs, so a typo cannot silently disable a step.
 */
export function evaluateCondition(condition: string, vars: VarBag): boolean {
  const text = condition.trim();
  if (text === '' || text === 'always') return true;
  if (text === 'never') return false;
  if (text.startsWith('!$')) return !truthy(vars[text.slice(2)]);

  if (text.startsWith('$')) {
    for (const op of ['==', '!='] as const) {
      const at = text.indexOf(op);
      if (at === -1) continue;
      const name = text.slice(1, at).trim();
      const literal = text.slice(at + op.length).trim().replace(/^['"]|['"]$/g, '');
      const value = vars[name] ?? '';
      return op === '==' ? value === literal : value !== literal;
    }
    return truthy(vars[text.slice(1)]);
  }
  return true;
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== 'false' && value !== '0';
}

/** Value written into the bag by a step's `extractTo`. */
function extractedValue(result: ToolResult): string {
  const { value } = result;
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Run a chain. Steps inside one entry are fanned out together and joined
 * before the next entry; each of them sees the bag as it was *before* the
 * entry started, which is what makes "no dependencies within a group" a
 * property of the engine rather than a promise from the chain's author.
 */
export async function executeChain(scenario: Scenario, options: ExecuteOptions): Promise<ChainResult> {
  const started = Date.now();
  const steps: StepRecord[] = [];
  const skipped: string[] = [];
  const failedTools: string[] = [];
  let vars: VarBag = { ...options.vars };

  for (const [entryIndex, entry] of scenario.chain.entries()) {
    const snapshot = vars;
    const group = entrySteps(entry).filter((step) => {
      const run = evaluateCondition(step.condition, snapshot);
      if (!run) skipped.push(step.tool);
      return run;
    });
    if (group.length === 0) continue;

    const prepared = group.map((step) => ({ step, args: renderArgs(step, snapshot) }));
    const results = await Promise.all(
      prepared.map(({ step, args }) => options.runner(step.tool, args, options.signal)),
    );

    const extracted: Record<string, string> = {};
    let groupFailed = false;
    for (const [i, { step, args }] of prepared.entries()) {
      const result = results[i] as ToolResult;
      const record: StepRecord = { tool: step.tool, args, result, entryIndex };
      steps.push(record);
      notify(options.onStep, record);
      if (result.ok) {
        if (step.extractTo !== '') extracted[step.extractTo] = extractedValue(result);
      } else {
        groupFailed = true;
        failedTools.push(step.tool);
      }
    }
    vars = { ...snapshot, ...extracted };

    if (groupFailed && scenario.onFailure === 'fail_fast') break;
  }

  return {
    ok: failedTools.length === 0 && steps.length > 0,
    vars,
    steps,
    skipped,
    failedTools,
    durationMs: Date.now() - started,
  };
}

/** An observer's failure is its own problem; the chain keeps its result. */
function notify(onStep: ExecuteOptions['onStep'], record: StepRecord): void {
  if (onStep === undefined) return;
  try {
    onStep(record);
  } catch {
    // Intentionally swallowed: observation must not change execution.
  }
}
