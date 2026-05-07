// Reflect Memory -- User Service
// Find or create users by email. Used for dashboard multi-tenant auth.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface UserRow {
  id: string;
  email: string;
  clerk_id: string | null;
  role: string;
  plan: string;
  stripe_customer_id: string | null;
  org_id: string | null;
  org_role: string | null;
  team_id: string | null;
  first_name: string | null;
  last_name: string | null;
}

export function findOrCreateUserByEmail(
  db: Database.Database,
  email: string,
): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error("Email required");
  if (!EMAIL_REGEX.test(normalized)) throw new Error("Invalid email format");

  const existing = db
    .prepare(`SELECT id FROM users WHERE email = ?`)
    .get(normalized) as { id: string } | undefined;

  if (existing) return existing.id;

  const maxSeats = parseInt(process.env.RM_MAX_SEATS || "0", 10);
  if (maxSeats > 0) {
    const { count } = db
      .prepare(`SELECT COUNT(*) as count FROM users`)
      .get() as { count: number };
    if (count >= maxSeats) {
      throw new Error(
        `Seat limit reached (${maxSeats}). Contact your Reflect Memory administrator to increase RM_MAX_SEATS.`,
      );
    }
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  const hasUpdatedAt = (db.prepare(
    `SELECT count(*) as count FROM pragma_table_info('users') WHERE name = 'updated_at'`,
  ).get() as { count: number }).count > 0;

  if (hasUpdatedAt) {
    db.prepare(
      `INSERT INTO users (id, email, role, plan, created_at, updated_at) VALUES (?, ?, 'user', 'free', ?, ?)`,
    ).run(id, normalized, now, now);
  } else {
    db.prepare(
      `INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`,
    ).run(id, normalized, now);
  }

  return id;
}

const USER_COLS = "id, email, clerk_id, role, plan, stripe_customer_id, org_id, org_role, team_id, first_name, last_name";

export function getUserByEmail(
  db: Database.Database,
  email: string,
): UserRow | null {
  const normalized = email.trim().toLowerCase();
  const row = db.prepare(`SELECT ${USER_COLS} FROM users WHERE email = ?`).get(normalized);
  return (row as UserRow) ?? null;
}

export function getUserById(
  db: Database.Database,
  userId: string,
): UserRow | null {
  const row = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(userId);
  return (row as UserRow) ?? null;
}

export function updateUserRole(
  db: Database.Database,
  userId: string,
  role: "admin" | "private-alpha" | "user",
): void {
  db.prepare(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`).run(
    role,
    new Date().toISOString(),
    userId,
  );
}

export function updateUserName(
  db: Database.Database,
  userId: string,
  firstName: string,
  lastName: string,
): void {
  db.prepare(`UPDATE users SET first_name = ?, last_name = ?, updated_at = ? WHERE id = ?`).run(
    firstName.trim(),
    lastName.trim(),
    new Date().toISOString(),
    userId,
  );
}

export type OrgRole = "owner" | "admin" | "member";

export function addUserToOrg(
  db: Database.Database,
  userId: string,
  orgId: string,
  role: OrgRole,
): void {
  db.prepare(
    `UPDATE users SET org_id = ?, org_role = ?, plan = 'team', updated_at = ? WHERE id = ?`,
  ).run(orgId, role, new Date().toISOString(), userId);
}

/**
 * Update an existing org member's role (owner ↔ admin ↔ member).
 * Idempotent: setting the same role twice is a no-op.
 */
export function setOrgRole(
  db: Database.Database,
  userId: string,
  role: OrgRole,
): void {
  db.prepare(
    `UPDATE users SET org_role = ?, updated_at = ? WHERE id = ?`,
  ).run(role, new Date().toISOString(), userId);
}

export function removeUserFromTeam(
  db: Database.Database,
  userId: string,
): void {
  db.prepare(
    `UPDATE users SET org_id = NULL, org_role = NULL, plan = 'free', updated_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), userId);
}

export interface TeamMember {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  org_role: string;
  created_at: string;
}

export function getTeamMembers(
  db: Database.Database,
  orgId: string,
): TeamMember[] {
  return db
    .prepare(
      `SELECT id, email, first_name, last_name, org_role, created_at
       FROM users WHERE org_id = ? ORDER BY org_role ASC, created_at ASC`,
    )
    .all(orgId) as TeamMember[];
}

export function getOrgMemberCount(
  db: Database.Database,
  orgId: string,
): number {
  const row = db
    .prepare(`SELECT COUNT(*) as cnt FROM users WHERE org_id = ?`)
    .get(orgId) as { cnt: number };
  return row.cnt;
}
