import { describe, expect, it } from 'vitest';
import { parseScenario } from '../src/core/scenario.js';
import type { Scenario } from '../src/core/scenario.js';
import {
  DEFAULT_DEFERRAL_CONFIG,
  DEFERRAL_STATUSES,
  LIVE_STATUSES,
  SETTLED_STATUSES,
  authorityLapsed,
  describeAge,
  describeChain,
  enqueue,
  hasExpired,
  isDeferralStatus,
  settle,
  type DeferralConfig,
  type DeferralRequest,
} from '../src/queue/deferred.js';

const NOW = 1_700_000_000_000;

const chain = (...tools: readonly string[]): Scenario =>
  parseScenario({
    id: 'reply',
    name: 'reply',
    chain: tools.map((tool) => ({ tool, args: { text: '$text' } })),
  });

const request = (over: Partial<DeferralRequest> = {}): DeferralRequest => ({
  traceId: 'feishu-1',
  chain: chain('feishu.reply'),
  vars: { text: 'pong' },
  purpose: "reply in 'Ops'",
  precondition: { kind: 'feishu.reply', facts: { chat: 'Ops' } },
  ...over,
});

const config = (over: Partial<DeferralConfig> = {}): DeferralConfig => ({ ...DEFAULT_DEFERRAL_CONFIG, ...over });

describe('a deferred action', () => {
  it('sets both deadlines from the moment it was queued', () => {
    const action = enqueue(request(), config({ ttlMs: 900_000, trustResetMs: 300_000 }), NOW, 'q1', 1);
    expect(action.enqueuedAt).toBe(NOW);
    expect(action.expiresAt).toBe(NOW + 900_000);
    expect(action.trustResetAt).toBe(NOW + 300_000);
    expect(action.status).toBe('pending');
    expect(action.detail).toBe('');
  });

  it('clamps a reset window that outlives the action, so the gate can still fire', () => {
    // Configured the wrong way round, the trust reset would be unreachable:
    // anything old enough to hit it has already been dropped as expired.
    const action = enqueue(request(), config({ ttlMs: 60_000, trustResetMs: 600_000 }), NOW, 'q1', 1);
    expect(action.trustResetAt).toBe(action.expiresAt);
    expect(authorityLapsed(action, action.expiresAt)).toBe(false);
    expect(authorityLapsed(action, action.expiresAt + 1)).toBe(true);
  });

  it('copies the args and facts it was handed, so a later mutation cannot rewrite it', () => {
    const vars: Record<string, string> = { text: 'pong' };
    const facts: Record<string, string> = { chat: 'Ops' };
    const action = enqueue(request({ vars, precondition: { kind: 'feishu.reply', facts } }), config(), NOW, 'q1', 1);

    vars['text'] = 'something else';
    facts['chat'] = 'Someone Else';

    expect(action.vars).toEqual({ text: 'pong' });
    expect(action.precondition.facts).toEqual({ chat: 'Ops' });
  });

  it('expires strictly after its deadline, not on it', () => {
    const action = enqueue(request(), config({ ttlMs: 1_000 }), NOW, 'q1', 1);
    expect(hasExpired(action, NOW)).toBe(false);
    expect(hasExpired(action, NOW + 1_000)).toBe(false);
    expect(hasExpired(action, NOW + 1_001)).toBe(true);
  });

  it('loses its authority before it expires, which is the whole point of two clocks', () => {
    const action = enqueue(request(), config({ ttlMs: 900_000, trustResetMs: 300_000 }), NOW, 'q1', 1);
    const midway = NOW + 400_000;
    expect(authorityLapsed(action, midway)).toBe(true);
    expect(hasExpired(action, midway)).toBe(false);
  });

  it('settles into a new record rather than editing the one it was given', () => {
    const action = enqueue(request(), config(), NOW, 'q1', 1);
    const dead = settle(action, 'expired', 'too old', NOW + 1);

    expect(action.status).toBe('pending');
    expect(action.settledAt).toBeUndefined();
    expect(dead.status).toBe('expired');
    expect(dead.detail).toBe('too old');
    expect(dead.settledAt).toBe(NOW + 1);
  });

  it('names the chain it is holding', () => {
    const action = enqueue(request({ chain: chain('clock.now', 'feishu.reply') }), config(), NOW, 'q1', 1);
    expect(describeChain(action)).toBe('clock.now → feishu.reply');
  });

  it('says so when it is holding an empty chain rather than printing nothing', () => {
    const empty = parseScenario({ id: 'nothing', name: 'nothing', chain: [] });
    expect(describeChain(enqueue(request({ chain: empty }), config(), NOW, 'q1', 1))).toBe('(empty chain)');
  });

  it('renders an age a person can read at every scale', () => {
    expect(describeAge(NOW, NOW)).toBe('0s');
    expect(describeAge(NOW, NOW + 45_000)).toBe('45s');
    expect(describeAge(NOW, NOW + 125_000)).toBe('2m5s');
    expect(describeAge(NOW, NOW + 7_500_000)).toBe('2h5m');
    // A clock that went backwards must not print a negative age.
    expect(describeAge(NOW, NOW - 5_000)).toBe('0s');
  });

  it('keeps pending and running out of the settled set, and everything else in', () => {
    // `running` matters here: a claimed action is still in play, so a capacity
    // eviction must not treat it as finished and settle it mid-send.
    expect([...LIVE_STATUSES].sort()).toEqual(['pending', 'running']);
    for (const status of DEFERRAL_STATUSES) {
      expect(SETTLED_STATUSES.has(status)).toBe(!LIVE_STATUSES.has(status));
    }
    expect(isDeferralStatus('running')).toBe(true);
    expect(isDeferralStatus('something-a-newer-build-invented')).toBe(false);
  });

  it('never produces a deadline before the moment it was queued', () => {
    const action = enqueue(request(), config({ ttlMs: -5, trustResetMs: -5 }), NOW, 'q1', 1);
    expect(action.expiresAt).toBe(NOW);
    expect(action.trustResetAt).toBe(NOW);
  });
});
