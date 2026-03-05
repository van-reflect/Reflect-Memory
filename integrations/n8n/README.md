# Reflect Memory - n8n Integration

Two ways to connect n8n to Reflect Memory: a **community node** with a
purpose-built UI, or n8n's built-in **MCP Client Tool** for AI Agent workflows.

## Environment Variable

Add an n8n-scoped agent key to your Reflect Memory environment:

```
RM_AGENT_KEY_N8N=<your-n8n-agent-key>
```

---

## Option 1: Community Node (Recommended)

The `n8n-nodes-reflect-memory` package provides a dedicated Reflect Memory node
with operation dropdowns, typed fields, and built-in credential management.

### Install

In your n8n instance, go to **Settings > Community Nodes** and install:

```
n8n-nodes-reflect-memory
```

Or install via npm in a self-hosted instance:

```bash
cd ~/.n8n
npm install n8n-nodes-reflect-memory
```

### Configure Credentials

1. In n8n, go to **Credentials > Add Credential**
2. Search for **Reflect Memory API**
3. Enter your API key (`RM_AGENT_KEY_N8N` value)
4. Optionally change the Base URL (default: `https://api.reflectmemory.com`)
5. Save

### Operations

| Operation | Description |
|-----------|-------------|
| **Get Latest** | Get the most recent memory (optional tag filter) |
| **Get by ID** | Retrieve a specific memory by UUID |
| **Browse** | Browse memory summaries with pagination |
| **Get by Tag** | Get memories matching any of the given tags |
| **Write** | Create a new memory with title, content, and tags |

### Example Workflow

1. **Trigger** (e.g., Webhook, Schedule)
2. **Reflect Memory** node → Browse memories
3. **IF** node → Check if a specific tag exists
4. **Reflect Memory** node → Write a new memory with results

---

## Option 2: MCP Client Tool (AI Agent Workflows)

n8n has a built-in **MCP Client Tool** node that can connect directly to Reflect
Memory's MCP server. This is ideal for AI Agent workflows where you want the
agent to decide when to read/write memories.

### Setup

1. Add an **AI Agent** node to your workflow
2. Add an **MCP Client Tool** sub-node connected to the agent
3. Configure the MCP Client Tool:

   | Field | Value |
   |-------|-------|
   | SSE Endpoint | `https://api.reflectmemory.com/mcp` |
   | Authentication | Header Auth |
   | Header Name | `Authorization` |
   | Header Value | `Bearer <your-RM_AGENT_KEY_N8N>` |

4. Set **Tools to Include** to "All" (or select specific tools)

The agent will automatically discover all 7 Reflect Memory tools:
`read_memories`, `get_memory_by_id`, `get_latest_memory`, `browse_memories`,
`search_memories`, `get_memories_by_tag`, `write_memory`.

### When to use MCP Client Tool vs Community Node

| | Community Node | MCP Client Tool |
|---|---|---|
| **Best for** | Deterministic workflows | AI Agent workflows |
| **Control** | You choose the operation | Agent decides |
| **Setup** | Install package + credentials | Point at MCP URL |
| **Operations** | 5 (REST-based) | 7 (MCP tools) |

---

## Development

The community node source is in `n8n-nodes-reflect-memory/`.

```bash
cd n8n-nodes-reflect-memory
npm install
npm run build
```

### Local Testing

```bash
# Link the node for local n8n development
cd n8n-nodes-reflect-memory
npm link
cd ~/.n8n
npm link n8n-nodes-reflect-memory
# Restart n8n
```

### Publishing

```bash
cd n8n-nodes-reflect-memory
npm publish
```

To submit for n8n community verification, see
[n8n docs](https://docs.n8n.io/integrations/creating-nodes/deploy/submit-community-nodes/).
