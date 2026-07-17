# MQM Plan — v1 Design → v2 POC/MVP → v3 Roadmap

One document, three chapters: why this was designed the way it was (v1), what
got built first (v2), and where it's going now (v3). Older per-topic docs (10
numbered design essays, `IMPLEMENTATION.md`, `docs/DEFINITION-OF-DONE.md`,
`docs/INTEGRATION.md`, `PROJECT-CONTEXT.md`, `ROADMAP.md`) are folded in here
and removed — this is the single source of truth for project history and
direction.

---

## v1 — Design (July 2026)

**Problem:** give Cursor/Playwright QA agents institutional memory (flake
history, journey maps, env quirks) **without** creating a second store of loan
NPI, raw snapshots, or unbounded logs.

**Solution name:** Mortgage QA Memory (MQM) — one governed memory platform,
adapted from DoorDash's "Ask DoorDash" agentic memory architecture and
Salesforce's Agentic Memory pattern.

![DoorDash agentic memory architecture](./assets/doordash-memory-architecture.png)

### What we took from DoorDash / Salesforce

| Pattern | MQM adaptation |
|---------|----------------|
| Three memory layers (long-term / session / conversational) | Tier 0 session (8h) / Tier 1 operational (30d) / Tier 2 curated (git, human-approved) |
| Shared save pipeline (sanitize → extract → dedupe) | Same shape, + **policy pre-save** as a fourth, non-optional stage |
| Memory Policy enforced pre-save | `mqm-policy.yaml` — deny fields/patterns, retention, RBAC — is code, not documentation |
| Write gates / read gates (Salesforce) | Deny-by-default writes; read tools scoped by role |
| Namespace isolation | `qa`, `pr`, `ops`, `compliance`, `product` namespaces on one server (see v3) |
| Eval platform (completeness/accuracy/freshness) | Golden CI-failure set (`eval/ci-failures-golden.jsonl`) |

