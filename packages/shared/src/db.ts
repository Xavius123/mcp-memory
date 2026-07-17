import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS test_runs (
  id TEXT PRIMARY KEY,
  test_id TEXT NOT NULL,
  journey_id TEXT,
  app_id TEXT,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  browser TEXT,
  os TEXT,
  env TEXT,
  commit_sha TEXT,
  loan_scenario_id TEXT,
  error_class TEXT,
  failure_signature TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_test ON test_runs(test_id);
CREATE INDEX IF NOT EXISTS idx_runs_expires ON test_runs(expires_at);
CREATE INDEX IF NOT EXISTS idx_runs_sig ON test_runs(failure_signature);

CREATE TABLE IF NOT EXISTS failure_signatures (
  signature TEXT PRIMARY KEY,
  classification TEXT NOT NULL,
  notes TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS env_facts (
  id TEXT PRIMARY KEY,
  env TEXT NOT NULL,
  overlay_key TEXT,
  fact TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_env ON env_facts(env, overlay_key);

CREATE TABLE IF NOT EXISTS audit_events (
  audit_id TEXT PRIMARY KEY,
  timestamp_utc TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  principal_role TEXT NOT NULL,
  action_class TEXT NOT NULL,
  tool_server TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_summary TEXT,
  journey_id TEXT,
  loan_scenario_id TEXT,
  environment TEXT,
  policy_version TEXT NOT NULL,
  outcome TEXT NOT NULL,
  evidence_ref TEXT,
  prev_hash TEXT,
  record_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(timestamp_utc);

-- ── Governed knowledge graph (server-memory-compatible) ─────────────────────
-- Entities, observations, and relations that back the create_entities /
-- add_observations / create_relations / search_nodes / open_nodes / read_graph
-- tool surface. Every write is gated by evaluatePolicy first (see graph.ts).
CREATE TABLE IF NOT EXISTS entities (
  name TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  app_id TEXT,
  tier INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_expires ON entities(expires_at);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  entity_name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  UNIQUE(entity_name, content),
  FOREIGN KEY (entity_name) REFERENCES entities(name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_obs_entity ON observations(entity_name);
CREATE INDEX IF NOT EXISTS idx_obs_expires ON observations(expires_at);

CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY,
  from_entity TEXT NOT NULL,
  to_entity TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  UNIQUE(from_entity, to_entity, relation_type),
  FOREIGN KEY (from_entity) REFERENCES entities(name) ON DELETE CASCADE,
  FOREIGN KEY (to_entity) REFERENCES entities(name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rel_from ON relations(from_entity);
CREATE INDEX IF NOT EXISTS idx_rel_to ON relations(to_entity);
CREATE INDEX IF NOT EXISTS idx_rel_expires ON relations(expires_at);
`;

export function dbPath(): string {
  return process.env.MQM_DB_PATH ?? "./data/qa-memory.db";
}

/** Open (and migrate) the Tier 1 + audit SQLite store. */
export function openDb(path: string = dbPath()): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON"); // enforce graph FK cascades (observations/relations)
  db.exec(SCHEMA);
  return db;
}
