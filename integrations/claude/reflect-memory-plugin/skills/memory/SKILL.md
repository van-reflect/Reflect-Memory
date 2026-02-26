---
name: memory
description: Read, write, browse, and search Reflect Memory entries. Use when the user asks about memories, wants to save something to memory, check what memories exist, pull the latest memory, or search for specific information stored in Reflect Memory.
---

# Reflect Memory

You have access to Reflect Memory, a cross-agent memory system. Use the MCP tools to interact with it.

## Available Tools

- **read_memories**: Get recent memories with full content. Use `limit` to control how many (default 10, max 50).
- **get_memory_by_id**: Retrieve a specific memory by its UUID.
- **get_latest_memory**: Get the single most recent memory. Use `tag` to filter by a specific tag.
- **browse_memories**: Browse memory summaries (title, tags, dates — no content). Use to discover what exists before reading specific ones.
- **search_memories**: Search by text in title or content.
- **get_memories_by_tag**: Get full memories filtered by tags. Returns memories matching ANY of the given tags.
- **write_memory**: Create a new memory entry with title, content, tags, and allowed_vendors.

## When to use each tool

- User asks "what's the latest memory?" → `get_latest_memory`
- User asks "pull memories about X" → `search_memories` or `get_memories_by_tag`
- User asks "what memories do I have?" → `browse_memories`
- User asks "save this to memory" or "write a memory" → `write_memory`
- User gives you a memory ID → `get_memory_by_id`
- User asks for recent context → `read_memories`

## Writing memories

When writing memories, follow this format:
- **Title**: Short descriptor. Format: "Topic - Summary"
- **Content**: Structured text. Use clear sections.
- **Tags**: Relevant categorization tags as an array.
- **allowed_vendors**: Use `["*"]` to make visible to all agents, or specify vendors like `["chatgpt", "claude"]`.
