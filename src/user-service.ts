// Reflect Memory — User Service
// Find or create users by email. Used for dashboard multi-tenant auth.
// New sign-ins always get a fresh, empty user. Owner binding is handled
// exclusively by RM_OWNER_EMAIL at startup in index.ts.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export function findOrCreateUserByEmail(
  db: Database.Database,
  email: string,
): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error("Email required");

  const existing = db
    .prepare(`SELECT id FROM users WHERE email = ?`)
    .get(normalized) as { id: string } | undefined;

  if (existing) return existing.id;

  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`,
  ).run(id, normalized, now);
  return id;
}
