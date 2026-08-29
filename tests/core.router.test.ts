import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTER_CONFIG, route } from '../src/core/router.js';
import type { RouterInput } from '../src/core/router.js';
import { parseEvent } from '../src/core/events.js';
import type { Event } from '../src/core/events.js';
import { parseScenario } from '../src/core/scenario.js';
import type { Scenario } from '../src/core/scenario.js';
import { createCandidate } from '../src/core/promotion.js';
import { applyOutcome, createTrust } from '../src/core/trust.js';
import type { TrustState } from '../src/core/trust.js';

const event = (text: string, kind = 'message.received'): Event =>
  parseEvent({ traceId: 't', source: 'feishu', kind, ts: 1, payload: { text } });

const ciScenario: Scenario = parseScenario({
  id: 'ci_failure_log',
  name: 'CI failure log',
  description: 'read the failing CI log',
  triggers: ['看看 dev 分支 CI 为什么挂了', 'why did the build fail'],
  chain: [{ tool: 'gh_run_log', args: { q: '$event_text' } }],
  origin: 'promoted',
});

const input = (over: Partial<RouterInput> = {}): RouterInput => ({
  event: event('why did the build fail'),
  scenarios: [ciScenario],
  candidates: [],
  trust: new Map<string, TrustState>(),
  config: DEFAULT_ROUTER_CONFIG,
  ...over,
});

describe('router', () => {
  it('sends a matching event to muscle', () => {
    const decision = route(input());
    expect(decision.tier).toBe('muscle');
    expect(decision.scenarioId).toBe('ci_failure_log');
    expect(decision.considered).toContain('ci_failure_log');
  });

  it('asks for confirmation while the scenario is still on probation', () => {
    expect(route(input()).needsConfirmation).toBe(true);
  });

  it('stops asking once the trust gate says auto', () => {
    let trust = createTrust('ci_failure_log', { required: 1, quarantineAfter: 2 });
    trust = applyOutcome(trust, 'confirmed_success');
    expect(route(input({ trust: new Map([['ci_failure_log', trust]]) })).needsConfirmation).toBe(false);
  });

  it('trusts a hand-authored scenario without asking', () => {
    const authored = parseScenario({ ...ciScenario, origin: 'authored' });
    expect(route(input({ scenarios: [authored] })).needsConfirmation).toBe(false);
  });

  it('ignores a quarantined scenario entirely', () => {
    let trust = createTrust('ci_failure_log', { required: 2, quarantineAfter: 1 });
    trust = applyOutcome(trust, 'auto_failure');
    const decision = route(input({ trust: new Map([['ci_failure_log', trust]]) }));
    expect(decision.tier).toBe('fast');
    expect(decision.scenarioId).toBeUndefined();
  });

  it('will not fire a scenario declared for another event kind', () => {
    const scoped = parseScenario({ ...ciScenario, kinds: ['tool.post_use'] });
    expect(route(input({ scenarios: [scoped] })).tier).toBe('fast');
  });

  it('ignores a scenario with no chain', () => {
    const hollow = parseScenario({ ...ciScenario, chain: [] });
    expect(route(input({ scenarios: [hollow] })).tier).toBe('fast');
  });

  it('reuses a cached plan when no scenario matches', () => {
    const candidate = createCandidate(
      { intent: 'book_room', description: '', chain: [{ tool: 'rooms', args: {}, extractTo: '', condition: 'always' }], slotNames: ['time'] },
      { query: '帮我订个会议室 下午三点', slots: { time: '下午三点' }, kind: 'message.received' },
    );
    const decision = route(input({ event: event('帮我订个会议室 下午四点'), scenarios: [], candidates: [candidate] }));
    expect(decision.tier).toBe('fast');
    expect(decision.planId).toBe(candidate.planId);
    expect(decision.reason).toContain('covers this phrasing');
  });

  it('plans afresh when nothing deterministic matches', () => {
    const decision = route(input({ event: event('帮我写一份季度总结') }));
    expect(decision.tier).toBe('fast');
    expect(decision.planId).toBeUndefined();
    expect(decision.needsConfirmation).toBe(true);
  });

  it('falls through to slow when planning is switched off', () => {
    const decision = route(input({ event: event('帮我写一份季度总结'), config: { ...DEFAULT_ROUTER_CONFIG, planningEnabled: false } }));
    expect(decision.tier).toBe('slow');
    expect(decision.reason).toContain('planning disabled');
  });

  it('sends an event with no text straight to slow', () => {
    const decision = route(input({ event: parseEvent({ traceId: 't', source: 'macos_ax', kind: 'AXValueChanged', ts: 1, payload: { pid: 9 } }) }));
    expect(decision.tier).toBe('slow');
    expect(decision.reason).toContain('no routable text');
  });

  it('honours kinds pinned to slow', () => {
    const decision = route(input({ config: { ...DEFAULT_ROUTER_CONFIG, alwaysSlowKinds: ['message.received'] } }));
    expect(decision.tier).toBe('slow');
    expect(decision.reason).toContain('pinned to slow');
  });

  it('limits how many scenarios it considers in detail', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      parseScenario({ id: `s${i}`, name: `build ${i}`, triggers: ['why did the build fail'], chain: [{ tool: 'noop' }] }),
    );
    const decision = route(input({ scenarios: many, config: { ...DEFAULT_ROUTER_CONFIG, topK: 3 } }));
    expect(decision.considered).toHaveLength(3);
  });

  it('is a pure function of its inputs', () => {
    const args = input();
    expect(route(args)).toEqual(route(args));
  });
});
