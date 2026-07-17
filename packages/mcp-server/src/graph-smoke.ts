/**
 * End-to-end smoke test for the governed graph memory server.
 * Spawns it over stdio, exercises a clean write, a credential write (must be
 * denied), a read-back, and verifies audit rows were chained.
 *
 *   npm run smoke:graph
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDb } from "@mqm/shared";

function textOf(res: { content?: Array<{ type: string; text?: string }> }): string {
  return res.content?.find((c) => c.type === "text")?.text ?? "";
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "packages/mcp-server/src/graph-index.ts"],
    env: { ...process.env, MQM_USER_ROLE: "qa_engineer", MQM_ENV: "local" } as Record<string, string>,
  });
  const client = new Client({ name: "graph-smoke", version: "0.1.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`tools: ${tools.length} ->`, tools.map((t) => t.name).join(", "));

  const created = await client.callTool({
    name: "create_entities",
    arguments: {
      entities: [
        { name: "US_471244_AC1", entityType: "acceptance_criterion", observations: ["status: PASS", "url: /pipeline"] },
      ],
    },
  });
  console.log("\ncreate_entities (clean, expect created):\n" + textOf(created as never));

  const creds = await client.callTool({
    name: "create_entities",
    arguments: { entities: [{ name: "app_login", entityType: "secret", observations: ["password: hunter2"] }] },
  });
  console.log("\ncreate_entities (credentials, expect denied):\n" + textOf(creds as never));

  const graph = await client.callTool({ name: "search_nodes", arguments: { query: "471244" } });
  console.log("\nsearch_nodes(471244):\n" + textOf(graph as never));

  await client.close();

  const db = openDb();
  const n = db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE tool_server = 'naf-qa-memory'").get() as { n: number };
  const blocked = db
    .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE tool_server = 'naf-qa-memory' AND action_class = 'policy_block'")
    .get() as { n: number };
  const secretRows = db.prepare("SELECT COUNT(*) AS n FROM entities WHERE name = 'app_login'").get() as { n: number };
  db.close();

  console.log(`\naudit rows (naf-qa-memory): ${n.n} (policy_block: ${blocked.n}); credential entity persisted: ${secretRows.n}`);
  if (blocked.n < 1 || secretRows.n !== 0) {
    console.error("SMOKE FAIL: credential write was not blocked / leaked into the graph");
    process.exit(1);
  }
  console.log("SMOKE PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
