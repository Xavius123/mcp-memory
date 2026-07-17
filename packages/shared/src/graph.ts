import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import { evaluatePolicy, getPolicy, type Policy } from "./policy.js";
import type {
  EntityInput,
  EntityRow,
  GraphNode,
  GraphRelation,
  GraphWriteResult,
  KnowledgeGraph,
  ObservationInput,
  ObservationRow,
  RelationInput,
  RelationRow,
  WriteContext,
} from "./types.js";

/**
 * Governed knowledge-graph store (server-memory-compatible surface).
 *
 * Same entity/observation/relation model and tool names as
 * `@modelcontextprotocol/server-memory`, but every write passes through
 * `evaluatePolicy` first (RBAC + PII/credential deny + size guards) and every
 * row carries tiered retention so nothing is stored unbounded.
 *
 * Tier 1 (default) = operational, auto-expires after retention.tier1_operational_days.
 * Tier 2 = curated (no expiry) — but evaluatePolicy forces require_approval for
 * tier 2, so tier-2 graph writes are human-PR only, never a direct agent write.
 */

/** Caller supplies tier + principal; the canonical tool name is set internally. */
export type GraphCtx = Omit<WriteContext, "tool">;

function isoNow(): string {
  return new Date().toISOString();
}
function isoPlusDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}
function retentionDays(policy: Policy, key: string, fallback: number): number {
  const retention = (policy.raw?.retention ?? {}) as Record<string, unknown>;
  const v = retention[key];
  return typeof v === "number" ? v : fallback;
}
function graphLimits(policy: Policy): { maxObsChars: number; maxObsPerEntity: number } {
  const g = (policy.raw?.graph ?? {}) as Record<string, unknown>;
  return {
    maxObsChars: typeof g.max_observation_chars === "number" ? g.max_observation_chars : 2000,
    maxObsPerEntity: typeof g.max_observations_per_entity === "number" ? g.max_observations_per_entity : 200,
  };
}

/** Expiry for a write at the context's tier (tier 2 = curated, never expires). */
function expiryFor(ctx: GraphCtx, policy: Policy): string | null {
  if (ctx.tier === 2) return null;
  return isoPlusDays(retentionDays(policy, "tier1_operational_days", 30));
}

function getEntityRow(db: DB, name: string): EntityRow | undefined {
  return db.prepare("SELECT * FROM entities WHERE name = ?").get(name) as EntityRow | undefined;
}

// ── Writes (gated) ──────────────────────────────────────────────────────────

/** create_entities — insert/refresh entities and their initial observations. */
export function createEntities(
  db: DB,
  entities: EntityInput[],
  ctx: GraphCtx,
  policy: Policy = getPolicy(),
): GraphWriteResult<EntityRow> {
  const wctx: WriteContext = { ...ctx, tool: "create_entities" };
  const { maxObsChars, maxObsPerEntity } = graphLimits(policy);
  const created: EntityRow[] = [];
  const denied: GraphWriteResult<EntityRow>["denied"] = [];
  const now = isoNow();
  const expires = expiryFor(ctx, policy);

  const upsertEntity = db.prepare(
    `INSERT INTO entities (name, entity_type, app_id, tier, created_at, updated_at, expires_at)
     VALUES (@name, @entity_type, @app_id, @tier, @created_at, @updated_at, @expires_at)
     ON CONFLICT(name) DO UPDATE SET
       entity_type = @entity_type, updated_at = @updated_at, expires_at = @expires_at`,
  );

  for (const e of entities) {
    const asRow: EntityRow = {
      name: e.name,
      entity_type: e.entityType,
      app_id: e.appId ?? process.env.MQM_APP_ID ?? null,
      tier: ctx.tier,
      created_at: now,
      updated_at: now,
      expires_at: expires,
    };
    const obs = (e.observations ?? []).filter((o) => o.length > 0);

    // Size guards — block raw-snapshot/prompt dumping as "observations".
    const tooLong = obs.find((o) => o.length > maxObsChars);
    if (tooLong !== undefined) {
      denied.push({ item: asRow, reason: `observation exceeds ${maxObsChars} chars (raw content not allowed)` });
      continue;
    }
    if (obs.length > maxObsPerEntity) {
      denied.push({ item: asRow, reason: `too many observations (> ${maxObsPerEntity})` });
      continue;
    }

    // Policy pre-save: RBAC + PII/credential deny scan over name + observations.
    const decision = evaluatePolicy(
      { name: e.name, entityType: e.entityType, observations: obs },
      wctx,
      policy,
    );
    if (decision.outcome !== "allow") {
      denied.push({ item: asRow, reason: decision.reason, matchedPattern: decision.matchedPattern });
      continue;
    }

    const tx = db.transaction(() => {
      upsertEntity.run(asRow);
      for (const content of obs) insertObservation(db, e.name, content, now, expires);
    });
    tx();
    created.push(getEntityRow(db, e.name)!);
  }
  return { created, denied };
}

