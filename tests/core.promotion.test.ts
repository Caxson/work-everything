import { describe, expect, it } from 'vitest';
import {
  createCandidate,
  describeCandidate,
  makePlanId,
  matchCandidate,
  MAX_ANCHORS,
  observe,
  planShape,
  promotionReadiness,
  recordRun,
  stripSlotValues,
  toScenario,
} from '../src/core/promotion.js';
import type { PlanCandidate } from '../src/core/promotion.js';
import type { ToolChainEntry } from '../src/core/scenario.js';
import { applyOutcome, createTrust, initialTrust } from '../src/core/trust.js';

const chain: readonly ToolChainEntry[] = [
  { tool: 'gh_run_list', args: { branch: '$branch' }, extractTo: 'runs', condition: 'always' },
  { tool: 'gh_run_log', args: { id: '$runs' }, extractTo: '', condition: 'always' },
];

const candidate = (): PlanCandidate =>
  createCandidate({ intent: 'ci_failure_log', description: 'read the failing CI log', chain, slotNames: ['branch'] }, { query: '看看 dev 分支 CI 为什么挂了', slots: { branch: 'dev' }, kind: 'message.received' });

const trustConfig = { required: 1, quarantineAfter: 2 };

describe('anchor normalization', () => {
  it('removes slot values so two phrasings share a skeleton', () => {
    const a = stripSlotValues('看看 dev 分支 CI 为什么挂了', { branch: 'dev' });
    const b = stripSlotValues('看看 release 分支 CI 为什么挂了', { branch: 'release' });
    expect(a).toBe(b);
  });

  it('strips the longest value first so overlaps come out cleanly', () => {
    expect(stripSlotValues('北京市天气', { a: '北京', b: '北京市' })).toBe('天气');
  });

  it('ignores empty slot values', () => {
    expect(stripSlotValues('unchanged text', { a: '' })).toBe('unchanged text');
  });
});

describe('plan identity', () => {
  it('hashes tools and arg names, not values', () => {
    const other: readonly ToolChainEntry[] = [
      { tool: 'gh_run_list', args: { branch: '$other' }, extractTo: 'runs', condition: 'always' },
      { tool: 'gh_run_log', args: { id: '$runs' }, extractTo: '', condition: 'always' },
    ];
    expect(planShape(other)).toBe(planShape(chain));
    expect(makePlanId('ci_failure_log', other)).toBe(makePlanId('ci_failure_log', chain));
  });

  it('separates chains that differ in shape', () => {
    expect(makePlanId('x', chain)).not.toBe(makePlanId('x', [chain[0]!]));
  });

  it('renders a group in the shape', () => {
    expect(planShape([[chain[0] as never, chain[1] as never]])).toContain('&');
  });
});

describe('candidate bookkeeping', () => {
  it('records the first observation and derives its anchor', () => {
    const c = candidate();
    expect(c.sourceQueries).toHaveLength(1);
    expect(c.anchors[0]).not.toContain('dev');
    expect(c.kinds).toEqual(['message.received']);
    expect(describeCandidate(c)).toBe('gh_run_list -> gh_run_log');
  });

  it('deduplicates identical phrasings and caps the anchor list', () => {
    let c = candidate();
    c = observe(c, { query: '看看 dev 分支 CI 为什么挂了', slots: { branch: 'dev' }, kind: 'message.received' });
    expect(c.sourceQueries).toHaveLength(1);
    for (let i = 0; i < 20; i += 1) c = observe(c, { query: `phrasing ${i}`, slots: {}, kind: 'message.received' });
    expect(c.sourceQueries).toHaveLength(MAX_ANCHORS);
  });

  it('counts runs without mutating the previous value', () => {
    const c = candidate();
    const after = recordRun(recordRun(c, true), false);
    expect(after.successes).toBe(1);
    expect(after.failures).toBe(1);
    expect(c.successes).toBe(0);
  });
});

describe('matching', () => {
  it('matches a different value in the same phrasing', () => {
    const match = matchCandidate('看看 release 分支 CI 为什么挂了', [candidate()], 0.6);
    expect(match?.candidate.intent).toBe('ci_failure_log');
  });

  it('does not match an unrelated request', () => {
    expect(matchCandidate('帮我订个会议室', [candidate()], 0.6)).toBeUndefined();
  });

  it('skips candidates that have already been promoted', () => {
    expect(matchCandidate('看看 dev 分支 CI 为什么挂了', [{ ...candidate(), promoted: true }], 0.6)).toBeUndefined();
  });
});

describe('promotion gates', () => {
  it('withholds both tracks once a chain is promoted', () => {
    const readiness = promotionReadiness({ ...candidate(), promoted: true }, createTrust('p', trustConfig));
    expect(readiness).toMatchObject({ rule: false, manual: false });
  });

  it('withholds both tracks for a quarantined chain', () => {
    let trust = createTrust('p', trustConfig);
    trust = applyOutcome(applyOutcome(trust, 'auto_failure'), 'auto_failure');
    const readiness = promotionReadiness(candidate(), trust);
    expect(readiness.manual).toBe(false);
    expect(readiness.reason).toContain('quarantined');
  });

  it('keeps the rule track shut while the trust gate is unfinished', () => {
    const readiness = promotionReadiness(recordRun(candidate(), true), createTrust('p', trustConfig));
    expect(readiness).toMatchObject({ rule: false, manual: true });
    expect(readiness.reason).toContain('trust gate');
  });

  it('keeps the rule track shut after any failure, but allows a human', () => {
    const trust = applyOutcome(createTrust('p', trustConfig), 'confirmed_success');
    const readiness = promotionReadiness(recordRun(candidate(), false), trust);
    expect(readiness).toMatchObject({ rule: false, manual: true });
    expect(readiness.reason).toContain('failed run');
  });

  it('opens the rule track on clean runs past the threshold', () => {
    const trust = applyOutcome(createTrust('p', trustConfig), 'confirmed_success');
    let c = candidate();
    for (let i = 0; i < 3; i += 1) c = recordRun(c, true);
    expect(promotionReadiness(c, trust, { promoteAfter: 3 }).rule).toBe(true);
    expect(promotionReadiness(c, trust, { promoteAfter: 9 }).rule).toBe(false);
  });

  it('turns a candidate into a scenario whose triggers are real phrasings', () => {
    const scenario = toScenario(candidate());
    expect(scenario.origin).toBe('promoted');
    expect(scenario.triggers).toEqual(['看看 dev 分支 CI 为什么挂了']);
    expect(scenario.chain).toEqual(chain);
    expect(initialTrust(scenario.id, scenario.origin).confirmations).toBe(0);
  });

  it('gives a description-less candidate a traceable one', () => {
    const scenario = toScenario({ ...candidate(), description: '' });
    expect(scenario.description).toContain('Promoted from');
  });
});
