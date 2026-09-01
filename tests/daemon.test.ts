import { describe, expect, it, vi } from 'vitest';
import { Daemon } from '../src/daemon.js';
import type { ConfirmFn, DaemonOptions } from '../src/daemon.js';
import { openDb } from '../src/memory/db.js';
import { TrajectoryStore } from '../src/memory/trajectory.js';
import { Registry } from '../src/memory/registry.js';
import { parseEvent } from '../src/core/events.js';
import type { Event } from '../src/core/events.js';
import { parseScenario } from '../src/core/scenario.js';
import type { Scenario } from '../src/core/scenario.js';
import { DEFAULT_ROUTER_CONFIG } from '../src/core/router.js';
import { ok as toolOk, fail as toolFail } from '../src/execution/base.js';
import type { ToolRunner } from '../src/execution/base.js';
import type { SlowThinker } from '../src/hosts/base.js';
import type { Perceiver } from '../src/perception/base.js';

let counter = 0;
const event = (text: string): Event => parseEvent({ traceId: `t${++counter}`, source: 'feishu', kind: 'message.received', ts: Date.now(), payload: { text } });

const planReply = JSON.stringify({
  intent: 'build_log',
  description: 'read the build log',
  steps: [{ tool: 'read_log', args: { q: '$event_text' } }],
  slots: {},
});

const slowHost = (): SlowThinker & { calls: number } => {
  const host = {
    calls: 0,
    name: 'fake',
    available: async () => true,
    think: async () => {
      host.calls += 1;
      return { ok: true, text: 'reasoned answer', llmCalls: 3, durationMs: 1 };
    },
  };
  return host;
};

interface Harness {
  readonly daemon: Daemon;
  readonly store: TrajectoryStore;
  readonly registry: Registry;
  readonly host: SlowThinker & { calls: number };
  readonly modelCalls: () => number;
}

function harness(over: Partial<DaemonOptions> = {}, modelReply: string = planReply): Harness {
  const db = openDb(':memory:');
  const store = new TrajectoryStore(db);
  const registry = new Registry(db);
  const host = slowHost();
  let modelCalls = 0;
  const runner: ToolRunner = async (tool) => (tool === 'explode' ? toolFail('tool exploded', 1) : toolOk(`ran ${tool}`, 1));

  const daemon = new Daemon({
    store,
    registry,
    runner,
    tools: [{ name: 'read_log', description: 'read a log', params: ['q'] }],
    router: DEFAULT_ROUTER_CONFIG,
    trust: { required: 2, quarantineAfter: 2 },
    promotion: { promoteAfter: 2 },
    planner: { maxSteps: 5 },
    host,
    lightModel: async () => {
      modelCalls += 1;
      return modelReply;
    },
    confirm: async () => true,
    ...over,
  });
  return { daemon, store, registry, host, modelCalls: () => modelCalls };
}

const authored = (over: Partial<Scenario> = {}): Scenario =>
  parseScenario({
    id: 'read_build_log',
    name: 'Read build log',
    triggers: ['check the build log'],
    chain: [{ tool: 'read_log', args: { q: '$event_text' } }],
    origin: 'authored',
    ...over,
  });

describe('daemon tiers', () => {
  it('runs a trusted scenario as muscle, at zero model calls', async () => {
    const h = harness();
    h.registry.saveScenario(authored());
    // A fresh daemon over the same registry: what a restart would see.
    const reloaded = new Daemon({
      store: h.store,
      registry: h.registry,
      runner: async () => toolOk('log contents', 1),
      tools: [{ name: 'read_log', description: '', params: ['q'] }],
      router: DEFAULT_ROUTER_CONFIG,
      trust: { required: 2, quarantineAfter: 2 },
      promotion: { promoteAfter: 2 },
      planner: { maxSteps: 5 },
    });
    const record = await reloaded.handle(event('check the build log'));
    expect(record.tier).toBe('muscle');
    expect(record.llmCalls).toBe(0);
    expect(record.ok).toBe(true);
    expect(record.needsConfirmation).toBe(false);
    expect(record.steps[0]?.tool).toBe('read_log');
    expect(h.store.get(record.traceId)?.tier).toBe('muscle');
  });

  it('demotes a scenario whose slots a model would have to fill', async () => {
    const h = harness();
    h.registry.saveScenario(authored({ chain: [{ tool: 'read_log', args: { q: '$branch' } }] }));
    const daemon = new Daemon({
      store: h.store,
      registry: h.registry,
      runner: async () => toolOk('v', 1),
      tools: [{ name: 'read_log', description: '', params: ['q'] }],
      router: DEFAULT_ROUTER_CONFIG,
      trust: { required: 2, quarantineAfter: 2 },
      promotion: { promoteAfter: 2 },
      planner: { maxSteps: 5 },
      lightModel: async () => planReply,
      confirm: async () => true,
    });
    const record = await daemon.handle(event('check the build log'));
    expect(record.tier).toBe('fast');
    expect(record.llmCalls).toBe(1);
    expect(record.reason).toContain('slots need filling');
  });

  it('sends an unplannable event to the slow host', async () => {
    const h = harness({}, '{"intent": null}');
    const record = await h.daemon.handle(event('write me a quarterly summary please'));
    expect(record.tier).toBe('fast->slow');
    expect(record.reason).toContain('not plannable');
    expect(record.llmCalls).toBe(4);
    expect(h.host.calls).toBe(1);
  });

  it('goes slow when no LIGHT model is configured', async () => {
    const h = harness({ lightModel: undefined });
    const record = await h.daemon.handle(event('check the build log'));
    expect(record.tier).toBe('fast->slow');
    expect(record.reason).toContain('no LIGHT model');
  });

  it('records a failure rather than pretending, with no host at all', async () => {
    const h = harness({ lightModel: undefined, host: undefined });
    const record = await h.daemon.handle(event('check the build log'));
    expect(record.ok).toBe(false);
    expect(record.error).toContain('no slow-thinking host');
  });

  it('records a chain whose step failed', async () => {
    const h = harness({
      runner: async () => toolFail('tool exploded', 1),
      confirm: async () => true,
    });
    const record = await h.daemon.handle(event('check the build log'));
    expect(record.ok).toBe(false);
    expect(record.error).toContain('read_log');
  });
});

