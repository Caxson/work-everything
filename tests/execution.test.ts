import { describe, expect, it } from 'vitest';
import { availableTools, describeError, fail, ok, toolRunner } from '../src/execution/base.js';
import type { Executor } from '../src/execution/base.js';
import { ShellExecutor } from '../src/execution/shell.js';

const stub = (kind: string, names: readonly string[], impl: () => Promise<never> | ReturnType<typeof ok>): Executor => ({
  kind,
  supports: (tool) => names.includes(tool),
  run: async () => impl(),
});

describe('executor composition', () => {
  it('routes a tool to the executor that claims it', async () => {
    const run = toolRunner([stub('a', ['x'], () => ok('from-a', 1)), stub('b', ['y'], () => ok('from-b', 1))]);
    expect(await run('y', {})).toMatchObject({ ok: true, value: 'from-b' });
  });

  it('reports an unclaimed tool instead of throwing', async () => {
    expect(await toolRunner([])('nope', {})).toMatchObject({ ok: false, error: "no executor provides tool 'nope'" });
  });

  it('turns an executor that throws into a failed result', async () => {
    const run = toolRunner([
      stub('a', ['x'], async () => {
        throw new Error('inner explosion');
      }),
    ]);
    expect(await run('x', {})).toMatchObject({ ok: false, error: 'inner explosion' });
  });

  it('describes non-Error throws without inventing a stack', () => {
    expect(describeError('plain string')).toBe('plain string');
    expect(describeError({ weird: true })).toBe('unknown error');
  });

  it('reports which declared tools are actually served', () => {
    expect([...availableTools([stub('a', ['x'], () => ok('v', 1))], ['x', 'y'])]).toEqual(['x']);
    expect(fail('why', 5)).toEqual({ ok: false, error: 'why', durationMs: 5 });
  });
});

describe('shell executor', () => {
  const executor = new ShellExecutor([
    { name: 'echo', description: 'echo a value', command: process.execPath, argv: ['-e', 'process.stdout.write(process.argv[1])', '$value'], params: ['value'] },
    { name: 'boom', description: 'always fails', command: process.execPath, argv: ['-e', 'console.error("bad news"); process.exit(3)'], params: [] },
    { name: 'slow', description: 'never returns', command: process.execPath, argv: ['-e', 'setTimeout(()=>{},10000)'], params: [], timeoutMs: 120 },
    { name: 'missing', description: 'no such binary', command: '/nonexistent/binary-xyz', argv: [], params: [] },
  ]);

  it('declares what it supports', () => {
    expect(executor.supports('echo')).toBe(true);
    expect(executor.supports('other')).toBe(false);
    expect(executor.names()).toContain('boom');
  });

  it('passes arguments as argv, not through a shell', async () => {
    const result = await executor.run('echo', { value: 'hello; rm -rf /' });
    expect(result).toMatchObject({ ok: true, value: 'hello; rm -rf /' });
  });

  it('refuses to run with a missing required argument', async () => {
    expect(await executor.run('echo', {})).toMatchObject({ ok: false, error: expect.stringContaining('missing argument') });
  });

  it('reports a non-zero exit with the last line of stderr', async () => {
    const result = await executor.run('boom', {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('bad news');
  });

  it('kills a tool that overruns its timeout', async () => {
    expect(await executor.run('slow', {})).toMatchObject({ ok: false, error: expect.stringContaining('timed out') });
  });

  it('reports a binary that cannot be started', async () => {
    expect(await executor.run('missing', {})).toMatchObject({ ok: false, error: expect.stringContaining('cannot start') });
  });

  it('aborts on signal', async () => {
    const controller = new AbortController();
    const pending = executor.run('slow', {}, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('aborted') });
  });

  it('rejects an unknown tool name', async () => {
    expect(await executor.run('nope', {})).toMatchObject({ ok: false, error: expect.stringContaining('unknown shell tool') });
  });
});
