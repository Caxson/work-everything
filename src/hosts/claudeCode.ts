/**
 * Slow thinking hosted by the Claude Code CLI.
 *
 * `claude -p --output-format json` is a one-shot: a prompt in, a JSON object
 * out. That is the entire integration. The daemon does not manage a session,
 * does not stream, and treats a non-zero exit or a timeout the same way it
 * treats any other failed tier — as something to record and move past.
 */
import { spawn } from 'node:child_process';
import type { SlowRequest, SlowResult, SlowThinker } from './base.js';

export interface ClaudeCodeConfig {
  /** The executable. Overridable so a test can point at a stand-in. */
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly cwd?: string | undefined;
}

export const DEFAULT_CLAUDE_CODE_CONFIG: ClaudeCodeConfig = {
  command: 'claude',
  args: ['-p', '--output-format', 'json'],
  timeoutMs: 120_000,
};

interface ClaudeJsonOutput {
  readonly result?: string;
  readonly is_error?: boolean;
  readonly num_turns?: number;
  readonly subtype?: string;
}

export class ClaudeCodeHost implements SlowThinker {
  readonly name = 'claude_code';

  constructor(private readonly config: ClaudeCodeConfig = DEFAULT_CLAUDE_CODE_CONFIG) {}

  async available(): Promise<boolean> {
    const probe = await this.run(['--version'], '', 5_000, undefined);
    return probe.code === 0;
  }

  async think(request: SlowRequest): Promise<SlowResult> {
    const started = Date.now();
    const outcome = await this.run([...this.config.args], request.prompt, this.config.timeoutMs, request.signal);
    const durationMs = Date.now() - started;

    if (outcome.error !== undefined) return { ok: false, text: '', llmCalls: 0, durationMs, error: outcome.error };
    if (outcome.code !== 0) {
      const detail = outcome.stderr.trim().split('\n').slice(-1)[0] ?? '';
      return { ok: false, text: '', llmCalls: 0, durationMs, error: `${this.config.command} exited ${outcome.code}${detail === '' ? '' : `: ${detail}`}` };
    }

    const parsed = parseOutput(outcome.stdout);
    return {
      ok: !(parsed?.is_error ?? false),
      text: parsed?.result ?? outcome.stdout.trim(),
      llmCalls: parsed?.num_turns ?? 1,
      durationMs,
      ...(parsed?.is_error === true ? { error: parsed.subtype ?? 'host reported an error' } : {}),
    };
  }

  private run(
    args: readonly string[],
    stdin: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<{ code: number; stdout: string; stderr: string; error?: string }> {
    return new Promise((resolve) => {
      const child = spawn(this.config.command, [...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(this.config.cwd === undefined ? {} : { cwd: this.config.cwd }),
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (value: { code: number; stdout: string; stderr: string; error?: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ code: -1, stdout, stderr, error: `host timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      const onAbort = (): void => {
        child.kill('SIGKILL');
        finish({ code: -1, stdout, stderr, error: 'host call aborted' });
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (stdout += chunk));
      child.stderr.on('data', (chunk: string) => (stderr += chunk));
      child.on('error', (error) => finish({ code: -1, stdout, stderr, error: `cannot start '${this.config.command}': ${error.message}` }));
      child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }));

      child.stdin.end(stdin);
    });
  }
}

function parseOutput(stdout: string): ClaudeJsonOutput | undefined {
  const text = stdout.trim();
  if (text === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as ClaudeJsonOutput) : undefined;
  } catch {
    return undefined;
  }
}
