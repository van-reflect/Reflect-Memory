# Reflect Memory - Gemini Integration

Two integration paths: a **Gemini Gem** (relay pattern for the chat UI) and a
**Gemini API function-calling example** for developers building Gemini-powered apps.

## Environment Variable

Add a Gemini-scoped agent key to your Reflect Memory environment:

```
RM_AGENT_KEY_GEMINI=<your-gemini-agent-key>
```

The backend discovers it automatically via the `RM_AGENT_KEY_*` pattern and
registers vendor `"gemini"`. All memories written through this key are tagged
with `origin: "gemini"`.

---

## Path 1: Gemini Gem (Relay Pattern)

### Current Limitation

Gemini Gems do **not** support external API calls from the chat UI. The Gemini
API supports function calling for developers, but Gems at gemini.google.com
cannot make outbound HTTP requests.

### How it works

Until Google adds tool/extension support to Gems, we use a **CEO relay pattern**:

1. The Gem knows its role, the team structure, and the memory format.
2. When it needs to read or write memory, it asks the CEO (you) to relay.
3. You run the cURL command and paste the response back into the chat.

### Setup

1. Go to [gemini.google.com](https://gemini.google.com)
2. Click **Gems** in the sidebar
3. Click **New Gem**
4. Set the name to **Reflect Memory COO**
5. Paste the instructions from `gem-instructions.md` into the Instructions field
6. Save the Gem

### Relay Commands

**Read the latest memory:**
```bash
curl -s https://api.reflectmemory.com/agent/memories/latest \
  -H "Authorization: Bearer $RM_AGENT_KEY_GEMINI" | jq .
```

**Read memories by tag:**
```bash
curl -s -X POST https://api.reflectmemory.com/agent/memories/by-tag \
  -H "Authorization: Bearer $RM_AGENT_KEY_GEMINI" \
  -H "Content-Type: application/json" \
  -d '{"tags": ["council"]}' | jq .
```

**Write a memory the Gem requests:**
```bash
curl -s -X POST https://api.reflectmemory.com/agent/memories \
  -H "Authorization: Bearer $RM_AGENT_KEY_GEMINI" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Operations Update - [topic]",
    "content": "[content from Gem]",
    "tags": ["council", "operations", "gemini_coo"],
    "allowed_vendors": ["*"]
  }' | jq .
```

---

## Path 2: Gemini API Function Calling

For developers building apps with the Gemini API, `function-calling-example.ts`
demonstrates how to give a Gemini model native read/write access to Reflect
Memory via function declarations.

### Prerequisites

- Node.js 18+
- `@google/generative-ai` SDK
- A Google AI API key (`GOOGLE_AI_API_KEY`)
- A Reflect Memory agent key (`RM_AGENT_KEY_GEMINI`)

### How it works

The example defines five function declarations that map to Reflect Memory's
agent endpoints:

| Function | Endpoint | Description |
|----------|----------|-------------|
| `get_latest_memory` | `GET /agent/memories/latest` | Most recent memory |
| `get_memory_by_id` | `GET /agent/memories/:id` | Single memory by UUID |
| `browse_memories` | `POST /agent/memories/browse` | Summaries (paginated) |
| `get_memories_by_tag` | `POST /agent/memories/by-tag` | Filter by tags |
| `write_memory` | `POST /agent/memories` | Create a new memory |

When Gemini calls a function, the example executes the corresponding HTTP
request against the Reflect Memory API and feeds the result back to the model.

### Run it

```bash
cd integrations/gemini
npm install
GOOGLE_AI_API_KEY=<key> RM_AGENT_KEY_GEMINI=<key> npx tsx function-calling-example.ts
```

---

## Future: Native Gem Tool Support

When Google adds external tool/extension support to Gems (or MCP support to
Gemini), we will:

1. Point the Gem at the MCP server (`https://api.reflectmemory.com/mcp`) using
   `RM_AGENT_KEY_GEMINI` for auth
2. Or register Reflect Memory as a Gemini extension using the function-calling
   framework already demonstrated in this directory
3. Remove the relay pattern and give the Gem direct read/write access

Monitor Google's Gems roadmap for tool-use expansion.