function insertObservation(db: DB, entityName: string, content: string, now: string, expires: string | null): boolean {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO observations (id, entity_name, content, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), entityName, content, now, expires);
  return res.changes > 0;
}

/** add_observations — append new observations to existing entities (deduped). */
export function addObservations(
  db: DB,
  items: ObservationInput[],
  ctx: GraphCtx,
  policy: Policy = getPolicy(),
): GraphWriteResult<{ entityName: string; added: string[] }> {
  const wctx: WriteContext = { ...ctx, tool: "add_observations" };
  const { maxObsChars, maxObsPerEntity } = graphLimits(policy);
  const created: Array<{ entityName: string; added: string[] }> = [];
  const denied: GraphWriteResult<{ entityName: string; added: string[] }>["denied"] = [];
  const now = isoNow();
  const expires = expiryFor(ctx, policy);

  for (const item of items) {
    const result = { entityName: item.entityName, added: [] as string[] };
    const contents = (item.contents ?? []).filter((c) => c.length > 0);

    if (!getEntityRow(db, item.entityName)) {
      denied.push({ item: result, reason: `entity not found: ${item.entityName}` });
      continue;
    }
    const tooLong = contents.find((c) => c.length > maxObsChars);
    if (tooLong !== undefined) {
      denied.push({ item: result, reason: `observation exceeds ${maxObsChars} chars (raw content not allowed)` });
      continue;
    }
    if (contents.length > maxObsPerEntity) {
      denied.push({ item: result, reason: `too many observations (> ${maxObsPerEntity})` });
      continue;
    }

    const decision = evaluatePolicy({ entityName: item.entityName, contents }, wctx, policy);
    if (decision.outcome !== "allow") {
      denied.push({ item: result, reason: decision.reason, matchedPattern: decision.matchedPattern });
      continue;
    }

    const tx = db.transaction(() => {
      for (const content of contents) {
        if (insertObservation(db, item.entityName, content, now, expires)) result.added.push(content);
      }
      db.prepare("UPDATE entities SET updated_at = ? WHERE name = ?").run(now, item.entityName);
    });
    tx();
    created.push(result);
  }
  return { created, denied };
}

/** create_relations — connect two existing entities (deduped). */
export function createRelations(
  db: DB,
  relations: RelationInput[],
  ctx: GraphCtx,
  policy: Policy = getPolicy(),
): GraphWriteResult<RelationInput> {
  const wctx: WriteContext = { ...ctx, tool: "create_relations" };
  const created: RelationInput[] = [];
  const denied: GraphWriteResult<RelationInput>["denied"] = [];
  const now = isoNow();
  const expires = expiryFor(ctx, policy);

  for (const r of relations) {
    const decision = evaluatePolicy(
      { from: r.from, to: r.to, relationType: r.relationType },
      wctx,
      policy,
    );
    if (decision.outcome !== "allow") {
      denied.push({ item: r, reason: decision.reason, matchedPattern: decision.matchedPattern });
      continue;
    }
    if (!getEntityRow(db, r.from) || !getEntityRow(db, r.to)) {
      denied.push({ item: r, reason: `relation endpoints must both exist (${r.from} -> ${r.to})` });
      continue;
    }
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO relations (id, from_entity, to_entity, relation_type, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), r.from, r.to, r.relationType, now, expires);
    if (res.changes > 0) created.push(r);
  }
  return { created, denied };
}

// ── Deletes (gated by RBAC; no content to scan) ─────────────────────────────

export function deleteEntities(db: DB, names: string[], ctx: GraphCtx, policy: Policy = getPolicy()): { deleted: string[]; denied?: string } {
  const decision = evaluatePolicy({ names }, { ...ctx, tool: "delete_entities" }, policy);
  if (decision.outcome !== "allow") return { deleted: [], denied: decision.reason };
  const deleted: string[] = [];
  const stmt = db.prepare("DELETE FROM entities WHERE name = ?");
  for (const name of names) if (stmt.run(name).changes > 0) deleted.push(name);
  return { deleted };
}

