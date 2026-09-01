import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/memory/db.js';
import type { Db } from '../src/memory/db.js';
import { DeferredStore } from '../src/memory/deferred.js';
import { parseScenario } from '../src/core/scenario.js';
import type { Scenario } from '../src/core/scenario.js';
import { DEFAULT_DEFERRAL_CONFIG, type DeferralConfig, type DeferralRequest } from '../src/queue/deferred.js';

const NOW = 1_700_000_000_000;

const chain = (tool = 'feishu.reply'): Scenario =>
  parseScenario({ id: 'reply', name: 'reply', chain: [{ tool, args: { text: '$text' } }] });

const request = (traceId: string, over: Partial<DeferralRequest> = {}): DeferralRequest => ({
  traceId,
  chain: chain(),
  vars: { text: `answer for ${traceId}` },
  purpose: `reply to ${traceId}`,
  precondition: { kind: 'feishu.reply', facts: { chat: 'Ops', originTraceId: traceId } },
  ...over,
});

const config = (over: Partial<DeferralConfig> = {}): DeferralConfig => ({ ...DEFAULT_DEFERRAL_CONFIG, ...over });

/** Ids that read like the real ones but do not depend on randomness. */
function counting(): () => string {
  let n = 0;
  return () => `q${++n}`;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A database on disk, so "survives a restart" means what it says. */
function onDisk(): { path: string; open: () => Db } {
  const dir = mkdtempSync(join(tmpdir(), 'we-queue-'));
  dirs.push(dir);
  const path = join(dir, 'queue.db');
  return { path, open: () => openDb(path) };
}

const store = (deps: { id?: () => string } = {}): DeferredStore => new DeferredStore(openDb(':memory:'), deps);

describe('the deferred action store', () => {
  it('hands actions back in the order they were queued', () => {
    const queue = store({ id: counting() });
    queue.add(request('a'), config(), NOW);
    queue.add(request('b'), config(), NOW);
    queue.add(request('c'), config(), NOW);

    expect(queue.pending().map((action) => action.traceId)).toEqual(['a', 'b', 'c']);
    expect(queue.pendingCount()).toBe(3);
  });

  it('orders by sequence, not by clock, so a same-millisecond pair still has an order', () => {
    const queue = store({ id: counting() });
    for (const traceId of ['a', 'b', 'c']) queue.add(request(traceId), config(), NOW);
    expect(queue.pending().map((action) => action.seq)).toEqual([1, 2, 3]);
  });

  it('round-trips the chain and the variable bag it will be replayed against', () => {
    const queue = store({ id: counting() });
    const { action } = queue.add(request('a'), config(), NOW);
    const back = queue.get(action.id);

    expect(back?.chain.chain).toEqual(chain().chain);
    expect(back?.vars).toEqual({ text: 'answer for a' });
    expect(back?.precondition).toEqual({ kind: 'feishu.reply', facts: { chat: 'Ops', originTraceId: 'a' } });
    expect(queue.get('nothing-like-this')).toBeUndefined();
  });

  it('survives a restart: a new process over the same file finds the queue intact', () => {
    const file = onDisk();
    const first = new DeferredStore(file.open(), { id: counting() });
    first.add(request('a'), config(), NOW);
    first.add(request('b'), config(), NOW);

    const second = new DeferredStore(file.open());
    expect(second.pending().map((action) => action.traceId)).toEqual(['a', 'b']);
    expect(second.pending()[0]?.vars).toEqual({ text: 'answer for a' });
  });

  it('drops the oldest to make room, and says which ones it dropped', () => {
    const queue = store({ id: counting() });
    queue.add(request('a'), config({ capacity: 2 }), NOW);
    queue.add(request('b'), config({ capacity: 2 }), NOW);
    const third = queue.add(request('c'), config({ capacity: 2 }), NOW + 1);

    // The one being added is never the one evicted to make room for itself.
    expect(third.dropped.map((action) => action.traceId)).toEqual(['a']);
    expect(third.dropped[0]?.status).toBe('dropped_for_capacity');
    expect(third.dropped[0]?.detail).toContain('pushed out of a queue holding 2');
    expect(queue.pending().map((action) => action.traceId)).toEqual(['b', 'c']);
  });

  it('drops as many as it has to when the capacity shrinks under a full queue', () => {
    const queue = store({ id: counting() });
    for (const traceId of ['a', 'b', 'c', 'd']) queue.add(request(traceId), config({ capacity: 10 }), NOW);
    const next = queue.add(request('e'), config({ capacity: 2 }), NOW);

    expect(next.dropped.map((action) => action.traceId)).toEqual(['a', 'b', 'c']);
    expect(queue.pending().map((action) => action.traceId)).toEqual(['d', 'e']);
  });

  it('moves a settled action out of the queue and into the history, with its reason', () => {
    const queue = store({ id: counting() });
    const { action } = queue.add(request('a'), config(), NOW);
    const dead = queue.settle(action, 'expired', 'waited too long', NOW + 10);

    expect(dead.status).toBe('expired');
    expect(queue.pending()).toEqual([]);
    expect(queue.settled().map((each) => [each.id, each.status, each.detail])).toEqual([['q1', 'expired', 'waited too long']]);
    expect(queue.get('q1')?.settledAt).toBe(NOW + 10);
  });

  it('keeps the history bounded without touching what is still waiting', () => {
    const queue = store({ id: counting() });
    for (let i = 0; i < 5; i += 1) {
      const { action } = queue.add(request(`old-${i}`), config({ historyLimit: 2 }), NOW);
      queue.settle(action, 'expired', 'old', NOW);
    }
    // The trim runs on the next add, so this one is what forces it.
    queue.add(request('live'), config({ historyLimit: 2 }), NOW);

    expect(queue.settled(50)).toHaveLength(2);
    expect(queue.pending().map((action) => action.traceId)).toEqual(['live']);
  });

  it('never reuses a sequence number, even after the history is trimmed away', () => {
    const queue = store({ id: counting() });
    const { action } = queue.add(request('a'), config({ historyLimit: 0 }), NOW);
    queue.settle(action, 'expired', 'gone', NOW);
    const next = queue.add(request('b'), config({ historyLimit: 0 }), NOW);

    expect(queue.settled(10)).toEqual([]);
    expect(next.action.seq).toBeGreaterThan(action.seq);
  });

  it('quarantines a stored action it can no longer read, rather than leaving it at the head', () => {
    const db = openDb(':memory:');
    const problems: string[] = [];
    const queue = new DeferredStore(db, { id: counting(), onUnreadable: (id, problem) => problems.push(`${id}: ${problem}`) });
    queue.add(request('a'), config(), NOW);
    queue.add(request('b'), config(), NOW);

    // Whatever produced this — a hand edit, or a shape this build no longer
    // understands — it must not be executed and must not block the queue.
    db.prepare('UPDATE deferred_actions SET chain = ? WHERE id = ?').run('{"not":"a scenario"}', 'q1');

    expect(queue.pending().map((action) => action.traceId)).toEqual(['b']);
    expect(problems.join(' ')).toContain('q1');
    // Withheld from the queue, but still listable: `we queue --discarded` is
    // where somebody looks for an action that did not happen, and an empty
    // answer there would erase it.
    expect(queue.settled(10).map((action) => action.status)).toEqual(['unverifiable']);
    expect(queue.get('q1')?.chain.id).toBe('(unreadable)');
    expect(queue.get('q1')?.chain.chain).toEqual([]);
  });

  it('skips a row whose status this build does not recognise, without quarantining it', () => {
    const db = openDb(':memory:');
    const problems: string[] = [];
    const queue = new DeferredStore(db, { id: counting(), onUnreadable: (id, problem) => problems.push(`${id}: ${problem}`) });
    const { action } = queue.add(request('a'), config(), NOW);
    db.prepare('UPDATE deferred_actions SET status = ? WHERE id = ?').run('invented_later', action.id);

    // It is not pending, so it can never be executed; it is simply not
    // listable, and the listing says so rather than pretending it is not there.
    expect(queue.pending()).toEqual([]);
    expect(queue.settled(10)).toEqual([]);
    expect(problems.join(' ')).toContain("unknown status 'invented_later'");
  });

  it('recovers an unreadable variable bag as empty rather than refusing the row', () => {
    const db = openDb(':memory:');
    const queue = new DeferredStore(db, { id: counting() });
    const { action } = queue.add(request('a'), config(), NOW);
    db.prepare('UPDATE deferred_actions SET vars = ?, precondition_facts = ? WHERE id = ?').run('not json', '[1,2]', action.id);

    const back = queue.pending()[0];
    expect(back?.vars).toEqual({});
    expect(back?.precondition.facts).toEqual({});
  });

  it('coerces stored non-string fact values rather than dropping the whole row', () => {
    const db = openDb(':memory:');
    const queue = new DeferredStore(db, { id: counting() });
    const { action } = queue.add(request('a'), config(), NOW);
    db.prepare('UPDATE deferred_actions SET precondition_facts = ? WHERE id = ?').run('{"chat":"Ops","seen":7}', action.id);

    expect(queue.pending()[0]?.precondition.facts).toEqual({ chat: 'Ops', seen: '7' });
  });

  it('generates its own ids when nothing supplies them', () => {
    const queue = new DeferredStore(openDb(':memory:'));
    const first = queue.add(request('a'), config(), NOW).action;
    const second = queue.add(request('b'), config(), NOW).action;
    expect(first.id).not.toBe(second.id);
    expect(first.id.startsWith('q')).toBe(true);
  });

  it('reports an unreadable row on stderr when nothing else is listening', () => {
    const db = openDb(':memory:');
    const queue = new DeferredStore(db, { id: counting() });
    queue.add(request('a'), config(), NOW);
    db.prepare('UPDATE deferred_actions SET chain = ? WHERE id = ?').run('{}', 'q1');

    const errors: string[] = [];
    const original = console.error;
    console.error = (line: string): void => {
      errors.push(line);
    };
    try {
      expect(queue.pending()).toEqual([]);
    } finally {
      console.error = original;
    }
    expect(errors.join(' ')).toContain("unreadable deferred action 'q1'");
  });

  it('claims an action before it runs, so a crash cannot replay it', () => {
    const queue = store({ id: counting() });
    const { action } = queue.add(request('a'), config(), NOW);
    const claimed = queue.claim(action, NOW + 1);

    expect(claimed.status).toBe('running');
    // Out of the dequeue order, and out of reach of a capacity eviction, but
    // not settled: it has not finished.
    expect(queue.pending()).toEqual([]);
    expect(queue.settled(10)).toEqual([]);
    expect(queue.get('q1')?.status).toBe('running');
  });

  it('never evicts an action that is mid-send to make room', () => {
    const queue = store({ id: counting() });
    const { action } = queue.add(request('a'), config({ capacity: 1 }), NOW);
    queue.claim(action, NOW);
    const next = queue.add(request('b'), config({ capacity: 1 }), NOW);

    expect(next.dropped).toEqual([]);
    expect(queue.get('q1')?.status).toBe('running');
  });

  it('settles, and never replays, a run a dead process left claimed', () => {
    const file = onDisk();
    const first = new DeferredStore(file.open(), { id: counting() });
    const { action } = first.add(request('a'), config(), NOW);
    first.claim(action, NOW);
    // The process dies here — between the send and the record of it.

    const second = new DeferredStore(file.open());
    const recovered = second.recoverInterrupted(NOW + 5);
    expect(recovered.map((each) => each.status)).toEqual(['failed']);
    expect(recovered[0]?.detail).toContain('may already have happened');
    expect(second.pending()).toEqual([]);
    expect(second.recoverInterrupted(NOW + 6)).toEqual([]);
  });

  it('puts a re-authorized action back in its old place, with both clocks restarted', () => {
    const queue = store({ id: counting() });
    const first = queue.add(request('a'), config(), NOW).action;
    const second = queue.add(request('b'), config(), NOW).action;
    const handedBack = queue.settle(first, 'trust_reset', 'needs confirming again', NOW + 10);

    const back = queue.reinstate(handedBack, config({ ttlMs: 900_000, trustResetMs: 300_000 }), NOW + 20);
    expect(back.status).toBe('pending');
    expect(back.settledAt).toBeUndefined();
    // The approval just given *is* the authorization, so both clocks run from it.
    expect(back.enqueuedAt).toBe(NOW + 20);
    expect(back.expiresAt).toBe(NOW + 20 + 900_000);
    expect(back.trustResetAt).toBe(NOW + 20 + 300_000);
    // And it keeps its position rather than going to the back.
    expect(queue.pending().map((action) => action.id)).toEqual([back.id, second.id]);
  });

  it('trims the history on a settle, not only on an add', () => {
    const queue = store({ id: counting() });
    for (let i = 0; i < 4; i += 1) {
      const { action } = queue.add(request(`x-${i}`), config({ historyLimit: 99 }), NOW);
      queue.settle(action, 'expired', 'old', NOW, 1);
    }
    // A daemon that fills its queue once and is never locked again still keeps
    // the history bounded.
    expect(queue.settled(50)).toHaveLength(1);
  });
});
