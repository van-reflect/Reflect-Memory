// Reflect Memory -- Entrypoint
// Reads config from environment, opens the database, seeds the user,
// starts the server. No new logic. No feature code. Just wiring.
//
// Load .env from project root for local development. In production,
// set env vars via Railway, systemd, or docker-compose.

import "dotenv/config";

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ServerConfig } from "./server.js";
import { EventBroker } from "./event-broker.js";
import type { ModelGatewayConfig } from "./model-gateway.js";
import type { ProviderConfig } from "./chat-gateway.js";
import { isBackupConfigured, runBackup } from "./backup.js";
import { startMcpServer } from "./mcp-server.js";
import {
  resolveDeploymentConfig,
  validateDeploymentConfig,
  enforceModelHostPolicy,
  freezeDeploymentConfig,
} from "./deployment-config.js";
import { createAuditTables, pruneAuditEvents } from "./audit-service.js";
import { runMigrationWithHooks } from "./migration-hooks.js";

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

function isPublicModelHost(urlValue: string): boolean {
  try {
    const host = new URL(urlValue).hostname.toLowerCase();
    return [
      "api.openai.com",
      "api.anthropic.com",
      "api.perplexity.ai",
      "api.x.ai",
      "generativelanguage.googleapis.com",
    ].includes(host);
  } catch {
    return false;
  }
}

const PORT = parseInt(optionalEnv("RM_PORT", optionalEnv("PORT", "3000")), 10);
const DB_PATH = optionalEnv("RM_DB_PATH", "/data/reflect-memory.db");
const API_KEY = requireEnv("RM_API_KEY");

const TEST_MODE = process.env.RM_TEST_MODE === "1";
if (TEST_MODE && process.env.NODE_ENV === "production") {
  console.error(
    "[SECURITY] Refusing to start: RM_TEST_MODE=1 is set while NODE_ENV=production. " +
    "RM_TEST_MODE disables the CI-memory quarantine and must never run in production. " +
    "If you're sure, unset one of them.",
  );
  process.exit(1);
}
if (TEST_MODE) {
  console.warn("[test-mode] RM_TEST_MODE=1 -- CI-memory quarantine DISABLED. Do not use in prod.");
}
const deployment = freezeDeploymentConfig(resolveDeploymentConfig(process.env));
validateDeploymentConfig(deployment);

const modelGateway: ModelGatewayConfig = {
  provider: "openai",
  model: deployment.disableModelEgress
    ? optionalEnv("RM_MODEL_NAME", "disabled")
    : requireEnv("RM_MODEL_NAME"),
  apiKey: deployment.disableModelEgress
    ? optionalEnv("RM_MODEL_API_KEY", "")
    : requireEnv("RM_MODEL_API_KEY"),
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

const agentKeys: Record<string, string> = {};
const AGENT_KEY_PREFIX = "RM_AGENT_KEY_";

for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith(AGENT_KEY_PREFIX) && value && value.trim().length > 0) {
    const vendor = key.slice(AGENT_KEY_PREFIX.length).toLowerCase();
    agentKeys[vendor] = value.trim();
  }
}

const validVendors = Object.keys(agentKeys);

const chatProviders: ProviderConfig = {
  openaiKey: deployment.disableModelEgress
    ? optionalEnv("RM_CHAT_OPENAI_KEY", "")
    : optionalEnv("RM_CHAT_OPENAI_KEY", modelGateway.apiKey),
  openaiBaseUrl: optionalEnv("RM_CHAT_OPENAI_BASE_URL", "https://api.openai.com/v1"),
  anthropicKey: optionalEnv("RM_CHAT_ANTHROPIC_KEY", ""),
  googleKey: optionalEnv("RM_CHAT_GOOGLE_KEY", ""),
  perplexityKey: optionalEnv("RM_CHAT_PERPLEXITY_KEY", ""),
  xaiKey: optionalEnv("RM_CHAT_XAI_KEY", ""),
};

