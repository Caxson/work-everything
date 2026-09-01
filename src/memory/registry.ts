/**
 * What the daemon knows between restarts: the scenarios it has, the plan
 * candidates it is still watching, and how much it trusts each of them.
 *
 * These are stored as validated JSON blobs rather than shredded into columns
 * — the shapes are owned by `core/`, and a schema change there should not
 * become a migration here. Reads validate on the way out, so a hand-edited or
 * stale row is reported, not executed.
 */
import type { Db } from './db.js';
import type { Scenario } from '../core/scenario.js';
import { ScenarioSchema } from '../core/scenario.js';
import type { PlanCandidate } from '../core/promotion.js';
import type { TrustState } from '../core/trust.js';

export class Registry {
  constructor(private readonly db: Db) {}

  saveScenario(scenario: Scenario): void {
    this.db
      .prepare('INSERT OR REPLACE INTO scenarios (id, updated, body) VALUES (?, ?, ?)')
      .run(scenario.id, Date.now(), JSON.stringify(scenario));
  }

  /** Every stored scenario. Rows that no longer validate are skipped, loudly. */
  scenarios(): readonly Scenario[] {
    const rows = this.db.prepare('SELECT id, body FROM scenarios ORDER BY updated').all() as { id: string; body: string }[];
    const out: Scenario[] = [];
    for (const row of rows) {
      const parsed = ScenarioSchema.safeParse(safeJson(row.body));
      if (parsed.success) out.push(parsed.data);
      else console.error(`[registry] dropping unreadable scenario '${row.id}': ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    }
    return out;
  }

  deleteScenario(id: string): boolean {
    return this.db.prepare('DELETE FROM scenarios WHERE id = ?').run(id).changes > 0;
  }

  saveCandidate(candidate: PlanCandidate): void {
    this.db
      .prepare('INSERT OR REPLACE INTO plan_candidates (plan_id, updated, body) VALUES (?, ?, ?)')
      .run(candidate.planId, Date.now(), JSON.stringify(candidate));
  }

  candidates(): readonly PlanCandidate[] {
    const rows = this.db.prepare('SELECT body FROM plan_candidates ORDER BY updated').all() as { body: string }[];
    return rows.map((row) => safeJson(row.body) as PlanCandidate).filter((candidate) => typeof candidate?.planId === 'string');
  }

  candidate(planId: string): PlanCandidate | undefined {
    const row = this.db.prepare('SELECT body FROM plan_candidates WHERE plan_id = ?').get(planId) as { body: string } | undefined;
    return row === undefined ? undefined : (safeJson(row.body) as PlanCandidate);
  }

  deleteCandidate(planId: string): boolean {
    return this.db.prepare('DELETE FROM plan_candidates WHERE plan_id = ?').run(planId).changes > 0;
  }

  saveTrust(state: TrustState): void {
    this.db
      .prepare('INSERT OR REPLACE INTO trust_states (subject_id, updated, body) VALUES (?, ?, ?)')
      .run(state.subjectId, state.updatedAt, JSON.stringify(state));
  }

  trust(): ReadonlyMap<string, TrustState> {
    const rows = this.db.prepare('SELECT subject_id, body FROM trust_states').all() as { subject_id: string; body: string }[];
    return new Map(rows.map((row) => [row.subject_id, safeJson(row.body) as TrustState]));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
