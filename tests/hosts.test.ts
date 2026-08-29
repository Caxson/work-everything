import { describe, expect, it } from 'vitest';
import { ClaudeCodeHost } from '../src/hosts/claudeCode.js';

const fakeHost = (script: string, timeoutMs = 5000): ClaudeCodeHost =>
  new ClaudeCodeHost({ command: process.execPath, args: ['-e', script], timeoutMs });

const echoJson = `
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ result: 'answered: ' + input.trim(), num_turns: 2 }));
});`;

describe('claude code host', () => {
  it('sends the prompt on stdin and reads the JSON result', async () => {
    const result = await fakeHost(echoJson).think({ prompt: 'why did the build fail' });
    expect(result).toMatchObject({ ok: true, text: 'answered: why did the build fail', llmCalls: 2 });
  });

  it('reports a host that flags its own error', async () => {
    const result = await fakeHost('process.stdout.write(JSON.stringify({ is_error: true, subtype: "max_turns" }))').think({ prompt: 'x' });
    expect(result).toMatchObject({ ok: false, error: 'max_turns' });
  });

  it('falls back to raw output when the host does not answer in JSON', async () => {
    const result = await fakeHost('process.stdout.write("plain text answer")').think({ prompt: 'x' });
    expect(result).toMatchObject({ ok: true, text: 'plain text answer', llmCalls: 1 });
  });

  it('reports a non-zero exit with the last line of stderr', async () => {
    const result = await fakeHost('console.error("host blew up"); process.exit(2)').think({ prompt: 'x' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('host blew up');
  });

  it('kills a host that overruns its timeout', async () => {
    const result = await fakeHost('setTimeout(() => {}, 10000)', 100).think({ prompt: 'x' });
    expect(result.error).toContain('timed out');
  });

  it('reports a missing binary rather than crashing', async () => {
    const host = new ClaudeCodeHost({ command: '/nonexistent/claude', args: [], timeoutMs: 500 });
    expect(await host.available()).toBe(false);
    expect((await host.think({ prompt: 'x' })).error).toContain('cannot start');
  });

  it('stops on abort', async () => {
    const controller = new AbortController();
    const pending = fakeHost('setTimeout(() => {}, 10000)').think({ prompt: 'x', signal: controller.signal });
    controller.abort();
    expect((await pending).error).toContain('aborted');
  });

  it('probes availability with --version', async () => {
    expect(await new ClaudeCodeHost({ command: process.execPath, args: [], timeoutMs: 5000 }).available()).toBe(true);
  });
});
