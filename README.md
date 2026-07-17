# Mortgage QA Memory MCP

**Status:** working POC/MVP, now pivoting toward a governed knowledge-graph
memory core. See [PLAN.md](./PLAN.md) for the full history (v1 design → v2
build → v3 roadmap) — start there.

A governed MCP memory service for **Playwright QA automation**, with **tiered
retention** and **mortgage compliance audit**, adapted from DoorDash's and
Salesforce's agentic memory architectures.

See [AGENTS.md](./AGENTS.md) for agent working rules.

---

## Who this is for

- Platform / QA engineers building internal AI tooling on **Cursor**, **Gemini
  gateway**, **KB MCP**, and **Azure MCP**
- Mortgage technology teams that need QA intelligence **without** creating a
  second store of loan data or NPI
- Teams evaluating **Playwright MCP** + a **QA memory expander** they control
  end-to-end

---

## Quickstart

```bash
npm install
npm run typecheck
npm test
npm run seed:demo
npm run smoke        # QA-domain MCP tools
npm run smoke:graph  # governed knowledge-graph MCP tools
```

Then point Cursor at [`cursor/mcp.json`](./cursor/mcp.json) and add the
[`mortgage-qa-triage`](./cursor/skills/mortgage-qa-triage/SKILL.md) skill.

## Layout

| Path | Contents |
|------|----------|
| `packages/policy/mqm-policy.yaml` | The one enforced policy: retention, deny patterns, RBAC, write tiers |
| `packages/shared`, `packages/reporter`, `packages/mcp-server`, `packages/audit-client` | The runnable monorepo — see [PLAN.md](./PLAN.md) v2 |
| `journeys/le_generation.yaml` | Curated (Tier 2) mortgage journey with TRID checkpoints |
| `ai-inventory.yaml` | LL-2026-04 AI tool inventory |
| `cursor/mcp.json`, `cursor/skills/mortgage-qa-triage/` | Cursor MCP config + triage skill |
| `cursor/qa-testing-agents/` | QA agent definitions (AC explorer, testcase writer, ADO publisher, automation generator, QA assistant) |
| `eval/` | Golden CI-failure set for flake-classification accuracy |
| `fixtures/loan-scenarios/` | Synthetic loan data used by tests |

---

## Related external references

- [DoorDash Ask DoorDash / InfoQ summary](https://www.infoq.com/news/2026/07/doordash-ai-ask-assistant/) — agentic memory + MCP + eval at scale
- [Playwright MCP docs](https://playwright.dev/docs/getting-started-mcp) — browser automation via MCP
- [flakiness-knowledge-graph-mcp](https://github.com/vola-trebla/flakiness-knowledge-graph-mcp) — reporter + SQLite + MCP pattern
- [Fannie Mae LL-2026-04](https://singlefamily.fanniemae.com/news-events/lender-letter-ll-2026-04-governance-framework-use-artificial-intelligence-and-machine-learning) — AI governance for seller/servicers (effective Aug 6, 2026)
- [Blend Autopilot MCP](https://blend.com/company/newsroom/blend-launches-autopilot-mcp-server-opening-lending-platform-fi-built-ai-agents/) — lending MCP reference architecture

## Next steps

See [PLAN.md](./PLAN.md) v3 for the live roadmap and open questions for the QA
team.
