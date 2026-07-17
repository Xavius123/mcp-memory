# AGENTS.md — mcp-memory

Governed **Mortgage QA Memory MCP**. Working POC/MVP (`packages/*`), now
pivoting to a governed knowledge-graph memory core (see PLAN.md v3).

## What this repo is

- A working MCP memory service for **Playwright QA memory** with **mortgage compliance audit**
- Adapted from **DoorDash** agentic memory + **Salesforce** Agentic Memory patterns
- **Tiered retention** — agents summarize, policy blocks PII/long-term hoarding

## Read first

1. [README.md](./README.md) — index
2. [PLAN.md](./PLAN.md) — design rationale (v1), what's built (v2), roadmap (v3)
3. [packages/policy/mqm-policy.yaml](./packages/policy/mqm-policy.yaml) — enforce before any write path

## Hard rules for agents working here

- **Policy pre-save** on every memory write — no bypass
- **Never persist** raw snapshots, prompts, network bodies, SSN/account patterns
- **Tier 2** (journeys, locators, checkpoints) — human PR only, no agent auto-write
- **Playwright MCP** — staging/UAT allowlist; `browser_run_code_unsafe` disabled
- **Synthetic loan scenarios only** — see `loan_scenarios.allowed_ids` in policy

## Implementation layout

```
packages/policy/           mqm-policy.yaml — the one enforced policy
packages/shared/            pipeline, redact, types, graph store, policy engine
packages/reporter/          Playwright MqmReporter
packages/mcp-server/        QA-domain MCP + governed knowledge-graph MCP
packages/audit-client/      hash-chained audit log
journeys/                   Tier 2 curated YAML
cursor/qa-testing-agents/    QA agent definitions
eval/                        golden CI failure labels
```

## Related stack (external repos)

- Gemini gateway (`ai-gateway`)
- KB MCP, doc wizard, PR assistant, Azure MCP — see PLAN.md v1 for the integration model
