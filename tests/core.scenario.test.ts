import { describe, expect, it } from 'vitest';
import { chainSteps, entrySteps, isGroup, parseScenario, requiredVars, scenarioDocument, templateVars, validateScenario } from '../src/core/scenario.js';
import type { Scenario, ToolChainStep } from '../src/core/scenario.js';

const step = (tool: string, over: Partial<ToolChainStep> = {}): ToolChainStep => ({ tool, args: {}, extractTo: '', condition: 'always', ...over });

const scenario = (over: Partial<Scenario> = {}): Scenario =>
  parseScenario({ id: 's1', name: 'S', chain: [step('a')], ...over });

describe('scenario', () => {
  it('reads template variables out of a string', () => {
    expect(templateVars('$a and $b_2 and plain')).toEqual(['a', 'b_2']);
  });

  it('flattens single steps and parallel groups alike', () => {
    const s = scenario({ chain: [step('a'), [step('b'), step('c')]] });
    expect(chainSteps(s.chain).map((x) => x.tool)).toEqual(['a', 'b', 'c']);
    expect(isGroup(s.chain[1]!)).toBe(true);
    expect(entrySteps(s.chain[0]!)).toHaveLength(1);
  });

  it('subtracts reserved and produced vars from what a chain needs', () => {
    const s = scenario({
      chain: [step('a', { args: { q: '$topic $event_text' }, extractTo: 'found' }), step('b', { args: { q: '$found $other' } })],
    });
    expect(requiredVars(s.chain)).toEqual(['other', 'topic']);
  });

  it('counts condition variables as required too', () => {
    const s = scenario({ chain: [step('a', { condition: '$mode == fast' })] });
    expect(requiredVars(s.chain)).toEqual(['mode']);
  });

  it('builds a retrieval document from triggers and identity', () => {
    const s = scenario({ name: 'Check CI', description: 'looks at builds', triggers: ['ci 挂了'], kinds: ['message.received'] });
    expect(scenarioDocument(s)).toContain('ci 挂了');
    expect(scenarioDocument(s)).toContain('message.received');
  });

  it('flags unknown tools, dangling vars and empty chains', () => {
    const empty = scenario({ chain: [] });
    expect(validateScenario(empty, new Set())).toContain('chain has no steps');

    const s = scenario({ chain: [step('a', { args: { q: '$missing' } })] });
    const problems = validateScenario(s, new Set(['a']));
    expect(problems.join(' ')).toContain("reads '$missing'");
    expect(validateScenario(s, new Set()).join(' ')).toContain("unknown tool 'a'");
  });

  it('does not let a group member read a sibling output', () => {
    const s = scenario({ chain: [[step('a', { extractTo: 'x' }), step('b', { args: { q: '$x' } })]] });
    expect(validateScenario(s, new Set(['a', 'b'])).join(' ')).toContain("reads '$x'");
  });

  it('accepts a var produced by an earlier entry', () => {
    const s = scenario({ chain: [step('a', { extractTo: 'x' }), step('b', { args: { q: '$x' } })] });
    expect(validateScenario(s, new Set(['a', 'b']))).toEqual([]);
  });
});
