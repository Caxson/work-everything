import { describe, expect, it } from 'vitest';
import { openDb } from '../src/memory/db.js';
import { TrajectoryStore } from '../src/memory/trajectory.js';
import { DeferredStore } from '../src/memory/deferred.js';
import { parseScenario } from '../src/core/scenario.js';
import type { Scenario } from '../src/core/scenario.js';
import { fail as toolFail, ok as toolOk } from '../src/execution/base.js';
import type { ToolRunner } from '../src/execution/base.js';
import { ScreenSensor } from '../src/queue/screen.js';
import { QueueJournal, QUEUE_TIERS } from '../src/queue/journal.js';
import { PreconditionRegistry, broken, fixedChecker, holds, notYet } from '../src/queue/preconditions.js';
import { QueueDrainer } from '../src/queue/drain.js';
import { DEFAULT_DEFERRAL_CONFIG, type DeferralConfig, type DeferralRequest } from '../src/queue/deferred.js';

const NOW = 1_700_000_000_000;
const PREMISE = 'feishu.reply';

const chain = (...tools: readonly string[]): Scenario =>
  parseScenario({ id: 'reply', name: 'reply', chain: tools.map((tool) => ({ tool, args: { text: '$text' } })) });

const request = (traceId: string, over: Partial<DeferralRequest> = {}): DeferralRequest => ({
  traceId,
  chain: chain('feishu.reply'),
  vars: { text: `answer for ${traceId}` },
  purpose: `reply to ${traceId}`,
  precondition: { kind: PREMISE, facts: { chat: 'Ops', originTraceId: traceId } },
  ...over,
});

interface Harness {
  readonly drainer: QueueDrainer;
  readonly queue: DeferredStore;
  readonly store: TrajectoryStore;
  readonly sensor: ScreenSensor;
  readonly ran: { tool: string; args: Readonly<Record<string, string>> }[];
  readonly lines: string[];
  readonly setNow: (value: number) => void;
  readonly setLocked: (value: boolean) => void;
}

function harness(
  over: {
    config?: Partial<DeferralConfig>;
    checker?: Parameters<PreconditionRegistry['register']>[1];
    runner?: ToolRunner;
    registerChecker?: boolean;
  } = {},
): Harness {
  const db = openDb(':memory:');
  const store = new TrajectoryStore(db);
  let ids = 0;
  const queue = new DeferredStore(db, { id: () => `q${++ids}` });

  let now = NOW;
  let locked = true;
  const sensor = new ScreenSensor({ probe: async () => ({ locked }), now: () => now });

  const preconditions = new PreconditionRegistry();
  if (over.registerChecker !== false) preconditions.register(PREMISE, over.checker ?? fixedChecker(holds("'Ops' is open")));

  const ran: { tool: string; args: Readonly<Record<string, string>> }[] = [];
  const runner: ToolRunner =
    over.runner ??
    (async (tool, args) => {
      ran.push({ tool, args });
      return toolOk(`sent via ${tool}`, 1);
    });

  const lines: string[] = [];
  const drainer = new QueueDrainer({
    sensor,
    store: queue,
    journal: new QueueJournal(store, () => now),
    preconditions,
    runner,
    config: { ...DEFAULT_DEFERRAL_CONFIG, ...over.config },
    now: () => now,
    sleep: async () => undefined,
    log: (line) => lines.push(line),
  });

  return {
    drainer,
    queue,
    store,
    sensor,
    ran,
    lines,
    setNow: (value) => {
      now = value;
    },
    setLocked: (value) => {
      locked = value;
    },
  };
}

const config = (over: Partial<DeferralConfig> = {}): DeferralConfig => ({ ...DEFAULT_DEFERRAL_CONFIG, ...over });

