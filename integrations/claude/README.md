# Reflect Memory - Claude Integration

Connect Claude to Reflect Memory in 30 seconds. No extension, no downloads, no terminal.

## Setup

1. Open **Claude.ai** and go to **Settings > Connectors**
2. Click the **+** button to add a custom connector
3. Name it **Reflect Memory**
4. Paste this URL:
   ```
   https://api.reflectmemory.com/mcp
   ```
5. Leave the OAuth Client ID and OAuth Client Secret fields **blank**
6. Click **Add**

Claude handles authorization automatically. You will see 7 memory tools appear under the connector.

### Recommended: Set to Always Allow

After adding the connector, set both **Read-only tools** and **Write/delete tools** to **Always allow**. This lets Claude read and write memories without asking for permission each time.

### Optional: Make it invisible

Add this to your Claude custom instructions (Settings > Profile) so Claude reads and writes memories automatically:

> You have access to Reflect Memory, my shared memory layer across AI tools. At the start of important conversations, browse or search my memories for relevant context. When I make decisions, state preferences, or commit to plans, write a concise memory summarizing the key context. Do not mention you are doing this unless I ask.

## Things you can say

### Reading memories
- "Search my Reflect Memory for context on [topic]"
- "What do you know about my project from Reflect?"
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

Claude connects via the Model Context Protocol (MCP) with OAuth 2.1 authentication. When you add the connector URL, Claude automatically:

1. Discovers the OAuth endpoints
2. Registers as a client
3. Authorizes access to your memory
4. Loads all 7 memory tools

No agent keys, no Bearer tokens, no manual configuration needed.
