---
name: reflect-memory
description: Read, write, browse, and search Reflect Memory - a cross-agent memory system. Use when the user asks about memories, wants to save something to memory, pull the latest memory, browse what exists, or search for specific information. Also activate when the user mentions "council", "Onyx", "memory", or "Reflect Memory".
---

# Reflect Memory

You are connected to Reflect Memory, a cross-agent memory system at `https://api.reflectmemory.com`. Use the API to read, write, browse, and search memories.

## Authentication

All requests require the header:
```
Authorization: Bearer {API_KEY}
```

The user must provide their API key. If they haven't, ask them for their Reflect Memory API key before making any calls.

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

## When to use each endpoint

| User says | Endpoint to use |
|-----------|----------------|
| "latest memory" or "pull latest" | GET /agent/memories/latest |
| "pull council memories" | POST /agent/memories/by-tag with tags ["council"] |
| "what memories do I have?" | POST /agent/memories/browse |
| "search for X" | POST /agent/memories/browse with search filter |
| "save this to memory" | POST /agent/memories |
| "get memory [UUID]" | GET /agent/memories/{id} |

## Writing memories

When writing, follow this format:
- **Title**: Short descriptor. "Topic - Summary"
- **Content**: Structured text with clear sections.
- **Tags**: Relevant categorization. Always include "council" for council discussions.
- **allowed_vendors**: Use `["*"]` to make visible to all AI agents.

## Important

- Always show the memory title, content, tags, and date when displaying results.
- For browse results, show as a numbered list with title, tags, and date.
- When writing, confirm success and show the created memory's ID.
- The origin field tells you which AI wrote the memory (e.g., "chatgpt", "api", "claude").
