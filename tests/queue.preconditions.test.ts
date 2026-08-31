import { describe, expect, it } from 'vitest';
import { PreconditionRegistry, broken, fixedChecker, holds, notYet } from '../src/queue/preconditions.js';

describe('the precondition registry', () => {
  it('refuses a premise nothing knows how to re-check', async () => {
    const registry = new PreconditionRegistry();
    const verdict = await registry.check({ kind: 'feishu.reply', facts: {} });

    // Fail closed. Treating "no checker" as "no objection" would make the whole
    // gate opt-in, which is backwards for a mechanism that exists to stop
    // stale work from running.
    expect(verdict.state).toBe('broken');
    expect(verdict.detail).toContain("nothing knows how to re-check a 'feishu.reply' premise");
    expect(registry.knows('feishu.reply')).toBe(false);
  });

  it('passes a checker its facts and returns what it said', async () => {
    const registry = new PreconditionRegistry();
    let seen: Readonly<Record<string, string>> = {};
    registry.register('reply', async (facts) => {
      seen = facts;
      return holds(`'${facts['chat']}' is still open`);
    });

    const verdict = await registry.check({ kind: 'reply', facts: { chat: 'Ops' } });
    expect(seen).toEqual({ chat: 'Ops' });
    expect(verdict).toEqual({ state: 'holds', detail: "'Ops' is still open" });
  });

  it('keeps broken and not-yet apart, because one drops and the other waits', async () => {
    const registry = new PreconditionRegistry();
    registry.register('gone', fixedChecker(broken('the target left the allowlist')));
    registry.register('later', fixedChecker(notYet('that conversation is not on screen')));

    expect((await registry.check({ kind: 'gone', facts: {} })).state).toBe('broken');
    expect((await registry.check({ kind: 'later', facts: {} })).state).toBe('not_yet');
  });

  it('treats a checker that throws as a premise that does not hold', async () => {
    const registry = new PreconditionRegistry();
    registry.register('reply', async () => {
      throw new Error('the bridge is not running');
    });

    const verdict = await registry.check({ kind: 'reply', facts: {} });
    expect(verdict.state).toBe('broken');
    expect(verdict.detail).toContain('the bridge is not running');
  });

  it('reports a non-Error throw readably rather than as [object Object]', async () => {
    const registry = new PreconditionRegistry();
    registry.register('reply', async () => {
      throw 'no reader';
    });
    expect((await registry.check({ kind: 'reply', facts: {} })).detail).toContain('no reader');
  });

  it('replaces a checker rather than accumulating two answers for one kind', async () => {
    const registry = new PreconditionRegistry();
    registry.register('reply', fixedChecker(holds('first')));
    registry.register('reply', fixedChecker(broken('second')));

    expect(await registry.check({ kind: 'reply', facts: {} })).toEqual({ state: 'broken', detail: 'second' });
    expect(registry.kinds).toEqual(['reply']);
  });

  it('lists what it knows, sorted, for a status line', () => {
    const registry = new PreconditionRegistry();
    registry.register('zulip.reply', fixedChecker(holds('')));
    registry.register('feishu.reply', fixedChecker(holds('')));
    expect(registry.kinds).toEqual(['feishu.reply', 'zulip.reply']);
    expect(registry.knows('feishu.reply')).toBe(true);
  });
});
