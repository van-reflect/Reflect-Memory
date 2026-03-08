# Add persistent cross-vendor memory to Cursor in 60 seconds

Give Cursor a memory layer that persists across sessions and works with ChatGPT, Claude, Gemini, and more. One API, one MCP server.

**Setup:** Add Reflect Memory to your MCP config:

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

Get your API key at [reflectmemory.com](https://reflectmemory.com). The MCP server exposes tools for reading, writing, browsing, and querying memories. Cursor can now recall project context, preferences, and decisions across conversations.

**Use cases:**
- **Project context:** Store architecture decisions, tech stack choices, and conventions. Cursor pulls them in when you start a new session.
- **Preferences:** Remember your coding style, naming conventions, and tool preferences. No more repeating yourself.
- **Cross-vendor continuity:** What you tell ChatGPT can be available to Cursor. Same memory store, different agents.

TypeScript SDK: `npm install reflect-memory-sdk` (zero deps, Node 18+). API: `https://api.reflectmemory.com`. Open source: [github.com/van-reflect/Reflect-Memory](https://github.com/van-reflect/Reflect-Memory).
