#!/usr/bin/env npx tsx
// Reflect Memory -- SQLite to Postgres Migration Script
//
// Usage:
//   RM_DB_PATH=/data/reflect-memory.db DATABASE_URL=postgres://... npx tsx scripts/migrate-to-postgres.ts
//
// Prerequisites:
//   - Postgres database initialized with schema-postgres.sql
//   - npm install pg (add to dependencies)
//
// This script:
//   1. Reads all data from SQLite
//   2. Inserts into Postgres in the correct order (users → api_keys → memories → etc.)
//   3. Preserves all IDs and timestamps
//   4. Reports row counts for verification

import Database from "better-sqlite3";

const DB_PATH = process.env.RM_DB_PATH ?? "/data/reflect-memory.db";
const PG_URL = process.env.DATABASE_URL;

if (!PG_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sqlite = new Database(DB_PATH, { readonly: true });
sqlite.pragma("foreign_keys = ON");

async function migrate() {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: PG_URL });

  try {
    console.log("[migrate] Connected to Postgres");

    // --- Users ---
    const users = sqlite.prepare("SELECT * FROM users").all() as Array<Record<string, unknown>>;
    console.log(`[migrate] Migrating ${users.length} users...`);

    for (const u of users) {
      await pool.query(
        `INSERT INTO users (id, clerk_id, email, role, stripe_customer_id, plan, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          u.id,
          u.clerk_id ?? null,
          u.email,
          u.role ?? "user",
          u.stripe_customer_id ?? null,
          u.plan ?? "free",
          u.created_at,
          u.updated_at ?? u.created_at,
        ],
      );
    }

    // --- API Keys ---
    const hasApiKeys = sqlite
      .prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='api_keys'")
      .get() as { count: number };

    if (hasApiKeys.count > 0) {
      const keys = sqlite.prepare("SELECT * FROM api_keys").all() as Array<Record<string, unknown>>;
      console.log(`[migrate] Migrating ${keys.length} API keys...`);

      for (const k of keys) {
        await pool.query(
          `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, label, last_used_at, created_at, revoked_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO NOTHING`,
          [k.id, k.user_id, k.key_hash, k.key_prefix, k.label, k.last_used_at, k.created_at, k.revoked_at],
        );
      }
    }

    // --- Memories ---
    const memories = sqlite.prepare("SELECT * FROM memories").all() as Array<Record<string, unknown>>;
    console.log(`[migrate] Migrating ${memories.length} memories...`);

    for (const m of memories) {
      await pool.query(
        `INSERT INTO memories (id, user_id, title, content, tags, origin, allowed_vendors, created_at, updated_at, deleted_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING`,
        [
          m.id, m.user_id, m.title, m.content,
          m.tags, m.origin, m.allowed_vendors,
          m.created_at, m.updated_at, m.deleted_at,
        ],
      );
    }

    // --- Usage Events ---
    const hasUsageEvents = sqlite
      .prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='usage_events'")
      .get() as { count: number };

    if (hasUsageEvents.count > 0) {
      const events = sqlite.prepare("SELECT * FROM usage_events").all() as Array<Record<string, unknown>>;
      console.log(`[migrate] Migrating ${events.length} usage events...`);

      for (const e of events) {
        await pool.query(
          `INSERT INTO usage_events (id, user_id, operation, origin, request_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT DO NOTHING`,
          [e.id, e.user_id, e.operation, e.origin, e.request_id, e.created_at],
        );
      }
    }

    // --- Monthly Usage ---
    const hasMonthlyUsage = sqlite
      .prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='monthly_usage'")
      .get() as { count: number };

    if (hasMonthlyUsage.count > 0) {
      const monthly = sqlite.prepare("SELECT * FROM monthly_usage").all() as Array<Record<string, unknown>>;
      console.log(`[migrate] Migrating ${monthly.length} monthly usage records...`);

      for (const m of monthly) {
        await pool.query(
          `INSERT INTO monthly_usage (id, user_id, month, writes, reads, queries, total_ops, overage_ops, synced_to_stripe)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT DO NOTHING`,
          [m.id, m.user_id, m.month, m.writes, m.reads, m.queries, m.total_ops, m.overage_ops, m.synced_to_stripe],
        );
      }
    }

    // --- Waitlist ---
    const waitlist = sqlite.prepare("SELECT * FROM waitlist").all() as Array<Record<string, unknown>>;
    console.log(`[migrate] Migrating ${waitlist.length} waitlist entries...`);

    for (const w of waitlist) {
      await pool.query(
        `INSERT INTO waitlist (id, email, position, notified, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [w.id, w.email, w.position, w.notified, w.created_at],
      );
    }

    // --- Early Access ---
    const earlyAccess = sqlite.prepare("SELECT * FROM early_access_requests").all() as Array<Record<string, unknown>>;
    console.log(`[migrate] Migrating ${earlyAccess.length} early access requests...`);

    for (const e of earlyAccess) {
      await pool.query(
        `INSERT INTO early_access_requests (id, email, linkedin, company, use_case, details, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [e.id, e.email, e.linkedin, e.company, e.use_case, e.details, e.status, e.created_at],
      );
    }

    // --- Migrations ---
    const migrations = sqlite.prepare("SELECT * FROM _migrations").all() as Array<Record<string, unknown>>;
    for (const m of migrations) {
      await pool.query(
        `INSERT INTO _migrations (name, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [m.name, m.applied_at],
      );
    }

    // --- Verification ---
    console.log("\n[migrate] Verification:");
    const tables = ["users", "memories", "api_keys", "usage_events", "monthly_usage", "waitlist", "early_access_requests"];
    for (const t of tables) {
      const result = await pool.query(`SELECT count(*) as count FROM ${t}`);
      console.log(`  ${t}: ${result.rows[0].count} rows`);
    }

    console.log("\n[migrate] Migration complete!");
  } finally {
    await pool.end();
    sqlite.close();
  }
}

migrate().catch((err) => {
  console.error("[migrate] Fatal error:", err);
  process.exit(1);
});
