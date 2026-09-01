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
  /**
   * Whether this executor's tools need a screen that is actually there.
   *
   * Declared rather than inferred, because the difference is invisible from a
   * tool name and expensive to get wrong in both directions: a screen-bound
   * tool run behind a locked Mac drives an accessibility tree that has been
   * substituted out from under it, and a shell tool needlessly deferred is
   * work that would have completed while nobody was looking. Absent means no.
   */
  readonly screenBound?: boolean;
  /** Whether this executor claims the named tool. */
  supports(tool: string): boolean;
  /** Every tool this executor claims. Optional: not everything can enumerate. */
  names?(): readonly string[];
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

/**
 * Run the named tools one at a time, whatever else is happening.
 *
 * The daemon's loop and the queue's drain are two async loops over one runner,
 * and the screen-bound tools reach a single application through a single
 * composer and a single snapshot of it. Interleaved, one send's Enter can fire
 * over another's half-typed text, or one send's cleanup can wipe the other's.
 * Serializing only the screen-bound names leaves shell work — and a chain's
 * parallel groups of it — running concurrently, which is where concurrency was
 * actually wanted.
 */
export function serializeTools(runner: ToolRunner, tools: ReadonlySet<string>): ToolRunner {
  let tail: Promise<unknown> = Promise.resolve();
  return async (tool, args, signal) => {
    if (!tools.has(tool)) return await runner(tool, args, signal);
    const mine = tail.then(
      () => runner(tool, args, signal),
      () => runner(tool, args, signal),
    );
    // The chain never rejects; keep the tail alive either way.
    tail = mine.catch(() => undefined);
    return await mine;
  };
}

/**
 * The tools that cannot run while the screen is locked, taken from what the
 * executors declare about themselves. An executor that says it is screen-bound
 * but cannot enumerate its tools contributes nothing here rather than being
 * guessed at — the gate would rather admit a call that then fails honestly than
 * defer one it cannot name.
 */
export function screenBoundTools(executors: readonly Executor[]): ReadonlySet<string> {
  return new Set(executors.filter((executor) => executor.screenBound === true).flatMap((executor) => [...(executor.names?.() ?? [])]));
}

/** Tool names an executor set can serve, for scenario validation. */
export function availableTools(executors: readonly Executor[], names: readonly string[]): ReadonlySet<string> {
  return new Set(names.filter((name) => executors.some((executor) => executor.supports(name))));
}
