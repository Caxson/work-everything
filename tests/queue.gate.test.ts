import { describe, expect, it } from 'vitest';
import { openDb } from '../src/memory/db.js';
import { TrajectoryStore } from '../src/memory/trajectory.js';
import { DeferredStore } from '../src/memory/deferred.js';
import { parseScenario } from '../src/core/scenario.js';
import type { Scenario } from '../src/core/scenario.js';
import { ScreenLockSensor } from '../src/queue/screenLock.js';
import { QueueJournal, QUEUE_TIERS } from '../src/queue/journal.js';
import { ActionGate, type CaptureFn } from '../src/queue/gate.js';
import { DEFAULT_DEFERRAL_CONFIG, type DeferralConfig } from '../src/queue/deferred.js';

const NOW = 1_700_000_000_000;
const SCREEN_BOUND = new Set(['feishu.reply']);

const chain = (id: string, ...tools: readonly string[]): Scenario =>
  parseScenario({ id, name: id, chain: tools.map((tool) => ({ tool, args: { text: '$text' } })) });

const capture: CaptureFn = (request) => ({
  purpose: `reply to ${request.traceId}`,
  precondition: { kind: 'feishu.reply', facts: { chat: 'Ops', originTraceId: request.traceId } },
});

interface Harness {
  readonly gate: ActionGate;
  readonly queue: DeferredStore;
  readonly store: TrajectoryStore;
  readonly sensor: ScreenLockSensor;
  readonly lines: string[];
}

function harness(over: { locked?: boolean; config?: Partial<DeferralConfig>; capture?: CaptureFn; busy?: () => boolean } = {}): Harness {
  const db = openDb(':memory:');
  const store = new TrajectoryStore(db);
  let ids = 0;
  const queue = new DeferredStore(db, { id: () => `q${++ids}` });
  const sensor = new ScreenLockSensor({ probe: async () => ({ locked: over.locked ?? true }) });
  if (over.locked !== false) sensor.noteLocked('the Mac is locked');
  const lines: string[] = [];
  const config: DeferralConfig = { ...DEFAULT_DEFERRAL_CONFIG, ...over.config };

  const gate = new ActionGate({
    sensor,
    store: queue,
    journal: new QueueJournal(store, () => NOW),
    screenBound: SCREEN_BOUND,
    capture: over.capture ?? capture,
    config,
    ...(over.busy === undefined ? {} : { busy: over.busy }),
    now: () => NOW,
    log: (line) => lines.push(line),
  });
  return { gate, queue, store, sensor, lines };
}

