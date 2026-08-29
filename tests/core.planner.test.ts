import { describe, expect, it } from 'vitest';
import { buildPlanPrompt, extractJsonObject, generatePlan, parsePlan, planSlotNames, validatePlan } from '../src/core/planner.js';
import type { GeneratedPlan, LightModel, ToolSchema } from '../src/core/planner.js';

const tools: readonly ToolSchema[] = [
  { name: 'gh_run_list', description: 'list workflow runs', params: ['branch'] },
  { name: 'gh_run_log', description: 'fetch a run log', params: ['id'] },
];

const goodPlan = JSON.stringify({
  intent: 'ci_failure_log',
  description: 'read the failing CI log',
  steps: [
    { tool: 'gh_run_list', args: { branch: '$branch' }, extractTo: 'runId' },
    { tool: 'gh_run_log', args: { id: '$runId' } },
  ],
  slots: { branch: 'dev' },
});

describe('plan prompt', () => {
  it('lists the tools and the step budget', () => {
    const prompt = buildPlanPrompt('why did dev fail', tools, { maxSteps: 4 });
    expect(prompt).toContain('gh_run_list(branch): list workflow runs');
    expect(prompt).toContain('at most 4 steps');
    expect(prompt).toContain('why did dev fail');
  });

  it('says so when there are no tools at all', () => {
    expect(buildPlanPrompt('x', [])).toContain('(none)');
  });
});

describe('tolerant JSON extraction', () => {
  it('reads a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads a fenced object', () => {
    expect(extractJsonObject('sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('reads an object buried in prose with nested braces', () => {
    expect(extractJsonObject('here you go: {"a":{"b":2}} hope that helps')).toEqual({ a: { b: 2 } });
  });

  it('gives up on unbalanced or absent objects', () => {
    expect(extractJsonObject('no object here')).toBeUndefined();
    expect(extractJsonObject('{"a": ')).toBeUndefined();
  });
});

describe('parsePlan', () => {
  it('builds a chain, an intent and this request\'s slots', () => {
    const plan = parsePlan(goodPlan);
    expect(plan?.intent).toBe('ci_failure_log');
    expect(plan?.chain).toHaveLength(2);
    expect(planSlotNames(plan as GeneratedPlan)).toEqual(['branch']);
  });

  it('treats an explicit null intent as "not plannable"', () => {
    expect(parsePlan('{"intent": null}')).toBeUndefined();
    expect(parsePlan('I cannot do that')).toBeUndefined();
  });

  it('accepts kwargs as an alias for args', () => {
    const plan = parsePlan('{"intent":"x","steps":[{"tool":"a","kwargs":{"q":"1"}}]}');
    expect(plan?.chain[0]).toMatchObject({ tool: 'a', args: { q: '1' } });
  });

  it('sanitizes an unusable intent instead of trusting it', () => {
    expect(parsePlan('{"intent":"Read The CI Log!","steps":[]}')?.intent).toBe('read_the_ci_log');
    expect(parsePlan('{"intent":"!!!","steps":[]}')?.intent).toBe('plan');
  });

  it('rejects a step with no tool name', () => {
    expect(parsePlan('{"intent":"x","steps":[{"args":{}}]}')).toBeUndefined();
  });

  it('drops empty slot values rather than passing blanks along', () => {
    expect(parsePlan('{"intent":"x","steps":[{"tool":"a"}],"slots":{"b":"  "}}')?.slots).toEqual({});
  });
});

describe('validatePlan', () => {
  const plan = (): GeneratedPlan => parsePlan(goodPlan) as GeneratedPlan;

  it('accepts a plan whose vars all resolve', () => {
    expect(validatePlan(plan(), new Set(['gh_run_list', 'gh_run_log']))).toEqual([]);
  });

  it('rejects unknown tools', () => {
    expect(validatePlan(plan(), new Set(['gh_run_list'])).join(' ')).toContain("unknown tool 'gh_run_log'");
  });

  it('rejects a var that nothing defines', () => {
    const broken = parsePlan('{"intent":"x","steps":[{"tool":"a","args":{"q":"$nope"}}]}') as GeneratedPlan;
    expect(validatePlan(broken, new Set(['a'])).join(' ')).toContain("undefined '$nope'");
  });

  it('allows reserved vars without a slot', () => {
    const reserved = parsePlan('{"intent":"x","steps":[{"tool":"a","args":{"q":"$event_text"}}]}') as GeneratedPlan;
    expect(validatePlan(reserved, new Set(['a']))).toEqual([]);
  });

  it('rejects empty and over-long plans', () => {
    expect(validatePlan({ intent: 'x', description: '', chain: [], slots: {} }, new Set()).join(' ')).toContain('no steps');
    expect(validatePlan(plan(), new Set(['gh_run_list', 'gh_run_log']), { maxSteps: 1 }).join(' ')).toContain('max 1');
  });
});

describe('generatePlan', () => {
  const model = (reply: string): LightModel => async () => reply;

  it('returns a validated plan on the happy path', async () => {
    const outcome = await generatePlan({ request: 'why did dev fail', tools, model: model(goodPlan) });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.plan.slots).toEqual({ branch: 'dev' });
  });

  it('reports an unplannable request without throwing', async () => {
    const outcome = await generatePlan({ request: 'x', tools, model: model('{"intent": null}') });
    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) expect(outcome.reason).toContain('not plannable');
  });

  it('reports a plan that references a tool it was not given', async () => {
    const outcome = await generatePlan({ request: 'x', tools: [tools[0] as ToolSchema], model: model(goodPlan) });
    if (!outcome.ok) expect(outcome.reason).toContain('unknown tool');
    else throw new Error('expected validation to fail');
  });

  it('turns a failing model call into a plain reason, not an exception', async () => {
    const outcome = await generatePlan({
      request: 'x',
      tools,
      model: async () => {
        throw new Error('endpoint down');
      },
    });
    if (!outcome.ok) expect(outcome.reason).toContain('endpoint down');
    else throw new Error('expected the call to fail');
  });
});
