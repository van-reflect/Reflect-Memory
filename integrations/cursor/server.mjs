#!/usr/bin/env node
/**
 * Reflect Memory MCP Server for Cursor
 *
 * Exposes Read, Write, Browse, and Search tools for the Reflect Memory API.
 * Set REFLECT_MEMORY_API_KEY (or RM_AGENT_KEY_CURSOR) in your environment.
 *
 * Configure in Cursor: Settings → Tools & MCP → Add new MCP server
 * Or add to .cursor/mcp.json in your project root.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
const API_BASE =
  process.env.REFLECT_MEMORY_API_URL || "https://api.reflectmemory.com";
const API_KEY =
  process.env.REFLECT_MEMORY_API_KEY || process.env.RM_AGENT_KEY_CURSOR;

function getApiKey() {
  if (!API_KEY?.trim()) {
    throw new Error(
      "REFLECT_MEMORY_API_KEY or RM_AGENT_KEY_CURSOR must be set. Add it to your environment or .env file."
    );
  }
  return API_KEY.trim();
}

async function fetchApi(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${getApiKey()}`,
    ...options.headers,
  };
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data.error || data.message || `API error ${res.status}`;
    throw new Error(err);
  }
  return data;
}

const server = new Server(
  {
    name: "reflect-memory",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_latest_memory",
      description:
        "Get the most recent memory from Reflect Memory. Supports optional tag filter (e.g. project_state, council). Use for 'pull latest', 'what's the latest memory', 'get latest from ChatGPT' (origin is set server-side).",
      inputSchema: {
        type: "object",
        properties: {
          tag: {
            type: "string",
            description: "Optional filter by tag (e.g. project_state, council). Leave empty for latest overall.",
          },
        },
      },
    },
    {
      name: "get_memory_by_id",
      description: "Get a single memory by its UUID. Use when you have an ID from browse results.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The memory UUID",
          },
        },
        required: ["id"],
      },
    },
    {
      name: "browse_memories",
      description:
        "Browse memory summaries (title, tags, origin, date) without full content. Use for 'list all memories', 'what memories do I have', discovery. Supports pagination and search.",
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            enum: ["all", "tags", "search"],
            description: "all=all memories, tags=filter by tags, search=text search",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Required if filter=tags. E.g. ['project_state','council']",
          },
          term: {
            type: "string",
            description: "Required if filter=search. Search term for title/content.",
          },
          limit: {
            type: "number",
            description: "Max memories to return. Default 50.",
          },
        },
      },
    },
    {
      name: "get_memories_by_tag",
      description:
        "Get full memory bodies by tags. Returns complete content. Use for 'council memories', 'memories tagged X', topic-based retrieval.",
      inputSchema: {
        type: "object",
        properties: {
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags to filter by. Returns memories matching ANY of these.",
          },
          limit: {
            type: "number",
            description: "Max memories. Default 20.",
          },
        },
        required: ["tags"],
      },
    },
    {
      name: "write_memory",
      description:
        "Write a new memory to Reflect Memory. Use allowed_vendors: ['*'] for cross-agent visibility.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short descriptor. Format: 'Topic - Summary'",
          },
          content: {
            type: "string",
            description: "Structured content. Use Change/Reason/Impact/Open Questions format when appropriate.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Relevant tags. Include project_state, architecture when applicable.",
          },
          allowed_vendors: {
            type: "array",
            items: { type: "string" },
            description: "Use ['*'] for all agents. Default: ['*']",
          },
        },
        required: ["title", "content", "tags"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "get_latest_memory": {
        const tag = args?.tag ? `?tag=${encodeURIComponent(args.tag)}` : "";
        const data = await fetchApi(`/agent/memories/latest${tag}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case "get_memory_by_id": {
        const id = args?.id;
        if (!id) throw new Error("id is required");
        const data = await fetchApi(`/agent/memories/${id}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case "browse_memories": {
        const filterType = args?.filter || "all";
        let filter = { by: filterType };
        if (filterType === "tags" && args?.tags?.length) {
          filter.tags = args.tags;
        } else if (filterType === "search" && args?.term) {
          filter = { by: "search", term: args.term };
        }
        const limit = args?.limit ?? 50;
        const data = await fetchApi("/agent/memories/browse", {
          method: "POST",
          body: JSON.stringify({ filter, limit }),
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case "get_memories_by_tag": {
        const tags = args?.tags;
        if (!tags?.length) throw new Error("tags array is required");
        const limit = args?.limit ?? 20;
        const data = await fetchApi("/agent/memories/by-tag", {
          method: "POST",
          body: JSON.stringify({ tags, limit }),
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case "write_memory": {
        const { title, content, tags } = args || {};
        if (!title || !content || !tags?.length) {
          throw new Error("title, content, and tags are required");
        }
        const allowed_vendors = args?.allowed_vendors ?? ["*"];
        const data = await fetchApi("/agent/memories", {
          method: "POST",
          body: JSON.stringify({
            title,
            content,
            tags,
            allowed_vendors,
          }),
        });
        return {
          content: [
            {
              type: "text",
              text: `Memory created: ${data.id}\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${err.message}`,
        },
      ],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