enforceModelHostPolicy(modelGateway.baseUrl, deployment, "RM_MODEL_BASE_URL");
if (chatProviders.openaiBaseUrl) {
  enforceModelHostPolicy(
    chatProviders.openaiBaseUrl,
    deployment,
    "RM_CHAT_OPENAI_BASE_URL",
  );
}
if (
  deployment.requireInternalModelBaseUrl &&
  (isPublicModelHost(modelGateway.baseUrl) ||
    (chatProviders.openaiBaseUrl
      ? isPublicModelHost(chatProviders.openaiBaseUrl)
      : false))
) {
  console.error(
    "Deployment policy violation: RM_REQUIRE_INTERNAL_MODEL_BASE_URL is enabled but a public model host is configured.",
  );
  process.exit(1);
}

const dashboardServiceKey = optionalEnv("RM_DASHBOARD_SERVICE_KEY", "");
const dashboardJwtSecret = optionalEnv("RM_DASHBOARD_JWT_SECRET", "");

if (dashboardJwtSecret && dashboardJwtSecret.length < 32) {
  console.error(
    "[SECURITY] RM_DASHBOARD_JWT_SECRET must be at least 32 characters. " +
    "Generate one with: openssl rand -hex 32",
  );
  process.exit(1);
}

if (deployment.tenantId) {
  const dataDir = dirname(DB_PATH);
  const markerPath = resolve(dataDir, ".tenant_id");
  if (existsSync(markerPath)) {
    const existing = readFileSync(markerPath, "utf-8").trim();
    if (existing !== deployment.tenantId) {
      console.error(
        `[SECURITY] Tenant ID mismatch: data directory belongs to "${existing}" but config says "${deployment.tenantId}". ` +
        `This prevents accidental cross-tenant data access. Aborting.`,
      );
      process.exit(1);
    }
  } else {
    writeFileSync(markerPath, deployment.tenantId, "utf-8");
    console.log(`[tenant] Wrote tenant marker: ${deployment.tenantId}`);
  }
}

const db = new Database(DB_PATH);

db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

const journalMode = db.pragma("journal_mode = WAL") as Array<{ journal_mode: string }>;
if (journalMode[0]?.journal_mode !== "wal") {
  console.error(`WAL mode not active. Got: ${journalMode[0]?.journal_mode}`);
  process.exit(1);
}
db.pragma("synchronous = NORMAL");

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

  const hasMemoryType = db
    .prepare(
      `SELECT count(*) as count FROM pragma_table_info('memories') WHERE name = 'memory_type'`,
    )
    .get() as { count: number };

  if (hasMemoryType.count === 0) {
    db.exec(`ALTER TABLE memories ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'semantic'`);
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

// Migration: create waitlist and early_access_requests tables
const waitlistMigrationName = "004_waitlist_and_early_access";
const waitlistAlreadyRan = db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(waitlistMigrationName);
if (!waitlistAlreadyRan) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS waitlist (
        id          TEXT NOT NULL PRIMARY KEY,
        email       TEXT NOT NULL UNIQUE,
        position    INTEGER NOT NULL,
        notified    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS early_access_requests (
        id          TEXT NOT NULL PRIMARY KEY,
        email       TEXT NOT NULL,
        linkedin    TEXT,
        company     TEXT,
        use_case    TEXT,
        details     TEXT,
        status      TEXT NOT NULL DEFAULT 'pending',
        created_at  TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist(email);
    CREATE INDEX IF NOT EXISTS idx_waitlist_position ON waitlist(position);
    CREATE INDEX IF NOT EXISTS idx_early_access_email ON early_access_requests(email);
    CREATE INDEX IF NOT EXISTS idx_early_access_status ON early_access_requests(status);
  `);
  db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(
    waitlistMigrationName,
    new Date().toISOString(),
  );
}

// Migration: v1 schema -- add role, plan, clerk_id, stripe_customer_id, updated_at to users
const v1UsersMigration = "005_v1_users_columns";
const v1UsersRan = db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(v1UsersMigration);
if (!v1UsersRan) {
  const hasRole = (db.prepare(`SELECT count(*) as count FROM pragma_table_info('users') WHERE name = 'role'`).get() as { count: number }).count > 0;
  if (!hasRole) {
    db.exec(`ALTER TABLE users ADD COLUMN clerk_id TEXT`);
    db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`);
    db.exec(`ALTER TABLE users ADD COLUMN stripe_customer_id TEXT`);
    db.exec(`ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'`);
    db.exec(`ALTER TABLE users ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
    db.exec(`UPDATE users SET updated_at = created_at WHERE updated_at = ''`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_clerk_id ON users(clerk_id)`);
  }
  db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(v1UsersMigration, new Date().toISOString());
}

