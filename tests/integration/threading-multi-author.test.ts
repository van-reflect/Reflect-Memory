// Multi-author threading: a teammate (Van) writes a child memory under a
// memory another teammate (Tamer / the primary owner) created and shared
// with the team. Regression tests for the "parent memory belongs to another
// user" bug Van hit on 2026-04-22.
//
// What we cover:
//   1. Van CAN reply to a parent shared with his team.
//   2. Van CANNOT reply to a parent that's NOT shared (still 403 — privacy).
//   3. Van CANNOT reply to a parent owned by an unrelated user on a
//      different team (still 403 — wrong team).
//   4. The thread fetch returns the parent + ALL replies (from any author).
//   5. Cascade share/unshare flips visibility on EVERY child including
//      teammates' replies.
//   6. Soft-delete by parent author trashes their OWN children only;
//      teammate replies stay readable in the teammate's personal pool
//      (they can still be seen via direct GET, even though the thread
//      itself is no longer visible because the parent is in trash).
//   7. Permanent delete by parent author orphans teammate children
//      (parent_memory_id → NULL) so the FK doesn't blow up; teammate's
//      reply remains as a top-level personal memory.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, getTestServer } from "../helpers";
import { generateApiKey } from "../../src/api-key-service";

interface MemoryResponse {
  id: string;
  title: string;
  content: string;
  tags: string[];
  parent_memory_id?: string | null;
  shared_with_org_id?: string | null;
  shared_at?: string | null;
  deleted_at?: string | null;
  user_id?: string;
}

interface ThreadResponse {
  parent: MemoryResponse;
  children: MemoryResponse[];
}

let orgId: string;
let outsideTeamId: string;
let ownerUserId: string;
let vanUserId: string;
let outsiderUserId: string;
let vanApiKey: string;
let outsiderApiKey: string;
const trackedMemoryIds: string[] = [];

beforeAll(() => {
  const { dbPath, ownerEmail } = getTestServer();
  const db = new Database(dbPath);
  try {
    const ownerRow = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(ownerEmail) as { id: string } | undefined;
    ownerUserId = ownerRow!.id;

    orgId = randomUUID();
    outsideTeamId = randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO orgs (id, name, owner_id, plan, created_at, updated_at)
       VALUES (?, ?, ?, 'team', ?, ?)`,
    ).run(orgId, "Multi-Author-Team", ownerUserId, now, now);
    db.prepare(
      `UPDATE users SET org_id = ?, org_role = 'owner' WHERE id = ?`,
    ).run(orgId, ownerUserId);

    // Provision Van: same team as owner.
    vanUserId = randomUUID();
    db.prepare(
      `INSERT INTO users (id, email, created_at, updated_at, org_id, org_role)
       VALUES (?, ?, ?, ?, ?, 'member')`,
    ).run(
      vanUserId,
      `van-${vanUserId.slice(0, 8)}@reflectmemory.com`,
      now,
      now,
      orgId,
    );
    vanApiKey = generateApiKey(db, vanUserId, "van-test-key").key;

    // Provision an outsider on a separate team — they should NEVER be able
    // to write children to the first team's memories. The outside team's
    // owner_id needs to point at a real user; create the outsider first
    // (with no team), make them the team owner, then assign them to it.
    outsiderUserId = randomUUID();
    db.prepare(
      `INSERT INTO users (id, email, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(
      outsiderUserId,
      `outsider-${outsiderUserId.slice(0, 8)}@example.com`,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO orgs (id, name, owner_id, plan, created_at, updated_at)
       VALUES (?, ?, ?, 'team', ?, ?)`,
    ).run(outsideTeamId, "Outside-Team", outsiderUserId, now, now);
    db.prepare(
      `UPDATE users SET org_id = ?, org_role = 'owner' WHERE id = ?`,
    ).run(outsideTeamId, outsiderUserId);
    outsiderApiKey = generateApiKey(db, outsiderUserId, "outsider-test-key").key;
  } finally {
    db.close();
  }
});

afterAll(() => {
  const { dbPath } = getTestServer();
  const db = new Database(dbPath);
  try {
    if (trackedMemoryIds.length > 0) {
      const placeholders = trackedMemoryIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM memory_versions WHERE memory_id IN (${placeholders})`).run(
        ...trackedMemoryIds,
      );
      db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(
        ...trackedMemoryIds,
      );
    }
    // Orphan-purge: clean up anything left behind under either user that
    // tracked-ids missed (e.g. orphaned children from the cascadeHardDelete
    // test, where Van's reply ends up with parent_memory_id NULL but is
    // still in the DB).
    const leftover = db
      .prepare(`SELECT id FROM memories WHERE user_id IN (?, ?)`)
      .all(vanUserId, outsiderUserId) as { id: string }[];
    if (leftover.length > 0) {
      const placeholders = leftover.map(() => "?").join(",");
      const ids = leftover.map((r) => r.id);
      db.prepare(
        `DELETE FROM memory_versions WHERE memory_id IN (${placeholders})`,
      ).run(...ids);
      db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);
    }
    db.prepare(`DELETE FROM api_keys WHERE user_id IN (?, ?)`).run(
      vanUserId,
      outsiderUserId,
    );
    db.prepare(`DELETE FROM usage_events WHERE user_id IN (?, ?)`).run(
      vanUserId,
      outsiderUserId,
    );
    db.prepare(`DELETE FROM monthly_usage WHERE user_id IN (?, ?)`).run(
      vanUserId,
      outsiderUserId,
    );
    // Clear team back-refs first (FK on users.org_id → teams.id), then
    // delete teams (which removes the teams.owner_id → users.id FK), THEN
    // delete users.
    db.prepare(
      `UPDATE users SET org_id = NULL, org_role = NULL WHERE id IN (?, ?, ?)`,
    ).run(ownerUserId, vanUserId, outsiderUserId);
    db.prepare(`DELETE FROM orgs WHERE id IN (?, ?)`).run(orgId, outsideTeamId);
    db.prepare(`DELETE FROM users WHERE id IN (?, ?)`).run(vanUserId, outsiderUserId);
  } finally {
    db.close();
  }
});

