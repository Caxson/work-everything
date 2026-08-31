import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/memory/db.js';
import type { Db } from '../src/memory/db.js';
import { TrajectoryStore } from '../src/memory/trajectory.js';
import { Registry } from '../src/memory/registry.js';
import { DeferredStore } from '../src/memory/deferred.js';
import { Daemon } from '../src/daemon.js';
import { parseEvent } from '../src/core/events.js';
import type { Event } from '../src/core/events.js';
import { parseScenario } from '../src/core/scenario.js';
import { DEFAULT_ROUTER_CONFIG } from '../src/core/router.js';
import { stageOf } from '../src/core/trust.js';
import { ok as toolOk } from '../src/execution/base.js';
import type { ToolRunner } from '../src/execution/base.js';
import type { Perceiver } from '../src/perception/base.js';
import { ChatRouteTable } from '../src/perception/feishu/chatRoutes.js';
import { FEISHU_REPLY_TOOL } from '../src/execution/feishu/sender.js';
import { FEISHU_REPLY_PREMISE, feishuReplyCapture, feishuReplyChecker } from '../src/execution/feishu/replyPremise.js';
import { ScreenLockSensor } from '../src/queue/screenLock.js';
import { QueueJournal, QUEUE_TIERS } from '../src/queue/journal.js';
import { PreconditionRegistry } from '../src/queue/preconditions.js';
import { ActionGate } from '../src/queue/gate.js';
import { QueueDrainer } from '../src/queue/drain.js';
import { DEFAULT_DEFERRAL_CONFIG, type DeferralConfig } from '../src/queue/deferred.js';