// Migration: v1 schema -- create api_keys table
const v1ApiKeysMigration = "006_v1_api_keys";
const v1ApiKeysRan = db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(v1ApiKeysMigration);
if (!v1ApiKeysRan) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
        id              TEXT NOT NULL PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key_hash        TEXT NOT NULL UNIQUE,
        key_prefix      TEXT NOT NULL,
        label           TEXT NOT NULL DEFAULT 'Default',
        last_used_at    TEXT,
        created_at      TEXT NOT NULL,
        revoked_at      TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
  `);
  db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(v1ApiKeysMigration, new Date().toISOString());
}

// Migration: v1 schema -- create usage_events and monthly_usage tables
const v1UsageMigration = "007_v1_usage_tables";
const v1UsageRan = db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(v1UsageMigration);
if (!v1UsageRan) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
        id              TEXT NOT NULL PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        operation       TEXT NOT NULL,
        origin          TEXT NOT NULL,
        request_id      TEXT UNIQUE,
        created_at      TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_usage_events_user_id ON usage_events(user_id);
    CREATE INDEX IF NOT EXISTS idx_usage_events_user_month ON usage_events(user_id, created_at);

    CREATE TABLE IF NOT EXISTS monthly_usage (
        id              TEXT NOT NULL PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        month           TEXT NOT NULL,
        writes          INTEGER NOT NULL DEFAULT 0,
        reads           INTEGER NOT NULL DEFAULT 0,
        queries         INTEGER NOT NULL DEFAULT 0,
        total_ops       INTEGER NOT NULL DEFAULT 0,
        overage_ops     INTEGER NOT NULL DEFAULT 0,
        synced_to_stripe INTEGER NOT NULL DEFAULT 0,
        UNIQUE(user_id, month)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_monthly_usage_user_month ON monthly_usage(user_id, month);
  `);
  db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(v1UsageMigration, new Date().toISOString());
}

// Migration: add memory_type column to memories
const memoryTypeMigrationName = "008_add_memory_type";
const memoryTypeMigrationRan = db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(memoryTypeMigrationName);
if (!memoryTypeMigrationRan) {
  db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(
    memoryTypeMigrationName,
    new Date().toISOString(),
  );
}

// Migration: create memory_versions table for version history
const memoryVersionsMigrationName = "009_memory_versions";
const memoryVersionsMigrationRan = db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(memoryVersionsMigrationName);
if (!memoryVersionsMigrationRan) {
  const hasMemoryVersions = db
    .prepare(
      `SELECT count(*) as count FROM sqlite_master WHERE type = 'table' AND name = 'memory_versions'`,
    )
    .get() as { count: number };

  if (hasMemoryVersions.count === 0) {
    db.exec(`CREATE TABLE memory_versions (
      id              TEXT NOT NULL PRIMARY KEY,
      memory_id       TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      title           TEXT NOT NULL,
      content         TEXT NOT NULL,
      tags            TEXT NOT NULL DEFAULT '[]' CHECK(json_type(tags) = 'array'),
      memory_type     TEXT NOT NULL DEFAULT 'semantic' CHECK(memory_type IN ('semantic', 'episodic', 'procedural')),
      origin          TEXT NOT NULL,
      allowed_vendors TEXT NOT NULL DEFAULT '["*"]' CHECK(json_type(allowed_vendors) = 'array'),
      version_number  INTEGER NOT NULL,
      created_at      TEXT NOT NULL
    ) STRICT`);
    db.exec(`CREATE INDEX idx_memory_versions_memory_id ON memory_versions(memory_id, version_number)`);
  }

  db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(
    memoryVersionsMigrationName,
    new Date().toISOString(),
  );
}

