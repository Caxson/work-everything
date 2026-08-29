/**
 * The shell executor.
 *
 * Tools are declared up front with a fixed argv template; a chain step fills
 * in the placeholders. Nothing here builds a command string out of event
 * text and hands it to a shell — arguments are passed as an argv array, so a
 * value that happens to contain a semicolon is an argument, not a command.
 */
import { spawn } from 'node:child_process';
import type { Executor, ToolResult } from './base.js';
import { fail, ok } from './base.js';

export interface ShellTool {
  readonly name: string;
  readonly description: string;
  readonly command: string;
  /** argv entries; `$name` placeholders are filled from the step's args. */
  readonly argv: readonly string[];
  /** Argument names this tool requires. Missing ones fail the step. */
  readonly params: readonly string[];
  readonly timeoutMs?: number | undefined;
  readonly cwd?: string | undefined;
}

export const DEFAULT_SHELL_TIMEOUT_MS = 30_000;
/** Stdout beyond this is truncated before it reaches the trajectory. */
export const MAX_OUTPUT_CHARS = 64_000;

export class ShellExecutor implements Executor {
  readonly kind = 'shell';
  private readonly tools: ReadonlyMap<string, ShellTool>;

  constructor(tools: readonly ShellTool[]) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  supports(tool: string): boolean {
    return this.tools.has(tool);
  }

  names(): readonly string[] {
    return [...this.tools.keys()];
  }

  async run(tool: string, args: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<ToolResult> {
    const started = Date.now();
    const spec = this.tools.get(tool);
    if (spec === undefined) return fail(`unknown shell tool '${tool}'`, 0);

    const missing = spec.params.filter((param) => (args[param] ?? '') === '');
    if (missing.length > 0) return fail(`tool '${tool}' is missing argument(s): ${missing.join(', ')}`, Date.now() - started);

    const argv = spec.argv.map((entry) => entry.replace(/\$(\w+)/g, (whole, name: string) => args[name] ?? whole));
    return await this.spawn(spec, argv, started, signal);
  }

  private spawn(spec: ShellTool, argv: readonly string[], started: number, signal: AbortSignal | undefined): Promise<ToolResult> {
    return new Promise((resolve) => {
      const timeoutMs = spec.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
      const child = spawn(spec.command, [...argv], {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result: ToolResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(fail(`tool '${spec.name}' timed out after ${timeoutMs}ms`, Date.now() - started));
      }, timeoutMs);
      const onAbort = (): void => {
        child.kill('SIGKILL');
        finish(fail(`tool '${spec.name}' aborted`, Date.now() - started));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (stdout += chunk));
      child.stderr.on('data', (chunk: string) => (stderr += chunk));
      child.on('error', (error) => finish(fail(`cannot start '${spec.command}': ${error.message}`, Date.now() - started)));
      child.on('close', (code) => {
        const duration = Date.now() - started;
        if (code === 0) return finish(ok(truncate(stdout).trim(), duration));
        const detail = truncate(stderr).trim().split('\n').slice(-1)[0] ?? '';
        finish(fail(`tool '${spec.name}' exited ${code ?? -1}${detail === '' ? '' : `: ${detail}`}`, duration));
      });
    });
  }
}

function truncate(text: string): string {
  return text.length <= MAX_OUTPUT_CHARS ? text : `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated)`;
}
