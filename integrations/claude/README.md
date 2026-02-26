# Reflect Memory - Claude Integration

Connect Claude to Reflect Memory via the Model Context Protocol (MCP).

## How it works

Reflect Memory runs a remote MCP server alongside the main API. Claude.ai connects to it as a **Connector**, giving Claude native tool access to read, write, browse, and search memories.

## Setup (Claude.ai)

### Prerequisites
- Claude Pro, Max, Team, or Enterprise plan
- A running Reflect Memory instance with `RM_AGENT_KEY_CLAUDE` configured

### Steps

1. **Get your Claude agent key** from your Reflect Memory environment variables (`RM_AGENT_KEY_CLAUDE`).

2. **Open Claude.ai** and go to **Settings > Connectors**.

3. Click **"Add"** to add a custom connector.

4. Enter the MCP server URL:
   ```
   https://api.reflectmemory.com/mcp
   ```

5. In **Advanced settings**, configure authentication:
   - Set the Authorization header to `Bearer <your-claude-agent-key>`

6. Click **"Add custom connector"**.

7. In any chat, click the **"+"** button and enable the **Reflect Memory** connector.

## Available Tools

Once connected, Claude has access to these tools:

| Tool | Description |
|------|-------------|
| `read_memories` | Get recent memories (full content) |
| `get_memory_by_id` | Retrieve a specific memory by UUID |
| `get_latest_memory` | Get the single most recent memory |
| `browse_memories` | Browse memory summaries (lightweight) |
| `search_memories` | Search by text in title or content |
| `get_memories_by_tag` | Get memories filtered by tags |
| `write_memory` | Create a new memory entry |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `RM_AGENT_KEY_CLAUDE` | Agent API key for the Claude vendor (required) |
| `RM_MCP_PORT` | Port for the MCP server (default: 3001) |

## Architecture

The MCP server runs as a separate Express process on port 3001 (configurable), alongside the main Fastify API on port 3000. Both share the same SQLite database and user context. The MCP server authenticates requests using the Claude agent key and enforces the same vendor-scoped access rules as the REST API.
