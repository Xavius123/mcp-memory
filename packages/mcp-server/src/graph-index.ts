import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { graphTools, READ_TOOLS } from "./graph-tools.js";
import {
  openDb,
  getPolicy,
  createEntities,
  addObservations,
  createRelations,
  deleteEntities,
  deleteObservations,
  deleteRelations,
  searchNodes,
  openNodes,
  readGraph,
  type EntityInput,
  type ObservationInput,
  type RelationInput,
  type GraphCtx,
  type Principal,
  type Role,
  type Tier,
} from "@mqm/shared";
import { logAudit } from "@mqm/audit-client";

const SERVER = "naf-qa-memory";
const policy = getPolicy();
const db = openDb();

const principal: Principal = {
  userId: process.env.MQM_USER_ID ?? "local-user",
  role: (process.env.MQM_USER_ROLE as Role) ?? "qa_engineer",
  displayName: process.env.MQM_USER_NAME,
};

// Graph writes default to Tier 1 (operational, auto-expiring). MQM_GRAPH_TIER=2
// makes them curated (require_approval — human PR only).
const tier: Tier = process.env.MQM_GRAPH_TIER === "2" ? 2 : 1;
const ctx: GraphCtx = { tier, principal };

const server = new Server(
  { name: SERVER, version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: graphTools }));

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(reason: string, extra: Record<string, unknown> = {}) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ error: reason, policy_version: policy.version, ...extra }, null, 2) },
    ],
    isError: true,
  };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const isRead = READ_TOOLS.has(name);

  const audit = (outcome: "success" | "failure" | "blocked", summary: string) =>
    logAudit(db, {
      principal,
      actionClass: outcome === "blocked" ? "policy_block" : isRead ? "memory_read" : "memory_write",
      toolServer: SERVER,
      toolName: name,
      argsSummary: summary,
      environment: process.env.MQM_ENV,
      policyVersion: policy.version,
      outcome,
    });

  // A gated write auditor: blocked when nothing was written but something was denied.
  const auditWrite = (createdCount: number, deniedCount: number) => {
    const summary = `created=${createdCount},denied=${deniedCount}`;
    audit(createdCount === 0 && deniedCount > 0 ? "blocked" : "success", summary);
  };

  try {
    switch (name) {
      case "read_graph": {
        const g = readGraph(db);
        audit("success", `entities=${g.entities.length},relations=${g.relations.length}`);
        return ok(g);
      }
      case "search_nodes": {
        const g = searchNodes(db, String(args.query ?? ""));
        audit("success", `query=${String(args.query ?? "")},hits=${g.entities.length}`);
        return ok(g);
      }
      case "open_nodes": {
        const g = openNodes(db, toStringArray(args.names));
        audit("success", `names=${toStringArray(args.names).length}`);
        return ok(g);
      }

      case "create_entities": {
        const res = createEntities(db, (args.entities ?? []) as EntityInput[], ctx, policy);
        auditWrite(res.created.length, res.denied.length);
        return ok({ created: res.created.map((e) => e.name), denied: res.denied });
      }
      case "add_observations": {
        const res = addObservations(db, (args.observations ?? []) as ObservationInput[], ctx, policy);
        auditWrite(res.created.length, res.denied.length);
        return ok(res);
      }
      case "create_relations": {
        const res = createRelations(db, (args.relations ?? []) as RelationInput[], ctx, policy);
        auditWrite(res.created.length, res.denied.length);
        return ok(res);
      }
      case "delete_entities": {
        const res = deleteEntities(db, toStringArray(args.entityNames), ctx, policy);
        if (res.denied) { audit("blocked", res.denied); return fail(res.denied); }
        audit("success", `deleted=${res.deleted.length}`);
        return ok(res);
      }
      case "delete_observations": {
        const deletions = ((args.deletions ?? []) as Array<{ entityName: string; observations: string[] }>).map(
          (d) => ({ entityName: d.entityName, contents: d.observations }),
        );
        const res = deleteObservations(db, deletions, ctx, policy);
        if (res.denied) { audit("blocked", res.denied); return fail(res.denied); }
        audit("success", `deleted=${res.deleted}`);
        return ok(res);
      }
      case "delete_relations": {
        const res = deleteRelations(db, (args.relations ?? []) as RelationInput[], ctx, policy);
        if (res.denied) { audit("blocked", res.denied); return fail(res.denied); }
        audit("success", `deleted=${res.deleted}`);
        return ok(res);
      }

      default:
        return fail("unknown_tool", { tool: name });
    }
  } catch (e) {
    audit("failure", "exception");
    return fail("internal_error", { message: e instanceof Error ? e.message : String(e) });
  }
});

function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

const transport = new StdioServerTransport();
await server.connect(transport);
// eslint-disable-next-line no-console
console.error(`[${SERVER}] governed graph memory ready (role=${principal.role}, tier=${tier}, policy=${policy.version}).`);