// Migration: add UNIQUE constraint on (memory_id, version_number) to prevent duplicate versions
const uniqueVersionMigration = "010_unique_version_number";
if (!db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(uniqueVersionMigration)) {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_versions_unique_number ON memory_versions(memory_id, version_number)`);
  db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(
    uniqueVersionMigration,
    new Date().toISOString(),
  );
}

// Migration: bulk soft-delete existing CI integration test memories.
// Skipped when RM_TEST_MODE=1 (tests need to write + read CI-looking memories).
const ciTrashMigrationName = "011_bulk_trash_ci_test_memories";
if (!TEST_MODE && !db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(ciTrashMigrationName)) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE memories
    SET deleted_at = ?, updated_at = ?
    WHERE deleted_at IS NULL
    AND (
      title LIKE 'CI %' OR title LIKE '%ci-%'
      OR EXISTS (
        SELECT 1 FROM json_each(tags)
        WHERE value LIKE 'ci_%' OR value LIKE '%integration_test%'
      )
    )
  `);
  const result = stmt.run(now, now);
  if (result.changes > 0) {
    console.log(`[migration] Soft-deleted ${result.changes} CI test memories`);
  }
  db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(
    ciTrashMigrationName,
    now,
  );
}

// Migration: create OAuth tables for MCP native connector
import { createOAuthTables, ensureOAuthUserColumns } from "./oauth-store.js";
const oauthMigrationName = "012_oauth_tables";
if (!db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(oauthMigrationName)) {
  createOAuthTables(db);
  db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(
    oauthMigrationName,
    new Date().toISOString(),
  );
  console.log("[migration] Created OAuth tables for MCP connector");
}

const oauthPendingMigration = "013_oauth_pending_requests";
if (!db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(oauthPendingMigration)) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_pending_requests (
      id            TEXT NOT NULL PRIMARY KEY,
      client_id     TEXT NOT NULL,
      client_name   TEXT,
      redirect_uri  TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      scopes        TEXT NOT NULL DEFAULT '[]',
      state         TEXT,
      resource      TEXT,
      expires_at    TEXT NOT NULL,
      created_at    TEXT NOT NULL
    ) STRICT;
  `);
  db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(
    oauthPendingMigration,
    new Date().toISOString(),
  );
  console.log("[migration] Created oauth_pending_requests table for consent flow");
}

const integrationReqMigration = "014_integration_requests";
if (!db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(integrationReqMigration)) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_requests (
      id            TEXT NOT NULL PRIMARY KEY,
      email         TEXT NOT NULL,
      company_name  TEXT NOT NULL,
      website       TEXT,
      description   TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_integration_requests_email ON integration_requests(email);
    CREATE INDEX IF NOT EXISTS idx_integration_requests_status ON integration_requests(status);
  `);
  db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(
    integrationReqMigration,
    new Date().toISOString(),
  );
  console.log("[migration] Created integration_requests table");
}

const auditEventsMigration = "015_audit_events";
if (!db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(auditEventsMigration)) {
  runMigrationWithHooks(db, auditEventsMigration, () => {
    createAuditTables(db);
  });
  console.log("[migration] Created audit_events table");
}

const adminPlanMigration = "016_admin_plan_for_owner";
if (!db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(adminPlanMigration)) {
  db.prepare(`UPDATE users SET plan = 'admin', updated_at = ? WHERE role = 'admin'`)
    .run(new Date().toISOString());
  db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(
    adminPlanMigration,
    new Date().toISOString(),
  );
  console.log("[migration] Set admin users to admin plan (unlimited)");
}

