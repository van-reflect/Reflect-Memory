# Reflect Memory - Gemini Gem Integration

Connect Gemini to Reflect Memory as the COO (Chief Operating Officer).

## Current Limitation

Gemini Gems do **not** support external API calls from the chat UI. The Gemini API supports function calling for developers building apps, but Gems in gemini.google.com cannot make outbound HTTP requests.

## How it works (relay pattern)

Until Google adds tool/extension support to Gems, we use a **CEO relay pattern**:

1. The Gem knows its role, the team structure, and the memory format.
2. When it needs to read or write memory, it asks the CEO (you) to relay the request.
3. You copy the API response into the chat, or run the write command it provides.

This keeps Gemini in the loop as COO while we wait for native tool support.

## Setup

### Create the Gem

1. Go to [gemini.google.com](https://gemini.google.com)
2. Click **Gems** in the sidebar
3. Click **New Gem**
4. Set the name to **Reflect Memory COO**
5. Paste the instructions from `gem-instructions.md` into the Instructions field
6. Save the Gem

### Using the Gem

Start a chat with the Gem. It will operate as COO and request memory reads/writes through you.

**Reading memory for the Gem:**
```bash
cd ~/Desktop/reflective-memory && source .env
curl -s https://api.reflectmemory.com/agent/memories/latest \
  -H "Authorization: Bearer $RM_API_KEY" | jq .
```

**Writing memory the Gem requests:**
```bash
curl -s -X POST https://api.reflectmemory.com/memories \
  -H "Authorization: Bearer $RM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Operations Update - [topic]",
    "content": "[content from Gem]",
    "tags": ["council", "operations", "gemini_coo"]
  }' | jq .
```

## Future: Native Integration

When Google adds external tool support to Gems (or MCP support to Gemini), we will:
1. Register an `RM_AGENT_KEY_GEMINI` agent key
2. Either build an MCP adapter (if Gemini supports MCP) or use Gemini's function calling framework
3. Give the Gem direct read/write access to Reflect Memory

Monitor Google's Gems roadmap for tool-use expansion.
