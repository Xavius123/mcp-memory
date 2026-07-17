// Shared type contracts for Mortgage QA Memory (MQM).
// See design docs 05 (retention), 07 (tools), 04 (audit).

export type Tier = 0 | 1 | 2;

export type Role =
  | "qa_engineer"
  | "qa_lead"
  | "engineer"
  | "qc_analyst"
  | "platform";

export type TestStatus = "passed" | "failed" | "flaky" | "skipped";

export type Classification = "flake" | "regression" | "env" | "unknown";

export type PolicyOutcome = "allow" | "deny" | "require_approval";

export interface Principal {
  userId: string;
  role: Role;
  displayName?: string;
}

/** Context passed to the save pipeline on every write attempt. */
export interface WriteContext {
  tier: Tier;
  tool: string;
  principal: Principal;
  agent?: string;
  policyVersion?: string;
}

/** Raw run info handed to the reporter/pipeline. `errorMessage` is NEVER stored raw. */
export interface TestRunInput {
  testId: string;
  status: TestStatus;
  durationMs: number;
  journeyId?: string;
  appId?: string;
  browser?: string;
  os?: string;
  env?: string;
  commitSha?: string;
  loanScenarioId?: string;
  errorClass?: string;
  errorMessage?: string;
}

/** Persisted Tier 1 row (allowlisted columns only). */
export interface TestRunRow {
  id: string;
  test_id: string;
  journey_id: string | null;
  app_id: string | null;
  status: TestStatus;
  duration_ms: number | null;
  browser: string | null;
  os: string | null;
  env: string | null;
  commit_sha: string | null;
  loan_scenario_id: string | null;
  error_class: string | null;
  failure_signature: string | null;
  created_at: string;
  expires_at: string;
}

export interface FailureSignatureRow {
  signature: string;
  classification: Classification;
  notes: string | null;
  occurrence_count: number;
  first_seen: string;
  last_seen: string;
  expires_at: string;
}

export interface EnvFactRow {
  id: string;
  env: string;
  overlay_key: string | null;
  fact: string;
  source: string | null;
  created_at: string;
  expires_at: string;
}

export interface AuditEventRow {
  audit_id: string;
  timestamp_utc: string;
  principal_id: string;
  principal_role: string;
  action_class: string;
  tool_server: string;
  tool_name: string;
  args_summary: string | null;
  journey_id: string | null;
  loan_scenario_id: string | null;
  environment: string | null;
  policy_version: string;
  outcome: string;
  evidence_ref: string | null;
  prev_hash: string | null;
  record_hash: string;
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  reason: string;
  policyVersion: string;
  /** Sanitized payload safe to persist (deny-fields removed). */
  transformed?: Record<string, unknown>;
  matchedPattern?: string;
}

// ── Governed knowledge graph (server-memory-compatible) ─────────────────────

/** Input to create_entities. `observations` are scanned for PII pre-save. */
export interface EntityInput {
  name: string;
  entityType: string;
  observations?: string[];
  /** Optional project tag; falls back to MQM_APP_ID. */
  appId?: string;
}

/** Input to add_observations. */
export interface ObservationInput {
  entityName: string;
  contents: string[];
}

/** Input to create_relations. */
export interface RelationInput {
  from: string;
  to: string;
  relationType: string;
}

export interface EntityRow {
  name: string;
  entity_type: string;
  app_id: string | null;
  tier: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export interface ObservationRow {
  id: string;
  entity_name: string;
  content: string;
  created_at: string;
  expires_at: string | null;
}

export interface RelationRow {
  id: string;
  from_entity: string;
  to_entity: string;
  relation_type: string;
  created_at: string;
  expires_at: string | null;
}

/** server-memory-compatible node shape returned by read/search/open. */
export interface GraphNode {
  name: string;
  entityType: string;
  observations: string[];
}

export interface GraphRelation {
  from: string;
  to: string;
  relationType: string;
}

export interface KnowledgeGraph {
  entities: GraphNode[];
  relations: GraphRelation[];
}

/** Per-item outcome of a gated graph write. */
export interface GraphWriteResult<T> {
  created: T[];
  denied: Array<{ item: T; reason: string; matchedPattern?: string }>;
}

/** Thrown when a write is blocked pre-save. */
export class PolicyDeniedError extends Error {
  readonly reason: string;
  readonly policyVersion: string;
  readonly matchedPattern?: string;
  constructor(decision: PolicyDecision) {
    super(`policy_denied: ${decision.reason}`);
    this.name = "PolicyDeniedError";
    this.reason = decision.reason;
    this.policyVersion = decision.policyVersion;
    this.matchedPattern = decision.matchedPattern;
  }
}
