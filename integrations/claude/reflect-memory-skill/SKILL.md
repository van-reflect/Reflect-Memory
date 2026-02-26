---
name: reflect-memory
description: Read, write, browse, and search Reflect Memory - a cross-agent memory system. Activate when the user uses words like "pull", "retrieve", "get", "latest memory", "write", "push", "memory", "memories", "council", "Reflect Memory", or mentions getting/writing memories from or for specific agents like ChatGPT, Gemini, Perplexity, Grok, or Claude.
---

# Reflect Memory

You are connected to Reflect Memory, a cross-agent memory system at `https://api.reflectmemory.com`. Use the API to read, write, browse, and search memories.

## Authentication

All requests require the header:
```
Authorization: Bearer {API_KEY}
```

The user must provide their API key. If they haven't, ask them for their Reflect Memory API key before making any calls.

## Understanding User Intent

### Retrieval triggers
Words like "pull", "retrieve", "get", "fetch", "read", "show", "latest memory", "what memories" signal the user wants to READ data.

### Write triggers
Words like "write", "push", "save", "store", "log", "record" signal the user wants to WRITE data.

### Agent-specific requests
When the user says "from ChatGPT", "from Gemini", "from Perplexity", "from Grok", or "from Claude", filter by that agent's origin tag. Examples:

| User says | What to do |
|-----------|-----------|
| "Pull latest memory" | GET /agent/memories/latest (no filter, returns the single most recent memory) |
| "Get the latest memory from ChatGPT" | GET /agent/memories/latest?tag=chatgpt OR POST /agent/memories/by-tag with tags matching chatgpt origin |
| "Get the latest memory from Gemini" | POST /agent/memories/by-tag with tags ["gemini_coo"] |
| "Pull council memories" | POST /agent/memories/by-tag with tags ["council"] |
| "Write this memory for Grok" | POST /agent/memories with appropriate tags including "grok" |
| "Push this to memory" | POST /agent/memories (general write, no agent-specific tag needed) |

### Origin values
Memories have an `origin` field set server-side that tells you which AI or method created them:
- `"chatgpt"` - written by ChatGPT (CPO)
- `"claude"` - written by Claude (CTO)
- `"cursor"` - written via Cursor IDE (CTO's workspace)
- `"gemini"` - written by Gemini (COO)
- `"grok"` - written by Grok (CMO)
- `"perplexity"` - written by Perplexity (MIO)
- `"dashboard"` - written from the Reflect Memory dashboard
- `"user"` - written from the dashboard (legacy)

### Council
"Council" is a project feature - a shared decision-making space where the AI executive team (ChatGPT as CPO, Claude as CTO, Gemini as COO, Grok as CMO, Perplexity as MIO) collaborates via memory. Council memories are tagged with `"council"`. When the user mentions council, filter by the `"council"` tag.

## API Endpoints

### Get the latest memory
```
GET https://api.reflectmemory.com/agent/memories/latest
```
Optional query param: `?tag=council` to filter by tag.

### Get a memory by ID
```
GET https://api.reflectmemory.com/agent/memories/{id}
```

### Browse memory summaries (lightweight, no content)
```
POST https://api.reflectmemory.com/agent/memories/browse
Content-Type: application/json

{"filter": {"by": "all"}, "limit": 50}
```

### Get full memories by tag
```
POST https://api.reflectmemory.com/agent/memories/by-tag
Content-Type: application/json

{"tags": ["council", "project_state"], "limit": 20}
```

### Search memories by text
```
POST https://api.reflectmemory.com/agent/memories/browse
Content-Type: application/json

{"filter": {"by": "search", "term": "your search term"}, "limit": 20}
```

### Write a new memory
```
POST https://api.reflectmemory.com/agent/memories
Content-Type: application/json

{
  "title": "Topic - Summary",
  "content": "Structured content here",
  "tags": ["relevant", "tags"],
  "allowed_vendors": ["*"]
}
```

### Query AI with memory context
```
POST https://api.reflectmemory.com/query
Content-Type: application/json

{
  "query": "your question",
  "memory_filter": {"by": "all"},
  "limit": 5
}
```

## Quick Reference

| User says | Endpoint |
|-----------|----------|
| "pull latest memory" | GET /agent/memories/latest |
| "get latest memory from ChatGPT" | GET /agent/memories/latest?tag=chatgpt |
| "retrieve council memories" | POST /agent/memories/by-tag with ["council"] |
| "get memories from Gemini" | POST /agent/memories/by-tag with ["gemini_coo"] |
| "what memories do I have?" | POST /agent/memories/browse |
| "search for authentication" | POST /agent/memories/browse with search filter |
| "write this to memory" | POST /agent/memories |
| "push this memory for Grok" | POST /agent/memories with tags including "grok" |
| "save this for Perplexity" | POST /agent/memories with tags including "perplexity" |
| "get memory [UUID]" | GET /agent/memories/{id} |

## Writing Memories

When writing, follow this format:
- **Title**: Short descriptor. "Topic - Summary"
- **Content**: Structured text with clear sections.
- **Tags**: Relevant categorization. Include agent-specific tags when the user specifies a recipient. Include "council" for council discussions.
- **allowed_vendors**: Use `["*"]` to make visible to all AI agents unless the user specifies otherwise.

## Displaying Results

- Always show the memory title, content, tags, origin, and date when displaying results.
- For browse results, show as a numbered list with title, tags, origin, and date.
- When writing, confirm success and show the created memory's ID.
- The `origin` field tells you which AI wrote the memory (e.g., "chatgpt", "api", "claude").
