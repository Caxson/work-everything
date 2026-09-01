import { describe, expect, it, vi } from 'vitest';
import { evaluateCondition, executeChain, renderArgs, renderTemplate } from '../src/core/engine.js';
import type { Scenario, ToolChainEntry, ToolChainStep } from '../src/core/scenario.js';
import { fail, ok, type ToolResult, type ToolRunner } from '../src/execution/base.js';

const step = (tool: string, over: Partial<ToolChainStep> = {}): ToolChainStep => ({ tool, args: {}, extractTo: '', condition: 'always', ...over });

const scenario = (chain: readonly ToolChainEntry[], onFailure: Scenario['onFailure'] = 'fail_fast'): Scenario => ({
  id: 's',
  name: 'S',
  description: '',
  triggers: [],
  kinds: [],
  chain,
  onFailure,
  origin: 'authored',
});

const runner = (impl: (tool: string, args: Readonly<Record<string, string>>) => ToolResult | Promise<ToolResult>): ToolRunner => async (tool, args) => impl(tool, args);

describe('engine templates and conditions', () => {
  it('substitutes known vars and leaves unknown ones literal', () => {
    expect(renderTemplate('$a/$b', { a: 'x' })).toBe('x/$b');
  });

  it('renders every arg of a step', () => {
    expect(renderArgs(step('t', { args: { a: '$x', b: 'plain' } }), { x: '1' })).toEqual({ a: '1', b: 'plain' });
  });

  it('covers the whole condition grammar', () => {
    expect(evaluateCondition('always', {})).toBe(true);
    expect(evaluateCondition('', {})).toBe(true);
    expect(evaluateCondition('never', {})).toBe(false);
    expect(evaluateCondition('$x', { x: 'v' })).toBe(true);
    expect(evaluateCondition('$x', { x: '' })).toBe(false);
    expect(evaluateCondition('$x', { x: 'false' })).toBe(false);
    expect(evaluateCondition('!$x', {})).toBe(true);
    expect(evaluateCondition('!$x', { x: 'v' })).toBe(false);
    expect(evaluateCondition("$s == 'red'", { s: 'red' })).toBe(true);
    expect(evaluateCondition('$s != red', { s: 'red' })).toBe(false);
    expect(evaluateCondition('nonsense', {})).toBe(true);
  });
});

describe('executeChain', () => {
  it('threads an extracted value into the next entry', async () => {
    const seen: Record<string, string>[] = [];
    const result = await executeChain(scenario([step('first', { extractTo: 'id' }), step('second', { args: { q: '$id' } })]), {
      runner: runner((_tool, args) => {
        seen.push({ ...args });
        return ok('A-1', 1);
      }),
      vars: {},
    });
    expect(result.ok).toBe(true);
    expect(seen[1]).toEqual({ q: 'A-1' });
    expect(result.vars['id']).toBe('A-1');
  });

  it('serializes a non-string result before it enters the bag', async () => {
    const result = await executeChain(scenario([step('first', { extractTo: 'obj' })]), {
      runner: runner(() => ok({ a: 1 }, 1)),
      vars: {},
    });
    expect(result.vars['obj']).toBe('{"a":1}');
  });

  it('runs a group concurrently against one snapshot', async () => {
    let running = 0;
    let peak = 0;
    const result = await executeChain(scenario([[step('a', { extractTo: 'x' }), step('b')]]), {
      runner: runner(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
        return ok('v', 5);
      }),
      vars: {},
    });
    expect(peak).toBe(2);
    expect(result.steps.map((s) => s.entryIndex)).toEqual([0, 0]);
  });

  it('stops the chain on failure under fail_fast', async () => {
    const calls: string[] = [];
    const result = await executeChain(scenario([step('a'), step('b')]), {
      runner: runner((tool) => {
        calls.push(tool);
        return tool === 'a' ? fail('boom', 1) : ok('v', 1);
      }),
      vars: {},
    });
    expect(calls).toEqual(['a']);
    expect(result.ok).toBe(false);
    expect(result.failedTools).toEqual(['a']);
  });

  it('keeps going under best_effort but still reports failure', async () => {
    const calls: string[] = [];
    const result = await executeChain(scenario([step('a'), step('b')], 'best_effort'), {
      runner: runner((tool) => {
        calls.push(tool);
        return tool === 'a' ? fail('boom', 1) : ok('v', 1);
      }),
      vars: {},
    });
    expect(calls).toEqual(['a', 'b']);
    expect(result.ok).toBe(false);
  });

  it('skips steps whose condition is false', async () => {
    const result = await executeChain(scenario([step('a', { condition: '$flag' }), step('b')]), {
      runner: runner(() => ok('v', 1)),
      vars: {},
    });
    expect(result.skipped).toEqual(['a']);
    expect(result.steps).toHaveLength(1);
  });

  it('reports an empty chain as not ok rather than as success', async () => {
    const result = await executeChain(scenario([]), { runner: runner(() => ok('v', 1)), vars: {} });
    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([]);
  });

  it('lets a throwing observer see steps without breaking the chain', async () => {
    const onStep = vi.fn(() => {
      throw new Error('observer exploded');
    });
    const result = await executeChain(scenario([step('a')]), { runner: runner(() => ok('v', 1)), vars: {}, onStep });
    expect(onStep).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });

  it('does not mutate the caller\'s variable bag', async () => {
    const vars = { seed: '1' };
    await executeChain(scenario([step('a', { extractTo: 'added' })]), { runner: runner(() => ok('v', 1)), vars });
    expect(vars).toEqual({ seed: '1' });
  });
});
