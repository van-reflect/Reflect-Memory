# Reflect Memory

[![npm: reflect-memory-sdk](https://img.shields.io/npm/dm/reflect-memory-sdk?label=reflect-memory-sdk&color=blue)](https://www.npmjs.com/package/reflect-memory-sdk)
[![npm: reflect-memory-mcp](https://img.shields.io/npm/dm/reflect-memory-mcp?label=reflect-memory-mcp&color=blue)](https://www.npmjs.com/package/reflect-memory-mcp)
[![npm: n8n-nodes-reflect-memory](https://img.shields.io/npm/dm/n8n-nodes-reflect-memory?label=n8n-nodes-reflect-memory&color=blue)](https://www.npmjs.com/package/n8n-nodes-reflect-memory)
[![GitHub stars](https://img.shields.io/github/stars/van-reflect/Reflect-Memory?style=social)](https://github.com/van-reflect/Reflect-Memory)

Privacy-first AI memory system. All memory is explicitly user-authored, structured, editable, and deletable. The AI model is stateless -- it sees only what you choose to show it.

## Requirements

- Node.js >= 20.0.0 (LTS)
- An OpenAI-compatible API key (OpenAI, local model via ollama, etc.)

## Setup

```bash
npm install
```

## Environment Variables

Required:

```bash
export RM_API_KEY="your-secret-api-key"        # User key -- full access to all endpoints
export RM_MODEL_API_KEY="sk-..."               # Your OpenAI (or compatible) API key
export RM_MODEL_NAME="gpt-4o-mini"             # Model identifier
```

Optional:

```bash
export RM_PORT=3000                            # HTTP port (default: 3000)
export RM_DB_PATH="/data/reflect-memory.db"     # SQLite file path (default on Railway)
export RM_MODEL_BASE_URL="https://api.openai.com/v1"  # Model API base URL
export RM_MODEL_TEMPERATURE=0.7                # Temperature (default: 0.7)
export RM_MODEL_MAX_TOKENS=1024                # Max tokens (default: 1024)
export RM_SYSTEM_PROMPT="Your custom prompt"   # System prompt for AI queries
```

Agent keys (per-vendor, optional):

```bash
export RM_AGENT_KEY_CHATGPT="agent-key-for-chatgpt"   # Registers vendor "chatgpt"
export RM_AGENT_KEY_CLAUDE="agent-key-for-claude"      # Registers vendor "claude"
# RM_AGENT_KEY_<NAME> -- any env var matching this pattern registers a vendor
```

Dashboard multi-user auth (required for dashboard deployment):

```bash
export RM_DASHBOARD_SERVICE_KEY="..."   # Shared with dashboard. Generate: openssl rand -hex 32
export RM_DASHBOARD_JWT_SECRET="..."    # Must match dashboard AUTH_SECRET. Same value for JWT verification.
```

Multi-vendor chat (dashboard Chat tab -- enables GPT, Claude, Gemini, Perplexity, Grok):

```bash
export RM_CHAT_OPENAI_KEY="sk-..."        # Defaults to RM_MODEL_API_KEY if omitted
export RM_CHAT_ANTHROPIC_KEY="sk-ant-..." # Claude (console.anthropic.com)
export RM_CHAT_GOOGLE_KEY="..."           # Gemini (aistudio.google.com)
export RM_CHAT_PERPLEXITY_KEY="..."       # Perplexity (perplexity.ai/settings/api)
export RM_CHAT_XAI_KEY="..."             # Grok (x.ai)
```

Each agent key gives the vendor scoped access:
- Can write memories via `POST /agent/memories`
- Can query via `POST /query` (sees only memories with `allowed_vendors` containing `"*"` or their vendor name)
- Can check identity via `GET /whoami`
- Cannot access user endpoints (`POST /memories`, `GET /memories/:id`, `PUT /memories/:id`, `DELETE /memories/:id`, `POST /memories/list`)

## Run

Development (with hot reload via tsx):

```bash
npm run dev
```

Production:

```bash
npm run build
npm start
```

## API

All requests (except `/health`) require the `Authorization` header:

```
Authorization: Bearer your-secret-api-key
```

### Health check (no auth required)

```bash
curl -s https://api.reflectmemory.com/health | jq
```

### Who am I? (identity debugging)

```bash
curl -s https://api.reflectmemory.com/whoami \
  -H "Authorization: Bearer your-secret-api-key" | jq
```

Response:

```json
{ "role": "user", "vendor": null }
```

With an agent key:

```json
{ "role": "agent", "vendor": "chatgpt" }
```

### Create a memory (user path)

```bash
curl -s -X POST http://localhost:3000/memories \
  -H "Authorization: Bearer your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Project deadline",
    "content": "The API migration must be completed by end of Q3 2026.",
    "tags": ["work", "deadlines"]
  }' | jq
```

`allowed_vendors` is optional for user writes. If omitted, defaults to `["*"]` (all vendors can see it). To restrict:

```bash
curl -s -X POST http://localhost:3000/memories \
  -H "Authorization: Bearer your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Private note",
    "content": "Only Claude should see this.",
    "tags": ["private"],
    "allowed_vendors": ["claude"]
  }' | jq
```

### Create a memory (agent path)

Agents must use `POST /agent/memories`. The `origin` field is set server-side from the agent's key -- it cannot be self-reported. `allowed_vendors` is required.

```bash
curl -s -X POST http://localhost:3000/agent/memories \
  -H "Authorization: Bearer agent-key-for-chatgpt" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "ChatGPT learned this",
    "content": "User prefers bullet points over paragraphs.",
    "tags": ["preference"],
    "allowed_vendors": ["chatgpt"]
  }' | jq
```

Response (201):

```json
{
  "id": "a1b2c3d4-...",
  "user_id": "...",
  "title": "ChatGPT learned this",
  "content": "User prefers bullet points over paragraphs.",
  "tags": ["preference"],
  "origin": "chatgpt",
  "allowed_vendors": ["chatgpt"],
  "created_at": "2026-02-08T...",
  "updated_at": "2026-02-08T..."
}
```

### Read a memory by ID

```bash
curl -s http://localhost:3000/memories/MEMORY_ID \
  -H "Authorization: Bearer your-secret-api-key" | jq
```

### List memories (explicit filter required)

All memories:

```bash
curl -s -X POST http://localhost:3000/memories/list \
  -H "Authorization: Bearer your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{ "filter": { "by": "all" } }' | jq
```

By tags:

```bash
curl -s -X POST http://localhost:3000/memories/list \
  -H "Authorization: Bearer your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{ "filter": { "by": "tags", "tags": ["work"] } }' | jq
```

### Update a memory (full replacement)

Now requires `allowed_vendors` in the body (full replacement -- all fields required).

```bash
curl -s -X PUT http://localhost:3000/memories/MEMORY_ID \
  -H "Authorization: Bearer your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Project deadline (revised)",
    "content": "The API migration deadline has been extended to Q4 2026.",
    "tags": ["work", "deadlines", "revised"],
    "allowed_vendors": ["*"]
  }' | jq
```

### Delete a memory

```bash
curl -s -X DELETE http://localhost:3000/memories/MEMORY_ID \
  -H "Authorization: Bearer your-secret-api-key" -w "\nHTTP %{http_code}\n"
```

Returns `204 No Content` on success. The row is gone.

### Query the AI (with memory context)

User key sees all memories matching the filter:

```bash
curl -s -X POST http://localhost:3000/query \
  -H "Authorization: Bearer your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "When is the API migration deadline?",
    "memory_filter": { "by": "tags", "tags": ["deadlines"] }
  }' | jq
```

Agent key sees only memories where `allowed_vendors` contains `"*"` or the agent's vendor name:

```bash
curl -s -X POST http://localhost:3000/query \
  -H "Authorization: Bearer agent-key-for-chatgpt" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What are the user preferences?",
    "memory_filter": { "by": "all" }
  }' | jq
```

The `vendor_filter` field in the receipt shows which vendor filter was applied (`null` for users, vendor name for agents).

## MCP Server

Reflect Memory includes a built-in MCP (Model Context Protocol) server for native integration with Claude, Cursor, and other MCP-compatible tools.

**Endpoint:** `/mcp` (proxied through the main API — single port, no extra config)

**Transport:** Streamable HTTP (MCP clients must use `streamable-http` / `streamableHttp`)

**Enabling MCP:** Set at least one agent key environment variable. Agent keys serve double duty: they tell the server to start the MCP endpoint *and* authenticate requests against it.

```bash
export RM_AGENT_KEY_CURSOR="your-cursor-key"
export RM_AGENT_KEY_CLAUDE="your-claude-key"
```

Without any `RM_AGENT_KEY_*` variables set, the `/mcp` endpoint returns 404.

**Cursor** — create `.cursor/mcp.json` in your project:

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

**Claude** — go to Claude.ai Settings > Connectors, click +, paste `https://api.reflectmemory.com/mcp`. Claude handles OAuth automatically.

**Tools (9):** `read_memories`, `get_memory_by_id`, `get_latest_memory`, `browse_memories`, `search_memories`, `get_memories_by_tag`, `write_memory`, `read_team_memories`, `share_memory`.

See `integrations/cursor/README.md` and `integrations/claude/README.md` for detailed setup guides.

## Team Memories

Team Memories let multiple users share context through a shared pool. Any team member can share personal memories with the team, and all members can read them from any connected tool.

```bash
# Create a team
curl -s -X POST http://localhost:3000/teams \
  -H "Authorization: Bearer your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Team"}' | jq

# Invite a member
curl -s -X POST http://localhost:3000/teams/TEAM_ID/invite \
  -H "Authorization: Bearer your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{"email": "teammate@example.com"}' | jq
```

Team tools (`read_team_memories`, `share_memory`) are available in all MCP clients once the user belongs to a team. The team API endpoints (`/teams`, `/teams/:id/invite`, etc.) use standard Bearer token auth.

## Docker Quick Start (Private Deploy)

Run Reflect Memory locally with Docker Compose. Data stays on your machine.

1. Clone the repo and create a `.env` file:

```bash
git clone https://github.com/van-reflect/Reflect-Memory.git
cd Reflect-Memory
```

```bash
# .env
RM_API_KEY=your-api-key
RM_MODEL_API_KEY=sk-...
RM_MODEL_NAME=gpt-4o-mini

# MCP — at least one agent key is required to enable /mcp
RM_AGENT_KEY_CURSOR=pick-any-strong-secret
RM_AGENT_KEY_CLAUDE=pick-any-strong-secret
```

2. Build and start:

```bash
docker compose --profile isolated-hosted up --build -d
```

3. Verify:

```bash
curl -s http://localhost:3000/health | jq
# → { "service": "reflect-memory", "status": "ok", ... }

curl -s http://localhost:3000/whoami \
  -H "Authorization: Bearer your-api-key" | jq
# → { "role": "user", "vendor": null }
```

4. Connect Cursor to your local instance:

```json
{
  "mcpServers": {
    "reflect-memory": {
      "type": "streamable-http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer your-RM_AGENT_KEY_CURSOR-value"
      }
    }
  }
}
```

**Important:** The `/mcp` endpoint uses agent keys for auth, not `RM_API_KEY`. Your `RM_API_KEY` works for REST/curl calls, but MCP clients must use the corresponding `RM_AGENT_KEY_*` value.

## Deploy to Railway

### 1. Environment variables

Set these in the Railway service's **Variables** tab:

| Variable | Required | Value |
|---|---|---|
| `RM_API_KEY` | Yes | A strong random string (your user API key) |
| `RM_MODEL_API_KEY` | Yes | Your OpenAI API key (`sk-...`) |
| `RM_MODEL_NAME` | Yes | `gpt-4o-mini` or any OpenAI model |
| `RM_DB_PATH` | No | Defaults to `/data/reflect-memory.db` |
| `RM_AGENT_KEY_CHATGPT` | No | Agent key for ChatGPT integration |
| `RM_AGENT_KEY_CLAUDE` | No | Agent key for Claude integration |

Railway sets `PORT` automatically -- the app picks it up.

### 2. Attach a volume (persistent storage)

Without a volume, Railway containers are ephemeral -- the SQLite database resets on every deploy or restart. To persist data:

1. Click on the **Reflect-Memory** service in Railway
2. Go to the **Volumes** section (or **Settings > Volumes**)
3. Click **"Add Volume"**
4. Set **Mount Path** to `/data`
5. Save

Railway will mount a persistent disk at `/data`. The app creates the database file at `/data/reflect-memory.db` by default. This survives restarts, redeploys, and container replacements.

### 3. Build and start commands

Railway should auto-detect these from `package.json`:

- **Build:** `npm run build`
- **Start:** `npm start`

### 4. Custom domain

To use `api.reflectmemory.com`:

1. In Railway: Service → Settings → Networking → Custom Domain → add `api.reflectmemory.com`
2. In your DNS provider: add the CNAME and TXT records Railway shows you
3. Wait for the green checkmark

## Verification Checklist

### Whoami

```bash
# User key
curl -s https://api.reflectmemory.com/whoami \
  -H "Authorization: Bearer YOUR_USER_KEY" | jq
# → { "role": "user", "vendor": null }

# Agent key (ChatGPT)
curl -s https://api.reflectmemory.com/whoami \
  -H "Authorization: Bearer YOUR_CHATGPT_AGENT_KEY" | jq
# → { "role": "agent", "vendor": "chatgpt" }
```

### Agent write

```bash
curl -s -X POST https://api.reflectmemory.com/agent/memories \
  -H "Authorization: Bearer YOUR_CHATGPT_AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Agent test",
    "content": "Written by chatgpt agent.",
    "tags": ["agent-test"],
    "allowed_vendors": ["chatgpt"]
  }' | jq
# → origin: "chatgpt", allowed_vendors: ["chatgpt"]
```

### Agent query scoping

```bash
# Agent sees only memories with allowed_vendors containing "*" or "chatgpt"
curl -s -X POST https://api.reflectmemory.com/query \
  -H "Authorization: Bearer YOUR_CHATGPT_AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What do you know?",
    "memory_filter": { "by": "all" }
  }' | jq '.memories_used | length'
# → vendor_filter: "chatgpt" in receipt
```

### User sees all

```bash
# User sees every memory regardless of allowed_vendors
curl -s -X POST https://api.reflectmemory.com/memories/list \
  -H "Authorization: Bearer YOUR_USER_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "filter": { "by": "all" } }' | jq '.memories | length'
```

### Agent route restriction

```bash
# Agent cannot hit user-only endpoints
curl -s -X POST https://api.reflectmemory.com/memories \
  -H "Authorization: Bearer YOUR_CHATGPT_AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"x","content":"x","tags":["x"]}' | jq
# → { "error": "Agent keys cannot access this endpoint" } (403)
```

### Persistence (data survives redeploy)

1. Create a memory, note the ID
2. Trigger a redeploy in Railway
3. Read the memory by ID -- should still exist

## Architecture

```
User key  → POST /memories        → Memory Service → SQLite (origin: "user")
          → GET  /memories/:id     → Memory Service → SQLite
          → POST /memories/list    → Memory Service → SQLite
          → PUT  /memories/:id     → Memory Service → SQLite
          → DELETE /memories/:id   → Memory Service → SQLite

Agent key → POST /agent/memories   → Memory Service → SQLite (origin: vendor)
          → POST /query            → Memory Service (vendor-filtered read)
                                   → Context Builder → Model Gateway → QueryReceipt

Both      → GET /health           (no auth)
          → GET /whoami           (returns role + vendor)
          → POST /query           (vendor filter from key, not body)
```

## Hard Invariants

1. **Explicit Intent** -- No defaults, no inferred behavior. Every request declares exactly what it wants.
2. **Hard Deletion** -- Delete means delete. One row, one table, gone. No soft deletes.
3. **Pure Context Builder** -- No I/O. Same inputs, same output. Always.
4. **No AI Write Path** -- The model cannot create, modify, or delete memories. One-directional data flow.
5. **Deterministic Visibility** -- Every query response includes the full receipt: memories used, prompt sent, model config, vendor filter.

## Hard Security Constraints

1. **`/agent/memories` must never accept `origin` in the body.** If present, hard 400 (enforced by `additionalProperties: false` in the schema).
2. **Agent keys must never be allowed to call user endpoints.** Agents can only hit `/agent/*`, `/query`, `/whoami`, `/health`. Everything else returns 403.
