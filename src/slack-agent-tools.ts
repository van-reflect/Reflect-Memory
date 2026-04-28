/**
 * Tool definitions and dispatch for the Slack agent loop.
 *
 * Read-only memory tools only — Phase 3b. Writes (write_memory, etc.) come
 * in Phase 4.
 *
 * Each tool is a thin shim over the existing memory-service / memory-graph /
 * tag-clustering functions, reusing the same auth + validation that MCP and
 * the user-facing API go through. Differences from MCP:
 *  - vendor is hardcoded to "slack" so explicit allowed_vendors restrictions
 *    work consistently.
 *  - results are JSON-stringified text so the model can see them; no MCP
 *    content-block wrapping.
 *  - we cap result sizes aggressively so a chatty tool call doesn't blow
 *    Anthropic's context budget.
 */

import type Database from "better-sqlite3";

import {
  listMemories,
  readMemoryWithTeamAccess,
  listTeamMemories,
  listChildren,
  type MemoryEntry,
} from "./memory-service.js";
import { getGraphAround } from "./memory-graph.js";
import {
  buildMemoryBriefingAsync,
  formatBriefingAsMarkdown,
} from "./memory-briefing.js";

const SLACK_VENDOR = "slack";

// Hard caps so a single tool call can't dominate the LLM context.
const MAX_LIMIT = 25;

