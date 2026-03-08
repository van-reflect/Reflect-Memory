# Reflect Memory MCP Server for Cursor

Connect Cursor to Reflect Memory -- read, write, browse, and search your cross-agent memory without manual API calls.

## Prerequisites

- Node.js 18+
- A Reflect Memory agent key (`RM_AGENT_KEY_CURSOR` from Railway, or use `RM_AGENT_KEY_CLAUDE` for testing)

## Setup

### 1. Install dependencies

```bash
cd integrations/cursor
npm install
```

### 2. Set your API key

Add to your shell profile (`~/.zshrc`, `~/.bashrc`) or create a `.env` in this directory:

```bash
export REFLECT_MEMORY_API_KEY="your-agent-key-here"
# Or: export RM_AGENT_KEY_CURSOR="your-agent-key-here"
```

### 3. Add MCP server to Cursor

**Option A: Via Cursor Settings UI**

1. Open Cursor Settings (Cmd/Ctrl + ,)
2. Go to **Features** → **Model Context Protocol** (or **Tools & MCP**)
3. Click **Add new MCP server**
4. Configure:
   - **Name:** `reflect-memory`
   - **Type:** `stdio`
   - **Command:** `node`
   - **Args:** `["/absolute/path/to/reflective-memory/integrations/cursor/server.mjs"]`

**Option B: Via project config**

Create or edit `.cursor/mcp.json` in your project root (e.g. `reflect-memory-dashboard` or `reflective-memory`):

```json
{
  "mcpServers": {
    "reflect-memory": {
      "command": "node",
      "args": ["/Users/YOUR_USERNAME/Desktop/reflective-memory/integrations/cursor/server.mjs"],
      "env": {
        "REFLECT_MEMORY_API_KEY": "your-agent-key-here"
      }
    }
  }
}
```

Replace the path with your actual path to `server.mjs`. You can put the API key in `env` to avoid exporting it globally.

### 4. Restart Cursor

Restart Cursor completely for the MCP server to load.

## Tools

| Tool | Use when |
|------|----------|
| `get_latest_memory` | "Pull latest memory", "What's the latest from ChatGPT?", "Get most recent" |
| `get_memory_by_id` | You have a memory UUID from browse results |
| `browse_memories` | "List all memories", "What memories do I have?", discovery |
| `get_memories_by_tag` | "Council memories", "Memories tagged project_state" |
| `write_memory` | "Save this to memory", "Write a memory", "Push to Reflect Memory" |

## Usage

Ask Cursor naturally:

- "Pull the latest memory from Reflect Memory"
- "What's my most recent memory?"
- "Browse all my memories"
- "Search memories for authentication"
- "Write this to memory: [your content]"

## Troubleshooting

- **"REFLECT_MEMORY_API_KEY must be set"** -- Add the key to `env` in mcp.json or export it in your shell.
- **401 Unauthorized** -- Wrong or expired agent key. Get `RM_AGENT_KEY_CURSOR` from Railway.
- **Server not showing** -- Restart Cursor fully (quit and reopen).
- **Path issues** -- Use the absolute path to `server.mjs` in your mcp.json args.