const phantomReadsMigration = "017_reset_phantom_reads";
if (!db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(phantomReadsMigration)) {
  // Users with 0 writes and 0 memories had all reads generated by idle
  // dashboard polling against empty accounts. Reset to accurate counts.
  const result = db.prepare(`
    UPDATE monthly_usage
    SET reads = 0, total_ops = writes + queries
    WHERE user_id IN (
      SELECT mu.user_id FROM monthly_usage mu
      JOIN users u ON u.id = mu.user_id
      WHERE mu.writes = 0
        AND (SELECT COUNT(*) FROM memories m WHERE m.user_id = mu.user_id AND m.deleted_at IS NULL) = 0
        AND mu.reads > 0
    )
  `).run();
  if (result.changes > 0) {
    console.log(`[migration] Reset phantom reads for ${result.changes} monthly_usage rows`);
  }
  // Also clean the usage_events table for accuracy
  const evtResult = db.prepare(`
    DELETE FROM usage_events
    WHERE operation = 'memory_read'
      AND user_id IN (
        SELECT u.id FROM users u
        WHERE (SELECT COUNT(*) FROM memories m WHERE m.user_id = u.id AND m.deleted_at IS NULL) = 0
          AND (SELECT COUNT(*) FROM usage_events ue WHERE ue.user_id = u.id AND ue.operation = 'memory_write') = 0
      )
  `).run();
  if (evtResult.changes > 0) {
    console.log(`[migration] Deleted ${evtResult.changes} phantom read events`);
  }
  db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(
    phantomReadsMigration,
    new Date().toISOString(),
  );
}

const oauthUserIdMigration = "018_oauth_user_id_columns";
if (!db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(oauthUserIdMigration)) {
  ensureOAuthUserColumns(db);
  db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(
    oauthUserIdMigration,
    new Date().toISOString(),
  );
  console.log("[migration] Added user_id columns to OAuth tables and created agent_keys");
}

