/**
 * Trajectories — every event, the tier it took, and what that cost.
 *
 * This is the only place that can answer whether the whole idea is working:
 * how much traffic the muscle tier absorbs, how many model calls the rest
 * spends, what gets confirmed and what fails. So it records the decision and
 * the outcome for *every* event, including the ones that fell through to
 * slow thinking, and it never drops a record because a step threw.
 */
import type { Db } from './db.js';
import { toBool, toInt } from './db.js';

export interface TrajectoryStep {
  readonly entryIndex: number;
  readonly tool: string;
  readonly args: Readonly<Record<string, string>>;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string | undefined;
  readonly durationMs: number;
}

export interface TrajectoryRecord {
  readonly traceId: string;
  readonly ts: number;
  readonly source: string;
  readonly kind: string;
  readonly text: string;
  /** The event's payload verbatim, so a trajectory can be replayed as observed. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly tier: string;
  readonly scenarioId?: string | undefined;
  readonly planId?: string | undefined;
  readonly needsConfirmation: boolean;
  /** null while unanswered; true/false once a human decided. */
  readonly confirmed?: boolean | null;
  readonly score: number;
  readonly reason: string;
  readonly considered: readonly string[];
  /** Model calls this event cost. The muscle tier must record zero. */
  readonly llmCalls: number;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly error?: string | undefined;
  readonly steps: readonly TrajectoryStep[];
}

export interface TierStat {
  readonly tier: string;
  readonly events: number;
  readonly llmCalls: number;
  readonly failures: number;
  readonly avgDurationMs: number;
}

interface TrajectoryRow {
  readonly trace_id: string;
  readonly ts: number;
  readonly source: string;
  readonly kind: string;
  readonly text: string;
  readonly payload: string;
  readonly tier: string;
  readonly scenario_id: string | null;
  readonly plan_id: string | null;
  readonly needs_confirmation: number;
  readonly confirmed: number | null;
  readonly score: number;
  readonly reason: string;
  readonly considered: string;
  readonly llm_calls: number;
  readonly duration_ms: number;
  readonly ok: number;
  readonly error: string | null;
}

interface StepRow {
  readonly entry_index: number;
  readonly tool: string;
  readonly args: string;
  readonly ok: number;
  readonly value: string | null;
  readonly error: string | null;
  readonly duration_ms: number;
}

export class TrajectoryStore {
  constructor(private readonly db: Db) {}

  /** Write one event's full record. The record and its steps go in together. */
  append(record: TrajectoryRecord): void {
    const insertEvent = this.db.prepare(
      `INSERT OR REPLACE INTO trajectories
       (trace_id, ts, source, kind, text, payload, tier, scenario_id, plan_id, needs_confirmation,
        confirmed, score, reason, considered, llm_calls, duration_ms, ok, error)
       VALUES (@trace_id, @ts, @source, @kind, @text, @payload, @tier, @scenario_id, @plan_id,
        @needs_confirmation, @confirmed, @score, @reason, @considered, @llm_calls,
        @duration_ms, @ok, @error)`,
    );
    const insertStep = this.db.prepare(
      `INSERT OR REPLACE INTO trajectory_steps
       (trace_id, seq, entry_index, tool, args, ok, value, error, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      insertEvent.run({
        trace_id: record.traceId,
        ts: record.ts,
        source: record.source,
        kind: record.kind,
        text: record.text,
        payload: JSON.stringify(record.payload),
        tier: record.tier,
        scenario_id: record.scenarioId ?? null,
        plan_id: record.planId ?? null,
        needs_confirmation: toInt(record.needsConfirmation),
        confirmed: record.confirmed === null || record.confirmed === undefined ? null : toInt(record.confirmed),
        score: record.score,
        reason: record.reason,
        considered: JSON.stringify(record.considered),
        llm_calls: record.llmCalls,
        duration_ms: record.durationMs,
        ok: toInt(record.ok),
        error: record.error ?? null,
      });
      this.db.prepare('DELETE FROM trajectory_steps WHERE trace_id = ?').run(record.traceId);
      for (const [seq, step] of record.steps.entries()) {
        insertStep.run(
          record.traceId,
          seq,
          step.entryIndex,
          step.tool,
          JSON.stringify(step.args),
          toInt(step.ok),
          step.value === undefined ? null : JSON.stringify(step.value),
          step.error ?? null,
          step.durationMs,
        );
      }
    })();
  }

  /** Record a human's answer to a confirmation request, after the fact. */
  markConfirmed(traceId: string, confirmed: boolean): boolean {
    const result = this.db.prepare('UPDATE trajectories SET confirmed = ? WHERE trace_id = ?').run(toInt(confirmed), traceId);
    return result.changes > 0;
  }

  get(traceId: string): TrajectoryRecord | undefined {
    const row = this.db.prepare('SELECT * FROM trajectories WHERE trace_id = ?').get(traceId) as TrajectoryRow | undefined;
    if (row === undefined) return undefined;
    const steps = this.db
      .prepare('SELECT * FROM trajectory_steps WHERE trace_id = ? ORDER BY seq')
      .all(traceId) as StepRow[];
    return toRecord(row, steps);
  }

  recent(limit: number): readonly TrajectoryRecord[] {
    const rows = this.db.prepare('SELECT * FROM trajectories ORDER BY ts DESC LIMIT ?').all(Math.max(1, limit)) as TrajectoryRow[];
    return rows.map((row) => toRecord(row, []));
  }

  /** The benchmark view: what each tier absorbed and what it cost. */
  tierStats(): readonly TierStat[] {
    const rows = this.db
      .prepare(
        `SELECT tier,
                COUNT(*)                AS events,
                SUM(llm_calls)          AS llm_calls,
                SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures,
                AVG(duration_ms)        AS avg_duration
         FROM trajectories GROUP BY tier ORDER BY events DESC`,
      )
      .all() as { tier: string; events: number; llm_calls: number | null; failures: number | null; avg_duration: number | null }[];
    return rows.map((row) => ({
      tier: row.tier,
      events: row.events,
      llmCalls: row.llm_calls ?? 0,
      failures: row.failures ?? 0,
      avgDurationMs: Math.round(row.avg_duration ?? 0),
    }));
  }

  /** Events still waiting on a human. */
  pendingConfirmations(limit = 20): readonly TrajectoryRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM trajectories WHERE needs_confirmation = 1 AND confirmed IS NULL ORDER BY ts DESC LIMIT ?')
      .all(Math.max(1, limit)) as TrajectoryRow[];
    return rows.map((row) => toRecord(row, []));
  }
}

function toRecord(row: TrajectoryRow, steps: readonly StepRow[]): TrajectoryRecord {
  return {
    traceId: row.trace_id,
    ts: row.ts,
    source: row.source,
    kind: row.kind,
    text: row.text,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    tier: row.tier,
    scenarioId: row.scenario_id ?? undefined,
    planId: row.plan_id ?? undefined,
    needsConfirmation: toBool(row.needs_confirmation),
    confirmed: row.confirmed === null ? null : toBool(row.confirmed),
    score: row.score,
    reason: row.reason,
    considered: JSON.parse(row.considered) as string[],
    llmCalls: row.llm_calls,
    durationMs: row.duration_ms,
    ok: toBool(row.ok),
    error: row.error ?? undefined,
    steps: steps.map((step) => ({
      entryIndex: step.entry_index,
      tool: step.tool,
      args: JSON.parse(step.args) as Record<string, string>,
      ok: toBool(step.ok),
      value: step.value === null ? undefined : (JSON.parse(step.value) as unknown),
      error: step.error ?? undefined,
      durationMs: step.duration_ms,
    })),
  };
}