async function ownerCreatesParent(title: string): Promise<MemoryResponse> {
  const r = await api<MemoryResponse>("POST", "/memories", {
    body: { title, content: `parent body ${title}`, tags: ["multi-author-test"] },
  });
  expect(r.status).toBe(201);
  trackedMemoryIds.push(r.json.id);
  return r.json;
}

async function ownerShares(memoryId: string): Promise<void> {
  const r = await api("POST", `/memories/${memoryId}/share`);
  expect(r.status).toBe(200);
}

async function vanCreatesChild(
  parentId: string,
  title: string,
): Promise<{ status: number; json: MemoryResponse & { error?: string } }> {
  const r = await api<MemoryResponse & { error?: string }>(
    "POST",
    `/memories/${parentId}/children`,
    {
      token: vanApiKey,
      body: {
        title,
        content: `van's reply: ${title}`,
        tags: ["multi-author-test", "van-reply"],
      },
    },
  );
  if (r.status === 201 && r.json.id) trackedMemoryIds.push(r.json.id);
  return r;
}

describe("multi-author threading: write-child permission", () => {
  it("teammate CAN reply to a team-shared parent (the bug Van hit)", async () => {
    const parent = await ownerCreatesParent(`mt-shared-parent-${Date.now()}`);
    await ownerShares(parent.id);

    const r = await vanCreatesChild(parent.id, "vans-reply");
    expect(r.status).toBe(201);
    expect(r.json.parent_memory_id).toBe(parent.id);
    // Inheritance: child is auto-shared with the same team.
    expect(r.json.shared_with_org_id).toBe(orgId);
    expect(r.json.shared_at).toBeTruthy();
  });

  it("teammate CANNOT reply to a parent that is NOT shared (still private)", async () => {
    const parent = await ownerCreatesParent(`mt-private-parent-${Date.now()}`);
    // Intentionally do NOT share.

    const r = await vanCreatesChild(parent.id, "vans-blocked-reply");
    // 403 — Van has no access to this private memory.
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/another user|not shared/i);
  });

  it("user on a different team CANNOT reply to a shared parent", async () => {
    const parent = await ownerCreatesParent(`mt-cross-team-${Date.now()}`);
    await ownerShares(parent.id);

    // Outsider (different team) tries to reply.
    const r = await api<MemoryResponse & { error?: string }>(
      "POST",
      `/memories/${parent.id}/children`,
      {
        token: outsiderApiKey,
        body: {
          title: "trespass",
          content: "should be blocked",
          tags: ["multi-author-test"],
        },
      },
    );
    if (r.status === 201 && r.json.id) trackedMemoryIds.push(r.json.id);
    expect(r.status).toBe(403);
  });
});

describe("multi-author threading: thread visibility", () => {
  it("owner sees teammate's reply in the thread fetch", async () => {
    const parent = await ownerCreatesParent(`mt-vis-owner-${Date.now()}`);
    await ownerShares(parent.id);
    const vansReply = await vanCreatesChild(parent.id, "owner-should-see-this");
    expect(vansReply.status).toBe(201);

    // Owner fetches the thread.
    const thread = await api<ThreadResponse>("GET", `/memories/${parent.id}/thread`);
    expect(thread.status).toBe(200);
    expect(thread.json.children.map((c) => c.id)).toContain(vansReply.json.id);
  });

  it("teammate can fetch a thread on the owner's shared parent and see all replies", async () => {
    const parent = await ownerCreatesParent(`mt-vis-teammate-${Date.now()}`);
    await ownerShares(parent.id);
    const vansReply = await vanCreatesChild(parent.id, "vans-own-reply");
    expect(vansReply.status).toBe(201);

    // Van reads the thread directly via the parent id.
    const thread = await api<ThreadResponse>(
      "GET",
      `/memories/${parent.id}/thread`,
      { token: vanApiKey },
    );
    expect(thread.status).toBe(200);
    expect(thread.json.parent.id).toBe(parent.id);
    expect(thread.json.children.map((c) => c.id)).toContain(vansReply.json.id);
  });

  it("teammate can root the thread from their own child id (parent is teammate's)", async () => {
    const parent = await ownerCreatesParent(`mt-vis-childroot-${Date.now()}`);
    await ownerShares(parent.id);
    const vansReply = await vanCreatesChild(parent.id, "via-childid");
    expect(vansReply.status).toBe(201);

    const thread = await api<ThreadResponse>(
      "GET",
      `/memories/${vansReply.json.id}/thread`,
      { token: vanApiKey },
    );
    expect(thread.status).toBe(200);
    expect(thread.json.parent.id).toBe(parent.id);
    expect(thread.json.children.some((c) => c.id === vansReply.json.id)).toBe(true);
  });

  it("non-team user gets 404 on a shared parent's thread (no access)", async () => {
    const parent = await ownerCreatesParent(`mt-vis-stranger-${Date.now()}`);
    await ownerShares(parent.id);

    const thread = await api("GET", `/memories/${parent.id}/thread`, {
      token: outsiderApiKey,
    });
    expect(thread.status).toBe(404);
  });
});

