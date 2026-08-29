/**
 * Executors — how a chain step actually touches the world.
 *
 * The engine never knows what a tool does; it only knows how to ask for one
 * by name and how to read the result. Every executor returns the same
 * envelope, including on failure, so no step can throw its way out of the
 * chain and skip the trajectory record.
 */

export interface ToolResult {
  readonly ok: boolean;
  /** Present when ok; JSON-serializable so it can go into the trajectory. */
  readonly value?: unknown;
  /** Present when !ok. Safe to show a user: no stack traces, no secrets. */
  readonly error?: string | undefined;
  readonly durationMs: number;
}

export interface Executor {
  /** Identifies the executor in logs and errors. */
  readonly kind: string;
  /** Whether this executor claims the named tool. */
  supports(tool: string): boolean;
  run(tool: string, args: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<ToolResult>;
}

/** What the engine calls per step. Composed from executors by `toolRunner`. */
export type ToolRunner = (
  tool: string,
  args: Readonly<Record<string, string>>,
  signal?: AbortSignal,
) => Promise<ToolResult>;

export function ok(value: unknown, durationMs: number): ToolResult {
  return { ok: true, value, durationMs };
}

export function fail(error: string, durationMs: number): ToolResult {
  return { ok: false, error, durationMs };
}

/**
 * Compose executors into one runner. First claimant wins; an unclaimed tool
 * is a failed result rather than a throw, so the chain's failure policy —
 * not an exception — decides what happens next.
 */
export function toolRunner(executors: readonly Executor[]): ToolRunner {
  return async (tool, args, signal) => {
    const executor = executors.find((candidate) => candidate.supports(tool));
    if (executor === undefined) return fail(`no executor provides tool '${tool}'`, 0);
    const started = Date.now();
    try {
      return await executor.run(tool, args, signal);
    } catch (error) {
      return fail(describeError(error), Date.now() - started);
    }
  };
}

/** Message-only rendering of an unknown throw: never leaks a stack trace. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

/** Tool names an executor set can serve, for scenario validation. */
export function availableTools(executors: readonly Executor[], names: readonly string[]): ReadonlySet<string> {
  return new Set(names.filter((name) => executors.some((executor) => executor.supports(name))));
}