export function deleteObservations(db: DB, items: ObservationInput[], ctx: GraphCtx, policy: Policy = getPolicy()): { deleted: number; denied?: string } {
  const decision = evaluatePolicy({ items: items.map((i) => i.entityName) }, { ...ctx, tool: "delete_observations" }, policy);
  if (decision.outcome !== "allow") return { deleted: 0, denied: decision.reason };
  let deleted = 0;
  const stmt = db.prepare("DELETE FROM observations WHERE entity_name = ? AND content = ?");
  for (const item of items) for (const content of item.contents) deleted += stmt.run(item.entityName, content).changes;
  return { deleted };
}

export function deleteRelations(db: DB, relations: RelationInput[], ctx: GraphCtx, policy: Policy = getPolicy()): { deleted: number; denied?: string } {
  const decision = evaluatePolicy({ n: relations.length }, { ...ctx, tool: "delete_relations" }, policy);
  if (decision.outcome !== "allow") return { deleted: 0, denied: decision.reason };
  let deleted = 0;
  const stmt = db.prepare("DELETE FROM relations WHERE from_entity = ? AND to_entity = ? AND relation_type = ?");
  for (const r of relations) deleted += stmt.run(r.from, r.to, r.relationType).changes;
  return { deleted };
}

// ── Reads (live rows only — expired rows are invisible before purge) ────────

const LIVE = "(expires_at IS NULL OR expires_at > @now)";

function nodesFor(db: DB, entityRows: EntityRow[], now: string): GraphNode[] {
  const obsStmt = db.prepare(
    `SELECT content FROM observations WHERE entity_name = @name AND ${LIVE} ORDER BY created_at ASC`,
  );
  return entityRows.map((e) => ({
    name: e.name,
    entityType: e.entity_type,
    observations: (obsStmt.all({ name: e.name, now }) as Array<{ content: string }>).map((o) => o.content),
  }));
}

/** Relations whose endpoints are both within `names`. */
function relationsAmong(db: DB, names: string[], now: string): GraphRelation[] {
  if (names.length === 0) return [];
  const set = new Set(names);
  const rows = db
    .prepare(`SELECT from_entity, to_entity, relation_type FROM relations WHERE ${LIVE}`)
    .all({ now }) as RelationRow[];
  return rows
    .filter((r) => set.has(r.from_entity) && set.has(r.to_entity))
    .map((r) => ({ from: r.from_entity, to: r.to_entity, relationType: r.relation_type }));
}

/** read_graph — the whole live graph. */
export function readGraph(db: DB): KnowledgeGraph {
  const now = isoNow();
  const entityRows = db.prepare(`SELECT * FROM entities WHERE ${LIVE} ORDER BY name ASC`).all({ now }) as EntityRow[];
  const nodes = nodesFor(db, entityRows, now);
  const relations = relationsAmong(db, entityRows.map((e) => e.name), now);
  return { entities: nodes, relations };
}

/** open_nodes — a subgraph for the named entities (+ relations among them). */
export function openNodes(db: DB, names: string[]): KnowledgeGraph {
  const now = isoNow();
  const found: EntityRow[] = [];
  const stmt = db.prepare(`SELECT * FROM entities WHERE name = @name AND ${LIVE}`);
  for (const name of names) {
    const row = stmt.get({ name, now }) as EntityRow | undefined;
    if (row) found.push(row);
  }
  return { entities: nodesFor(db, found, now), relations: relationsAmong(db, found.map((e) => e.name), now) };
}

/** search_nodes — match query against entity name, type, or observation text. */
export function searchNodes(db: DB, query: string): KnowledgeGraph {
  const now = isoNow();
  const like = `%${query}%`;
  const entityRows = db
    .prepare(
      `SELECT DISTINCT e.* FROM entities e
       LEFT JOIN observations o ON o.entity_name = e.name AND (o.expires_at IS NULL OR o.expires_at > @now)
       WHERE (e.expires_at IS NULL OR e.expires_at > @now)
         AND (e.name LIKE @like OR e.entity_type LIKE @like OR o.content LIKE @like)
       ORDER BY e.name ASC`,
    )
    .all({ now, like }) as EntityRow[];
  return { entities: nodesFor(db, entityRows, now), relations: relationsAmong(db, entityRows.map((e) => e.name), now) };
}