describe("multi-author threading: cascade share + unshare", () => {
  it("unshare by parent owner cascades to teammate's reply (whole thread goes private)", async () => {
    const parent = await ownerCreatesParent(`mt-cas-unshare-${Date.now()}`);
    await ownerShares(parent.id);
    const vansReply = await vanCreatesChild(parent.id, "vans-reply-pre-unshare");
    expect(vansReply.json.shared_with_org_id).toBe(orgId);

    const unshare = await api("POST", `/memories/${parent.id}/unshare`);
    expect(unshare.status).toBe(200);

    // Van reads his own reply directly — should now be unshared.
    const dbPath = getTestServer().dbPath;
    const db = new Database(dbPath);
    try {
      const row = db
        .prepare(
          "SELECT shared_with_org_id, shared_at FROM memories WHERE id = ?",
        )
        .get(vansReply.json.id) as
        | { shared_with_org_id: string | null; shared_at: string | null }
        | undefined;
      expect(row?.shared_with_org_id).toBeNull();
      expect(row?.shared_at).toBeNull();
    } finally {
      db.close();
    }
  });

  it("share applied AFTER teammate replies still propagates to all children", async () => {
    // We can't replicate this naturally — Van can't reply unless parent is
    // already shared. So instead: share, Van replies, owner unshares, then
    // re-shares — verify Van's reply comes back to shared on re-share.
    const parent = await ownerCreatesParent(`mt-cas-reshare-${Date.now()}`);
    await ownerShares(parent.id);
    const vansReply = await vanCreatesChild(parent.id, "v-pre-reshare");
    await api("POST", `/memories/${parent.id}/unshare`);
    await api("POST", `/memories/${parent.id}/share`);

    const dbPath = getTestServer().dbPath;
    const db = new Database(dbPath);
    try {
      const row = db
        .prepare("SELECT shared_with_org_id FROM memories WHERE id = ?")
        .get(vansReply.json.id) as { shared_with_org_id: string | null };
      expect(row.shared_with_org_id).toBe(orgId);
    } finally {
      db.close();
    }
  });
});

describe("multi-author threading: cascade delete preserves teammate work", () => {
  it("owner soft-deletes parent: own children trashed, teammate's reply NOT trashed", async () => {
    const parent = await ownerCreatesParent(`mt-cas-softdel-${Date.now()}`);
    await ownerShares(parent.id);
    const vansReply = await vanCreatesChild(parent.id, "v-survives-softdel");

    const del = await api("DELETE", `/memories/${parent.id}`);
    expect(del.status).toBe(200);

    // Van's reply should NOT be in trash. We check directly in the DB
    // because the thread endpoint won't return a trashed parent.
    const dbPath = getTestServer().dbPath;
    const db = new Database(dbPath);
    try {
      const row = db
        .prepare("SELECT deleted_at FROM memories WHERE id = ?")
        .get(vansReply.json.id) as { deleted_at: string | null };
      expect(row.deleted_at).toBeNull();
    } finally {
      db.close();
    }
  });

  it("owner permanently deletes parent: teammate's reply orphaned (parent_memory_id NULL), not purged", async () => {
    const parent = await ownerCreatesParent(`mt-cas-purge-${Date.now()}`);
    await ownerShares(parent.id);
    const vansReply = await vanCreatesChild(parent.id, "v-survives-purge");

    await api("DELETE", `/memories/${parent.id}`);
    const purge = await api("DELETE", `/memories/${parent.id}/permanent`);
    // 204 — not 500 from FK violation, which is the bug this test guards.
    expect(purge.status).toBe(204);

    const dbPath = getTestServer().dbPath;
    const db = new Database(dbPath);
    try {
      const row = db
        .prepare(
          "SELECT id, parent_memory_id, deleted_at FROM memories WHERE id = ?",
        )
        .get(vansReply.json.id) as
        | { id: string; parent_memory_id: string | null; deleted_at: string | null }
        | undefined;
      expect(row).toBeTruthy();
      expect(row!.parent_memory_id).toBeNull();
      expect(row!.deleted_at).toBeNull();
    } finally {
      db.close();
    }
  });
});
