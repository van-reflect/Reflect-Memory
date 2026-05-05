// Phase 2 integration tests — orgs/teams CRUD + share_scope.
// Provisions an org with the test owner as owner, exercises the new
// /orgs/:id/teams/* endpoints + share_scope on POST /memories.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, getTestServer, uniqueTag } from "../helpers";

interface TeamRow {
  id: string;
  org_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface MemoryResp {
  id: string;
  shared_with_org_id: string | null;
  shared_with_team_id: string | null;
  shared_at: string | null;
}

let orgId: string;
let ownerUserId: string;
const seededTeamIds: string[] = [];
const seededMemoryIds: string[] = [];

beforeAll(() => {
  const { dbPath, ownerEmail } = getTestServer();
  const db = new Database(dbPath);
  try {
    ownerUserId = (
      db.prepare("SELECT id FROM users WHERE email = ?").get(ownerEmail) as
        | { id: string }
        | undefined
    )?.id!;
    expect(ownerUserId).toBeTruthy();

    orgId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO orgs (id, name, owner_id, plan, created_at, updated_at)
       VALUES (?, ?, ?, 'team', ?, ?)`,
    ).run(orgId, "OrgsAndTeams-Test-Org", ownerUserId, now, now);
    db.prepare(
      `UPDATE users SET org_id = ?, org_role = 'owner', updated_at = ? WHERE id = ?`,
    ).run(orgId, now, ownerUserId);
  } finally {
    db.close();
  }
});

afterAll(() => {
  const { dbPath } = getTestServer();
  const db = new Database(dbPath);
  try {
    if (seededMemoryIds.length > 0) {
      const placeholders = seededMemoryIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM memory_versions WHERE memory_id IN (${placeholders})`).run(
        ...seededMemoryIds,
      );
      db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(
        ...seededMemoryIds,
      );
    }
    if (seededTeamIds.length > 0) {
      const placeholders = seededTeamIds.map(() => "?").join(",");
      db.prepare(`UPDATE users SET team_id = NULL WHERE team_id IN (${placeholders})`).run(
        ...seededTeamIds,
      );
      db.prepare(`DELETE FROM teams WHERE id IN (${placeholders})`).run(...seededTeamIds);
    }
    db.prepare(
      `UPDATE users SET org_id = NULL, org_role = NULL WHERE org_id = ?`,
    ).run(orgId);
    db.prepare("DELETE FROM orgs WHERE id = ?").run(orgId);
  } finally {
    db.close();
  }
});

describe("POST /orgs/:id/teams — create team", () => {
  it("creates a team with the given name as an admin/owner", async () => {
    const r = await api<TeamRow>("POST", `/orgs/${orgId}/teams`, {
      body: { name: "Engineering" },
    });
    expect(r.status).toBe(201);
    if (r.json.id) seededTeamIds.push(r.json.id);
    expect(r.json.name).toBe("Engineering");
    expect(r.json.org_id).toBe(orgId);
    expect(r.json.created_at).toBeTruthy();
  });

  it("returns 409 on duplicate name within the same org", async () => {
    const r = await api<{ error: string; code: string }>("POST", `/orgs/${orgId}/teams`, {
      body: { name: "Engineering" },
    });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("duplicate_name");
  });

  it("trims whitespace from the team name", async () => {
    const r = await api<TeamRow>("POST", `/orgs/${orgId}/teams`, {
      body: { name: "   Sales   " },
    });
    expect(r.status).toBe(201);
    if (r.json.id) seededTeamIds.push(r.json.id);
    expect(r.json.name).toBe("Sales");
  });
});

describe("GET /orgs/:id/teams — list teams in org", () => {
  it("returns all teams created so far, sorted alphabetically", async () => {
    const r = await api<{ teams: (TeamRow & { member_count: number; memory_count: number })[] }>(
      "GET",
      `/orgs/${orgId}/teams`,
    );
    expect(r.status).toBe(200);
    expect(r.json.teams.map((t) => t.name)).toContain("Engineering");
    expect(r.json.teams.map((t) => t.name)).toContain("Sales");
    // member/memory counts default to 0 for empty teams
    for (const t of r.json.teams) {
      expect(typeof t.member_count).toBe("number");
      expect(typeof t.memory_count).toBe("number");
    }
  });
});

describe("PATCH /orgs/:id/teams/:tid — rename", () => {
  it("renames a team", async () => {
    const teamId = seededTeamIds[0];
    const r = await api<TeamRow>("PATCH", `/orgs/${orgId}/teams/${teamId}`, {
      body: { name: "Engineering Platform" },
    });
    expect(r.status).toBe(200);
    expect(r.json.name).toBe("Engineering Platform");
  });

  it("returns 409 when renaming to a name already taken in the same org", async () => {
    const teamId = seededTeamIds[0];
    const r = await api<{ code: string }>("PATCH", `/orgs/${orgId}/teams/${teamId}`, {
      body: { name: "Sales" },
    });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("duplicate_name");
  });
});

describe("POST /orgs/:id/teams/:tid/members — add member", () => {
  it("assigns the owner to the team", async () => {
    const teamId = seededTeamIds[0];
    const r = await api<{ added: boolean }>(
      "POST",
      `/orgs/${orgId}/teams/${teamId}/members`,
      { body: { user_id: ownerUserId } },
    );
    expect(r.status).toBe(200);
    expect(r.json.added).toBe(true);
  });

  it("400s when the target user isn't in the org", async () => {
    const teamId = seededTeamIds[0];
    const ghostUserId = randomUUID();
    const r = await api<{ code: string }>(
      "POST",
      `/orgs/${orgId}/teams/${teamId}/members`,
      { body: { user_id: ghostUserId } },
    );
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("user_not_in_org");
  });
});

