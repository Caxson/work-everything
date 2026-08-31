/**
 * Where deferred actions live between a lock and an unlock.
 *
 * Durable because the alternative is a lie: the daemon writes a trajectory
 * saying it is holding an action until the screen unlocks, and a restart in
 * between would quietly throw that away while the record still claims
 * otherwise. A queue that survives a restart is the only version of this
 * feature that matches what it tells the user.
 *
 * The store enforces one policy of its own — **capacity** — and it enforces it
 * by dropping the *oldest* pending action, not the newest. A queue that fills
 * up behind a lock is full of work that has been waiting longest and is
 * therefore closest to being wrong anyway; refusing the newest would keep the
 * stalest. Every drop is returned to the caller so it can be recorded rather
 * than vanishing.
 *
 * Chains are stored as JSON and **validated on the way out**, the same rule
 * `registry.ts` follows: a row that no longer parses is reported and skipped,
 * never executed. Settled rows are kept for `we queue` and trimmed to
 * `historyLimit`, so a long-running daemon does not grow this table without
 * bound.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import type { Scenario } from '../core/scenario.js';
import { ScenarioSchema } from '../core/scenario.js';
import type { DeferralConfig, DeferralRequest, DeferralStatus, DeferredAction } from '../queue/deferred.js';
import { enqueue, isDeferralStatus, settle } from '../queue/deferred.js';

interface DeferredRow {
  readonly seq: number;
  readonly id: string;
  readonly trace_id: string;
  readonly chain: string;
  readonly vars: string;
  readonly purpose: string;
  readonly precondition_kind: string;
  readonly precondition_facts: string;
  readonly enqueued_at: number;
  readonly expires_at: number;
  readonly trust_reset_at: number;
  readonly status: string;
  readonly settled_at: number | null;
  readonly detail: string;
}

/** What one `add` did: the action queued, and anything it pushed out. */
export interface AddResult {
  readonly action: DeferredAction;
  readonly dropped: readonly DeferredAction[];
}

export interface DeferredStoreDeps {
  /** Injectable so tests get stable ids. */
  readonly id?: () => string;
  /** Where an unreadable row is reported. Defaults to stderr. */
  readonly onUnreadable?: (id: string, problem: string) => void;
}

export class DeferredStore {
  constructor(
    private readonly db: Db,
    private readonly deps: DeferredStoreDeps = {},
  ) {}

  /**
   * Queue one action. Capacity is applied first, so the action being added is
   * never the one dropped to make room for itself.
   */
  add(request: DeferralRequest, config: DeferralConfig, now: number): AddResult {
    const dropped = this.makeRoom(Math.max(1, config.capacity), now);
    const action = enqueue(request, config, now, this.deps.id?.() ?? defaultId(now), this.nextSeq());
    this.insert(action);
    this.trimHistory(Math.max(0, config.historyLimit));
    return { action, dropped };
  }

  /** Everything still waiting, oldest first. This is the dequeue order. */
  pending(): readonly DeferredAction[] {
    return this.rows('SELECT * FROM deferred_actions WHERE status = ? ORDER BY seq', ['pending'], 'runnable');
  }

  pendingCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM deferred_actions WHERE status = ?').get('pending') as { n: number };
    return row.n;
  }

  /** Actions that will never run, newest first, with the reason on each. */
  settled(limit = 50): readonly DeferredAction[] {
    return this.rows(
      "SELECT * FROM deferred_actions WHERE status NOT IN ('pending', 'running') ORDER BY seq DESC LIMIT ?",
      [Math.max(1, limit)],
      'history',
    );
  }

  /** One action by id, whatever state it is in. Listing semantics, not running. */
  get(id: string): DeferredAction | undefined {
    const row = this.db.prepare('SELECT * FROM deferred_actions WHERE id = ?').get(id) as DeferredRow | undefined;
    return row === undefined ? undefined : this.toAction(row, 'history');
  }

  /**
   * Mark an action as running, before it runs.
   *
   * The claim is what makes the queue at-most-once rather than at-least-once.
   * It also takes the row out of `pending`, so a capacity eviction arriving
   * mid-send cannot settle an action that is in the middle of writing to
   * somebody's chat window.
   */
  claim(action: DeferredAction, now: number): DeferredAction {
    return this.settle(action, 'running', 'claimed by a drain and executing', now);
  }

  /**
   * Actions found `running` at startup: claimed by a process that did not
   * survive to record what happened. They are settled as failed rather than
   * replayed — the message may already have been sent, and sending it twice is
   * worse than not sending it at all.
   */
  recoverInterrupted(now = Date.now()): readonly DeferredAction[] {
    const stranded = this.rows('SELECT * FROM deferred_actions WHERE status = ? ORDER BY seq', ['running'], 'history');
    return stranded.map((action) =>
      this.settle(
        action,
        'failed',
        'a previous run claimed this and did not survive to record the outcome; it is not being retried, because ' +
          'part of it may already have happened',
        now,
      ),
    );
  }

  /**
   * Put a handed-back action back in the queue, re-authorized by a person.
   *
   * Both clocks restart from `now`, and that is the point: the approval just
   * given *is* the authorization, so measuring it from a decision made an hour
   * ago would expire it before it could run. It keeps its sequence number, so
   * it returns to the position it held rather than to the back.
   */
  reinstate(action: DeferredAction, config: DeferralConfig, now: number): DeferredAction {
    const expiresAt = now + Math.max(0, config.ttlMs);
    const next: DeferredAction = {
      ...action,
      status: 'pending',
      detail: '',
      settledAt: undefined,
      enqueuedAt: now,
      expiresAt,
      trustResetAt: Math.min(expiresAt, now + Math.max(0, config.trustResetMs)),
    };
    this.db
      .prepare('UPDATE deferred_actions SET status = ?, detail = ?, settled_at = NULL, enqueued_at = ?, expires_at = ?, trust_reset_at = ? WHERE id = ?')
      .run(next.status, next.detail, next.enqueuedAt, next.expiresAt, next.trustResetAt, next.id);
    return next;
  }

  /** Move an action out of `pending`. Returns the settled record. */
  settle(action: DeferredAction, status: DeferralStatus, detail: string, now: number, historyLimit?: number): DeferredAction {
    const next = settle(action, status, detail, now);
    this.db
      .prepare('UPDATE deferred_actions SET status = ?, detail = ?, settled_at = ? WHERE id = ?')
      .run(next.status, next.detail, next.settledAt ?? now, next.id);
    if (historyLimit !== undefined) this.trimHistory(Math.max(0, historyLimit));
    return next;
  }

  /**
   * Settle a row that could not be read back into an action. It has no
   * `DeferredAction` to hand to `settle`, and leaving it pending would put an
   * unrunnable row at the head of the queue forever.
   */
  private quarantineRow(row: DeferredRow, problem: string, now = Date.now()): void {
    this.db
      .prepare('UPDATE deferred_actions SET status = ?, detail = ?, settled_at = ? WHERE id = ?')
      .run('unverifiable', `stored action is unreadable: ${problem}`, now, row.id);
  }

  // --- internals -----------------------------------------------------------

  private insert(action: DeferredAction): void {
    this.db
      .prepare(
        `INSERT INTO deferred_actions
         (seq, id, trace_id, chain, vars, purpose, precondition_kind, precondition_facts,
          enqueued_at, expires_at, trust_reset_at, status, settled_at, detail)
         VALUES (@seq, @id, @trace_id, @chain, @vars, @purpose, @precondition_kind, @precondition_facts,
          @enqueued_at, @expires_at, @trust_reset_at, @status, @settled_at, @detail)`,
      )
      .run({
        seq: action.seq,
        id: action.id,
        trace_id: action.traceId,
        chain: JSON.stringify(action.chain),
        vars: JSON.stringify(action.vars),
        purpose: action.purpose,
        precondition_kind: action.precondition.kind,
        precondition_facts: JSON.stringify(action.precondition.facts),
        enqueued_at: action.enqueuedAt,
        expires_at: action.expiresAt,
        trust_reset_at: action.trustResetAt,
        status: action.status,
        settled_at: action.settledAt ?? null,
        detail: action.detail,
      });
  }

  /**
   * A sequence that never reuses a position, even after settled rows are
   * deleted. `MAX(seq) + 1` over the whole table, not over the pending ones.
   */
  private nextSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS top FROM deferred_actions').get() as { top: number };
    return row.top + 1;
  }

  private makeRoom(capacity: number, now: number): readonly DeferredAction[] {
    const pending = this.pending();
    const excess = pending.length - (capacity - 1);
    if (excess <= 0) return [];
    return pending
      .slice(0, excess)
      .map((action) =>
        this.settle(action, 'dropped_for_capacity', `pushed out of a queue holding ${capacity} action(s) by newer work`, now),
      );
  }

  /**
   * Trim the settled history. Runs on every settle as well as every add, so a
   * daemon that fills its queue once and then never locks again does not keep
   * the whole history forever.
   */
  private trimHistory(limit: number): void {
    this.db
      .prepare(
        `DELETE FROM deferred_actions
         WHERE status NOT IN ('pending', 'running')
           AND seq NOT IN (SELECT seq FROM deferred_actions WHERE status NOT IN ('pending', 'running') ORDER BY seq DESC LIMIT ?)`,
      )
      .run(limit);
  }

  private rows(sql: string, params: readonly (string | number)[], mode: ReadMode): readonly DeferredAction[] {
    const rows = this.db.prepare(sql).all(...params) as DeferredRow[];
    const out: DeferredAction[] = [];
    for (const row of rows) {
      const action = this.toAction(row, mode);
      if (action !== undefined) out.push(action);
    }
    return out;
  }

  /**
   * Validate one row into an action.
   *
   * The two modes exist because the two readers want opposite things from a
   * row whose chain no longer parses. A `runnable` read is about to hand the
   * action to the engine, so an unreadable one is quarantined and withheld. A
   * `history` read is a listing that will never execute anything, and hiding
   * the row there would erase the record of an action that visibly did not
   * happen — exactly what `we queue --discarded` exists to show.
   */
  private toAction(row: DeferredRow, mode: ReadMode): DeferredAction | undefined {
    const parsed = ScenarioSchema.safeParse(safeJson(row.chain));
    let chain: Scenario;
    if (parsed.success) {
      chain = parsed.data;
    } else {
      const problem = parsed.error.issues[0]?.message ?? 'invalid';
      this.report(row, problem);
      if (mode === 'runnable') {
        if (row.status === 'pending') this.quarantineRow(row, problem);
        return undefined;
      }
      chain = UNREADABLE_CHAIN;
    }
    if (!isDeferralStatus(row.status)) {
      this.report(row, `unknown status '${row.status}'`);
      return undefined;
    }
    return {
      id: row.id,
      seq: row.seq,
      traceId: row.trace_id,
      chain,
      vars: safeRecord(row.vars),
      purpose: row.purpose,
      precondition: { kind: row.precondition_kind, facts: safeRecord(row.precondition_facts) },
      enqueuedAt: row.enqueued_at,
      expiresAt: row.expires_at,
      trustResetAt: row.trust_reset_at,
      status: row.status,
      settledAt: row.settled_at ?? undefined,
      detail: row.detail,
    };
  }

  private report(row: DeferredRow, problem: string): void {
    if (this.deps.onUnreadable !== undefined) {
      this.deps.onUnreadable(row.id, problem);
      return;
    }
    console.error(`[queue] dropping unreadable deferred action '${row.id}': ${problem}`);
  }
}

/** How a row is being read: to run it, or to list it. */
type ReadMode = 'runnable' | 'history';

/**
 * Stands in for a chain that can no longer be parsed, in listings only. It has
 * no steps, so even if it somehow reached the engine there would be nothing to
 * run — the placeholder cannot become an action by accident.
 */
const UNREADABLE_CHAIN: Scenario = {
  id: '(unreadable)',
  name: '(unreadable)',
  description: 'the stored chain could not be parsed by this build',
  triggers: [],
  kinds: [],
  chain: [],
  onFailure: 'fail_fast',
  origin: 'authored',
};

/** A stored JSON object of strings, or an empty one if the row is unreadable. */
function safeRecord(text: string): Readonly<Record<string, string>> {
  const parsed = safeJson(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function defaultId(now: number): string {
  return `q${now.toString(36)}-${randomUUID().slice(0, 8)}`;
}
