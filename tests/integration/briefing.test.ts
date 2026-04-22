// Integration tests for GET /briefing. Verifies shape + auth + format
// against the live test server (which runs the same boot path as prod).
// Deeper coverage of the formula lives in tests/unit/memory-briefing.test.ts.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, getTestServer, withAgentKey } from "../helpers";

interface BriefingResponse {
  user: { id: string; email: string | null; team_id: string | null };
  totals: {
    personal_memories: number;
    personal_memories_shared: number;
    team_pool_total: number;
  };
  personal_tags: Array<{ tag: string; count: number }>;
  team_tags: Array<{ tag: string; count: number }>;
  recent_tags: Array<{ tag: string; count: number }>;
  active_threads: Array<{
    memory_id: string;
    title: string;
    reply_count: number;
    shared_with_team: boolean;
  }>;
  detected_conventions: string[];
  generated_at: string;
}

let ownerUserId: string;
let teamId: string;
const seededMemoryIds: string[] = [];
let parentId: string;

beforeAll(() => {
  const { dbPath, ownerEmail } = getTestServer();
  const db = new Database(dbPath);
  try {
    ownerUserId = (
      db.prepare("SELECT id FROM users WHERE email = ?").get(ownerEmail) as {
        id: string;
      }
    ).id;

    // Team scaffold so team_tags + team-pool totals are exercised
    teamId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO teams (id, name, owner_id, plan, created_at, updated_at)
       VALUES (?, ?, ?, 'team', ?, ?)`,
    ).run(teamId, "Briefing-Test-Team", ownerUserId, now, now);
    db.prepare(
      `UPDATE users SET team_id = ?, team_role = 'owner' WHERE id = ?`,
    ).run(teamId, ownerUserId);

    function seed(tags: string[], opts: { shared?: boolean; parent?: string } = {}) {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO memories
          (id, user_id, title, content, tags, origin, allowed_vendors,
           memory_type, created_at, updated_at, shared_with_team_id,
           shared_at, parent_memory_id)
         VALUES (?, ?, ?, ?, ?, 'api', '["*"]', 'semantic', ?, ?, ?, ?, ?)`,
      ).run(
        id,
        ownerUserId,
        `briefing-seed-${id.slice(0, 4)}`,
        "body",
        JSON.stringify(tags),
        now,
        now,
        opts.shared ? teamId : null,
        opts.shared ? now : null,
        opts.parent ?? null,
      );
      seededMemoryIds.push(id);
      return id;
    }

    // Personal-only memories
    seed(["briefing-eng", "briefing-p0"]);
    seed(["briefing-eng", "briefing-p1"]);
    seed(["briefing-eng"]);
    // Shared with team
    seed(["briefing-eng", "briefing-resolved"], { shared: true });
    // Thread: parent + 2 children
    parentId = seed(["briefing-session"]);
    seed(["briefing-session-reply"], { parent: parentId });
    seed(["briefing-session-reply"], { parent: parentId });
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
      db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(
        ...seededMemoryIds,
      );
    }
    db.prepare(`UPDATE users SET team_id = NULL, team_role = NULL WHERE id = ?`).run(
      ownerUserId,
    );
    db.prepare(`DELETE FROM teams WHERE id = ?`).run(teamId);
  } finally {
    db.close();
  }
});

describe("GET /briefing (json)", () => {
  it("returns structured briefing with seeded tags + totals", async () => {
    const r = await api<BriefingResponse>("GET", "/briefing");
    expect(r.status).toBe(200);

    // User
    expect(r.json.user.id).toBe(ownerUserId);
    expect(r.json.user.team_id).toBe(teamId);

    // Totals should reflect our seed data (plus whatever else is in the DB)
    expect(r.json.totals.personal_memories).toBeGreaterThanOrEqual(6);
    expect(r.json.totals.personal_memories_shared).toBeGreaterThanOrEqual(1);
    expect(r.json.totals.team_pool_total).toBeGreaterThanOrEqual(1);

    // Personal tags should include our seeds; `briefing-eng` used 4 times
    const byTag = Object.fromEntries(
      r.json.personal_tags.map((t) => [t.tag, t.count]),
    );
    expect(byTag["briefing-eng"]).toBe(4);
    expect(byTag["briefing-p0"]).toBe(1);
    expect(byTag["briefing-p1"]).toBe(1);

    // Team tags only show the shared memory's tags
    const teamByTag = Object.fromEntries(
      r.json.team_tags.map((t) => [t.tag, t.count]),
    );
    expect(teamByTag["briefing-eng"]).toBe(1);
    expect(teamByTag["briefing-resolved"]).toBe(1);

    // Active threads include our parent with 2 replies
    const thread = r.json.active_threads.find((t) => t.memory_id === parentId);
    expect(thread).toBeDefined();
    expect(thread?.reply_count).toBe(2);
  });

  it("returns markdown when format=markdown", async () => {
    const r = await api<unknown>("GET", "/briefing?format=markdown");
    expect(r.status).toBe(200);
    const body = r.text;
    expect(body).toContain("# Reflect Memory — session briefing");
    expect(body).toContain("`briefing-eng`");
    expect(body).toContain("## Current open threads");
  });

  it("respects top_tags query param", async () => {
    const r = await api<BriefingResponse>("GET", "/briefing?top_tags=1");
    expect(r.status).toBe(200);
    expect(r.json.personal_tags.length).toBe(1);
  });

  it("agent keys are refused (briefing is delivered via MCP initialize)", async () => {
    const r = await api<{ error?: string }>("GET", "/briefing", {
      token: withAgentKey("cursor"),
    });
    expect(r.status).toBe(403);
  });
});
