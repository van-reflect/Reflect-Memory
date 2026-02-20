// Reflect Memory — Entrypoint
// Reads config from environment, opens the database, seeds the user,
// starts the server. No new logic. No feature code. Just wiring.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ServerConfig } from "./server.js";
import type { ModelGatewayConfig } from "./model-gateway.js";

// =============================================================================
// Environment loading
// =============================================================================
// All configuration comes from environment variables. No .env file parser —
// set them in your shell, docker-compose, or systemd unit. Explicit.
//
// Required:
//   RM_API_KEY          — the API key clients must send in Authorization header (user key)
//   RM_MODEL_API_KEY    — the API key for the model provider (e.g. OpenAI)
//   RM_MODEL_NAME       — model identifier (e.g. "gpt-4o", "gpt-4o-mini")
//
// Optional (with sensible defaults noted):
//   RM_PORT             — HTTP port (default: 3000)
//   RM_DB_PATH          — SQLite file path (default: /data/reflect-memory.db)
//   RM_MODEL_BASE_URL   — model API base URL (default: https://api.openai.com/v1)
//   RM_MODEL_TEMPERATURE — temperature (default: 0.7)
//   RM_MODEL_MAX_TOKENS  — max tokens (default: 1024)
//   RM_SYSTEM_PROMPT     — system prompt for AI queries
//
// Agent keys (dynamic, per-vendor):
//   RM_AGENT_KEY_CHATGPT  — agent key for vendor "chatgpt"
//   RM_AGENT_KEY_CLAUDE   — agent key for vendor "claude"
//   RM_AGENT_KEY_<NAME>   — any env var matching this pattern registers a vendor
// =============================================================================

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value.trim();
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) return fallback;
  return value.trim();
}

// =============================================================================
// Read config
// =============================================================================

const PORT = parseInt(optionalEnv("RM_PORT", optionalEnv("PORT", "3000")), 10);
const DB_PATH = optionalEnv("RM_DB_PATH", "/data/reflect-memory.db");
const API_KEY = requireEnv("RM_API_KEY");

const modelGateway: ModelGatewayConfig = {
  provider: "openai",
  model: requireEnv("RM_MODEL_NAME"),
  apiKey: requireEnv("RM_MODEL_API_KEY"),
  baseUrl: optionalEnv("RM_MODEL_BASE_URL", "https://api.openai.com/v1"),
  parameters: {
    temperature: parseFloat(optionalEnv("RM_MODEL_TEMPERATURE", "0.7")),
    maxTokens: parseInt(optionalEnv("RM_MODEL_MAX_TOKENS", "1024"), 10),
  },
};

const systemPrompt = optionalEnv(
  "RM_SYSTEM_PROMPT",
  "You are a helpful assistant. The user has provided memory entries for context. Use them to inform your response. Do not fabricate information that is not in the provided memories.",
);

// =============================================================================
// Agent keys — discovered from RM_AGENT_KEY_* environment variables
// =============================================================================
// Each RM_AGENT_KEY_<VENDOR> env var registers a vendor with its own API key.
// The vendor name is derived from the suffix, lowercased.
// Example: RM_AGENT_KEY_CHATGPT=sk-agent-abc → vendor "chatgpt" with key "sk-agent-abc"
// =============================================================================

const agentKeys: Record<string, string> = {};
const AGENT_KEY_PREFIX = "RM_AGENT_KEY_";

for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith(AGENT_KEY_PREFIX) && value && value.trim().length > 0) {
    const vendor = key.slice(AGENT_KEY_PREFIX.length).toLowerCase();
    agentKeys[vendor] = value.trim();
  }
}

const validVendors = Object.keys(agentKeys);

// =============================================================================
// Database setup
// =============================================================================

const db = new Database(DB_PATH);

// Invariant: foreign keys must be enforced on every connection.
db.pragma("foreign_keys = ON");

// WAL mode for better read concurrency. Works on Railway volumes (ext4).
// Returns the active journal mode — verify it's actually "wal".
const journalMode = db.pragma("journal_mode = WAL") as Array<{ journal_mode: string }>;
if (journalMode[0]?.journal_mode !== "wal") {
  console.error(`WAL mode not active. Got: ${journalMode[0]?.journal_mode}`);
  process.exit(1);
}

// Run the schema. Uses IF NOT EXISTS logic via a version check:
// if the users table doesn't exist, this is a fresh database.
const tableExists = db
  .prepare(
    `SELECT count(*) as count FROM sqlite_master
     WHERE type = 'table' AND name = 'users'`,
  )
  .get() as { count: number };

if (tableExists.count === 0) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const schemaPath = resolve(__dirname, "..", "schema.sql");
  const schemaSql = readFileSync(schemaPath, "utf-8");
  db.exec(schemaSql);
} else {
  // Migrate existing databases: add origin and allowed_vendors if missing.
  const hasOrigin = db
    .prepare(
      `SELECT count(*) as count FROM pragma_table_info('memories') WHERE name = 'origin'`,
    )
    .get() as { count: number };

  if (hasOrigin.count === 0) {
    db.exec(`ALTER TABLE memories ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'`);
    db.exec(
      `ALTER TABLE memories ADD COLUMN allowed_vendors TEXT NOT NULL DEFAULT '["*"]' CHECK(json_type(allowed_vendors) = 'array')`,
    );
  }
}

// =============================================================================
// User seeding
// =============================================================================
// Single-user MVP: ensure exactly one user exists. If the table is empty,
// create one. If a user already exists, use that user's ID.
// This runs once at startup. No user creation endpoint exists.
// =============================================================================

const existingUser = db
  .prepare(`SELECT id FROM users LIMIT 1`)
  .get() as { id: string } | undefined;

let userId: string;

if (existingUser) {
  userId = existingUser.id;
} else {
  userId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (id, created_at) VALUES (?, ?)`).run(userId, now);
}

// =============================================================================
// Server startup
// =============================================================================

const config: ServerConfig = {
  db,
  apiKey: API_KEY,
  userId,
  modelGateway,
  systemPrompt,
  startedAt: Date.now(),
  agentKeys,
  validVendors,
};

const server = createServer(config);

server.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  }
  console.log(`Reflect Memory listening on ${address}`);
  console.log(`User ID: ${userId}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Model: ${modelGateway.provider}/${modelGateway.model}`);
  console.log(`Agent vendors: ${validVendors.length > 0 ? validVendors.join(", ") : "(none configured)"}`);
});
