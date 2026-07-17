import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { loadPolicy } from "../src/policy.js";
import {
  createEntities,
  addObservations,
  createRelations,
  deleteEntities,
  searchNodes,
  openNodes,
  readGraph,
  type GraphCtx,
} from "../src/graph.js";
import { purgeExpired } from "../src/purge.js";

const policy = loadPolicy();

const qa = (tier: 0 | 1 | 2 = 1): GraphCtx => ({ tier, principal: { userId: "u1", role: "qa_engineer" } });
const qc: GraphCtx = { tier: 1, principal: { userId: "qc", role: "qc_analyst" } };

function freshDb() {
  return openDb(":memory:");
}

test("create_entities + read_graph round-trip", () => {
  const db = freshDb();
  const res = createEntities(
    db,
    [{ name: "US_471244_AC1", entityType: "acceptance_criterion", observations: ["status: PASS", "url: /pipeline"] }],
    qa(),
    policy,
  );
  assert.equal(res.created.length, 1);
  assert.equal(res.denied.length, 0);

  const graph = readGraph(db);
  assert.equal(graph.entities.length, 1);
  assert.equal(graph.entities[0]!.name, "US_471244_AC1");
  assert.deepEqual(graph.entities[0]!.observations, ["status: PASS", "url: /pipeline"]);
  db.close();
});

test("credential observation is denied pre-save (creds never enter the graph)", () => {
  const db = freshDb();
  const res = createEntities(
    db,
    [{ name: "app_credentials", entityType: "secret", observations: ["password: hunter2"] }],
    qa(),
    policy,
  );
  assert.equal(res.created.length, 0);
  assert.equal(res.denied.length, 1);
  assert.equal(res.denied[0]!.reason, "pii_pattern");
  assert.equal(readGraph(db).entities.length, 0);
  db.close();
});

test("SSN in an observation is denied", () => {
  const db = freshDb();
  const res = createEntities(
    db,
    [{ name: "borrower", entityType: "note", observations: ["applicant 123-45-6789 failed KYC"] }],
    qa(),
    policy,
  );
  assert.equal(res.denied.length, 1);
  assert.equal(res.denied[0]!.reason, "pii_pattern");
  db.close();
});

test("qc_analyst cannot write entities (RBAC)", () => {
  const db = freshDb();
  const res = createEntities(db, [{ name: "x", entityType: "t", observations: ["ok"] }], qc, policy);
  assert.equal(res.created.length, 0);
  assert.match(res.denied[0]!.reason, /not permitted/);
  db.close();
});

test("tier-2 graph write requires human approval (never a direct write)", () => {
  const db = freshDb();
  const res = createEntities(db, [{ name: "curated", entityType: "journey", observations: ["step 1"] }], qa(2), policy);
  assert.equal(res.created.length, 0);
  assert.match(res.denied[0]!.reason, /require|approval|pr/i);
  db.close();
});

test("oversized observation is blocked (no raw snapshots)", () => {
  const db = freshDb();
  const huge = "x".repeat(2001);
  const res = createEntities(db, [{ name: "e", entityType: "t", observations: [huge] }], qa(), policy);
  assert.equal(res.created.length, 0);
  assert.match(res.denied[0]!.reason, /exceeds/);
  db.close();
});

test("observations dedupe on repeat add", () => {
  const db = freshDb();
  createEntities(db, [{ name: "e", entityType: "t", observations: ["first"] }], qa(), policy);
  const r1 = addObservations(db, [{ entityName: "e", contents: ["first", "second"] }], qa(), policy);
  assert.deepEqual(r1.created[0]!.added, ["second"]); // "first" already present
  assert.deepEqual(openNodes(db, ["e"]).entities[0]!.observations, ["first", "second"]);
  db.close();
});

test("add_observations to a missing entity is denied", () => {
  const db = freshDb();
  const res = addObservations(db, [{ entityName: "ghost", contents: ["x"] }], qa(), policy);
  assert.equal(res.created.length, 0);
  assert.match(res.denied[0]!.reason, /not found/);
  db.close();
});

test("relations require both endpoints to exist", () => {
  const db = freshDb();
  createEntities(
    db,
    [
      { name: "US_1_AC1", entityType: "ac" },
      { name: "US_1_TC1", entityType: "tc" },
    ],
    qa(),
    policy,
  );
  const bad = createRelations(db, [{ from: "US_1_AC1", to: "nope", relationType: "covered_by" }], qa(), policy);
  assert.equal(bad.created.length, 0);

  const good = createRelations(db, [{ from: "US_1_TC1", to: "US_1_AC1", relationType: "covers" }], qa(), policy);
  assert.equal(good.created.length, 1);
  assert.equal(openNodes(db, ["US_1_AC1", "US_1_TC1"]).relations.length, 1);
  db.close();
});

test("search_nodes matches on observation content", () => {
  const db = freshDb();
  createEntities(
    db,
    [
      { name: "US_9_AC1", entityType: "ac", observations: ["milestone filter renders"] },
      { name: "US_9_AC2", entityType: "ac", observations: ["login via PingOne"] },
    ],
    qa(),
    policy,
  );
  const hits = searchNodes(db, "milestone");
  assert.equal(hits.entities.length, 1);
  assert.equal(hits.entities[0]!.name, "US_9_AC1");
  db.close();
});

test("expired rows are invisible to reads and are purged", () => {
  const db = freshDb();
  createEntities(db, [{ name: "old", entityType: "t", observations: ["stale"] }], qa(), policy);
  db.prepare("UPDATE entities SET expires_at = '2000-01-01T00:00:00.000Z'").run();
  db.prepare("UPDATE observations SET expires_at = '2000-01-01T00:00:00.000Z'").run();

  assert.equal(readGraph(db).entities.length, 0); // filtered by LIVE predicate
  const purged = purgeExpired(db);
  assert.equal(purged.entities, 1);
  assert.equal(purged.observations, 1);
  db.close();
});

test("delete_entities cascades to observations", () => {
  const db = freshDb();
  createEntities(db, [{ name: "e", entityType: "t", observations: ["a", "b"] }], qa(), policy);
  const res = deleteEntities(db, ["e"], qa(), policy);
  assert.deepEqual(res.deleted, ["e"]);
  const remaining = db.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number };
  assert.equal(remaining.n, 0);
  db.close();
});
