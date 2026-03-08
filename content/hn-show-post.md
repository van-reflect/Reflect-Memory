# Show HN: I built a shared memory layer for AI agents (ChatGPT, Claude, Cursor, Gemini)

---

**Top-level comment (paste with submission):**

Every AI tool forgets everything between sessions. ChatGPT Memory stays in OpenAI. Claude Projects stay in Anthropic. Nothing talks to each other, so you repeat yourself across every tool.

Reflect Memory is a vendor-neutral memory substrate. One API, every vendor. Write a memory from Cursor, retrieve it from Claude or ChatGPT. You control which vendors can see what via `allowed_vendors`. No AI in the write path, just deterministic persistence.

Architecture: https://github.com/van-reflect/Reflect-Memory/blob/main/ARCHITECTURE.md

Quick start: `npm install reflect-memory-sdk` then hit the API. MCP server for Cursor/Claude, Custom GPT for ChatGPT, n8n community node. Open spec, TypeScript backend.

I'm the solo founder, happy to answer questions.
