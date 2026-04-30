// share_with_team flag — write + share in a single call.
//
// Resolves Eng Ticket: "Claude MCP not writing to team shared memories
// correctly" (e52bc2f6) — adds a one-call ergonomic for vendors that
// don't want to chain write_memory + share_memory. Default behavior is
// unchanged (personal-by-default).
//
// Covers:
//   - POST /agent/memories  with share_with_team=true  → row lands in team pool
//   - POST /agent/memories  with share_with_team=false → row stays personal
//   - POST /agent/memories  WITHOUT share_with_team    → row stays personal
//   - POST /memories        with share_with_team=true  → row lands in team pool
//   - share_with_team=true while NOT on a team         → graceful (memory created, not shared)

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { api, getTestServer, uniqueTag, withAgentKey } from "../helpers";

interface MemoryResponse {
  id: string;
  title: string;
  shared_with_team_id: string | null;
  shared_at: string | null;
  origin: string;
}

let ownerUserId: string;
let teamId: string;
const trackedMemoryIds: string[] = [];

beforeAll(() => {
  const { dbPath, ownerEmail } = getTestServer();
  const db = new Database(dbPath);
  try {
    const row = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(ownerEmail) as { id: string } | undefined;
    ownerUserId = row!.id;

    teamId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO teams (id, name, owner_id, plan, created_at, updated_at)
       VALUES (?, ?, ?, 'team', ?, ?)`,
    ).run(teamId, "ShareOnWrite-Test-Team", ownerUserId, now, now);
    db.prepare(
      `UPDATE users SET team_id = ?, team_role = 'owner' WHERE id = ?`,
    ).run(teamId, ownerUserId);
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
    db.prepare("UPDATE users SET team_id = NULL, team_role = NULL WHERE id = ?").run(
      ownerUserId,
    );
    db.prepare("DELETE FROM teams WHERE id = ?").run(teamId);
  } finally {
    db.close();
  }
});

describe("POST /agent/memories — share_with_team flag", () => {
  it("share_with_team=true puts the row in the team pool on creation", async () => {
    const tag = uniqueTag("sow-agent-true");
    const r = await api<MemoryResponse>("POST", "/agent/memories", {
      token: withAgentKey("claude"),
      body: {
        title: `share-on-write ${tag}`,
        content: `body for ${tag}`,
        tags: [tag],
        allowed_vendors: ["*"],
        share_with_team: true,
      },
    });
    expect(r.status).toBe(201);
    if (r.json.id) trackedMemoryIds.push(r.json.id);
    expect(r.json.shared_with_team_id).toBe(teamId);
    expect(r.json.shared_at).toBeTruthy();
    expect(r.json.origin).toBe("claude");
  });

  it("share_with_team=false keeps the row personal", async () => {
    const tag = uniqueTag("sow-agent-false");
    const r = await api<MemoryResponse>("POST", "/agent/memories", {
      token: withAgentKey("claude"),
      body: {
        title: `personal-explicit ${tag}`,
        content: `body for ${tag}`,
        tags: [tag],
        allowed_vendors: ["*"],
        share_with_team: false,
      },
    });
    expect(r.status).toBe(201);
    if (r.json.id) trackedMemoryIds.push(r.json.id);
    // createMemory's hand-rolled return omits unset team fields; toBeFalsy
    // captures both undefined (fresh row) and null (re-read row) — same
    // pattern as tests/integration/threading.test.ts.
    expect(r.json.shared_with_team_id).toBeFalsy();
    expect(r.json.shared_at).toBeFalsy();
  });

  it("omitted share_with_team defaults to personal (no behavior change)", async () => {
    const tag = uniqueTag("sow-agent-omitted");
    const r = await api<MemoryResponse>("POST", "/agent/memories", {
      token: withAgentKey("claude"),
      body: {
        title: `personal-default ${tag}`,
        content: `body for ${tag}`,
        tags: [tag],
        allowed_vendors: ["*"],
      },
    });
    expect(r.status).toBe(201);
    if (r.json.id) trackedMemoryIds.push(r.json.id);
    expect(r.json.shared_with_team_id).toBeFalsy();
  });

  it("works the same way for the cursor agent key (parity with claude)", async () => {
    const tag = uniqueTag("sow-cursor-true");
    const r = await api<MemoryResponse>("POST", "/agent/memories", {
      token: withAgentKey("cursor"),
      body: {
        title: `cursor-share ${tag}`,
        content: `body for ${tag}`,
        tags: [tag],
        allowed_vendors: ["*"],
        share_with_team: true,
      },
    });
    expect(r.status).toBe(201);
    if (r.json.id) trackedMemoryIds.push(r.json.id);
    expect(r.json.shared_with_team_id).toBe(teamId);
    expect(r.json.origin).toBe("cursor");
  });
});

describe("POST /memories — share_with_team flag (user path)", () => {
  it("share_with_team=true on user path puts the row in the team pool", async () => {
    const tag = uniqueTag("sow-user-true");
    const r = await api<MemoryResponse>("POST", "/memories", {
      body: {
        title: `user-share ${tag}`,
        content: `body for ${tag}`,
        tags: [tag],
        share_with_team: true,
      },
    });
    expect(r.status).toBe(201);
    if (r.json.id) trackedMemoryIds.push(r.json.id);
    expect(r.json.shared_with_team_id).toBe(teamId);
    expect(r.json.shared_at).toBeTruthy();
  });

  it("omitted share_with_team on user path stays personal", async () => {
    const tag = uniqueTag("sow-user-omitted");
    const r = await api<MemoryResponse>("POST", "/memories", {
      body: {
        title: `user-personal ${tag}`,
        content: `body for ${tag}`,
        tags: [tag],
      },
    });
    expect(r.status).toBe(201);
    if (r.json.id) trackedMemoryIds.push(r.json.id);
    expect(r.json.shared_with_team_id).toBeFalsy();
  });
});

describe("share_with_team — graceful when caller is not on a team", () => {
  it("creates the memory + silently skips the share (no error)", async () => {
    const { dbPath } = getTestServer();
    const db = new Database(dbPath);
    try {
      // Temporarily detach the owner from the team so the share path
      // hits the "no team_id" branch in the handler.
      db.prepare("UPDATE users SET team_id = NULL, team_role = NULL WHERE id = ?").run(
        ownerUserId,
      );
    } finally {
      db.close();
    }

    try {
      const tag = uniqueTag("sow-noteam");
      const r = await api<MemoryResponse>("POST", "/agent/memories", {
        token: withAgentKey("claude"),
        body: {
          title: `no-team-share ${tag}`,
          content: `body for ${tag}`,
          tags: [tag],
          allowed_vendors: ["*"],
          share_with_team: true,
        },
      });
      expect(r.status).toBe(201);
      if (r.json.id) trackedMemoryIds.push(r.json.id);
      expect(r.json.shared_with_team_id).toBeFalsy();
    } finally {
      // Re-attach so the rest of the suite (in-file beforeAll/afterAll)
      // sees the same team membership.
      const db2 = new Database(dbPath);
      try {
        db2.prepare(
          "UPDATE users SET team_id = ?, team_role = 'owner' WHERE id = ?",
        ).run(teamId, ownerUserId);
      } finally {
        db2.close();
      }
    }
  });
});