describe('trust gate in the loop', () => {
  it('asks before running an unproven chain and honours a refusal', async () => {
    const confirm = vi.fn<ConfirmFn>(async () => false);
    const h = harness({ confirm });
    const record = await h.daemon.handle(event('check the build log'));
    expect(confirm).toHaveBeenCalledOnce();
    expect(record.confirmed).toBe(false);
    expect(record.needsConfirmation).toBe(true);
    expect(h.host.calls).toBe(1);
    expect(record.reason).toContain('declined by operator');
  });

  it('leaves the request pending when nobody is there to ask', async () => {
    const h = harness({ confirm: undefined });
    const record = await h.daemon.handle(event('check the build log'));
    expect(record.needsConfirmation).toBe(true);
    expect(record.confirmed).toBeNull();
    expect(h.store.pendingConfirmations().map((r) => r.traceId)).toEqual([record.traceId]);
  });
});

describe('promotion through the loop', () => {
  it('plans once, reuses the plan for free, then promotes it to muscle', async () => {
    const h = harness();

    const first = await h.daemon.handle(event('check the build log for dev'));
    expect(first.tier).toBe('fast');
    expect(first.llmCalls).toBe(1);
    expect(h.daemon.knownCandidates()).toHaveLength(1);
    expect(h.daemon.knownScenarios()).toHaveLength(0);

    const second = await h.daemon.handle(event('check the build log for release'));
    expect(second.tier).toBe('fast');
    expect(second.planId).toBe(first.planId);
    expect(second.llmCalls).toBe(0);
    expect(h.modelCalls()).toBe(1);
    expect(h.daemon.knownScenarios()).toHaveLength(1);
    expect(h.registry.scenarios()[0]?.origin).toBe('promoted');

    const third = await h.daemon.handle(event('check the build log for main'));
    expect(third.tier).toBe('muscle');
    expect(third.llmCalls).toBe(0);
    expect(third.needsConfirmation).toBe(false);
    expect(h.store.tierStats().find((row) => row.tier === 'muscle')?.llmCalls).toBe(0);
  });

  it('keeps the rule track shut when a run fails, and quarantines a repeat offender', async () => {
    const h = harness({ runner: async () => toolFail('tool exploded', 1) });
    await h.daemon.handle(event('check the build log for dev'));
    await h.daemon.handle(event('check the build log for release'));
    expect(h.daemon.knownScenarios()).toHaveLength(0);
    const candidate = h.daemon.knownCandidates()[0];
    expect(candidate?.failures).toBeGreaterThan(0);
    expect(h.daemon.promote(candidate?.planId ?? '')).toMatchObject({ ok: false });
  });

  it('promotes on the manual track and reports an unknown id', async () => {
    const h = harness();
    const first = await h.daemon.handle(event('check the build log for dev'));
    expect(h.daemon.promote(first.planId ?? '')).toMatchObject({ ok: true });
    expect(h.registry.scenarios()).toHaveLength(1);
    expect(h.daemon.promote('plan_nope_0')).toMatchObject({ ok: false, reason: expect.stringContaining('no plan candidate') });
  });
});

describe('daemon run loop', () => {
  it('consumes events from its perceivers until they end', async () => {
    const perceiver: Perceiver = {
      name: 'fixture',
      events: async function* () {
        yield event('check the build log for dev');
        yield event('check the build log for release');
      },
      close: async () => undefined,
    };
    const h = harness({ perceivers: [perceiver] });
    await h.daemon.run();
    expect(h.store.recent(10)).toHaveLength(2);
  });
});
