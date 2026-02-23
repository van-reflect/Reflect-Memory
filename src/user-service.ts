// Reflect Memory — User Service
// Find or create users by email. Used for dashboard multi-tenant auth.
//
// Handles the single-user → multi-user transition: the original seeded user
// has no email. The first dashboard sign-in "claims" that user by setting
// their email, preserving all existing memories.

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

  // Claim the original seeded user if it has no email yet.
  // This preserves all memories created via the API key or agent keys.
  const unclaimed = db
    .prepare(`SELECT id FROM users WHERE email IS NULL LIMIT 1`)
    .get() as { id: string } | undefined;

  if (unclaimed) {
    db.prepare(`UPDATE users SET email = ? WHERE id = ?`).run(
      normalized,
      unclaimed.id,
    );
    return unclaimed.id;
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`,
  ).run(id, normalized, now);
  return id;
}
