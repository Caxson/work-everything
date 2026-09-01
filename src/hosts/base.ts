/**
 * Slow thinking — the tier that is allowed to reason.
 *
 * Nothing in this project implements a reasoning loop. When an event has no
 * deterministic answer, it goes to a host that already has one, and the
 * daemon's only job is to hand over a prompt, bound the wait, and record what
 * came back.
 */

export interface SlowRequest {
  readonly prompt: string;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

export interface SlowResult {
  readonly ok: boolean;
  readonly text: string;
  /** What the host reported spending, when it says. Used by the benchmarks. */
  readonly llmCalls: number;
  readonly durationMs: number;
  readonly error?: string;
}

export interface SlowThinker {
  readonly name: string;
  /** Whether the host is actually usable right now (binary present, etc.). */
  available(): Promise<boolean>;
  think(request: SlowRequest): Promise<SlowResult>;
}
