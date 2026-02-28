// Reflect Memory — Entrypoint
// Reads config from environment, opens the database, seeds the user,
// starts the server. No new logic. No feature code. Just wiring.
//
// Load .env from project root for local development. In production,
// set env vars via Railway, systemd, or docker-compose.

import "dotenv/config";

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ServerConfig } from "./server.js";
import type { ModelGatewayConfig } from "./model-gateway.js";
import type { ProviderConfig } from "./chat-gateway.js";
import { isBackupConfigured, runBackup } from "./backup.js";
import { startMcpServer } from "./mcp-server.js";

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

// ~25K tokens worth of characters. Prevents prompt from exceeding model context windows.
const contextCharBudget = parseInt(optionalEnv("RM_CONTEXT_CHAR_BUDGET", "100000"), 10);

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
// Chat provider keys — for multi-model chat on the dashboard
// =============================================================================
// Each provider is optional. Only models with configured keys appear in /chat/models.
// RM_MODEL_API_KEY doubles as the OpenAI key for chat if RM_CHAT_OPENAI_KEY is not set.
// =============================================================================

const chatProviders: ProviderConfig = {
  openaiKey: optionalEnv("RM_CHAT_OPENAI_KEY", modelGateway.apiKey),
  openaiBaseUrl: optionalEnv("RM_CHAT_OPENAI_BASE_URL", "https://api.openai.com/v1"),
  anthropicKey: optionalEnv("RM_CHAT_ANTHROPIC_KEY", ""),
  googleKey: optionalEnv("RM_CHAT_GOOGLE_KEY", ""),
  perplexityKey: optionalEnv("RM_CHAT_PERPLEXITY_KEY", ""),
  xaiKey: optionalEnv("RM_CHAT_XAI_KEY", ""),
};

const dashboardServiceKey = optionalEnv("RM_DASHBOARD_SERVICE_KEY", "");
const dashboardJwtSecret = optionalEnv("RM_DASHBOARD_JWT_SECRET", "");

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

  const hasDeletedAt = db
    .prepare(
      `SELECT count(*) as count FROM pragma_table_info('memories') WHERE name = 'deleted_at'`,
    )
    .get() as { count: number };

  if (hasDeletedAt.count === 0) {
    db.exec(`ALTER TABLE memories ADD COLUMN deleted_at TEXT`);
  }

  const hasUserEmail = db
    .prepare(
      `SELECT count(*) as count FROM pragma_table_info('users') WHERE name = 'email'`,
    )
    .get() as { count: number };

  if (hasUserEmail.count === 0) {
    db.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
  }
}

// =============================================================================
// Migrations table
// =============================================================================
// Tracks one-time data migrations so they never re-run on subsequent deploys.
// =============================================================================

db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
)`);

// Migration: index for deterministic recency ordering (fixes "latest" returning wrong memory)
const idxMigrationName = "002_idx_memories_user_created";
const idxAlreadyRan = db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(idxMigrationName);
if (!idxAlreadyRan) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_user_created ON memories(user_id, created_at DESC)`);
  db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(
    idxMigrationName,
    new Date().toISOString(),
  );
}

// Migration: relabel origin "api" to "cursor" (all API-key writes were from Cursor)
const originMigrationName = "003_relabel_api_origin_to_cursor";
const originAlreadyRan = db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(originMigrationName);
if (!originAlreadyRan) {
  const updated = db.prepare(`UPDATE memories SET origin = 'cursor' WHERE origin = 'api'`).run();
  console.log(`[migration] Relabeled ${updated.changes} memories from origin "api" to "cursor"`);
  db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(
    originMigrationName,
    new Date().toISOString(),
  );
}

// =============================================================================
// Owner resolution
// =============================================================================
// RM_OWNER_EMAIL is the single source of truth for who the primary user is.
// On startup we guarantee exactly one user row with that email. The one-time
// migration absorbs orphaned NULL-email rows (from the old seeded-user bug).
// Legitimate users with emails are never touched.
// =============================================================================

const ownerEmail = optionalEnv("RM_OWNER_EMAIL", "").toLowerCase();

