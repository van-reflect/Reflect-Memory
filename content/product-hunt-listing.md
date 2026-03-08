# Product Hunt Launch: Reflect Memory

## Tagline (under 60 chars)

**Vendor-neutral memory for AI. One API, ChatGPT to Cursor.**

(52 chars)

---

## Description (under 260 chars)

Reflect Memory gives ChatGPT, Claude, Cursor, Gemini, and n8n shared persistent memory. TypeScript SDK, MCP server, REST API. Zero vendor lock-in. You control what agents remember. npm install reflect-memory-sdk. npx reflect-memory-mcp.

(248 chars)

---

## Maker Comment (200-300 words)

I built Reflect Memory because I was tired of repeating myself to every AI I use. ChatGPT doesn't remember my preferences. Claude doesn't recall my project context. Cursor starts every session from zero. I wanted one memory layer that any agent could read and write, regardless of vendor.

Reflect Memory is a vendor-neutral memory substrate. One API, one MCP server. Add it to Cursor or Claude Desktop in under a minute. The same memories are available to ChatGPT, Gemini, n8n, and more. You control what goes in, what gets shared, and what gets deleted. The model stays stateless. The memory is yours.

I chose the Model Context Protocol (MCP) for integration. One server, many clients. No per-vendor glue code. The TypeScript SDK has zero runtime dependencies and works anywhere Node 18+ runs. The backend is Fastify on SQLite with WAL mode. MCP-native, deterministic persistence, structured memory types.

I've spent years in design and product at Google, Apple, Sony, and TikTok. This is my first solo build in the AI space. Early days, but the problem is real. If you use multiple AI tools and want continuity across them, Reflect Memory is for you.

Try it: reflectmemory.com. Open source: github.com/van-reflect/Reflect-Memory.

---

## 5 Key Features to Highlight

1. **Vendor-neutral:** One API for ChatGPT, Claude, Cursor, Gemini, n8n. No lock-in.
2. **MCP-native:** Add to Cursor or Claude Desktop in 60 seconds. One integration, many clients.
3. **TypeScript SDK:** `npm install reflect-memory-sdk` (zero deps, Node 18+).
4. **User-controlled:** You decide what agents remember. Structured, editable, deletable.
5. **Deterministic persistence:** SQLite with WAL mode. Hard deletion. No soft deletes.

---

## Suggested Launch Timing and Strategy Notes

**Timing:**
- Launch Tuesday or Wednesday (higher engagement than Monday/Friday).
- Post between 12:01 AM and 3:00 AM PT so the post is live when East Coast and Europe wake up.
- Avoid major tech news days (Apple events, OpenAI releases, etc.).

**Strategy:**
- Prepare a short demo video (30-60 seconds) showing MCP setup in Cursor and a memory being recalled.
- Line up 5-10 supporters to upvote and comment in the first 2 hours. Early momentum matters.
- Cross-post to Dev.to, Cursor Discord, Claude community, and Hacker News (Show HN) on launch day.
- Maker comment should be personal and concise. Avoid jargon. Focus on the problem and the one-line value prop.
- Respond to every comment within the first 24 hours. Product Hunt rewards engagement.
