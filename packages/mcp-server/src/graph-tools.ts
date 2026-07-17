import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Tool catalog for the governed knowledge-graph memory server (`naf-qa-memory`).
 *
 * Deliberately API-compatible with `@modelcontextprotocol/server-memory` so the
 * QA agents keep the same tool names — the difference is that every write here
 * passes through evaluatePolicy (RBAC + PII/credential deny + size guards) and
 * carries tiered retention + a hash-chained audit entry.
 */
export type GraphToolKind = "read" | "write";

export const GRAPH_TOOL_KIND: Record<string, GraphToolKind> = {
  read_graph: "read",
  search_nodes: "read",
  open_nodes: "read",
  create_entities: "write",
  add_observations: "write",
  create_relations: "write",
  delete_entities: "write",
  delete_observations: "write",
  delete_relations: "write",
};

export const READ_TOOLS = new Set(
  Object.entries(GRAPH_TOOL_KIND).filter(([, k]) => k === "read").map(([n]) => n),
);

export const graphTools: Tool[] = [
  {
    name: "create_entities",
    description:
      "Create/refresh graph entities with initial observations. Governed: PII/credentials and oversized (raw-snapshot) observations are rejected pre-save; rows auto-expire per Tier 1 retention.",
    inputSchema: {
      type: "object",
      properties: {
        entities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              entityType: { type: "string" },
              observations: { type: "array", items: { type: "string" } },
            },
            required: ["name", "entityType"],
          },
        },
      },
      required: ["entities"],
    },
  },
  {
    name: "add_observations",
    description: "Append observations to existing entities (deduped). Same pre-save governance as create_entities.",
    inputSchema: {
      type: "object",
      properties: {
        observations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              entityName: { type: "string" },
              contents: { type: "array", items: { type: "string" } },
            },
            required: ["entityName", "contents"],
          },
        },
      },
      required: ["observations"],
    },
  },
  {
    name: "create_relations",
    description: "Create relations between existing entities (deduped). Both endpoints must already exist.",
    inputSchema: {
      type: "object",
      properties: {
        relations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              relationType: { type: "string" },
            },
            required: ["from", "to", "relationType"],
          },
        },
      },
      required: ["relations"],
    },
  },
  {
    name: "delete_entities",
    description: "Delete entities by name (cascades to their observations and relations).",
    inputSchema: {
      type: "object",
      properties: { entityNames: { type: "array", items: { type: "string" } } },
      required: ["entityNames"],
    },
  },
  {
    name: "delete_observations",
    description: "Delete specific observations from entities.",
    inputSchema: {
      type: "object",
      properties: {
        deletions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              entityName: { type: "string" },
              observations: { type: "array", items: { type: "string" } },
            },
            required: ["entityName", "observations"],
          },
        },
      },
      required: ["deletions"],
    },
  },
  {
    name: "delete_relations",
    description: "Delete specific relations.",
    inputSchema: {
      type: "object",
      properties: {
        relations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              relationType: { type: "string" },
            },
            required: ["from", "to", "relationType"],
          },
        },
      },
      required: ["relations"],
    },
  },
  {
    name: "read_graph",
    description: "Return the entire live graph (expired rows excluded).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_nodes",
    description: "Search entities by name, type, or observation text; returns the matching subgraph.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "open_nodes",
    description: "Return the subgraph for the named entities (and relations among them).",
    inputSchema: {
      type: "object",
      properties: { names: { type: "array", items: { type: "string" } } },
      required: ["names"],
    },
  },
];