export interface AgentToolContext {
  db: Database.Database;
  reflectUserId: string;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface AgentTools {
  definitions: AgentToolDefinition[];
  execute: (toolName: string, input: Record<string, unknown>) => Promise<string>;
}

function clampLimit(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function trimMemoryForLlm(m: MemoryEntry): Record<string, unknown> {
  return {
    id: m.id,
    title: m.title,
    content: m.content,
    tags: m.tags,
    memory_type: m.memory_type,
    created_at: m.created_at,
    updated_at: m.updated_at,
    shared_with_team_id: m.shared_with_team_id ?? null,
    parent_memory_id: m.parent_memory_id ?? null,
  };
}

export function buildAgentTools(ctx: AgentToolContext): AgentTools {
  const { db, reflectUserId } = ctx;

  const definitions: AgentToolDefinition[] = [
    {
      name: "get_memory_briefing",
      description:
        "Get a condensed snapshot of the user's memory state: identity, totals, top tags, active tags this week, open threads, topic clusters, and tagging conventions. Call this FIRST when the user asks an open-ended question (\"what's going on\", \"what did I do this week\", \"summarise X\"). Returns markdown.",
      input_schema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "search_memories",
      description:
        "Full-text search the user's personal memories by case-insensitive substring in title or content. Use for specific questions where you have a keyword. Returns up to 25 most-recent matching memories with full content.",
      input_schema: {
        type: "object",
        properties: {
          term: { type: "string", description: "Search term (1+ chars)" },
          limit: { type: "number", description: "Max results (1-25), default 10" },
        },
        required: ["term"],
      },
    },
    {
      name: "read_memories",
      description:
        "List the user's most-recent personal memories (no search filter). Use to scan recent activity. Returns full content. Prefer search_memories when you have a keyword.",
      input_schema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max results (1-25), default 10" },
        },
      },
    },
    {
      name: "get_memories_by_tag",
      description:
        "List memories tagged with ALL of the given tags. Use to see things in a specific category (e.g. tag='eng', tag='ticket').",
      input_schema: {
        type: "object",
        properties: {
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tag(s) to filter by (AND-ed)",
          },
          limit: { type: "number", description: "Max results (1-25), default 10" },
        },
        required: ["tags"],
      },
    },
    {
      name: "get_memory_by_id",
      description:
        "Fetch a single memory by its UUID. Returns full content. Use after a list/search call when you want to dig into one specific entry.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Memory UUID" },
        },
        required: ["id"],
      },
    },
    {
      name: "read_team_memories",
      description:
        "List memories shared with the user's team (visible to all team members). Use for team context, status updates, decisions.",
      input_schema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max results (1-25), default 10" },
        },
      },
    },
    {
      name: "read_thread",
      description:
        "Read a parent memory plus all its child replies (threaded conversation). Use after seeing a memory referenced as a thread root, or to get the full back-and-forth on a ticket / decision.",
      input_schema: {
        type: "object",
        properties: {
          parent_id: { type: "string", description: "UUID of the thread's root memory" },
        },
        required: ["parent_id"],
      },
    },
    {
      name: "get_graph_around",
      description:
        "Get the local subgraph around a memory: its parent, children, and similar memories (by shared tags). Use to discover related context after finding one relevant entry.",
      input_schema: {
        type: "object",
        properties: {
          memory_id: { type: "string", description: "Memory UUID to center the graph on" },
        },
        required: ["memory_id"],
      },
    },
  ];

  async function execute(name: string, input: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case "get_memory_briefing": {
          const briefing = await buildMemoryBriefingAsync(db, reflectUserId, {
            enableTopicClusters: true,
          });
          return formatBriefingAsMarkdown(briefing);
        }
        case "search_memories": {
          const term = String(input.term ?? "").trim();
          if (!term) return JSON.stringify({ error: "term is required" });
          const limit = clampLimit(input.limit, 10);
          const memories = listMemories(
            db,
            reflectUserId,
            { by: "search", term },
            SLACK_VENDOR,
            { limit },
          );
          return JSON.stringify({
            count: memories.length,
            memories: memories.map(trimMemoryForLlm),
          });
        }
        case "read_memories": {
          const limit = clampLimit(input.limit, 10);
          const memories = listMemories(
            db,
            reflectUserId,
            { by: "all" },
            SLACK_VENDOR,
            { limit },
          );
          return JSON.stringify({
            count: memories.length,
            memories: memories.map(trimMemoryForLlm),
          });
        }
        case "get_memories_by_tag": {
          const tags = Array.isArray(input.tags)
            ? (input.tags as unknown[]).map((t) => String(t)).filter(Boolean)
            : [];
          if (tags.length === 0) return JSON.stringify({ error: "tags is required (non-empty array)" });
          const limit = clampLimit(input.limit, 10);
          const memories = listMemories(
            db,
            reflectUserId,
            { by: "tags", tags },
            SLACK_VENDOR,
            { limit },
          );
          return JSON.stringify({
            count: memories.length,
            memories: memories.map(trimMemoryForLlm),
          });
        }
        case "get_memory_by_id": {
          const id = String(input.id ?? "").trim();
          if (!id) return JSON.stringify({ error: "id is required" });
          const memory = readMemoryWithTeamAccess(db, reflectUserId, id);
          if (!memory || memory.deleted_at) {
            return JSON.stringify({ error: "Memory not found" });
          }
          return JSON.stringify(trimMemoryForLlm(memory));
        }
        case "read_team_memories": {
          const limit = clampLimit(input.limit, 10);
          const teamRow = db
            .prepare(`SELECT team_id FROM users WHERE id = ?`)
            .get(reflectUserId) as { team_id: string | null } | undefined;
          if (!teamRow?.team_id) {
            return JSON.stringify({
              count: 0,
              memories: [],
              note: "User is not on a team — no team-shared memories to read.",
            });
          }
          const memories = listTeamMemories(db, teamRow.team_id, { limit });
          return JSON.stringify({
            count: memories.length,
            memories: memories.map(trimMemoryForLlm),
          });
        }
        case "read_thread": {
          const parentId = String(input.parent_id ?? "").trim();
          if (!parentId) return JSON.stringify({ error: "parent_id is required" });
          const parent = readMemoryWithTeamAccess(db, reflectUserId, parentId);
          if (!parent || parent.deleted_at) {
            return JSON.stringify({ error: "Parent memory not found" });
          }
          const children = listChildren(db, reflectUserId, parentId);
          return JSON.stringify({
            parent: trimMemoryForLlm(parent),
            children: children.map(trimMemoryForLlm),
          });
        }
        case "get_graph_around": {
          const memoryId = String(input.memory_id ?? "").trim();
          if (!memoryId) return JSON.stringify({ error: "memory_id is required" });
          const graph = getGraphAround(db, reflectUserId, memoryId, {
            minSharedTags: 2,
            topTagSimilar: 5,
          });
          if (!graph) return JSON.stringify({ error: "Memory not found" });
          return JSON.stringify(graph);
        }
        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Tool ${name} threw: ${msg}` });
    }
  }

  return { definitions, execute };
}
