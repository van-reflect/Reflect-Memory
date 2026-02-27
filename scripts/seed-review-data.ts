// Seed sample memories for Anthropic MCP review testing.
// Run once before sharing the test API key with reviewers.
//
// Usage: RM_DB_PATH=/path/to/db RM_OWNER_EMAIL=you@example.com npx tsx scripts/seed-review-data.ts
//
// On Railway: run as a one-off job with your env vars, or run locally against a backup.

import Database from "better-sqlite3";
import { createMemory } from "../src/memory-service.js";

const DB_PATH = process.env.RM_DB_PATH || "/data/reflect-memory.db";
const OWNER_EMAIL = process.env.RM_OWNER_EMAIL?.toLowerCase().trim();

if (!OWNER_EMAIL) {
  console.error("RM_OWNER_EMAIL is required.");
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

const owner = db.prepare("SELECT id FROM users WHERE email = ?").get(OWNER_EMAIL) as { id: string } | undefined;
if (!owner) {
  console.error(`No user found with email ${OWNER_EMAIL}. Create the owner first (server must have run at least once).`);
  process.exit(1);
}

const userId = owner.id;

const SAMPLE_MEMORIES = [
  { title: "AI Council governance", content: "The AI Council uses Reflect Memory for shared context. CEO sets governance thresholds; CTO, CPO, COO, CMO, and MIO sync memories via their respective integrations.", tags: ["council", "governance"], origin: "user" },
  { title: "Preferred writing style", content: "I prefer concise, direct writing with clear headings. Bullet points over long paragraphs when listing items.", tags: ["preferences", "style"], origin: "user" },
  { title: "Current project: MCP connector", content: "Working on Anthropic MCP Connectors Directory submission. Reflect Memory exposes 7 tools: read, browse, search, get latest, get by id, get by tag, write. Streamable HTTP at api.reflectmemory.com/mcp.", tags: ["work", "mcp", "anthropic"], origin: "cursor" },
  { title: "Meeting notes - Q1 planning", content: "Q1 priorities: 1) Get into Anthropic directory, 2) Gemini Gem relay, 3) Dashboard polish. Next sync Tuesday 10am.", tags: ["work", "meetings"], origin: "user" },
  { title: "Integrations status", content: "ChatGPT: custom action. Claude: MCP server (streamable HTTP). Cursor: MCP + Skill. Gemini: Gem instructions only (no API yet). More coming.", tags: ["integrations", "council"], origin: "claude" },
  { title: "Privacy stance", content: "Delete means delete. No shadow copies. User controls what gets stored and who can see it. Dashboard at reflectmemory.com.", tags: ["privacy", "policy"], origin: "user" },
  { title: "Technical stack", content: "Backend: Node, Fastify, SQLite. MCP: @modelcontextprotocol/sdk. Auth: Bearer tokens per vendor. Single-tenant, RM_OWNER_EMAIL scopes all data.", tags: ["technical"], origin: "cursor" },
  { title: "Test memory for search", content: "This memory contains the word 'review' and 'Anthropic' for testing the search_memories tool during MCP connector review.", tags: ["test", "review"], origin: "user" },
];

let inserted = 0;
for (const m of SAMPLE_MEMORIES) {
  createMemory(db, userId, {
    title: m.title,
    content: m.content,
    tags: m.tags,
    origin: m.origin,
    allowed_vendors: ["*"],
  });
  inserted++;
}

db.close();
console.log(`[seed] Inserted ${inserted} sample memories for ${OWNER_EMAIL}`);
console.log("[seed] Reviewers can now test read, browse, search, and get-by-tag immediately.");
