import { describe, expect, it } from 'vitest';
import {
  applyOutcome,
  createTrust,
  DEFAULT_TRUST_CONFIG,
  initialTrust,
  isEligible,
  needsConfirmation,
  progress,
  reinstate,
  stageOf,
} from '../src/core/trust.js';
import type { TrustState } from '../src/core/trust.js';

const config = { required: 2, quarantineAfter: 2 };
const fresh = (): TrustState => createTrust('s1', config, 0);

describe('trust gate', () => {
  it('starts a promoted subject as an unproven candidate', () => {
    const state = initialTrust('s1', 'promoted', config);
    expect(stageOf(state)).toBe('candidate');
    expect(needsConfirmation(state)).toBe(true);
    expect(progress(state)).toBe('0/2');
  });

  it('starts an authored scenario already trusted', () => {
    const state = initialTrust('s1', 'authored', config);
    expect(stageOf(state)).toBe('auto');
    expect(needsConfirmation(state)).toBe(false);
  });

  it('walks candidate -> confirming -> auto on confirmed successes', () => {
    const one = applyOutcome(fresh(), 'confirmed_success');
    expect(stageOf(one)).toBe('confirming');
    expect(progress(one)).toBe('1/2');
    const two = applyOutcome(one, 'confirmed_success');
    expect(stageOf(two)).toBe('auto');
    expect(needsConfirmation(two)).toBe(false);
  });

  it('refuses to let unattended successes buy autonomy', () => {
    const state = applyOutcome(applyOutcome(fresh(), 'auto_success'), 'auto_success');
    expect(stageOf(state)).toBe('candidate');
    expect(state.successes).toBe(2);
  });

  it('demotes an auto subject the moment it fails', () => {
    const auto = applyOutcome(applyOutcome(fresh(), 'confirmed_success'), 'confirmed_success');
    const demoted = applyOutcome(auto, 'auto_failure');
    expect(stageOf(demoted)).toBe('candidate');
    expect(needsConfirmation(demoted)).toBe(true);
    expect(demoted.confirmations).toBe(0);
  });

  it('treats a human rejection exactly like a failure', () => {
    const state = applyOutcome(applyOutcome(fresh(), 'confirmed_success'), 'rejected');
    expect(state.confirmations).toBe(0);
    expect(state.failures).toBe(1);
  });

  it('quarantines after consecutive failures and stops being eligible', () => {
    const once = applyOutcome(fresh(), 'confirmed_failure');
    expect(isEligible(once)).toBe(true);
    const twice = applyOutcome(once, 'auto_failure');
    expect(stageOf(twice)).toBe('quarantined');
    expect(isEligible(twice)).toBe(false);
  });

  it('resets the failure streak on any success', () => {
    const state = applyOutcome(applyOutcome(fresh(), 'confirmed_failure'), 'auto_success');
    expect(state.consecutiveFailures).toBe(0);
    expect(applyOutcome(state, 'confirmed_failure').quarantined).toBe(false);
  });

  it('reinstates a quarantined subject at the start of the gate', () => {
    const quarantined = applyOutcome(applyOutcome(fresh(), 'auto_failure'), 'auto_failure');
    const back = reinstate(quarantined);
    expect(stageOf(back)).toBe('candidate');
    expect(isEligible(back)).toBe(true);
  });

  it('never mutates the state it is given', () => {
    const before = fresh();
    const snapshot = { ...before };
    applyOutcome(before, 'confirmed_success');
    expect(before).toEqual(snapshot);
  });

  it('normalizes a nonsense config instead of trusting it', () => {
    const state = createTrust('s1', { required: 0, quarantineAfter: -3 });
    expect(state.config).toEqual({ required: 1, quarantineAfter: 1 });
    expect(DEFAULT_TRUST_CONFIG.required).toBe(3);
  });
});