describe('draining the queue after an unlock', () => {
  it('holds everything while the screen is still locked', async () => {
    const h = harness();
    h.queue.add(request('a'), config(), NOW);

    const report = await h.drainer.tick();
    expect(report.stoppedBecause).toContain('screen: locked');
    expect(h.ran).toEqual([]);
    expect(h.queue.pendingCount()).toBe(1);
  });

  it('holds for a blocker no poll can see, and drains when a reading lifts it', async () => {
    // The Mac is unlocked throughout: `env` reports the lock and says nothing
    // about Spaces, so a poll that comes back unlocked is not permission to run.
    const h = harness();
    h.queue.add(request('a'), config(), NOW);
    h.setLocked(false);
    h.sensor.note('fullscreen_space', 'the active Space belongs to a full-screen application (Google Chrome)');

    const held = await h.drainer.tick();
    expect(held.executed).toEqual([]);
    expect(held.stoppedBecause).toContain('a full-screen application owns the active Space');
    expect(h.ran).toEqual([]);
    expect(h.queue.pendingCount()).toBe(1);

    h.sensor.clear('fullscreen_space');
    const drained = await h.drainer.tick();
    expect(drained.executed.map((action) => action.traceId)).toEqual(['a']);
    expect(h.ran.map((call) => call.args['text'])).toEqual(['answer for a']);
  });

  it('runs what it was holding, in the order it was queued', async () => {
    const h = harness();
    for (const traceId of ['a', 'b', 'c']) h.queue.add(request(traceId), config(), NOW);
    h.setLocked(false);

    const report = await h.drainer.tick();
    expect(report.executed.map((action) => action.traceId)).toEqual(['a', 'b', 'c']);
    expect(h.ran.map((call) => call.args['text'])).toEqual(['answer for a', 'answer for b', 'answer for c']);
    expect(h.queue.pending()).toEqual([]);
    expect(h.queue.settled(10).map((action) => action.status)).toEqual(['executed', 'executed', 'executed']);
  });

  it('records the delayed run in the trajectory, with its steps and how long it waited', async () => {
    const h = harness();
    h.queue.add(request('feishu-1'), config(), NOW);
    h.setLocked(false);
    h.setNow(NOW + 120_000);
    await h.drainer.tick();

    const record = h.store.get('feishu-1:drained:q1');
    expect(record?.tier).toBe(QUEUE_TIERS.executed);
    expect(record?.ok).toBe(true);
    expect(record?.reason).toContain('after waiting 2m0s');
    expect(record?.reason).toContain("'Ops' is open");
    expect(record?.steps.map((step) => step.tool)).toEqual(['feishu.reply']);
  });

  it('drops an action past its TTL without running it and without asking anyone', async () => {
    const h = harness();
    h.queue.add(request('a'), config({ ttlMs: 60_000 }), NOW);
    h.setLocked(false);
    h.setNow(NOW + 60_001);

    const report = await h.drainer.tick();
    expect(h.ran).toEqual([]);
    expect(report.discarded.map((action) => action.status)).toEqual(['expired']);
    expect(report.discarded[0]?.detail).toContain('past the point where it was still the action that was authorized');
    expect(h.store.get('a:discarded:q1')?.tier).toBe(QUEUE_TIERS.discarded);
    // Not offered to a person either: an expired action is incoherent, and
    // asking for approval of it would be worse than dropping it.
    expect(h.store.pendingConfirmations()).toEqual([]);
  });

  it('checks the TTL before the premise, so an expired action costs no read of the world', async () => {
    let checked = 0;
    const h = harness({
      checker: async () => {
        checked += 1;
        return holds('open');
      },
      config: { ttlMs: 1_000 },
    });
    h.queue.add(request('a'), config({ ttlMs: 1_000 }), NOW);
    h.setLocked(false);
    h.setNow(NOW + 5_000);

    await h.drainer.tick();
    expect(checked).toBe(0);
  });

  it('drops an action whose premise is gone, and says what moved', async () => {
    const h = harness({ checker: fixedChecker(broken("'Ops' is no longer in feishu.allowedChats")) });
    h.queue.add(request('a'), config(), NOW);
    h.setLocked(false);

    const report = await h.drainer.tick();
    expect(h.ran).toEqual([]);
    expect(report.discarded.map((action) => action.status)).toEqual(['precondition_broken']);
    expect(report.discarded[0]?.detail).toContain('no longer in feishu.allowedChats');
  });

  it('calls an action unverifiable, not broken, when nothing knows how to check it', async () => {
    const h = harness({ registerChecker: false });
    h.queue.add(request('a'), config(), NOW);
    h.setLocked(false);

    const report = await h.drainer.tick();
    expect(report.discarded.map((action) => action.status)).toEqual(['unverifiable']);
    expect(h.ran).toEqual([]);
  });

  it('waits, rather than dropping, when the premise is merely not satisfiable yet', async () => {
    const h = harness({ checker: fixedChecker(notYet("'Ops' is not the conversation on screen")) });
    h.queue.add(request('a'), config(), NOW);
    h.setLocked(false);

    const report = await h.drainer.tick();
    expect(report.stoppedBecause).toContain('not the conversation on screen');
    expect(h.ran).toEqual([]);
    expect(h.queue.pendingCount()).toBe(1);
  });

  it('keeps order: a blocked head holds the queue instead of being overtaken', async () => {
    // Letting a later reply into the same conversation jump an earlier one is a
    // visible reordering in somebody's chat window. A blocked head only delays,
    // and its own TTL bounds how long it can.
    const h = harness({
      checker: async (facts) => (facts['originTraceId'] === 'a' ? notYet('that conversation is not on screen') : holds('open')),
    });
    h.queue.add(request('a'), config(), NOW);
    h.queue.add(request('b'), config(), NOW);
    h.setLocked(false);

    await h.drainer.tick();
    expect(h.ran).toEqual([]);
    expect(h.queue.pending().map((action) => action.traceId)).toEqual(['a', 'b']);
  });

  it('lets a blocked head go once the world catches up', async () => {
    let onScreen = false;
    const h = harness({ checker: async () => (onScreen ? holds('open') : notYet('not on screen')) });
    h.queue.add(request('a'), config(), NOW);
    h.setLocked(false);

    await h.drainer.tick();
    expect(h.ran).toEqual([]);

    onScreen = true;
    await h.drainer.tick();
    expect(h.ran.map((call) => call.tool)).toEqual(['feishu.reply']);
  });

  it('hands back, rather than running, an action that outlived its authorization', async () => {
    const h = harness();
    h.queue.add(request('a'), config({ ttlMs: 900_000, trustResetMs: 300_000 }), NOW);
    h.setLocked(false);
    h.setNow(NOW + 400_000);

    const report = await h.drainer.tick();
    expect(h.ran).toEqual([]);
    expect(report.handedBack.map((action) => action.status)).toEqual(['trust_reset']);

    const pending = h.store.pendingConfirmations();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.tier).toBe(QUEUE_TIERS.pendingConfirm);
    expect(pending[0]?.confirmed).toBeNull();
    expect(pending[0]?.reason).toContain('longer than the window in which it counted as already approved');
  });

  it('verifies the premise before handing anything back, so the question still makes sense', async () => {
    // Asking a person to approve a reply to a conversation that has gone is
    // worse than dropping it: an approval is the wrong thing to collect for it.
    const h = harness({ checker: fixedChecker(broken('the target left the allowlist')) });
    h.queue.add(request('a'), config({ ttlMs: 900_000, trustResetMs: 1_000 }), NOW);
    h.setLocked(false);
    h.setNow(NOW + 500_000);

    const report = await h.drainer.tick();
    expect(report.handedBack).toEqual([]);
    expect(report.discarded.map((action) => action.status)).toEqual(['precondition_broken']);
    expect(h.store.pendingConfirmations()).toEqual([]);
  });

  it('runs an action that is still inside its authorization window', async () => {
    const h = harness();
    h.queue.add(request('a'), config({ trustResetMs: 300_000 }), NOW);
    h.setLocked(false);
    h.setNow(NOW + 299_000);

    const report = await h.drainer.tick();
    expect(report.executed).toHaveLength(1);
    expect(h.ran).toHaveLength(1);
  });

  it('settles a failed run as failed rather than putting it back to try again', async () => {
    const h = harness({ runner: async () => toolFail('the composer is not there', 1) });
    h.queue.add(request('a'), config(), NOW);
    h.setLocked(false);

    const report = await h.drainer.tick();
    expect(report.executed.map((action) => action.status)).toEqual(['failed']);
    expect(h.queue.pending()).toEqual([]);
    expect(h.store.get('a:drained:q1')?.ok).toBe(false);
    expect(h.store.get('a:drained:q1')?.error).toContain('feishu.reply');
  });

  it('stops when the screen locks again, and leaves the rest queued', async () => {
    // The lock comes back while the first action is running: the driver
    // refuses, the sensor hears it through `note`, and the drain must
    // not carry on into the second.
    let relock = (): void => undefined;
    const h = harness({
      runner: async (tool) => {
        relock();
        return toolFail(`${tool} refused: the Mac is locked`, 1);
      },
    });
    relock = () => h.sensor.note('locked', 'the Mac is locked');

    h.queue.add(request('a'), config(), NOW);
    h.queue.add(request('b'), config(), NOW);
    h.setLocked(false);

    const report = await h.drainer.tick();
    expect(report.stoppedBecause).toContain('went away again mid-drain');
    // The one that ran is not put back: part of it may already have happened,
    // and repeating a write is the mistake this whole mechanism prevents.
    expect(report.executed.map((action) => action.status)).toEqual(['failed']);
    expect(report.executed[0]?.detail).toContain('may already have happened');
    expect(h.queue.pending().map((action) => action.traceId)).toEqual(['b']);
  });

  it('still asks the bridge about the screen when it is holding nothing', async () => {
    // The idle poll is what tells the gate the Mac is locked *before* an action
    // needs to know. Skipping it while the queue is empty would make the first
    // action after every lock run against a stale reading and fail.
    let probes = 0;
    const h = harness();
    const sensor = new ScreenSensor({
      probe: async () => {
        probes += 1;
        return { locked: false };
      },
    });
    const drainer = new QueueDrainer({
      sensor,
      store: h.queue,
      journal: new QueueJournal(h.store),
      preconditions: new PreconditionRegistry(),
      runner: async () => toolOk('', 1),
      config: config(),
    });

    expect(await drainer.tick()).toEqual({ executed: [], discarded: [], handedBack: [] });
    expect(probes).toBe(1);
    expect(sensor.current().state).toBe('available');
  });

  it('reports nothing at all when it is idle and the screen is locked', async () => {
    const h = harness();
    expect(await h.drainer.tick()).toEqual({ executed: [], discarded: [], handedBack: [] });
    expect(h.sensor.blocked).toBe(true);
  });

  it('stays out of the way entirely when the queue is switched off', async () => {
    const h = harness({ config: { enabled: false } });
    h.queue.add(request('a'), config(), NOW);
    h.setLocked(false);

    expect(await h.drainer.tick()).toEqual({ executed: [], discarded: [], handedBack: [] });
    expect(h.queue.pendingCount()).toBe(1);
  });

  it('keeps looping until the signal aborts, and survives a tick that throws', async () => {
    const h = harness({
      checker: async () => {
        throw new Error('the reader exploded');
      },
    });
    h.queue.add(request('a'), config(), NOW);
    h.setLocked(false);

    const controller = new AbortController();
    const loop = h.drainer.run(controller.signal);
    controller.abort();
    await loop;

    // A checker that throws is a broken premise, not a crashed daemon.
    expect(h.queue.settled(10).map((action) => action.status)).toEqual(['precondition_broken']);
  });

  it('stops immediately when handed an already-aborted signal', async () => {
    const h = harness();
    h.queue.add(request('a'), config(), NOW);
    h.setLocked(false);
    await h.drainer.run(AbortSignal.abort());
    expect(h.ran).toEqual([]);
  });

  it('logs a drain that throws instead of letting it end the daemon', async () => {
    const h = harness();
    const lines: string[] = [];
    const drainer = new QueueDrainer({
      sensor: h.sensor,
      store: {
        pendingCount: () => {
          throw new Error('the database is locked');
        },
      } as unknown as DeferredStore,
      journal: new QueueJournal(h.store),
      preconditions: new PreconditionRegistry(),
      runner: async () => toolOk('', 1),
      config: config(),
      sleep: async () => undefined,
      log: (line) => lines.push(line),
    });

    const controller = new AbortController();
    const loop = drainer.run(controller.signal);
    controller.abort();
    await loop;
    expect(lines.join(' ')).toContain('drain failed: the database is locked');
  });

  it('paces itself with a real timer when nothing injects one, and wakes on abort', async () => {
    const h = harness();
    h.setLocked(false);
    const drainer = new QueueDrainer({
      sensor: h.sensor,
      store: h.queue,
      journal: new QueueJournal(h.store),
      preconditions: new PreconditionRegistry(),
      runner: async () => toolOk('', 1),
      // No `now` and no `sleep`: the defaults are what the daemon actually runs.
      config: config({ pollIntervalMs: 50 }),
    });

    const controller = new AbortController();
    const started = Date.now();
    const loop = drainer.run(controller.signal);
    setTimeout(() => controller.abort(), 10);
    await loop;

    // Aborting cuts the wait short rather than serving out the interval.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(h.sensor.current().state).toBe('available');
  });

  it('uses the wall clock when no clock is injected', async () => {
    const h = harness();
    h.setLocked(false);
    const drainer = new QueueDrainer({
      sensor: h.sensor,
      store: h.queue,
      journal: new QueueJournal(h.store),
      preconditions: (() => {
        const registry = new PreconditionRegistry();
        registry.register(PREMISE, fixedChecker(holds('open')));
        return registry;
      })(),
      runner: async () => toolOk('sent', 1),
      config: config(),
      sleep: async () => undefined,
    });
    h.queue.add(request('a'), config(), Date.now());

    const report = await drainer.tick();
    expect(report.executed).toHaveLength(1);
    expect(report.executed[0]?.settledAt).toBeGreaterThan(0);
  });

  it('claims an action before running it, and settles the claim afterwards', async () => {
    const seen: string[] = [];
    const h = harness({
      runner: async () => {
        seen.push(h.queue.get('q1')?.status ?? 'gone');
        return toolOk('sent', 1);
      },
    });
    h.queue.add(request('a'), config(), NOW);
    h.setLocked(false);
    await h.drainer.tick();

    // The row is `running` for the whole of the send: a process killed here
    // comes back to evidence that it already happened.
    expect(seen).toEqual(['running']);
    expect(h.queue.get('q1')?.status).toBe('executed');
  });

  it('drops an action that expired while its premise was being re-checked', async () => {
    // The premise check reads the live world and can take seconds; the clock is
    // asked once more at the door.
    const h = harness({
      checker: async () => {
        h.setNow(NOW + 5_000);
        return holds('open');
      },
      config: { ttlMs: 1_000 },
    });
    h.queue.add(request('a'), config({ ttlMs: 1_000 }), NOW);
    h.setLocked(false);

    const report = await h.drainer.tick();
    expect(h.ran).toEqual([]);
    expect(report.discarded.map((action) => action.status)).toEqual(['expired']);
    expect(report.discarded[0]?.detail).toContain('while its premise was being re-checked');
  });

  it('still expires what it is holding when the queue is switched off', async () => {
    // Rows queued before the flag went off would otherwise sit pending forever,
    // never run and never dropped, with `we queue` still promising they will go.
    const h = harness({ config: { enabled: false, ttlMs: 1_000 } });
    h.queue.add(request('old'), config({ ttlMs: 1_000 }), NOW);
    h.queue.add(request('fresh'), config({ ttlMs: 900_000 }), NOW);
    h.setLocked(false);
    h.setNow(NOW + 5_000);

    const report = await h.drainer.tick();
    expect(h.ran).toEqual([]);
    expect(report.discarded.map((action) => action.traceId)).toEqual(['old']);
    expect(report.discarded[0]?.detail).toContain('queue.enabled is false');
    expect(h.queue.pending().map((action) => action.traceId)).toEqual(['fresh']);
  });

  it('says it is draining only while it is', async () => {
    let sawBusy = false;
    const h = harness({
      runner: async () => {
        sawBusy = h.drainer.draining;
        return toolOk('sent', 1);
      },
    });
    h.queue.add(request('a'), config(), NOW);
    h.setLocked(false);

    expect(h.drainer.draining).toBe(false);
    await h.drainer.tick();
    expect(sawBusy).toBe(true);
    expect(h.drainer.draining).toBe(false);
  });

  it('stops saying it is draining even when a pass throws', async () => {
    const h = harness({
      runner: async () => {
        throw new Error('the runner exploded');
      },
    });
    h.queue.add(request('a'), config(), NOW);
    h.setLocked(false);

    await expect(h.drainer.tick()).rejects.toThrow(/exploded/);
    expect(h.drainer.draining).toBe(false);
  });
});
