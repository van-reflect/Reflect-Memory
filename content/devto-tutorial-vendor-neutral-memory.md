---
title: Building a Vendor-Neutral Memory Layer in TypeScript
published: false
description: A technical deep-dive into Reflect Memory's architecture: TypeScript, Fastify, SQLite with WAL mode, and MCP transport for AI agent memory.
tags:
  - typescript
  - ai
  - mcp
  - sqlite
  - fastify
---

# Building a Vendor-Neutral Memory Layer in TypeScript

AI agents are stateless by default. Every conversation starts from zero. That works for one-off tasks, but breaks down when you want ChatGPT to remember your preferences, Claude to recall project context, and Cursor to know your coding style. The solution is a shared memory layer that any agent can read and write, regardless of vendor.

Reflect Memory is an open-source memory substrate built in TypeScript. Here's why we chose each piece of the stack and how they fit together.

## Why TypeScript?

TypeScript gives us a single language across the entire system: the REST API, the MCP server, the SDK, and the n8n node. No context switching. The SDK uses native `fetch` and has zero runtime dependencies, so it runs anywhere Node 18+ runs. The type system catches schema mismatches at compile time, which matters when you're passing memory structures between services.

```typescript
// SDK usage -- zero deps, native fetch
import { ReflectMemory } from "reflect-memory-sdk";

const rm = new ReflectMemory({ apiKey: process.env.REFLECT_API_KEY! });
const latest = await rm.getLatest();
```

## Fastify for the HTTP Layer

We use Fastify instead of Express for the main API. Fastify's schema-based validation (via JSON Schema) enforces request shapes before handlers run. That's critical for security: we reject malformed bodies and unknown fields at the edge. Rate limiting and CORS are first-class plugins. The server stays thin: it authenticates, validates, and delegates to pure service functions.

```typescript
// Server setup -- schema validation, rate limit, CORS
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";

const app = Fastify();
await app.register(cors, { origin: true });
await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
```

## SQLite with WAL Mode

We store memories in SQLite with WAL (Write-Ahead Logging) mode. WAL gives us concurrent reads while a single writer commits. The process exits at startup if WAL activation fails, so we never silently fall back to rollback journal mode.

```typescript
// Enforced at startup
const journalMode = db.pragma("journal_mode = WAL") as Array<{ journal_mode: string }>;
if (journalMode[0]?.journal_mode !== "wal") {
  console.error(`WAL mode not active. Got: ${journalMode[0]?.journal_mode}`);
  process.exit(1);
}
```

The schema uses `STRICT` tables and `json_type()` CHECK constraints on JSON columns. Foreign keys are enforced via `PRAGMA foreign_keys = ON`. No connection pooling needed: better-sqlite3 is synchronous and single-process.

## Pure Context Builder

The context builder is a pure function. No I/O, no database, no side effects. It takes memories and a query, returns a prompt string. Same inputs, same output, every time. That makes it testable and auditable. The model never decides which memories to include; that decision is made upstream based on the user's explicit filter.

```typescript
// Pure function -- no I/O
export function buildPrompt(
  memories: MemoryEntry[],
  userQuery: string,
  systemPrompt: string,
  charBudget?: number,
): PromptResult {
  const systemSection = systemPrompt.length > 0 ? `[System]\n${systemPrompt}` : "";
  const querySection = `[User Query]\n${userQuery}`;
  // ... assembles prompt, respects charBudget
}
```

## MCP Transport

The Model Context Protocol (MCP) is how Cursor, Claude Desktop, and other clients discover and call tools. We run a standalone MCP server that exposes `read_memories`, `get_memory_by_id`, `browse_memories`, `write_memory`, and `query`. Each tool is a Zod-validated function. The transport is Streamable HTTP, so it works over the network without stdio.

```typescript
// MCP tool registration
mcp.tool(
  "read_memories",
  "Get the most recent memories. Returns full content.",
  { limit: z.number().min(1).max(50).default(10) },
  { title: "Read Memories", readOnlyHint: true },
  async ({ limit }) => {
    const memories = listMemories(db, userId, { by: "all" }, vendor, { limit });
    return { content: [{ type: "text", text: JSON.stringify(memories, null, 2) }] };
  },
);
```

## One API, Many Vendors

User keys get full CRUD. Agent keys (per-vendor) can only write via `POST /agent/memories` and query via `POST /query`. Agents see only memories where `allowed_vendors` includes their vendor or `"*"`. The `origin` field is set server-side from the key, never from the request body. That prevents agents from impersonating each other.

The result: one memory store, one API, and one MCP server. ChatGPT, Claude, Cursor, Gemini, and n8n all talk to the same layer. No per-vendor integrations to maintain.

## Hard Invariants

We enforce a few invariants that keep the system predictable. Explicit intent: every request declares exactly what it wants. No inferred behavior. Hard deletion: delete means delete. One row, gone. No soft deletes or archives. Pure context builder: the prompt assembly has no I/O. Same inputs, same output. No AI write path: the model cannot create, modify, or delete memories. One-directional data flow. Deterministic visibility: every query response includes a full receipt with memories used, prompt sent, and vendor filter applied.

## Getting Started

Try it: `npm install reflect-memory-sdk` or `npx reflect-memory-mcp` for the MCP server. The SDK works with the hosted API at api.reflectmemory.com, or you can self-host. Docs and source: [reflectmemory.com](https://reflectmemory.com), [github.com/van-reflect/Reflect-Memory](https://github.com/van-reflect/Reflect-Memory).
