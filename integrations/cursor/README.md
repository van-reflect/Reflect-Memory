# Reflect Memory — Cursor Integration

Give Cursor persistent memory across sessions. Your coding AI remembers your project context, architecture decisions, and preferences.

## Setup (2 minutes)

### Option A: Paste a config file (recommended)

Create or edit `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "reflect-memory": {
      "url": "https://api.reflectmemory.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_AGENT_KEY"
      }
    }
  }
}
```

Replace `YOUR_AGENT_KEY` with your Cursor agent key from [reflectmemory.com/dashboard](https://reflectmemory.com/dashboard) (API Keys section).

Restart Cursor. Done. It discovers all 7 memory tools automatically.

### Option B: Use Cursor Settings UI

1. Open **Cursor Settings** (Cmd+, or Ctrl+,)
2. Go to **MCP** (under Features or Tools)
3. Click **+ Add new MCP server**
4. Set type to **streamableHttp**
5. Paste the URL: `https://api.reflectmemory.com/mcp`
6. Add a header: `Authorization` = `Bearer YOUR_AGENT_KEY`
7. Click **Save**

## What you can say to Cursor

**Read memories:**
- "Pull my latest memory from Reflect"
- "What does Reflect Memory know about this project?"
- "Search my Reflect Memory for authentication"
- "Browse my recent memories"
- "Check Reflect for context on [topic]"

**Write memories:**
- "Save this decision to Reflect Memory"
- "Write this to Reflect: we chose PostgreSQL over MySQL for [reason]"
- "Remember this for my other AI tools"
- "Save this memory"

## Pro tip: Add a Cursor Rule

Create `.cursor/rules/reflect-memory.mdc` so Cursor uses your memory automatically:

```
You have access to Reflect Memory, a shared memory layer across AI tools.
At the start of complex tasks, search memories for relevant project context,
decisions, and preferences. When the user makes architectural decisions or
commits to plans, write a concise memory. Do not mention you are doing this
unless asked.
```

## Tools available (7)

| Tool | Description |
|------|-------------|
| `read_memories` | Get recent memories |
| `get_memory_by_id` | Full memory by UUID |
| `get_latest_memory` | Most recent memory, optional tag filter |
| `browse_memories` | List memory summaries |
| `search_memories` | Search by keyword |
| `get_memories_by_tag` | Filter by tags |
| `write_memory` | Create a new memory |

## Troubleshooting

- **Tools not showing** — Restart Cursor completely (quit and reopen). Check that `.cursor/mcp.json` is valid JSON.
- **401 Unauthorized** — Wrong or expired agent key. Generate a new one from your [dashboard](https://reflectmemory.com/dashboard).
- **Connection failed** — Make sure the URL is exactly `https://api.reflectmemory.com/mcp` with no trailing slash.

## Advanced: Local server (optional)

If you prefer running a local MCP server instead of the remote one:

```json
{
  "mcpServers": {
    "reflect-memory": {
      "command": "node",
      "args": ["/path/to/reflective-memory/integrations/cursor/server.mjs"],
      "env": {
        "REFLECT_MEMORY_API_KEY": "your-agent-key-here"
      }
    }
  }
}
```
