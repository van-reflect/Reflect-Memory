# Give Claude persistent memory with Reflect Memory MCP

Claude is stateless by default. Every conversation starts fresh. Reflect Memory adds a persistent memory layer via the Model Context Protocol, so Claude can recall context, preferences, and decisions across sessions.

**Setup:** Add Reflect Memory to your Claude Desktop MCP config (or Cursor, or any MCP client):

```json
{
  "mcpServers": {
    "reflect-memory": {
      "command": "npx",
      "args": ["reflect-memory-mcp"],
      "env": {
        "RM_API_KEY": "your-api-key",
        "RM_MCP_USER_ID": "your-user-id"
      }
    }
  }
}
```

Get your API key at [reflectmemory.com](https://reflectmemory.com). The MCP server exposes five tools: `read_memories`, `get_memory_by_id`, `browse_memories`, `write_memory`, and `query`. Claude can read your stored memories, write new ones, and ask natural-language questions that get answered with memory context.

**What it enables:**
- Claude remembers your preferences, project context, and past decisions across conversations.
- Memories are structured (title, content, tags) and fully editable. You control what Claude sees.
- The same memory store works with ChatGPT, Cursor, Gemini, and n8n. One API, many agents.

TypeScript SDK: `npm install reflect-memory-sdk`. REST API: `https://api.reflectmemory.com`. Open source: [github.com/van-reflect/Reflect-Memory](https://github.com/van-reflect/Reflect-Memory).