const CHAT = 'Ops';
const NOW = 1_700_000_000_000;
const SCENARIO = parseScenario({
  id: 'feishu-ping',
  name: 'ping',
  triggers: ['we ping'],
  chain: [{ tool: FEISHU_REPLY_TOOL, args: { text: 'pong', trace_id: '$trace_id' } }],
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dbFile(): { path: string; open: () => Db } {
  const dir = mkdtempSync(join(tmpdir(), 'we-loop-'));
  dirs.push(dir);
  const path = join(dir, 'work-everything.db');
  return { path, open: () => openDb(path) };
}

const event = (traceId: string, text = 'we ping'): Event =>
  parseEvent({ traceId, source: 'feishu', kind: 'message.received', ts: NOW, payload: { text, chat: CHAT } });

/** Yields a fixed list of events, then ends. Nothing here reads a real app. */
function scriptedPerceiver(events: readonly Event[]): Perceiver {
  return {
    name: 'scripted',
    events: async function* () {
      for (const each of events) yield each;
    },
  };
}

interface Loop {
  readonly daemon: Daemon;
  readonly drainer: QueueDrainer;
  readonly queue: DeferredStore;
  readonly store: TrajectoryStore;
  readonly registry: Registry;
  readonly sensor: ScreenLockSensor;
  /** The first idle poll, so a test can await the screen state being known. */
  readonly primed: Promise<unknown>;
  readonly sent: Readonly<Record<string, string>>[];
  readonly setNow: (value: number) => void;
  readonly setLocked: (value: boolean) => void;
  readonly setOpenChat: (title: string) => void;
}

/**
 * The real wiring, minus the parts that need a Mac: the same gate, drainer,
 * premise checker and route table the runtime assembles, over a scripted
 * screen and a recording reply tool.
 */
function loop(over: { db?: Db; config?: Partial<DeferralConfig>; perceiver?: Perceiver; allowedChats?: readonly string[] } = {}): Loop {
  const db = over.db ?? openDb(':memory:');
  const store = new TrajectoryStore(db);
  const registry = new Registry(db);
  registry.saveScenario(SCENARIO);
  let ids = 0;
  const queue = new DeferredStore(db, { id: () => `q${++ids}` });

  let now = NOW;
  let locked = true;
  let openChat = CHAT;
  const sensor = new ScreenLockSensor({ probe: async () => ({ locked }), now: () => now });

  const routes = new ChatRouteTable();
  const sent: Readonly<Record<string, string>>[] = [];
  const runner: ToolRunner = async (tool, args) => {
    sent.push(args);
    return toolOk(`${tool} sent`, 1);
  };

  const journal = new QueueJournal(store, () => now);
  const preconditions = new PreconditionRegistry();
  preconditions.register(
    FEISHU_REPLY_PREMISE,
    feishuReplyChecker({
      allowedChats: () => over.allowedChats ?? [CHAT],
      routes,
      recordedChat: (traceId) => {
        const chat = store.get(traceId)?.payload['chat'];
        return typeof chat === 'string' && chat !== '' ? chat : undefined;
      },
      openConversation: async () => ({ title: openChat, messageIds: ['msg-1'] }),
    }),
  );

  const config: DeferralConfig = { ...DEFAULT_DEFERRAL_CONFIG, ...over.config };
  const gate = new ActionGate({
    sensor,
    store: queue,
    journal,
    screenBound: new Set([FEISHU_REPLY_TOOL]),
    capture: feishuReplyCapture({ routes }),
    config,
    now: () => now,
  });

  const daemon = new Daemon({
    store,
    registry,
    runner,
    tools: [],
    router: DEFAULT_ROUTER_CONFIG,
    // Deliberately hair-trigger: if a deferral cost a trust outcome, two of
    // them would quarantine this scenario, and the test below would see it.
    trust: { required: 2, quarantineAfter: 2 },
    promotion: { promoteAfter: 2 },
    planner: { maxSteps: 5 },
    gate,
    ...(over.perceiver === undefined ? {} : { perceivers: [over.perceiver] }),
  });

  const drainer = new QueueDrainer({
    sensor,
    store: queue,
    journal,
    preconditions,
    runner,
    config,
    now: () => now,
    sleep: async () => undefined,
  });

  // The real daemon learns the screen state from the drainer's idle poll before
  // the first event arrives. Doing the same here keeps the harness honest about
  // what the gate is actually reading.
  const primed = drainer.tick();

  // The perceiver records the origin conversation, exactly as the real one does.
  for (const traceId of ['feishu-1', 'feishu-2', 'feishu-3']) {
    routes.remember(traceId, { chatTitle: CHAT, messageId: 'msg-1', ts: NOW });
  }

  return {
    daemon,
    drainer,
    queue,
    store,
    registry,
    sensor,
    primed,
    sent,
    setNow: (value) => {
      now = value;
    },
    setLocked: (value) => {
      locked = value;
    },
    setOpenChat: (title) => {
      openChat = title;
    },
  };
}

describe('a locked screen, end to end', () => {
  it('queues the action, records it as deferred, and sends nothing', async () => {
    const l = loop();
    await l.primed;
    const record = await l.daemon.handle(event('feishu-1'));

    expect(record.tier).toBe('deferred');
    expect(record.scenarioId).toBe('feishu-ping');
    expect(record.ok).toBe(true);
    expect(record.reason).toContain('the screen is locked');
    expect(l.sent).toEqual([]);
    expect(l.queue.pending().map((action) => action.purpose)).toEqual(["reply in 'Ops' to feishu-1: pong"]);
  });

  it('costs the scenario no trust, however many times the Mac is locked', async () => {
    const l = loop();
    await l.primed;
    for (const traceId of ['feishu-1', 'feishu-2', 'feishu-3']) await l.daemon.handle(event(traceId));

    // Two failures would quarantine it. Being locked is not a failure of the
    // scenario, so it must not even be recorded as an outcome.
    expect(l.registry.trust().get('feishu-ping')).toBeUndefined();
    expect(l.queue.pendingCount()).toBe(3);
  });

  it('keeps perceiving while it is locked: every event is still routed and recorded', async () => {
    const events = [event('feishu-1'), event('feishu-2', 'what happened in the build')];
    const l = loop({ perceiver: scriptedPerceiver(events) });
    await l.primed;
    await l.daemon.run();

    // Perception is untouched by the lock. Only acting is held.
    expect(l.store.get('feishu-1')?.tier).toBe('deferred');
    expect(l.store.get('feishu-2')?.text).toBe('what happened in the build');
    expect(l.store.recent(10)).not.toHaveLength(0);
    expect(l.sent).toEqual([]);
  });

  it('sends what it was holding, in order, once the screen comes back', async () => {
    const l = loop();
    await l.primed;
    await l.daemon.handle(event('feishu-1'));
    await l.daemon.handle(event('feishu-2'));
    expect(l.sent).toEqual([]);

    l.setLocked(false);
    const report = await l.drainer.tick();

    expect(report.executed.map((action) => action.traceId)).toEqual(['feishu-1', 'feishu-2']);
    expect(l.sent.map((args) => args['trace_id'])).toEqual(['feishu-1', 'feishu-2']);
    expect(l.queue.pending()).toEqual([]);
    expect(l.store.get('feishu-1:drained:q1')?.tier).toBe(QUEUE_TIERS.executed);
  });

  it('drops what went stale while it waited, and sends only what is still current', async () => {
    const l = loop({ config: { ttlMs: 60_000 } });
    await l.primed;
    await l.daemon.handle(event('feishu-1'));

    l.setNow(NOW + 90_000);
    await l.daemon.handle(event('feishu-2'));

    l.setLocked(false);
    const report = await l.drainer.tick();

    expect(report.discarded.map((action) => [action.traceId, action.status])).toEqual([['feishu-1', 'expired']]);
    expect(l.sent.map((args) => args['trace_id'])).toEqual(['feishu-2']);
  });

  it('asks again for an action that waited past its authorization, instead of sending it', async () => {
    const l = loop({ config: { ttlMs: 900_000, trustResetMs: 60_000 } });
    await l.primed;
    await l.daemon.handle(event('feishu-1'));

    l.setNow(NOW + 120_000);
    l.setLocked(false);
    await l.drainer.tick();

    expect(l.sent).toEqual([]);
    const pending = l.store.pendingConfirmations();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.tier).toBe(QUEUE_TIERS.pendingConfirm);
    expect(pending[0]?.text).toContain("reply in 'Ops'");
  });

  it('holds a reply whose conversation is not on screen, then sends it when it is', async () => {
    const l = loop();
    await l.primed;
    await l.daemon.handle(event('feishu-1'));

    l.setLocked(false);
    l.setOpenChat('Somewhere Else');
    expect((await l.drainer.tick()).stoppedBecause).toContain('not the conversation on screen');
    expect(l.sent).toEqual([]);

    l.setOpenChat(CHAT);
    await l.drainer.tick();
    expect(l.sent.map((args) => args['trace_id'])).toEqual(['feishu-1']);
  });

  it('refuses to send a reply whose conversation left the allowlist while it waited', async () => {
    const l = loop({ allowedChats: [] });
    await l.primed;
    await l.daemon.handle(event('feishu-1'));

    l.setLocked(false);
    const report = await l.drainer.tick();

    expect(l.sent).toEqual([]);
    expect(report.discarded.map((action) => action.status)).toEqual(['precondition_broken']);
    expect(report.discarded[0]?.detail).toContain('no longer in feishu.allowedChats');
  });

  it('still has the queue after a restart, and drains it against the durable record', async () => {
    const file = dbFile();
    const first = loop({ db: file.open() });
    await first.primed;
    await first.daemon.handle(event('feishu-1'));
    expect(first.queue.pendingCount()).toBe(1);

    // A second process: nothing in memory carries over, so the origin
    // conversation has to come back out of the trajectory.
    const second = loop({ db: file.open() });
    await second.primed;
    expect(second.queue.pending().map((action) => action.traceId)).toEqual(['feishu-1']);

    second.setLocked(false);
    const report = await second.drainer.tick();
    expect(report.executed.map((action) => action.traceId)).toEqual(['feishu-1']);
    expect(second.sent.map((args) => args['trace_id'])).toEqual(['feishu-1']);
  });

  it('charges nobody for a chain the screen was taken away from mid-run', async () => {
    // The polling window: admitted against a reading that was true, then the
    // Mac locks before the first step lands. The bridge refuses, the sensor
    // hears it, and the scenario must not lose standing over it.
    const l = loop();
    await l.primed;
    l.setLocked(false);
    await l.drainer.tick();

    // A run that starts fine and then meets a lock, the way the driver reports it.
    const record = await l.daemon.handle(event('feishu-1'));
    expect(record.tier).toBe('muscle');
    expect(l.registry.trust().get('feishu-ping')?.successes).toBe(1);

    const relocked = loop();
    await relocked.primed;
    relocked.setLocked(false);
    await relocked.drainer.tick();
    relocked.sensor.noteLocked('the Mac is locked');

    // With the screen gone, the next chain is deferred at admission instead.
    const deferred = await relocked.daemon.handle(event('feishu-2'));
    expect(deferred.tier).toBe('deferred');
    expect(relocked.registry.trust().get('feishu-ping')).toBeUndefined();
  });

  it('keeps a scenario out of quarantine when every failure was the screen going away', async () => {
    const l = loop();
    await l.primed;
    l.setLocked(false);
    await l.drainer.tick();

    for (const traceId of ['feishu-1', 'feishu-2', 'feishu-3']) {
      // The lock lands mid-run: the chain is admitted, then the screen goes.
      l.sensor.noteLocked('the Mac is locked');
      await l.daemon.handle(event(traceId));
      l.setLocked(false);
      await l.drainer.tick();
    }

    const trust = l.registry.trust().get('feishu-ping');
    // quarantineAfter is 2 here. Three locks in a row must still leave it usable.
    expect(trust === undefined || stageOf(trust) !== 'quarantined').toBe(true);
  });

  it('runs normally, with no queue involved, when the screen was never locked', async () => {
    const l = loop();
    await l.primed;
    l.setLocked(false);
    await l.sensor.refresh();

    const record = await l.daemon.handle(event('feishu-1'));
    expect(record.tier).toBe('muscle');
    expect(record.ok).toBe(true);
    expect(l.sent.map((args) => args['trace_id'])).toEqual(['feishu-1']);
    expect(l.queue.pendingCount()).toBe(0);
  });

  it('drops the oldest when the queue fills, and says so in the trajectory', async () => {
    const l = loop({ config: { capacity: 1 } });
    await l.primed;
    await l.daemon.handle(event('feishu-1'));
    await l.daemon.handle(event('feishu-2'));

    expect(l.queue.pending().map((action) => action.traceId)).toEqual(['feishu-2']);
    expect(l.store.get('feishu-1:discarded:q1')?.tier).toBe(QUEUE_TIERS.discarded);

    l.setLocked(false);
    await l.drainer.tick();
    expect(l.sent.map((args) => args['trace_id'])).toEqual(['feishu-2']);
  });
});
