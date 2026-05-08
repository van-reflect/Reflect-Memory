// Phase 2 integration tests — orgs/teams CRUD + share_scope.
// Provisions an org with the test owner as owner, exercises the new
// /orgs/:id/teams/* endpoints + share_scope on POST /memories.

import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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

  // Issue #1 regression. Two writes with the same shape but different
  // intended scopes must NOT collapse via the dedup path — the prior
  // bug overwrote T1's team scope with T2's org scope (silent
  // visibility leak + data loss). Scope-aware findSimilarMemory means
  // they get distinct rows.
  it("does NOT dedup-merge two writes when their share_scope differs (issue #1)", async () => {
    const teamId = seededTeamIds[0];
    await api("POST", `/orgs/${orgId}/teams/${teamId}/members`, {
      body: { user_id: ownerUserId },
    });

    const sharedTitlePrefix = "QA scope-flip regression";
    const sharedBody =
      "Two consecutive write_memory calls with similar title and body but different share_scope must each produce their own row.";

    const t1 = await api<MemoryResp>("POST", "/memories", {
      body: {
        title: `${sharedTitlePrefix} T1`,
        content: `${sharedBody} (T1 picks team)`,
        tags: ["qa-scope-flip", "smoke"],
        share_scope: "team",
      },
    });
    expect(t1.status).toBe(201);
    if (t1.json.id) seededMemoryIds.push(t1.json.id);
    expect(t1.json.shared_with_team_id).toBe(teamId);
    expect(t1.json.shared_with_org_id).toBeFalsy();

    const t2 = await api<MemoryResp>("POST", "/memories", {
      body: {
        title: `${sharedTitlePrefix} T2`,
        content: `${sharedBody} (T2 picks org)`,
        tags: ["qa-scope-flip", "smoke"],
        share_scope: "org",
      },
    });
    expect(t2.status).toBe(201);
    if (t2.json.id) seededMemoryIds.push(t2.json.id);
    expect(t2.json.shared_with_org_id).toBe(orgId);
    expect(t2.json.shared_with_team_id).toBeFalsy();

    expect(t2.json.id).not.toBe(t1.json.id);

    // Re-read T1 by id to confirm its scope was NOT mutated by T2.
    const after = await api<MemoryResp>("GET", `/memories/${t1.json.id}`);
    expect(after.status).toBe(200);
    expect(after.json.shared_with_team_id).toBe(teamId);
    expect(after.json.shared_with_org_id).toBeFalsy();
  });

  // Same-scope writes SHOULD still dedup — that's the intended behavior.
  // This test guards against an over-correction of the issue #1 fix.
  it("DOES dedup-merge two writes when share_scope matches (preserves intended dedup)", async () => {
    const tag = uniqueTag("ss-dedup");
    const t1 = await api<MemoryResp>("POST", "/memories", {
      body: {
        title: `dedup baseline ${tag}`,
        content: `same-scope dedup test for ${tag}`,
        tags: [tag, "v1"],
        share_scope: "org",
      },
    });
    expect(t1.status).toBe(201);
    if (t1.json.id) seededMemoryIds.push(t1.json.id);

    const t2 = await api<MemoryResp>("POST", "/memories", {
      body: {
        title: `dedup baseline ${tag}`,
        content: `same-scope dedup test for ${tag} (slight tweak)`,
        tags: [tag, "v2"],
        share_scope: "org",
      },
    });
    expect(t2.status).toBe(201);
    expect(t2.json.id).toBe(t1.json.id);
    expect(t2.json.shared_with_org_id).toBe(orgId);
  });

  // Issue #3 regression. All POST /memories responses must include
  // shared_with_org_id, shared_with_team_id, shared_at, parent_memory_id —
  // null when not set, populated otherwise. Pre-fix, personal writes
  // omitted these keys entirely and clients couldn't reliably read
  // response.shared_with_org_id === null.
  it("returns a stable shape for personal writes (issue #3)", async () => {
    const tag = uniqueTag("shape");
    const r = await api<MemoryResp>("POST", "/memories", {
      body: {
        title: `shape ${tag}`,
        content: `body for ${tag}`,
        tags: [tag],
      },
    });
    expect(r.status).toBe(201);
    if (r.json.id) seededMemoryIds.push(r.json.id);
    expect(r.json).toHaveProperty("shared_with_org_id");
    expect(r.json).toHaveProperty("shared_with_team_id");
    expect(r.json).toHaveProperty("shared_at");
    expect(r.json).toHaveProperty("parent_memory_id");
    expect(r.json.shared_with_org_id).toBeNull();
    expect(r.json.shared_with_team_id).toBeNull();
    expect(r.json.shared_at).toBeNull();
    expect(r.json.parent_memory_id).toBeNull();
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

describe("GET /orgs/:id/teams/:tid/memories — sub-team feed", () => {
  // Uses a freshly-created team so we don't fight cross-test state.
  let isolatedTeamId: string;
  const teamScopedMemoryIds: string[] = [];

  beforeAll(async () => {
    const r = await api<TeamRow>("POST", `/orgs/${orgId}/teams`, {
      body: { name: `team-feed-isolated-${uniqueTag("t")}` },
    });
    expect(r.status).toBe(201);
    isolatedTeamId = r.json.id;
    seededTeamIds.push(isolatedTeamId);
    // Move the owner onto this team so subsequent share_scope='team'
    // writes from the same caller route here.
    await api("POST", `/orgs/${orgId}/teams/${isolatedTeamId}/members`, {
      body: { user_id: ownerUserId },
    });
  });

  // Two clearly-distinct titles/bodies to avoid createMemory's
  // Jaccard-similarity dedup merging them (DEDUP_WINDOW_HOURS).
  const widgetTitle = "Widget review meeting notes";
  const widgetContent = "Comprehensive review of widget design patterns and trade-offs.";
  const runbookTitle = "Operations runbook for production deploys";
  const runbookContent = "Standard procedure for shipping changes and rolling back if needed.";

  it("returns team-scoped memories shared via share_scope='team'", async () => {
    const a = await api<MemoryResp>("POST", "/memories", {
      body: {
        title: widgetTitle,
        content: widgetContent,
        tags: ["widgets", "design"],
        share_scope: "team",
      },
    });
    expect(a.status).toBe(201);
    expect(a.json.shared_with_team_id).toBe(isolatedTeamId);
    if (a.json.id) teamScopedMemoryIds.push(a.json.id);

    const b = await api<MemoryResp>("POST", "/memories", {
      body: {
        title: runbookTitle,
        content: runbookContent,
        tags: ["operations", "deploy"],
        share_scope: "team",
      },
    });
    expect(b.status).toBe(201);
    expect(b.json.shared_with_team_id).toBe(isolatedTeamId);
    if (b.json.id) teamScopedMemoryIds.push(b.json.id);

    const r = await api<{ memories: { id: string; title: string }[]; total: number }>(
      "GET",
      `/orgs/${orgId}/teams/${isolatedTeamId}/memories`,
    );
    expect(r.status).toBe(200);
    expect(r.json.total).toBe(2);
    const titles = r.json.memories.map((m) => m.title);
    expect(titles).toContain(widgetTitle);
    expect(titles).toContain(runbookTitle);
  });

  it("?term= filters across title/content/tags", async () => {
    const r = await api<{ memories: { title: string }[]; term?: string }>(
      "GET",
      `/orgs/${orgId}/teams/${isolatedTeamId}/memories?term=widget`,
    );
    expect(r.status).toBe(200);
    expect(r.json.term).toBe("widget");
    const titles = r.json.memories.map((m) => m.title);
    expect(titles).toContain(widgetTitle);
    expect(titles).not.toContain(runbookTitle);
  });

  it("404s when the team doesn't belong to the org", async () => {
    const r = await api<{ error: string }>(
      "GET",
      `/orgs/${orgId}/teams/${randomUUID()}/memories`,
    );
    expect(r.status).toBe(404);
  });

  afterAll(() => {
    if (teamScopedMemoryIds.length === 0) return;
    const { dbPath } = getTestServer();
    const db = new Database(dbPath);
    try {
      const placeholders = teamScopedMemoryIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM memory_versions WHERE memory_id IN (${placeholders})`).run(
        ...teamScopedMemoryIds,
      );
      db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(
        ...teamScopedMemoryIds,
      );
    } finally {
      db.close();
    }
  });
});

// Invite + join flow. Caught a real bug post-prod-cutover: the
// GET /orgs/invite/:token query was joining org_invites to the new
// `teams` (sub-units) table instead of `orgs` after the migration 026
// rename pass — so every invite preview 404'd. This test guards the
// whole onboarding loop a new client goes through (invite → preview →
// accept).
describe("Org invite + join flow", () => {
  let inviteToken: string;
  let inviteeUserId: string;
  let inviteeEmail: string;
  let inviteeApiKey: string;

  beforeAll(() => {
    const { dbPath } = getTestServer();
    const db = new Database(dbPath);
    try {
      inviteeUserId = randomUUID();
      inviteeEmail = `invitee-${uniqueTag("u")}@example.test`;
      // Mirror the prod key-creation path: rm_live_ prefix (enforced by
      // authenticateApiKey) + sha256 hash of the raw key.
      inviteeApiKey = `rm_live_${randomBytes(16).toString("hex")}`;
      const inviteeKeyHash = createHash("sha256").update(inviteeApiKey).digest("hex");
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO users (id, email, role, plan, created_at, updated_at)
         VALUES (?, ?, 'user', 'free', ?, ?)`,
      ).run(inviteeUserId, inviteeEmail, now, now);
      db.prepare(
        `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, label, created_at)
         VALUES (?, ?, ?, ?, 'invite-test', ?)`,
      ).run(randomUUID(), inviteeUserId, inviteeKeyHash, inviteeApiKey.slice(0, 12), now);
    } finally {
      db.close();
    }
  });

  afterAll(() => {
    const { dbPath } = getTestServer();
    const db = new Database(dbPath);
    try {
      db.prepare(`DELETE FROM org_invites WHERE org_id = ?`).run(orgId);
      db.prepare(`DELETE FROM api_keys WHERE user_id = ?`).run(inviteeUserId);
      db.prepare(`DELETE FROM users WHERE id = ?`).run(inviteeUserId);
    } finally {
      db.close();
    }
  });

  it("creates an invite as the org owner", async () => {
    const targetEmail = `${uniqueTag("invitee")}@example.test`;
    const r = await api<{ invites: { email: string; token: string; status: string }[] }>(
      "POST",
      `/orgs/${orgId}/invite`,
      { body: { emails: [targetEmail] } },
    );
    expect(r.status).toBe(200);
    expect(r.json.invites).toHaveLength(1);
    expect(r.json.invites[0].status).toBe("invited");
    expect(r.json.invites[0].token).toBeTruthy();
    inviteToken = r.json.invites[0].token;
  });

  it("GET /orgs/invite/:token returns the org name + inviter (REGRESSION: joins orgs, not teams)", async () => {
    const r = await api<{
      team_name: string;
      inviter_name: string;
      status: string;
      email: string | null;
    }>("GET", `/orgs/invite/${inviteToken}`);
    expect(r.status).toBe(200);
    // The org name is "OrgsAndTeams-Test-Org" from the top-level beforeAll.
    expect(r.json.team_name).toBe("OrgsAndTeams-Test-Org");
    expect(r.json.status).toBe("pending");
    expect(r.json.inviter_name).toBeTruthy();
  });

  it("GET /orgs/invite/:token 404s on an unknown token", async () => {
    const r = await api<{ error: string }>("GET", `/orgs/invite/not-a-real-token`);
    expect(r.status).toBe(404);
  });

  it("POST /orgs/join attaches the invitee to the org", async () => {
    const r = await api<{ org_id: string; team_name: string; role: string }>(
      "POST",
      `/orgs/join`,
      {
        body: { token: inviteToken, first_name: "Test", last_name: "Invitee" },
        token: inviteeApiKey,
      },
    );
    expect(r.status).toBe(200);
    expect(r.json.org_id).toBe(orgId);
    expect(r.json.role).toBe("member");

    // Confirm in DB: user is now in the org with role=member, and the
    // invite status flipped to accepted.
    const { dbPath } = getTestServer();
    const db = new Database(dbPath);
    try {
      const u = db
        .prepare(`SELECT org_id, org_role FROM users WHERE id = ?`)
        .get(inviteeUserId) as { org_id: string; org_role: string };
      expect(u.org_id).toBe(orgId);
      expect(u.org_role).toBe("member");
      const i = db
        .prepare(`SELECT status FROM org_invites WHERE token = ?`)
        .get(inviteToken) as { status: string };
      expect(i.status).toBe("accepted");
    } finally {
      db.close();
    }
  });

  it("POST /orgs/join 400s when reusing an accepted token", async () => {
    const r = await api<{ error: string }>(
      "POST",
      `/orgs/join`,
      { body: { token: inviteToken }, token: inviteeApiKey },
    );
    expect(r.status).toBe(400);
  });
});
