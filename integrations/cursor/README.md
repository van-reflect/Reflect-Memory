# Reflect Memory — Cursor Integration

Give Cursor persistent memory across sessions. Your coding AI remembers your project context, architecture decisions, and preferences.

## Setup (2 minutes)

### Option A: Paste a config file (recommended)

Create or edit `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "reflect-memory": {
      "type": "streamable-http",
      "url": "https://api.reflectmemory.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_AGENT_KEY"
      }
    }
  }
}
```

Replace `YOUR_AGENT_KEY` with your Cursor agent key from [reflectmemory.com/dashboard](https://reflectmemory.com/dashboard) (API Keys section).

Restart Cursor. Done. It discovers all 9 memory tools automatically.

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

## Tools available (9)

| Tool | Description |
|------|-------------|
| `read_memories` | Get recent memories |
| `get_memory_by_id` | Full memory by UUID |
| `get_latest_memory` | Most recent memory, optional tag filter |
| `browse_memories` | List memory summaries |
| `search_memories` | Search by keyword |
| `get_memories_by_tag` | Filter by tags |
| `write_memory` | Create a new memory |
| `read_team_memories` | Get memories shared with your team |
| `share_memory` | Share a personal memory with your team |

## Troubleshooting

- **503 / 404 / Connection failed** — Make sure your config includes `"type": "streamable-http"`. Without it, Cursor defaults to the old SSE protocol which our server does not support.
- **Tools not showing** — Restart Cursor completely (quit and reopen). Check that `.cursor/mcp.json` is valid JSON.
- **401 Unauthorized** — Wrong or expired agent key. Generate a new one from your [dashboard](https://reflectmemory.com/dashboard).
- **URL** — Must be exactly `https://api.reflectmemory.com/mcp` with no trailing slash.

## Self-Hosted / Private Deploy

If you're running Reflect Memory locally via Docker Compose, point Cursor at your local instance:

```json
{
  "mcpServers": {
    "reflect-memory": {
      "type": "streamable-http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_RM_AGENT_KEY_CURSOR"
      }
    }
  }
}
```

### Requirements

1. At least one `RM_AGENT_KEY_*` env var must be set in your `.env` — this tells the server to start the MCP endpoint. Without it, `/mcp` returns 404.

2. The Bearer token must be the value of `RM_AGENT_KEY_CURSOR` (or whichever agent key you set), **not** `RM_API_KEY`. The MCP endpoint uses a separate auth system from the REST API.

3. `type` must be `"streamable-http"`. Without it, Cursor defaults to SSE which is not supported.

### Example `.env` for local Docker

```bash
RM_API_KEY=your-api-key
RM_MODEL_API_KEY=sk-...
RM_MODEL_NAME=gpt-4o-mini
RM_AGENT_KEY_CURSOR=my-cursor-secret
```

```bash
docker compose --profile isolated-hosted up --build -d
```

### Team memories in self-hosted mode

Team tools (`read_team_memories`, `share_memory`) work the same way in self-hosted mode. Create a team via the REST API:

```bash
curl -s -X POST http://localhost:3000/teams \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Team"}' | jq
```

Once your user belongs to a team, the MCP tools appear automatically in Cursor.
