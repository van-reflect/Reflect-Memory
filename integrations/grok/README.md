# Reflect Memory - Grok Integration

Connect Grok to Reflect Memory via remote MCP tools. Grok discovers all 7 memory tools automatically.

## Setup

1. Go to **grok.com** and open **Settings**
2. Find **Remote MCP Tools** and add a new tool
3. Paste this URL:
   ```
   https://api.reflectmemory.com/mcp
   ```
4. Set authentication to **Bearer token** and paste your Grok agent key
5. Save

Grok discovers all 7 memory tools automatically via the MCP handshake. No additional configuration needed.

## Where to get your agent key

1. Log in to your Reflect Memory dashboard
2. Go to **API Keys**
3. Create a new agent key with vendor set to **grok**
4. Copy the key and paste it as the Bearer token in Grok

## Things you can say

### Reading memories
- "Search my Reflect Memory for context on [topic]"
- "What do you know about me from Reflect?"
- "Pull the latest memory from Reflect"
- "What's the memory from Reflect I have about [topic]?"
- "Browse my recent memories"
- "Check Reflect for context on [topic]"

### Writing memories
- "Save this to Reflect Memory"
- "Write this memory for Reflect"
- "Reflect this memory"
- "Save this memory"
- "Write this memory"
- "Remember this for my other AI tools"

## Available Tools

| Tool | What it does |
|------|-------------|
| `read_memories` | Get recent memories (full content) |
| `get_memory_by_id` | Retrieve a specific memory by UUID |
| `get_latest_memory` | Get the single most recent memory |
| `browse_memories` | Browse memory summaries (lightweight) |
| `search_memories` | Search by text in title or content |
| `get_memories_by_tag` | Get memories filtered by tags |
| `write_memory` | Create a new memory entry |

## How it works

Grok connects to the same multi-vendor MCP server that Claude and Cursor use. The server resolves the calling vendor from the Bearer token. Memories written by Grok have `origin: "grok"` and are visible to all your connected AI tools.

## Self-hosted / environment variable

If you are self-hosting Reflect Memory, add a Grok-scoped agent key:

```
RM_AGENT_KEY_GROK=<your-grok-agent-key>
```

The backend auto-discovers any `RM_AGENT_KEY_*` env var and registers the vendor on startup.