const teamsAndSharedMigration = "019_teams_and_shared_namespace";
if (!db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(teamsAndSharedMigration)) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id          TEXT NOT NULL PRIMARY KEY,
      name        TEXT NOT NULL,
      owner_id    TEXT NOT NULL REFERENCES users(id),
      plan        TEXT NOT NULL DEFAULT 'team',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS team_invites (
      id          TEXT NOT NULL PRIMARY KEY,
      team_id     TEXT NOT NULL REFERENCES teams(id),
      email       TEXT,
      token       TEXT NOT NULL UNIQUE,
      invited_by  TEXT NOT NULL REFERENCES users(id),
      status      TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending', 'accepted', 'expired')),
      created_at  TEXT NOT NULL,
      expires_at  TEXT NOT NULL
    ) STRICT;
  `);

  const addCol = (table: string, col: string, def: string) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
    catch (e) { if (!(e instanceof Error && e.message.includes("duplicate column"))) throw e; }
  };

  addCol("users", "team_id", "TEXT REFERENCES teams(id)");
  addCol("users", "team_role", "TEXT DEFAULT NULL CHECK(team_role IN ('owner', 'member'))");
  addCol("users", "first_name", "TEXT DEFAULT NULL");
  addCol("users", "last_name", "TEXT DEFAULT NULL");
  addCol("memories", "shared_with_team_id", "TEXT REFERENCES teams(id)");
  addCol("memories", "shared_at", "TEXT DEFAULT NULL");

  db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(
    teamsAndSharedMigration,
    new Date().toISOString(),
  );
  console.log("[migration] Created teams, team_invites tables and added team columns");
}

const planCheckMigration = "020_expand_plan_check_constraint";
if (!db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(planCheckMigration)) {
  const currentSql = (
    db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'`).get() as { sql: string } | undefined
  )?.sql ?? "";

  const needsRebuild = currentSql.includes("'free', 'builder')") && !currentSql.includes("'team'");

  if (needsRebuild) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.transaction(() => {
      db.exec(`
        CREATE TABLE users_new (
          id                  TEXT NOT NULL PRIMARY KEY,
          clerk_id            TEXT UNIQUE,
          email               TEXT NOT NULL UNIQUE,
          role                TEXT NOT NULL DEFAULT 'user'
                              CHECK(role IN ('admin', 'private-alpha', 'user')),
          stripe_customer_id  TEXT UNIQUE,
          plan                TEXT NOT NULL DEFAULT 'free'
                              CHECK(plan IN ('free', 'builder', 'pro', 'team', 'admin')),
          team_id             TEXT REFERENCES teams(id),
          team_role           TEXT DEFAULT NULL
                              CHECK(team_role IN ('owner', 'member')),
          first_name          TEXT DEFAULT NULL,
          last_name           TEXT DEFAULT NULL,
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL
        ) STRICT;
      `);

      const cols = (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map((c) => c.name);
      const newCols = new Set(
        (db.prepare(`PRAGMA table_info(users_new)`).all() as { name: string }[]).map((c) => c.name),
      );
      const shared = cols.filter((c) => newCols.has(c)).join(", ");

      db.exec(`INSERT INTO users_new (${shared}) SELECT ${shared} FROM users`);
      db.exec(`DROP TABLE users`);
      db.exec(`ALTER TABLE users_new RENAME TO users`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_users_clerk_id ON users(clerk_id)`);
    })();
    db.exec("PRAGMA foreign_keys = ON");
    console.log("[migration] Rebuilt users table with expanded plan CHECK constraint");
  }

  db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(
    planCheckMigration,
    new Date().toISOString(),
  );
}

// Migration: add parent_memory_id for threading. One level only (enforced in
// the app layer). Nullable; existing memories remain top-level.
const memoryThreadingMigration = "021_memory_threading_parent_id";
if (!db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(memoryThreadingMigration)) {
  const hasParentCol = (
    db
      .prepare(
        `SELECT count(*) as count FROM pragma_table_info('memories') WHERE name = 'parent_memory_id'`,
      )
      .get() as { count: number }
  ).count;

  if (hasParentCol === 0) {
    // Note: ALTER TABLE ADD COLUMN with a REFERENCES clause is legal in SQLite
    // but only creates the FK metadata; enforcement still respects
    // PRAGMA foreign_keys. The cascade behavior we want on parent purge is
    // handled in app code (see memory-service.ts cascade helpers), so we
    // deliberately do NOT attach ON DELETE CASCADE here — the app code needs
    // to emit SSE events per child, which a SQL cascade would skip.
    db.exec(
      `ALTER TABLE memories ADD COLUMN parent_memory_id TEXT REFERENCES memories(id)`,
    );
  }

  // Index to make "list children of parent" queries fast.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_memories_parent_id ON memories(parent_memory_id) WHERE parent_memory_id IS NOT NULL`,
  );

  db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(
    memoryThreadingMigration,
    new Date().toISOString(),
  );
}

// Tag cluster cache: stores the LLM-generated names for tag clusters so we
// don't pay the naming cost on every briefing build. Keyed on
// (user_id, scope, cluster_hash); the hash is sha256(sorted_tag_list) so
// small structural drift in the corpus doesn't invalidate the cache. Stale
// entries get re-derived after 24h or when the briefing detects N=20 new
// memories since the last compute. See cluster-naming.ts.
const tagClusterCacheMigration = "022_tag_cluster_cache";
if (!db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(tagClusterCacheMigration)) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tag_cluster_cache (
      user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scope          TEXT NOT NULL,
      cluster_hash   TEXT NOT NULL,
      name           TEXT NOT NULL,
      description    TEXT NOT NULL,
      tags           TEXT NOT NULL CHECK(json_type(tags) = 'array'),
      member_count   INTEGER NOT NULL,
      computed_at    TEXT NOT NULL,
      PRIMARY KEY (user_id, scope, cluster_hash)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_tag_cluster_cache_user_scope ON tag_cluster_cache(user_id, scope);
  `);
  db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(
    tagClusterCacheMigration,
    new Date().toISOString(),
  );
}

// Primary owner (RM_OWNER_EMAIL) anchors orphan consolidation and the legacy
// single-tenant userId semantics. Additional admins come from RM_OWNER_EMAILS
// (comma-separated). Both envs coexist: the singular is always included in the
// admin set; the plural widens it. Ordering: primary = singular if set, else
// first plural entry, else fall back to the existing "first user" behavior.
const primaryOwnerEmail = optionalEnv("RM_OWNER_EMAIL", "").toLowerCase();
const extraOwnerEmails = optionalEnv("RM_OWNER_EMAILS", "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter((e) => e.length > 0);

const ownerEmails: string[] = [];
if (primaryOwnerEmail) ownerEmails.push(primaryOwnerEmail);
for (const email of extraOwnerEmails) {
  if (!ownerEmails.includes(email)) ownerEmails.push(email);
}

const hasUpdatedAt = (db.prepare(
  `SELECT count(*) as count FROM pragma_table_info('users') WHERE name = 'updated_at'`,
).get() as { count: number }).count > 0;
const hasRole = (db.prepare(
  `SELECT count(*) as count FROM pragma_table_info('users') WHERE name = 'role'`,
).get() as { count: number }).count > 0;

function ensureAdminUser(email: string): string {
  let row = db
    .prepare(`SELECT id FROM users WHERE email = ?`)
    .get(email) as { id: string } | undefined;

  if (!row) {
    const id = randomUUID();
    const now = new Date().toISOString();
    if (hasUpdatedAt) {
      db.prepare(
        `INSERT INTO users (id, email, role, plan, created_at, updated_at) VALUES (?, ?, 'admin', 'free', ?, ?)`,
      ).run(id, email, now, now);
    } else {
      db.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`).run(id, email, now);
    }
    row = { id };
  } else if (hasRole) {
    db.prepare(`UPDATE users SET role = 'admin' WHERE id = ? AND role != 'admin'`).run(row.id);
  }
  return row.id;
}

