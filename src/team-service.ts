// Reflect Memory -- Team Service
//
// CRUD + membership for the new sub-team primitive (introduced 2026-05-05
// in migration 026). A team is a sub-unit within an org: its own shared
// memory pool, scoped membership, no per-team admin role (per D4 in
// docs/eng-plan-orgs-and-teams-v1.md — org admins manage all team
// aspects).
//
// What lives here:
//   - createTeam / listTeamsInOrg / getTeam / renameTeam / deleteTeam
//   - assignUserToTeam / removeUserFromTeam (sub-team membership)
//   - listTeamMembers / countTeamMembers
//   - countTeamSharedMemories
//
// Cascades on team delete (when force=true):
//   1. users.team_id NULLed for every member (they stay in the org).
//   2. memories.shared_with_team_id NULLed for every team-shared memory
//      (memories revert to personal — author still owns them).
//   3. Then DELETE FROM teams WHERE id = ?.
//
// Without force=true, deleteTeam refuses if the team has any members or
// any team-shared memories. The dashboard confirmation flow flips force
// after the user acknowledges.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface TeamRow {
  id: string;
  org_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export class TeamServiceError extends Error {
  constructor(
    message: string,
    public code:
      | "duplicate_name"
      | "not_found"
      | "wrong_org"
      | "user_not_in_org"
      | "has_members"
      | "has_memories",
  ) {
    super(message);
    this.name = "TeamServiceError";
  }
}

export function createTeam(
  db: Database.Database,
  orgId: string,
  name: string,
): TeamRow {
  const trimmed = name.trim();
  if (!trimmed) throw new TeamServiceError("Team name required", "duplicate_name");

  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO teams (id, org_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, orgId, trimmed, now, now);
  } catch (err) {
    const msg = (err as Error).message;
    // SQLite UNIQUE(org_id, name) violation
    if (msg.includes("UNIQUE") && msg.includes("teams")) {
      throw new TeamServiceError(
        `A team named "${trimmed}" already exists in this org`,
        "duplicate_name",
      );
    }
    throw err;
  }

  return { id, org_id: orgId, name: trimmed, created_at: now, updated_at: now };
}

export function listTeamsInOrg(
  db: Database.Database,
  orgId: string,
): TeamRow[] {
  return db
    .prepare(
      `SELECT id, org_id, name, created_at, updated_at
       FROM teams WHERE org_id = ?
       ORDER BY name COLLATE NOCASE ASC`,
    )
    .all(orgId) as TeamRow[];
}

export function getTeam(db: Database.Database, teamId: string): TeamRow | null {
  const row = db
    .prepare(
      `SELECT id, org_id, name, created_at, updated_at FROM teams WHERE id = ?`,
    )
    .get(teamId);
  return (row as TeamRow) ?? null;
}

export function renameTeam(
  db: Database.Database,
  teamId: string,
  newName: string,
): TeamRow {
  const trimmed = newName.trim();
  if (!trimmed) throw new TeamServiceError("Team name required", "duplicate_name");

  const existing = getTeam(db, teamId);
  if (!existing) throw new TeamServiceError("Team not found", "not_found");

  const now = new Date().toISOString();
  try {
    db.prepare(
      `UPDATE teams SET name = ?, updated_at = ? WHERE id = ?`,
    ).run(trimmed, now, teamId);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("UNIQUE") && msg.includes("teams")) {
      throw new TeamServiceError(
        `A team named "${trimmed}" already exists in this org`,
        "duplicate_name",
      );
    }
    throw err;
  }

  return { ...existing, name: trimmed, updated_at: now };
}

export interface DeleteTeamResult {
  members_unassigned: number;
  memories_unshared: number;
}

export function deleteTeam(
  db: Database.Database,
  teamId: string,
  opts: { force?: boolean } = {},
): DeleteTeamResult {
  const team = getTeam(db, teamId);
  if (!team) throw new TeamServiceError("Team not found", "not_found");

  const memberCount = countTeamMembers(db, teamId);
  const memoryCount = countTeamSharedMemories(db, teamId);

  if (!opts.force) {
    if (memberCount > 0) {
      throw new TeamServiceError(
        `Team has ${memberCount} member${memberCount === 1 ? "" : "s"}. Pass force=true to delete and unassign them.`,
        "has_members",
      );
    }
    if (memoryCount > 0) {
      throw new TeamServiceError(
        `Team has ${memoryCount} shared ${memoryCount === 1 ? "memory" : "memories"}. Pass force=true to delete and revert them to personal.`,
        "has_memories",
      );
    }
  }

  const tx = db.transaction(() => {
    // Cascade members + memories within a single tx so partial state can't
    // leak if any step fails.
    const ms = db
      .prepare(`UPDATE users SET team_id = NULL WHERE team_id = ?`)
      .run(teamId);
    const xs = db
      .prepare(
        `UPDATE memories
         SET shared_with_team_id = NULL,
             shared_at = NULL,
             updated_at = ?
         WHERE shared_with_team_id = ?`,
      )
      .run(new Date().toISOString(), teamId);
    db.prepare(`DELETE FROM teams WHERE id = ?`).run(teamId);
    return {
      members_unassigned: ms.changes,
      memories_unshared: xs.changes,
    };
  });

  return tx();
}

/**
 * Add an existing org member to a sub-team. Throws if the user isn't in
 * the team's parent org. Idempotent: setting the same team_id twice is a
 * no-op.
 */
export function assignUserToTeam(
  db: Database.Database,
  userId: string,
  teamId: string,
): void {
  const team = getTeam(db, teamId);
  if (!team) throw new TeamServiceError("Team not found", "not_found");

  const user = db
    .prepare(`SELECT org_id FROM users WHERE id = ?`)
    .get(userId) as { org_id: string | null } | undefined;
  if (!user || user.org_id !== team.org_id) {
    throw new TeamServiceError(
      "User is not a member of this team's org",
      "user_not_in_org",
    );
  }

  db.prepare(`UPDATE users SET team_id = ?, updated_at = ? WHERE id = ?`).run(
    teamId,
    new Date().toISOString(),
    userId,
  );
}

/**
 * Remove a user from any sub-team (their org membership is unchanged).
 * Idempotent: a user with team_id=NULL stays NULL.
 */
export function removeUserFromTeam(
  db: Database.Database,
  userId: string,
): void {
  db.prepare(`UPDATE users SET team_id = NULL, updated_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    userId,
  );
}

export interface TeamSubunitMember {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  org_role: string | null;
  created_at: string;
}

export function listTeamMembers(
  db: Database.Database,
  teamId: string,
): TeamSubunitMember[] {
  return db
    .prepare(
      `SELECT id, email, first_name, last_name, org_role, created_at
       FROM users WHERE team_id = ?
       ORDER BY org_role ASC, created_at ASC`,
    )
    .all(teamId) as TeamSubunitMember[];
}

export function countTeamMembers(
  db: Database.Database,
  teamId: string,
): number {
  const row = db
    .prepare(`SELECT COUNT(*) as cnt FROM users WHERE team_id = ?`)
    .get(teamId) as { cnt: number };
  return row.cnt;
}

export function countTeamSharedMemories(
  db: Database.Database,
  teamId: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM memories
       WHERE shared_with_team_id = ? AND deleted_at IS NULL`,
    )
    .get(teamId) as { cnt: number };
  return row.cnt;
}
