import { describe, expect, it } from 'vitest';
import { openDb } from '../src/memory/db.js';
import { TrajectoryStore } from '../src/memory/trajectory.js';
import type { TrajectoryRecord } from '../src/memory/trajectory.js';
import { Registry } from '../src/memory/registry.js';
import { parseScenario } from '../src/core/scenario.js';
import { createTrust } from '../src/core/trust.js';
import { createCandidate } from '../src/core/promotion.js';

const record = (over: Partial<TrajectoryRecord> = {}): TrajectoryRecord => ({
  traceId: 't1',
  ts: 1_700_000_000_000,
  source: 'feishu',
  kind: 'message.received',
  text: 'why did the build fail',
  payload: { text: 'why did the build fail' },
  tier: 'muscle',
  scenarioId: 'ci_failure_log',
  needsConfirmation: false,
  confirmed: null,
  score: 0.8,
  reason: 'matched',
  considered: ['ci_failure_log'],
  llmCalls: 0,
  durationMs: 12,
  ok: true,
  steps: [{ entryIndex: 0, tool: 'gh_run_log', args: { q: 'x' }, ok: true, value: { lines: 3 }, durationMs: 11 }],
  ...over,
});

describe('trajectory store', () => {
  const store = (): TrajectoryStore => new TrajectoryStore(openDb(':memory:'));

  it('round-trips a record with its steps', () => {
    const s = store();
    s.append(record());
    const back = s.get('t1');
    expect(back?.tier).toBe('muscle');
    expect(back?.payload).toEqual({ text: 'why did the build fail' });
    expect(back?.steps[0]).toMatchObject({ tool: 'gh_run_log', ok: true, value: { lines: 3 } });
    expect(back?.considered).toEqual(['ci_failure_log']);
  });

  it('returns undefined for an unknown trace', () => {
    expect(store().get('nope')).toBeUndefined();
  });

  it('replaces a record rather than duplicating its steps', () => {
    const s = store();
    s.append(record());
    s.append(record({ steps: [] }));
    expect(s.get('t1')?.steps).toEqual([]);
  });

  it('keeps a failure and its error message', () => {
    const s = store();
    s.append(record({ traceId: 't2', ok: false, error: 'steps failed: gh_run_log', steps: [{ entryIndex: 0, tool: 'gh_run_log', args: {}, ok: false, error: 'exit 1', durationMs: 3 }] }));
    const back = s.get('t2');
    expect(back?.ok).toBe(false);
    expect(back?.steps[0]?.error).toBe('exit 1');
    expect(back?.steps[0]?.value).toBeUndefined();
  });

  it('answers the benchmark question: events and model calls per tier', () => {
    const s = store();
    s.append(record());
    s.append(record({ traceId: 't2' }));
    s.append(record({ traceId: 't3', tier: 'fast', llmCalls: 1, ok: false }));
    s.append(record({ traceId: 't4', tier: 'slow', llmCalls: 3 }));
    const stats = s.tierStats();
    expect(stats.find((row) => row.tier === 'muscle')).toMatchObject({ events: 2, llmCalls: 0, failures: 0 });
    expect(stats.find((row) => row.tier === 'fast')).toMatchObject({ events: 1, llmCalls: 1, failures: 1 });
    expect(stats.find((row) => row.tier === 'slow')?.llmCalls).toBe(3);
  });

  it('lists recent events newest first', () => {
    const s = store();
    s.append(record({ traceId: 'old', ts: 1 }));
    s.append(record({ traceId: 'new', ts: 2 }));
    expect(s.recent(10).map((r) => r.traceId)).toEqual(['new', 'old']);
  });

  it('tracks what is still waiting on a human', () => {
    const s = store();
    s.append(record({ traceId: 'pending', needsConfirmation: true, confirmed: null }));
    s.append(record({ traceId: 'answered', needsConfirmation: true, confirmed: false }));
    expect(s.pendingConfirmations().map((r) => r.traceId)).toEqual(['pending']);
    expect(s.markConfirmed('pending', true)).toBe(true);
    expect(s.pendingConfirmations()).toEqual([]);
    expect(s.get('pending')?.confirmed).toBe(true);
    expect(s.markConfirmed('missing', true)).toBe(false);
  });
});

describe('registry', () => {
  const registry = (): Registry => new Registry(openDb(':memory:'));
  const scenario = parseScenario({ id: 's1', name: 'S', chain: [{ tool: 'a' }] });

  it('round-trips scenarios and deletes them', () => {
    const r = registry();
    r.saveScenario(scenario);
    expect(r.scenarios()).toHaveLength(1);
    expect(r.deleteScenario('s1')).toBe(true);
    expect(r.deleteScenario('s1')).toBe(false);
    expect(r.scenarios()).toEqual([]);
  });

  it('skips a stored scenario that no longer validates', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO scenarios (id, updated, body) VALUES (?, ?, ?)').run('broken', 1, '{"id":"broken"}');
    expect(new Registry(db).scenarios()).toEqual([]);
  });

  it('round-trips plan candidates', () => {
    const r = registry();
    const candidate = createCandidate({ intent: 'x', description: '', chain: [{ tool: 'a', args: {}, extractTo: '', condition: 'always' }], slotNames: [] }, { query: 'do x', slots: {}, kind: 'k' });
    r.saveCandidate(candidate);
    expect(r.candidate(candidate.planId)?.intent).toBe('x');
    expect(r.candidates()).toHaveLength(1);
    expect(r.deleteCandidate(candidate.planId)).toBe(true);
    expect(r.candidate(candidate.planId)).toBeUndefined();
  });

  it('round-trips trust states by subject', () => {
    const r = registry();
    r.saveTrust(createTrust('s1'));
    expect(r.trust().get('s1')?.subjectId).toBe('s1');
  });
});
