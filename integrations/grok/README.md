# Reflect Memory - Grok Integration

Connect Grok (x.ai) to Reflect Memory via the Model Context Protocol (MCP).

## How it works

Grok supports **Remote MCP Tools** via Streaming HTTP. Reflect Memory runs a
multi-vendor MCP server alongside the main API. Grok connects to it as a Remote
MCP Tool, giving it native access to read, write, browse, and search memories.

No Grok-specific code is needed -- Grok uses the same MCP server and protocol as
Claude and any other MCP-compatible client.

## Environment Variable

Add a Grok-scoped agent key to your Reflect Memory environment:

```
RM_AGENT_KEY_GROK=<your-grok-agent-key>
```

The backend discovers it automatically via the `RM_AGENT_KEY_*` pattern and
registers vendor `"grok"`. All memories written through this key are tagged with
`origin: "grok"`.

## Setup (Grok / x.ai)

### Prerequisites

- A Grok account with access to Remote MCP Tools
- A running Reflect Memory instance with `RM_AGENT_KEY_GROK` configured

### Steps

1. **Generate your Grok agent key** and add it to your Reflect Memory
   environment as `RM_AGENT_KEY_GROK`. Restart the backend.

2. **Open Grok** and navigate to the Remote MCP Tools configuration.

3. **Add a new Remote MCP Tool** with the following settings:

   | Field | Value |
   |-------|-------|
   | URL | `https://api.reflectmemory.com/mcp` |
   | Transport | Streaming HTTP |
   | Authentication | Bearer Token |
   | Token | Your `RM_AGENT_KEY_GROK` value |

4. **Save** the configuration. Grok will discover the available tools
   automatically via the MCP `initialize` → `tools/list` handshake.

## Available Tools

Once connected, Grok has access to these tools:

| Tool | Description |
|------|-------------|
| `read_memories` | Get recent memories (full content) |
| `get_memory_by_id` | Retrieve a specific memory by UUID |
| `get_latest_memory` | Get the single most recent memory |
| `browse_memories` | Browse memory summaries (lightweight) |
| `search_memories` | Search by text in title or content |
| `get_memories_by_tag` | Get memories filtered by tags |
| `write_memory` | Create a new memory entry |

## Architecture

Grok connects to the same multi-vendor MCP server that Claude uses. The server
resolves the calling vendor from the Bearer token -- each `RM_AGENT_KEY_*`
maps to a vendor name. This means:

- Memories written by Grok have `origin: "grok"`
- Vendor-scoped access rules apply (memories with `allowed_vendors: ["*"]` are
  visible to all; restricted memories are only visible to their allowed vendors)
- No Grok-specific server code is needed

```
Grok ──[Streaming HTTP]──> https://api.reflectmemory.com/mcp
                                      │
                              ┌───────┴───────┐
                              │  MCP Server   │
                              │  (multi-vendor)│
                              └───────┬───────┘
                                      │
                              ┌───────┴───────┐
                              │   SQLite DB   │
                              └───────────────┘
```

## Alternative: Function Calling

If you are building a custom application with the xAI API (not using Grok's
built-in MCP support), you can use xAI's function calling feature to integrate
with Reflect Memory's REST API directly. The pattern is the same as the Gemini
function-calling example in `../gemini/function-calling-example.ts` -- define
tool schemas, let the model call them, and execute the corresponding HTTP
requests against the `/agent/*` endpoints.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `RM_AGENT_KEY_GROK` | Agent API key for the Grok vendor (required) |
| `RM_MCP_PORT` | Port for the MCP server (default: 3001) |
