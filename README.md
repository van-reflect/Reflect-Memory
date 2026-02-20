# Reflective Memory

Privacy-first AI memory system. All memory is explicitly user-authored, structured, editable, and deletable. The AI model is stateless — it sees only what you choose to show it.

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
export RM_API_KEY="your-secret-api-key"        # Clients send this to authenticate
export RM_MODEL_API_KEY="sk-..."               # Your OpenAI (or compatible) API key
export RM_MODEL_NAME="gpt-4o-mini"             # Model identifier
```

Optional:

```bash
export RM_PORT=3000                            # HTTP port (default: 3000)
export RM_DB_PATH="./reflective-memory.db"     # SQLite file path
export RM_MODEL_BASE_URL="https://api.openai.com/v1"  # Model API base URL
export RM_MODEL_TEMPERATURE=0.7                # Temperature (default: 0.7)
export RM_MODEL_MAX_TOKENS=1024                # Max tokens (default: 1024)
export RM_SYSTEM_PROMPT="Your custom prompt"   # System prompt for AI queries
```

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

All requests require the `Authorization` header:

```
Authorization: Bearer your-secret-api-key
```

### Create a memory

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

Response (201):

```json
{
  "id": "a1b2c3d4-...",
  "user_id": "...",
  "title": "Project deadline",
  "content": "The API migration must be completed by end of Q3 2026.",
  "tags": ["work", "deadlines"],
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

By IDs:

```bash
curl -s -X POST http://localhost:3000/memories/list \
  -H "Authorization: Bearer your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{ "filter": { "by": "ids", "ids": ["MEMORY_ID_1", "MEMORY_ID_2"] } }' | jq
```

### Update a memory (full replacement)

```bash
curl -s -X PUT http://localhost:3000/memories/MEMORY_ID \
  -H "Authorization: Bearer your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Project deadline (revised)",
    "content": "The API migration deadline has been extended to Q4 2026.",
    "tags": ["work", "deadlines", "revised"]
  }' | jq
```

### Delete a memory

```bash
curl -s -X DELETE http://localhost:3000/memories/MEMORY_ID \
  -H "Authorization: Bearer your-secret-api-key" -w "\nHTTP %{http_code}\n"
```

Returns `204 No Content` on success. The row is gone.

### Query the AI (with memory context)

```bash
curl -s -X POST http://localhost:3000/query \
  -H "Authorization: Bearer your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "When is the API migration deadline?",
    "memory_filter": { "by": "tags", "tags": ["deadlines"] }
  }' | jq
```

Response (200) — the full QueryReceipt:

```json
{
  "response": "Based on your memory entries, the API migration must be completed by end of Q3 2026.",
  "memories_used": [
    {
      "id": "a1b2c3d4-...",
      "user_id": "...",
      "title": "Project deadline",
      "content": "The API migration must be completed by end of Q3 2026.",
      "tags": ["work", "deadlines"],
      "created_at": "2026-02-08T...",
      "updated_at": "2026-02-08T..."
    }
  ],
  "prompt_sent": "[System]\nYou are a helpful assistant...\n\n[Memories]\n\n--- Project deadline ---\nTags: work, deadlines\nThe API migration must be completed by end of Q3 2026.\n\n[User Query]\nWhen is the API migration deadline?",
  "model_config": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "parameters": {
      "temperature": 0.7,
      "max_tokens": 1024
    }
  }
}
```

The `prompt_sent` field shows you the exact text the AI model received. The `memories_used` field shows the full content of each memory as it was at query time. Nothing is hidden.

### Query — filter by tags

```bash
curl -s -X POST http://localhost:3000/query \
  -H "Authorization: Bearer your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Summarize my work notes",
    "memory_filter": { "by": "tags", "tags": ["work"] }
  }' | jq
```

### Query — filter by IDs

```bash
curl -s -X POST http://localhost:3000/query \
  -H "Authorization: Bearer your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What do these entries have in common?",
    "memory_filter": { "by": "ids", "ids": ["MEMORY_ID_1", "MEMORY_ID_2"] }
  }' | jq
```

## Architecture

```
POST /memories          → Memory Service → SQLite (create)
GET  /memories/:id      → Memory Service → SQLite (read)
POST /memories/list     → Memory Service → SQLite (list)
PUT  /memories/:id      → Memory Service → SQLite (update)
DELETE /memories/:id    → Memory Service → SQLite (delete)

POST /query             → Memory Service (read)
                        → Context Builder (pure function)
                        → Model Gateway (stateless HTTP call)
                        → QueryReceipt returned to client
```

## Hard Invariants

1. **Explicit Intent** — No defaults, no inferred behavior. Every request declares exactly what it wants.
2. **Hard Deletion** — Delete means delete. One row, one table, gone. No soft deletes.
3. **Pure Context Builder** — No I/O. Same inputs, same output. Always.
4. **No AI Write Path** — The model cannot create, modify, or delete memories. One-directional data flow.
5. **Deterministic Visibility** — Every query response includes the full receipt: memories used, prompt sent, model config.