let userId: string;
const ownerUserIds = new Set<string>();

if (ownerEmails.length > 0) {
  const resolvedIds = ownerEmails.map(ensureAdminUser);
  for (const id of resolvedIds) ownerUserIds.add(id);
  userId = resolvedIds[0]!;

  // One-time migration: absorb orphaned NULL-email users into the primary owner.
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
        db.prepare(`UPDATE memories SET user_id = ? WHERE user_id = ?`).run(userId, orphan.id);
        db.prepare(`UPDATE memory_versions SET user_id = ? WHERE user_id = ?`).run(userId, orphan.id);
        db.prepare(`UPDATE usage_events SET user_id = ? WHERE user_id = ?`).run(userId, orphan.id);
        db.prepare(`UPDATE monthly_usage SET user_id = ? WHERE user_id = ?`).run(userId, orphan.id);
        db.prepare(`DELETE FROM api_keys WHERE user_id = ?`).run(orphan.id);
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
  ownerUserIds.add(userId);
}

const chatProviderNames = [
  chatProviders.openaiKey ? "openai" : "",
  chatProviders.anthropicKey ? "anthropic" : "",
  chatProviders.googleKey ? "google" : "",
  chatProviders.perplexityKey ? "perplexity" : "",
  chatProviders.xaiKey ? "xai" : "",
].filter(Boolean);

const mcpPortEnv = optionalEnv("RM_MCP_PORT", "3001");
const mcpPort = (validVendors.length > 0 || optionalEnv("RM_PUBLIC_URL", ""))
  ? parseInt(mcpPortEnv, 10)
  : null;

const chatgptClientId = optionalEnv("RM_CHATGPT_CLIENT_ID", "");
const chatgptClientSecret = optionalEnv("RM_CHATGPT_CLIENT_SECRET", "");

const eventBroker = new EventBroker();

const config: ServerConfig = {
  db,
  apiKey: API_KEY,
  userId,
  ownerUserIds,
  eventBroker,
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
  deployment,
  chatgptClientId: chatgptClientId || null,
  chatgptClientSecret: chatgptClientSecret || null,
  testMode: TEST_MODE,
};