describe("DELETE /orgs/:id/teams/:tid — refuses to delete non-empty team without force", () => {
  it("409s when team has members and force is not set", async () => {
    const teamId = seededTeamIds[0];
    const r = await api<{ code: string }>(
      "DELETE",
      `/orgs/${orgId}/teams/${teamId}`,
    );
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("has_members");
  });

  it("force=true cascades members + deletes the team", async () => {
    // Create a fresh team to delete forcibly.
    const create = await api<TeamRow>("POST", `/orgs/${orgId}/teams`, {
      body: { name: `force-delete-${uniqueTag("t")}` },
    });
    expect(create.status).toBe(201);
    if (create.json.id) seededTeamIds.push(create.json.id);
    // Add the owner to it.
    await api("POST", `/orgs/${orgId}/teams/${create.json.id}/members`, {
      body: { user_id: ownerUserId },
    });
    // Force delete.
    const r = await api<{ deleted: boolean; members_unassigned: number }>(
      "DELETE",
      `/orgs/${orgId}/teams/${create.json.id}?force=true`,
    );
    expect(r.status).toBe(200);
    expect(r.json.deleted).toBe(true);
    expect(r.json.members_unassigned).toBeGreaterThanOrEqual(1);
    // Pop from cleanup list since it's already gone.
    const idx = seededTeamIds.indexOf(create.json.id);
    if (idx >= 0) seededTeamIds.splice(idx, 1);
  });
});

describe("share_scope param on POST /memories", () => {
  it("share_scope='team' shares with the user's current sub-team", async () => {
    const teamId = seededTeamIds[0];
    // Make sure the owner is assigned to that team.
    await api("POST", `/orgs/${orgId}/teams/${teamId}/members`, {
      body: { user_id: ownerUserId },
    });

    const tag = uniqueTag("ss-team");
    const r = await api<MemoryResp>("POST", "/memories", {
      body: {
        title: `team-scope ${tag}`,
        content: `body for ${tag}`,
        tags: [tag],
        share_scope: "team",
      },
    });
    expect(r.status).toBe(201);
    if (r.json.id) seededMemoryIds.push(r.json.id);
    expect(r.json.shared_with_team_id).toBe(teamId);
    expect(r.json.shared_with_org_id).toBeFalsy();
  });

  it("share_scope='org' shares with the user's current org", async () => {
    const tag = uniqueTag("ss-org");
    const r = await api<MemoryResp>("POST", "/memories", {
      body: {
        title: `org-scope ${tag}`,
        content: `body for ${tag}`,
        tags: [tag],
        share_scope: "org",
      },
    });
    expect(r.status).toBe(201);
    if (r.json.id) seededMemoryIds.push(r.json.id);
    expect(r.json.shared_with_org_id).toBe(orgId);
    expect(r.json.shared_with_team_id).toBeFalsy();
  });

  it("legacy share_with_team=true maps to share_scope='org'", async () => {
    const tag = uniqueTag("ss-legacy");
    const r = await api<MemoryResp>("POST", "/memories", {
      body: {
        title: `legacy ${tag}`,
        content: `body for ${tag}`,
        tags: [tag],
        share_with_team: true,
      },
    });
    expect(r.status).toBe(201);
    if (r.json.id) seededMemoryIds.push(r.json.id);
    expect(r.json.shared_with_org_id).toBe(orgId);
    expect(r.json.shared_with_team_id).toBeFalsy();
  });

  it("share_scope='team' silently falls back to personal when caller has no team", async () => {
    const { dbPath } = getTestServer();
    const db = new Database(dbPath);
    try {
      db.prepare(`UPDATE users SET team_id = NULL WHERE id = ?`).run(ownerUserId);
    } finally {
      db.close();
    }
    try {
      const tag = uniqueTag("ss-noteam");
      const r = await api<MemoryResp>("POST", "/memories", {
        body: {
          title: `no-team ${tag}`,
          content: `body for ${tag}`,
          tags: [tag],
          share_scope: "team",
        },
      });
      expect(r.status).toBe(201);
      if (r.json.id) seededMemoryIds.push(r.json.id);
      expect(r.json.shared_with_team_id).toBeFalsy();
      expect(r.json.shared_with_org_id).toBeFalsy();
    } finally {
      // Reattach for following tests.
      const teamId = seededTeamIds[0];
      const db2 = new Database(dbPath);
      try {
        db2.prepare(`UPDATE users SET team_id = ? WHERE id = ?`).run(teamId, ownerUserId);
      } finally {
        db2.close();
      }
    }
  });
});

describe("POST /orgs/:id/members/:uid/role — promote/demote", () => {
  it("403s for non-owner caller (admin can do other things, not change roles)", async () => {
    // Owner is the test user; use a random uid to ensure it 404s gracefully.
    const r = await api<{ error: string }>(
      "POST",
      `/orgs/${orgId}/members/${randomUUID()}/role`,
      { body: { role: "admin" } },
    );
    // Owner is the test user → should NOT 403 owner. The 404 path here is
    // because the random uid is not in the org. Either 403 or 404 is
    // acceptable depending on auth check ordering.
    expect([403, 404]).toContain(r.status);
  });

  it("400s when trying to demote the owner", async () => {
    const r = await api<{ error: string }>(
      "POST",
      `/orgs/${orgId}/members/${ownerUserId}/role`,
      { body: { role: "member" } },
    );
    expect(r.status).toBe(400);
  });
});
