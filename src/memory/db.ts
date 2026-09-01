/**
 * The one SQLite handle and the schema it guarantees.
 *
 * Every table the daemon persists lives here so the schema is readable in
 * one place and migrations stay honest. `:memory:` is a supported path, which
 * is what the tests use.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trajectories (
  trace_id           TEXT PRIMARY KEY,
  ts                 INTEGER NOT NULL,
  source             TEXT NOT NULL,
  kind               TEXT NOT NULL,
  text               TEXT NOT NULL DEFAULT '',
  payload            TEXT NOT NULL DEFAULT '{}',
  tier               TEXT NOT NULL,
  scenario_id        TEXT,
  plan_id            TEXT,
  needs_confirmation INTEGER NOT NULL DEFAULT 0,
  confirmed          INTEGER,
  score              REAL NOT NULL DEFAULT 0,
  reason             TEXT NOT NULL DEFAULT '',
  considered         TEXT NOT NULL DEFAULT '[]',
  llm_calls          INTEGER NOT NULL DEFAULT 0,
  duration_ms        INTEGER NOT NULL DEFAULT 0,
  ok                 INTEGER NOT NULL DEFAULT 0,
  error              TEXT
);
CREATE INDEX IF NOT EXISTS idx_trajectories_ts ON trajectories (ts DESC);
CREATE INDEX IF NOT EXISTS idx_trajectories_tier ON trajectories (tier);

CREATE TABLE IF NOT EXISTS trajectory_steps (
  trace_id    TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  entry_index INTEGER NOT NULL,
  tool        TEXT NOT NULL,
  args        TEXT NOT NULL DEFAULT '{}',
  ok          INTEGER NOT NULL DEFAULT 0,
  value       TEXT,
  error       TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (trace_id, seq),
  FOREIGN KEY (trace_id) REFERENCES trajectories (trace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scenarios (
  id      TEXT PRIMARY KEY,
  updated INTEGER NOT NULL,
  body    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_candidates (
  plan_id TEXT PRIMARY KEY,
  updated INTEGER NOT NULL,
  body    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trust_states (
  subject_id TEXT PRIMARY KEY,
  updated    INTEGER NOT NULL,
  body       TEXT NOT NULL
);

-- Actions that could not run when they were decided on — the screen was
-- locked — and the clocks that decide whether they still may. Durable on
-- purpose: a queue that a restart empties would silently drop work the daemon
-- has already told the trajectory it is holding.
--
-- The seq column is the dequeue order, and is an autoincrement rather than a timestamp:
-- two actions enqueued in the same millisecond still have an order, and
-- deleting settled rows must never let a later action inherit an earlier
-- position.
CREATE TABLE IF NOT EXISTS deferred_actions (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  id                 TEXT NOT NULL UNIQUE,
  trace_id           TEXT NOT NULL,
  chain              TEXT NOT NULL DEFAULT '{}',
  vars               TEXT NOT NULL DEFAULT '{}',
  purpose            TEXT NOT NULL DEFAULT '',
  precondition_kind  TEXT NOT NULL DEFAULT '',
  precondition_facts TEXT NOT NULL DEFAULT '{}',
  enqueued_at        INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  trust_reset_at     INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  settled_at         INTEGER,
  detail             TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_deferred_status ON deferred_actions (status, seq);
`;

/** Open (creating if needed) the daemon's database with the schema applied. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/** SQLite has no boolean type; keep the conversion in one place. */
export const toInt = (value: boolean): 0 | 1 => (value ? 1 : 0);
export const toBool = (value: number | null): boolean => value === 1;
