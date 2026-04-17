// Unit-test DB factory.
//
// Spawns a fresh in-memory better-sqlite3 instance with the canonical schema
// loaded from schema.sql plus the audit table created on demand. Each test
// gets its own isolated DB — no shared state, no migrations, no async setup.
//
// Why this exists:
//   - Integration tests already exercise the API end-to-end.
//   - Unit tests need to drill into edge cases of individual service modules
//     (jaccard math, key hashing, plan limits, idempotency keys) at a level
//     that's awkward to reach through HTTP.
//   - Sharing the canonical schema.sql guarantees unit tests don't drift away
//     from prod: if a column changes shape, both layers see it.

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createAuditTables } from "../../src/audit-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = resolve(__dirname, "..", "..", "schema.sql");

export interface TestDb {
  db: Database.Database;
  close: () => void;
}

export function makeTestDb(): TestDb {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf-8"));
  createAuditTables(db);
  return {
    db,
    close: () => db.close(),
  };
}

export interface SeededUser {
  id: string;
  email: string;
}

export function seedUser(
  db: Database.Database,
  overrides: Partial<{
    email: string;
    plan: string;
    role: string;
    teamId: string | null;
  }> = {},
): SeededUser {
  const id = randomUUID();
  const email = overrides.email ?? `u-${id.slice(0, 8)}@test.local`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, role, plan, team_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    email,
    overrides.role ?? "user",
    overrides.plan ?? "free",
    overrides.teamId ?? null,
    now,
    now,
  );
  return { id, email };
}