const server = await createServer(config);

server.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  }
  console.log(`Reflect Memory listening on ${address}`);
  console.log(`User ID: ${userId.slice(0, 8)}...`);
  if (ownerUserIds.size > 1) {
    console.log(`Admins: ${ownerUserIds.size} (${ownerEmails.join(", ")})`);
  }
  console.log(`Database: ${DB_PATH}`);
  console.log(`Model: ${modelGateway.provider}/${modelGateway.model}`);
  console.log(`Agent vendors: ${validVendors.length > 0 ? validVendors.join(", ") : "(none configured)"}`);
  console.log(`Chat providers: ${chatProviderNames.length > 0 ? chatProviderNames.join(", ") : "(none configured)"}`);
  console.log(`Deployment mode: ${deployment.mode} (${deployment.networkBoundary})`);
  console.log(`Model egress: ${deployment.disableModelEgress ? "disabled" : "enabled"}`);
  if (deployment.mode === "self-host" && !deployment.disableModelEgress) {
    console.warn("[SECURITY WARNING] Model egress is ENABLED in self-host mode. Data may leave the network.");
  }
  if (deployment.mode === "self-host" && deployment.allowPublicWebhooks) {
    console.warn("[SECURITY WARNING] Public webhooks are ENABLED in self-host mode.");
  }
  if (isBackupConfigured()) {
    console.log("Backup: configured (daily at 06:00 UTC)");
    scheduleDailyBackup();
  }

  const auditRetentionDays = parseInt(optionalEnv("RM_AUDIT_RETENTION_DAYS", "90"), 10);
  if (auditRetentionDays > 0) {
    scheduleAuditPruning(auditRetentionDays);
  }

  // Start MCP server when agent keys or OAuth (RM_PUBLIC_URL) is configured
  if (mcpPort != null) {
    const mcpPublicUrl = optionalEnv("RM_PUBLIC_URL", "");
    startMcpServer({
      db,
      userId,
      agentKeys,
      publicUrl: mcpPublicUrl || undefined,
      dashboardUrl: optionalEnv("RM_DASHBOARD_URL", "https://reflectmemory.com"),
      dashboardJwtSecret: dashboardJwtSecret || undefined,
      dashboardServiceKey: dashboardServiceKey || undefined,
    }, mcpPort);
  }
});

function scheduleDailyBackup() {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  function msUntil6UTC() {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 0, 0));
    if (now >= next) next.setTime(next.getTime() + MS_PER_DAY);
    return next.getTime() - now.getTime();
  }
  function doBackup() {
    runBackup()
      .catch((e) => console.error("[backup] Scheduled run failed:", e))
      .finally(() => setTimeout(doBackup, msUntil6UTC()));
  }
  setTimeout(doBackup, msUntil6UTC());
}

function scheduleAuditPruning(retentionDays: number) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  function doPrune() {
    try {
      const deleted = pruneAuditEvents(db, retentionDays);
      if (deleted > 0) {
        console.log(`[audit] Pruned ${deleted} events older than ${retentionDays} days`);
      }
    } catch (e) {
      console.error("[audit] Pruning failed:", e);
    }
    setTimeout(doPrune, MS_PER_DAY);
  }
  setTimeout(doPrune, 60_000);
}

function shutdown(signal: string) {
  console.log(`\n${signal} received -- shutting down`);
  const forceExit = setTimeout(() => {
    console.error("Shutdown timed out -- forcing exit");
    try { db.pragma("optimize"); } catch {}
    try { db.close(); } catch {}
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try { eventBroker.shutdown(); } catch {}

  server.close().then(() => {
    try { db.pragma("optimize"); } catch {}
    db.close();
    clearTimeout(forceExit);
    console.log("Database closed. Goodbye.");
    process.exit(0);
  }).catch(() => {
    try { db.close(); } catch {}
    clearTimeout(forceExit);
    process.exit(1);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