describe('the admission gate', () => {
  it('lets everything through while the screen is open', async () => {
    const { gate, queue } = harness({ locked: false });
    const admission = await gate.admit({ traceId: 'a', chain: chain('reply', 'feishu.reply'), vars: { text: 'pong' } });

    expect(admission.admitted).toBe(true);
    expect(queue.pending()).toEqual([]);
  });

  it('lets work that never needs a window run while the screen is locked', async () => {
    // The policy is "stop acting on the screen", not "stop working". A shell
    // tool behind a locked Mac completes exactly as it would have.
    const { gate, queue } = harness();
    const admission = await gate.admit({ traceId: 'a', chain: chain('build', 'run_tests'), vars: {} });

    expect(admission.admitted).toBe(true);
    expect(queue.pending()).toEqual([]);
  });

  it('queues a chain that needs the screen instead of letting it fail', async () => {
    const { gate, queue } = harness();
    const admission = await gate.admit({ traceId: 'feishu-1', chain: chain('reply', 'feishu.reply'), vars: { text: 'pong' } });

    expect(admission.admitted).toBe(false);
    if (admission.admitted) return;
    expect(admission.reason).toContain('the screen is locked');
    expect(admission.action?.id).toBe('q1');

    const [queued] = queue.pending();
    expect(queued?.traceId).toBe('feishu-1');
    expect(queued?.vars).toEqual({ text: 'pong' });
    expect(queued?.precondition.facts['chat']).toBe('Ops');
  });

  it('defers a mixed chain whole, so its halves never see two different worlds', async () => {
    // Running the shell half now and the reply half after an unlock would send
    // arguments rendered from a reading minutes out of date.
    const { gate, queue } = harness();
    const admission = await gate.admit({ traceId: 'a', chain: chain('mixed', 'clock.now', 'feishu.reply'), vars: { text: 'pong' } });

    expect(admission.admitted).toBe(false);
    expect(queue.pending()[0]?.chain.chain).toHaveLength(2);
  });

  it('records the deferral in the trajectory, with the deadline on it', async () => {
    const { gate, store } = harness({ config: { ttlMs: 60_000 } });
    await gate.admit({ traceId: 'feishu-1', chain: chain('reply', 'feishu.reply'), vars: { text: 'pong' } });

    const record = store.get('feishu-1:deferred:q1');
    expect(record?.tier).toBe(QUEUE_TIERS.deferred);
    expect(record?.ok).toBe(true);
    expect(record?.reason).toContain('queued as q1');
    expect(record?.reason).toContain('60s');
    expect(record?.payload['originTraceId']).toBe('feishu-1');
    expect(record?.payload['chain']).toBe('feishu.reply');
  });

  it('refuses to queue an action nobody can describe, and says why', async () => {
    const { gate, queue, store, lines } = harness({ capture: () => undefined });
    const admission = await gate.admit({ traceId: 'a', chain: chain('reply', 'feishu.reply'), vars: {} });

    expect(admission.admitted).toBe(false);
    if (admission.admitted) return;
    expect(admission.reason).toContain('premise cannot be re-checked');
    // It is recorded as a discard rather than vanishing: `we queue --discarded`
    // is where somebody looks for an action that did not happen.
    expect(queue.pending()).toEqual([]);
    expect(queue.settled(10).map((action) => action.status)).toEqual(['unverifiable']);
    expect(store.get('a:discarded:q1')?.tier).toBe(QUEUE_TIERS.discarded);
    expect(store.get('a:discarded:q1')?.ok).toBe(false);
    expect(lines.join(' ')).toContain('refused q1');
  });

  it('records every action a full queue pushed out', async () => {
    const { gate, queue, store, lines } = harness({ config: { capacity: 1 } });
    await gate.admit({ traceId: 'first', chain: chain('reply', 'feishu.reply'), vars: { text: 'one' } });
    await gate.admit({ traceId: 'second', chain: chain('reply', 'feishu.reply'), vars: { text: 'two' } });

    expect(queue.pending().map((action) => action.traceId)).toEqual(['second']);
    const evicted = store.get('first:discarded:q1');
    expect(evicted?.tier).toBe(QUEUE_TIERS.discarded);
    expect(evicted?.reason).toContain('pushed out');
    expect(lines.join('\n')).toContain('dropped');
  });

  it('is a no-op when the queue is switched off, lock or no lock', async () => {
    const { gate, queue } = harness({ config: { enabled: false } });
    const admission = await gate.admit({ traceId: 'a', chain: chain('reply', 'feishu.reply'), vars: {} });

    expect(admission.admitted).toBe(true);
    expect(queue.pending()).toEqual([]);
  });

  it('knows which chains need a screen without being told twice', () => {
    const { gate } = harness();
    expect(gate.needsScreen(chain('reply', 'feishu.reply'))).toBe(true);
    expect(gate.needsScreen(chain('shell', 'build'))).toBe(false);
    expect(gate.needsScreen(chain('empty'))).toBe(false);
  });

  it('queues each of several actions separately while the lock holds', async () => {
    const { gate, queue } = harness();
    for (const traceId of ['a', 'b', 'c']) {
      await gate.admit({ traceId, chain: chain('reply', 'feishu.reply'), vars: { text: traceId } });
    }
    expect(queue.pending().map((action) => action.traceId)).toEqual(['a', 'b', 'c']);
  });

  it('says whether the screen is unavailable, for a run that already failed', async () => {
    // The daemon asks this after a chain fails, to decide whose fault it was.
    const open = harness({ locked: false });
    expect(open.gate.screenIsUnavailable()).toBe(false);

    open.sensor.noteLocked('the Mac is locked');
    expect(open.gate.screenIsUnavailable()).toBe(true);

    const shut = harness();
    expect(shut.gate.screenIsUnavailable()).toBe(true);
  });

  it('queues live work while a drain is running, so it cannot overtake the queue', async () => {
    // The daemon's loop and the drain are two async loops over one runner, and
    // during a drain the screen is unlocked. Admitting here would let a reply
    // decided seconds ago reach a chat ahead of one that waited minutes.
    let draining = true;
    const { gate, queue } = harness({ locked: false, busy: () => draining });

    const held = await gate.admit({ traceId: 'new', chain: chain('reply', 'feishu.reply'), vars: { text: 'pong' } });
    expect(held.admitted).toBe(false);
    if (held.admitted) return;
    expect(held.reason).toContain('the queue is draining');
    expect(queue.pending().map((action) => action.traceId)).toEqual(['new']);

    draining = false;
    expect((await gate.admit({ traceId: 'later', chain: chain('reply', 'feishu.reply'), vars: {} })).admitted).toBe(true);
  });

  it('still lets work through mid-drain when it does not need the screen', async () => {
    const { gate } = harness({ locked: false, busy: () => true });
    expect((await gate.admit({ traceId: 'a', chain: chain('shell', 'build'), vars: {} })).admitted).toBe(true);
  });

  it('records an eviction caused by an action it then refuses as undescribable', async () => {
    // The refused action still passed the capacity check on its way in, and
    // whatever it pushed out is a real queued action that will never run.
    const { gate, queue, store, lines } = harness({ config: { capacity: 1 } });
    await gate.admit({ traceId: 'first', chain: chain('reply', 'feishu.reply'), vars: { text: 'one' } });

    const refusing = harness({ config: { capacity: 1 }, capture: () => undefined });
    await refusing.gate.admit({ traceId: 'keeper', chain: chain('reply', 'feishu.reply'), vars: {} });
    expect(queue.pendingCount()).toBe(1);
    expect(store.get('first:discarded:q1')).toBeUndefined();
    expect(lines.join(' ')).not.toContain('dropped');

    // Now with something to push out.
    const full = harness({ config: { capacity: 1 } });
    await full.gate.admit({ traceId: 'keeper', chain: chain('reply', 'feishu.reply'), vars: { text: 'one' } });
    const undescribable = new ActionGate({
      sensor: full.sensor,
      store: full.queue,
      journal: new QueueJournal(full.store, () => NOW),
      screenBound: SCREEN_BOUND,
      capture: () => undefined,
      config: { ...DEFAULT_DEFERRAL_CONFIG, capacity: 1 },
      now: () => NOW,
      log: (line) => full.lines.push(line),
    });
    await undescribable.admit({ traceId: 'intruder', chain: chain('reply', 'feishu.reply'), vars: {} });

    expect(full.store.get('keeper:discarded:q1')?.reason).toContain('pushed out');
    expect(full.lines.join('\n')).toContain("dropped 'reply to keeper'");
  });
});