**Explicitly skipped:** consumer behavioral profiling, dense embeddings/vector
search (v1 doesn't need it), unstructured conversational memory, auto-promotion
of agent facts to durable storage without human review.

### Memory tiers

| Tier | Contents | TTL | Writer | Reader |
|------|----------|-----|--------|--------|
| **0** Session | Draft notes, in-progress investigation | 8h | Agent | Agent |
| **1** Operational | Flake rates, failure signatures, env facts | 30d | Reporter + gated MCP tools | Agent + dashboards |
| **2** Curated | Journey YAML, checkpoints, locators | Until superseded | Human PR only | Agent (read-only) |
| **Audit metadata** | Who/when/tool/outcome/policy version | 365d | Automatic | QC / compliance |
| **Audit evidence** | Trace/screenshot blobs | 90d | Playwright trace upload | QC (time-limited) |

**Never stored long-term:** real SSN/account/DOB, borrower names, raw a11y
snapshots, full prompts/LLM responses, network bodies, screenshots with filled
forms, credit/income values, full stack traces. Use `failure_signature`,
`error_class`, and boolean checkpoint results instead.

### Save pipeline (every write path, no exceptions)

```
raw input → sanitize → extract durable facts → dedupe/merge → evaluatePolicy()
                                                                  │
                                                    deny ─────────┼───── allow
                                                     │            │
                                              audit(policy_block)  write to tier + audit(memory_write)
```

No code path may reach storage without passing `evaluatePolicy`.

### Compliance & audit

Driven by Fannie Mae **LL-2026-04** (AI/ML governance, effective Aug 6 2026)
and Freddie Mac Section 1302.8. MQM is **build-time/QC AI** (validates test
UIs), not credit-decision AI — audit proves controls were active, not that AI
made lending decisions.

- Thin audit event per tool call: principal, tool, policy version, outcome,
  evidence ref — never raw prompt/response text or snapshot content.
- Hash-chained (`prev_hash`/`record_hash`) for tamper detection.
- `ai-inventory.yaml` documents every AI tool touching this workflow (MQM
  server, Playwright MCP, Gemini gateway, Cursor); reviewed at least annually.
- QC/compliance query audit by `loan_scenario_id`, `journey_id`, or principal
  via `get_audit_trail` / `export_qc_sample`, RBAC-limited to
  `qa_lead` / `qc_analyst` / `platform`.

### What we explicitly do not build

- Full loan file intelligence (buy Ocrolus / vendor doc AI instead)
- Long-term storage of accessibility snapshots, prompts, or network bodies
- Agent-driven Playwright in production CI (deterministic tests only there)
- Unapproved agent writes to curated journey/locator registries

---

## v2 — POC / MVP build

What got implemented first, turning the v1 design into a runnable
`packages/*` npm monorepo.

### Packages

| Package | Role |
|---------|------|
| `packages/policy` | `mqm-policy.yaml` — retention, deny patterns, write tiers, RBAC |
| `packages/shared` | types, redact, signature, policy engine, save pipeline, SQLite, queries, purge, graph store |
| `packages/reporter` | Playwright `MqmReporter` → Tier 1 SQLite |
| `packages/mcp-server` | MCP tools (QA read/write + governed knowledge-graph tools) |
| `packages/audit-client` | append-only, hash-chained audit log + QC query |

### Quickstart

```bash
npm install
npm run typecheck        # type-check the whole monorepo
npm test                 # policy / redact / pipeline / graph unit tests
npm run seed:demo        # populate ./data/qa-memory.db with synthetic history
npm run smoke            # exercise the QA-domain MCP tools
npm run smoke:graph      # exercise the governed graph MCP tools
npm run eval             # flake-classification accuracy gate (>= 0.6)
npm run purge            # hard-delete expired Tier 1 rows
```

Point Cursor at [`cursor/mcp.json`](./cursor/mcp.json) and add the
[`mortgage-qa-triage`](./cursor/skills/mortgage-qa-triage/SKILL.md) skill to
enforce memory-before-browser.

### MCP tool surface

Read: `get_flaky_tests`, `get_test_history`, `get_failure_signature`,
`should_skip_browser`, `get_env_facts`, `get_journey_map`,
`get_compliance_checkpoint`, `plan_qa_investigation`, `get_ai_inventory`,
`get_audit_trail`, `export_qc_sample`.

Gated writes: `record_run_summary`, `tag_failure_signature`,
`remember_env_fact` (Tier 1, auto). `upsert_locator` / `propose_checkpoint`
(Tier 2) return `require_approval` — a human opens a PR; the agent never
writes curated memory directly.

Denied by design (never implement): `remember_raw_snapshot`,
`remember_network_body`, `remember_prompt`, `export_full_error`.

RBAC (`MQM_USER_ROLE`, wired from SSO at the gateway):

| Tool | qa_engineer | qa_lead | qc_analyst | platform |
|------|-------------|---------|------------|----------|
| `get_flaky_tests` etc. (read) | ✓ | ✓ | ✓ | ✓ |
| `record_run_summary` / `remember_env_fact` | ✓ | ✓ | — | — |
| `get_audit_trail` | — | ✓ | ✓ | ✓ |
| `upsert_locator` / `propose_checkpoint` | draft | approve | — | ✓ |
| Policy edit | — | — | — | ✓ |

### Integration contract (for other tools/agents)

| Surface | Contract |
|---------|----------|
| MCP server (stdio) | `packages/mcp-server/src/index.ts` (QA tools), `src/graph-index.ts` (graph tools) |
| npm packages | `@mqm/shared`, `@mqm/reporter`, `@mqm/audit-client` — safe to embed without the MCP server |
| Policy | `packages/policy/mqm-policy.yaml` — the one enforced copy (see v3, "reconcile policy files") |

Env vars: `MQM_POLICY_PATH`, `MQM_DB_PATH`, `MQM_JOURNEYS_DIR`, `MQM_ENV`,
`MQM_USER_ROLE`, `MQM_USER_ID`, `MQM_APP_ID`.

Engine vs domain seam: each tool is tagged `domain: "core" | "qa"` in
`packages/mcp-server/src/tools.ts`. Generic, reusable modules in
`@mqm/shared`: `policy.ts`, `pipeline.ts` (row shape is QA-specific),
`db.ts` (schema is QA-specific), `redact.ts`, `signature.ts`, `graph.ts`.
QA-specific: `queries.ts`, `reporter`.

### POC/MVP definition-of-done (as shipped)

| Gate | Status |
|------|--------|
| npm monorepo (policy/shared/reporter/mcp-server/audit-client), typecheck clean | DONE |
| Policy blocks SSN / denied fields pre-save (tested) | DONE |
| Reporter → SQLite, ≥20 `test_runs` rows from a seeded run | DONE |
| MCP read tools live in a client (`get_flaky_tests` returns real data) | DONE |
| `mortgage-qa-triage` Cursor skill; Playwright MCP wired (staging allowlist, no `run_code_unsafe`) | DONE |
| Thin, hash-chained audit per tool call; `get_audit_trail` RBAC-gated | DONE |
| Purge removes expired Tier 1 rows; CI artifact + eval gate wired | DONE |
| 2–3 journeys with TRID checkpoints | PARTIAL — 1 shipped (`le_generation`); add `cd_generation`, `urla_data_entry` |
| Compliance sign-off on `ai-inventory.yaml` | NEEDS-HUMAN — still `draft_pending_signoff` |
| 5 real CI failures triaged on staging | NEEDS-ENV — eval currently uses the synthetic golden set |

**Explicitly deferred post-MVP:** namespaces beyond `app_id` tagging, gateway
SSO / remote SSE transport, Redis Tier 0, Postgres HA, vector semantic search,
auto-promotion of agent facts to Tier 2.

---

## v3 — Roadmap (current)

**North star:** one **governed knowledge-graph memory service** (entities /
observations / relations, `server-memory`-compatible) is the core product.
Everything else — the UI, context notes, the QA agents, the flake tooling — is
a *consumer* of that core, added in sequence and validated with the QA team.

**Principle:** nothing reaches storage without passing `evaluatePolicy` (RBAC +
PII/credential deny + size guards), and every row carries tiered retention. No
second, ungoverned store.

### Phase 1 — Governed memory core ✅ (done)

- SQLite-backed graph: `entities` / `observations` / `relations` (+ FK cascade).
- `server-memory`-compatible tools: `create_entities`, `add_observations`,
  `create_relations`, `delete_*`, `search_nodes`, `open_nodes`, `read_graph`.
- Governance on every write: RBAC, PII/credential deny scan, 2000-char / 200-obs
  size guards (blocks raw-snapshot dumping), tiered retention + purge.
- Hash-chained audit on every call; served as the `naf-qa-memory` MCP server.

**Verify:** `npm run typecheck` · `npm test` (31/31) · `npm run smoke:graph`.

### Phase 2 — Read-only UI (next)

Once QA has generated real graph data worth looking at.

- Local web app served by the Node service, reading SQLite live.
- Browse/search entities & relations, view observations + tiers + expiry.
- View the audit trail (who wrote what, when, allowed/blocked).
- Honors `MQM_USER_ROLE` for the audit view.

*Deliberately read-only first — Phase 1 usage shapes what the UI needs before
we give it write power.*

### Phase 3 — QA agent integration (SUGGESTED — validate with QA team)

The five agents in `cursor/qa-testing-agents/` (`ac-explorer`,
`testcase-writer`, `ado-publisher`, `automation-generator`, `qa-assistant`)
**stay as-is** and keep working — they already call the same tool names the
governed server exposes, so at the tool-contract level they're a drop-in. The
unsolved work is the *seams* below; none should be built until QA confirms the
workflow.

**Mechanism (to assess): generalize the agents via a "QA profile."** The
agents are currently hard-wired to NAF specifics, and that hard-wiring is *why*
the credential blocker exists (a fixed app → a fixed place to read its creds).
Extracting the specifics into one injected profile removes the coupling *and*
the blocker at once — a prompt/config refactor of the `.agent.md` files plus a
resolver in the host, not a memory-service change:

```
profile:
  app_url:        https://qa.ll.nafinc.com
  ado_project:    Lender Link Project Management
  login:          { method: pingone-sso, credential_ref: "naflink-qa" }  # a NAME, not the secret
  memory_server:  naf-qa-memory
  automation:     naflink            # or "greenfield-e2e" (Profile B)
```

This formalizes the Profile A/B idea already implied by
`ADR-001-automation-profiles`, across all agents, not just
`automation-generator`. *No detailed plan yet; assess before committing.*

**Seams to resolve:**

1. **Credential handling (blocker → solved by the profile).** `credential_ref`
   names a secret the host resolves at runtime (env/vault); the agent never
   reads creds from the graph, so governance stops blocking and nothing
   sensitive is stored.
2. **Retention expectations.** Agent exploration entities (`US_{ID}_AC{N}`,
   `US_{ID}_Summary`, …) default to Tier 1 → auto-expire in 30 days. Confirm
   with QA whether some (locator catalogs, journey maps) should be curated
   Tier 2 (human-PR, no expiry) instead.
3. **Entity-schema contract.** Pin the shape agents write (`US_{ID}_AC{N}` +
   observation keys) as a documented contract so the UI and downstream agents
   can rely on it instead of guessing.
4. **Missing MCP wiring.** `cursor/mcp.json` still needs `azure-devops-mcp` and
   `sequentialthinking` servers the agents reference (playwright is already
   configured). Server names become profile values.
5. **Agent hygiene fixes** (cheap, do alongside): `ado-publisher` uses
   `Azure DevOps/*` vs the `microsoft/azure-devops-mcp/*` the others use;
   `ac-explorer` calls `browser_navigate_back` and `automation-generator` calls
   `askQuestions` without declaring them; 5 referenced `cursor/docs/*` files
   don't exist.

**Suggested order:** assess the profile shape → (1) creds via `credential_ref`
→ (4) MCP wiring → pilot one agent (`ac-explorer`) against the governed server
→ (2)(3) tune retention + schema from what it produces → roll out to the rest.

### Phase 4 — Context notes + governance actions in UI

Driven by Phase 2/3 feedback.

- **Context notes:** free-text notes (human- or agent-authored) attached to an
  entity as tagged observations, surfaced in the UI.
- **Governance actions:** approve/reject Tier-2 (`require_approval`) writes and
  run purge from the UI.
- RBAC hardening (roles wired from SSO at the gateway).

### Phase 5 — Hardening & genericization

Non-blocking; do when multi-team reuse arrives.

- **Fix audit hash-chain coverage** — currently only 8 columns are hashed;
  extend to cover `loan_scenario_id`, `environment`, `evidence_ref`,
  `args_summary`, `principal_role`, and add a chain-verify routine.
- **Reconcile the two policy files** — runtime loads
  `packages/policy/mqm-policy.yaml`; that is now the *only* policy file in the
  repo (the root `policies/` template was removed in this cleanup pass —
  customize `packages/policy/mqm-policy.yaml` directly going forward).
- **Park the flake MQM tools** (`get_flaky_tests`, `record_run_summary`, …) as
  an optional `qa` domain pack on the same core.
- Split `@mqm/shared` into `@mqm/core` (policy/redact/audit/retention/graph) +
  `@mqm/qa`.

### Open questions for the QA team

- Which agent-written memory should be **durable (Tier 2)** vs **expiring (Tier 1)**?
- Where should agent **credentials** come from (env, vault, per-user)?
- What does the QA team most want to *see* in the UI first (status per story,
  locator catalog, audit) — this orders Phase 2.

### Namespace roadmap (from v1 design, still the plan for multi-domain growth)

One `mortgage-qa-memory`-family server, namespaced rather than split, until
compliance mandates physical separation:

| Namespace | Scope | Phase |
|-----------|-------|-------|
| `qa` | Playwright, flake, journeys | done (v2) |
| `pr` | PR assistant, repo review patterns | future |
| `ops` | Incidents, deploy correlation | future |
| `compliance` | RFP answers, audit refs (human-write only) | future |
| `product` | Gateway session prefs, 7d TTL | future |

Cross-namespace rule: isolate by default, share deliberately (e.g. `app_id`),
no cross-namespace writes, unified audit tagged by `namespace`.