let userId: string;

if (ownerEmail) {
  let ownerRow = db
    .prepare(`SELECT id FROM users WHERE email = ?`)
    .get(ownerEmail) as { id: string } | undefined;

  if (!ownerRow) {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`).run(
      id,
      ownerEmail,
      now,
    );
    ownerRow = { id };
  }

  userId = ownerRow.id;

  // One-time migration: absorb orphaned NULL-email users into the owner.
  // Only runs once. Legitimate email-bearing users are never touched.
  const migrationName = "001_consolidate_owner_memories";
  const alreadyRan = db
    .prepare(`SELECT 1 FROM _migrations WHERE name = ?`)
    .get(migrationName);

  if (!alreadyRan) {
    const consolidate = db.transaction(() => {
      const orphans = db
        .prepare(`SELECT id FROM users WHERE id != ? AND email IS NULL`)
        .all(userId) as { id: string }[];

      for (const orphan of orphans) {
        db.prepare(`UPDATE memories SET user_id = ? WHERE user_id = ?`).run(
          userId,
          orphan.id,
        );
        db.prepare(`DELETE FROM users WHERE id = ?`).run(orphan.id);
      }

      db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(
        migrationName,
        new Date().toISOString(),
      );
    });
    consolidate();
  }
} else {
  const existingUser = db
    .prepare(`SELECT id FROM users LIMIT 1`)
    .get() as { id: string } | undefined;

  if (existingUser) {
    userId = existingUser.id;
  } else {
    userId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO users (id, created_at) VALUES (?, ?)`).run(userId, now);
  }
}

// =============================================================================
// Server startup
// =============================================================================

const chatProviderNames = [
  chatProviders.openaiKey ? "openai" : "",
  chatProviders.anthropicKey ? "anthropic" : "",
  chatProviders.googleKey ? "google" : "",
  chatProviders.perplexityKey ? "perplexity" : "",
  chatProviders.xaiKey ? "xai" : "",
].filter(Boolean);

const mcpPort = agentKeys["claude"]
  ? parseInt(optionalEnv("RM_MCP_PORT", "3001"), 10)
  : null;

const config: ServerConfig = {
  db,
  apiKey: API_KEY,
  userId,
  modelGateway,
  systemPrompt,
  startedAt: Date.now(),
  agentKeys,
  validVendors,
  contextCharBudget,
  chatProviders,
  dashboardServiceKey: dashboardServiceKey || null,
  dashboardJwtSecret: dashboardJwtSecret || null,
  mcpPort,
};

const server = await createServer(config);

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
  console.log(`Chat providers: ${chatProviderNames.length > 0 ? chatProviderNames.join(", ") : "(none configured)"}`);
  if (isBackupConfigured()) {
    console.log("Backup: configured (daily at 06:00 UTC)");
    scheduleDailyBackup();
  }

  // Start MCP server for Claude.ai Connectors if a Claude agent key is configured
  const claudeAgentKey = agentKeys["claude"];
  if (claudeAgentKey && mcpPort != null) {
    startMcpServer({ db, userId, agentKey: claudeAgentKey, vendor: "claude" }, mcpPort);
  }
});

// Daily backup at 06:00 UTC. Runs in-process; has access to the same volume as the API.
function scheduleDailyBackup() {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  function runAt6UTC() {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 0, 0));
    if (now >= next) next.setTime(next.getTime() + MS_PER_DAY);
    return next.getTime() - now.getTime();
  }
  function doBackup() {
    runBackup().catch((e) => console.error("[backup] Scheduled run failed:", e));
    setTimeout(doBackup, MS_PER_DAY);
  }
  setTimeout(doBackup, runAt6UTC());
}

// =============================================================================
// Graceful shutdown
// =============================================================================

function shutdown(signal: string) {
  console.log(`\n${signal} received — shutting down`);
  server.close().then(() => {
    db.close();
    console.log("Database closed. Goodbye.");
    process.exit(0);
  }).catch(() => {
    db.close();
    process.exit(1);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
