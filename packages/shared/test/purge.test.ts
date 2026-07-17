import { test } from "node:test";
import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { purgeExpired } from "../src/purge.js";

function dbWithRows(): Database.Database {
  const db = openDb(":memory:"); // real schema (incl. graph tables) so purge never drifts
  const past = "2000-01-01T00:00:00.000Z";
  const future = "2999-01-01T00:00:00.000Z";
  db.prepare("INSERT INTO test_runs (id, test_id, status, created_at, expires_at) VALUES (?,?,?,?,?)").run("a", "t", "passed", past, past);
  db.prepare("INSERT INTO test_runs (id, test_id, status, created_at, expires_at) VALUES (?,?,?,?,?)").run("b", "t", "passed", past, future);
  db.prepare("INSERT INTO env_facts (id, env, fact, created_at, expires_at) VALUES (?,?,?,?,?)").run("e1", "uat", "slow sso", past, past);
  return db;
}

test("purgeExpired hard-deletes only past-expiry rows", () => {
  const db = dbWithRows();
  const result = purgeExpired(db);
  assert.equal(result.test_runs, 1);
  assert.equal(result.env_facts, 1);
  const remaining = db.prepare("SELECT COUNT(*) AS n FROM test_runs").get() as { n: number };
  assert.equal(remaining.n, 1);
});
