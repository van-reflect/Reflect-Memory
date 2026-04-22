// Unit tests for memory-briefing: tag index, recency, thread discovery,
// convention detection, markdown rendering.
//
// Uses makeTestDb() (in-memory SQLite with canonical schema) so every test
// starts from a clean slate.

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  buildMemoryBriefing,
  formatBriefingAsMarkdown,
  type MemoryBriefing,
} from "../../src/memory-briefing";
import { makeTestDb, seedUser, type TestDb } from "./db";

interface MemorySeed {
  title?: string;
  tags?: string[];
  parent?: string | null;
  sharedToTeam?: string | null;
  createdAt?: string;
  deletedAt?: string | null;
  userId?: string;
}

function seedTeam(
  db: Database.Database,
  ownerId: string,
  name = "Unit-Test-Team",
): string {
  const teamId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO teams (id, name, owner_id, plan, created_at, updated_at)
     VALUES (?, ?, ?, 'team', ?, ?)`,
  ).run(teamId, name, ownerId, now, now);
  db.prepare(
    `UPDATE users SET team_id = ?, team_role = 'owner', first_name = 'Test', last_name = 'Owner' WHERE id = ?`,
  ).run(teamId, ownerId);
  return teamId;
}

function seedMemory(
  db: Database.Database,
  userId: string,
  seed: MemorySeed = {},
): string {
  const id = randomUUID();
  const now = seed.createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO memories
      (id, user_id, title, content, tags, origin, allowed_vendors,
       memory_type, created_at, updated_at, deleted_at,
       shared_with_team_id, shared_at, parent_memory_id)
     VALUES (?, ?, ?, ?, ?, 'api', '["*"]', 'semantic', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    seed.userId ?? userId,
    seed.title ?? `memory-${id.slice(0, 4)}`,
    "body",
    JSON.stringify(seed.tags ?? []),
    now,
    now,
    seed.deletedAt ?? null,
    seed.sharedToTeam ?? null,
    seed.sharedToTeam ? now : null,
    seed.parent ?? null,
  );
  return id;
}

let env: TestDb;

beforeEach(() => {
  env = makeTestDb();
});
afterEach(() => {
  env.close();
});

describe("buildMemoryBriefing — user + totals", () => {
  it("returns user summary fields when user exists", async () => {
    const user = seedUser(env.db, { email: "tamer@test.local" });
    env.db.prepare(
      `UPDATE users SET first_name = 'Tamer', last_name = 'Dev' WHERE id = ?`,
    ).run(user.id);
    const b = buildMemoryBriefing(env.db, user.id);
    expect(b.user.id).toBe(user.id);
    expect(b.user.email).toBe("tamer@test.local");
    expect(b.user.first_name).toBe("Tamer");
    expect(b.user.team_id).toBeNull();
    expect(b.user.team_member_count).toBe(0);
  });

  it("falls back to id-only summary when user row is missing", async () => {
    const b = buildMemoryBriefing(env.db, "does-not-exist");
    expect(b.user.id).toBe("does-not-exist");
    expect(b.user.email).toBeNull();
    expect(b.user.team_member_count).toBe(0);
  });

  it("populates team name + member count when user is on a team", async () => {
    const owner = seedUser(env.db);
    const teamId = seedTeam(env.db, owner.id, "Reflect");
    const teammate = seedUser(env.db);
    env.db.prepare(
      `UPDATE users SET team_id = ?, team_role = 'member' WHERE id = ?`,
    ).run(teamId, teammate.id);

    const b = buildMemoryBriefing(env.db, owner.id);
    expect(b.user.team_id).toBe(teamId);
    expect(b.user.team_name).toBe("Reflect");
    expect(b.user.team_role).toBe("owner");
    expect(b.user.team_member_count).toBe(2);
  });

  it("counts personal / shared / team-pool correctly, excluding trash", async () => {
    const owner = seedUser(env.db);
    const teamId = seedTeam(env.db, owner.id);
    const teammate = seedUser(env.db);
    env.db.prepare(
      `UPDATE users SET team_id = ?, team_role = 'member' WHERE id = ?`,
    ).run(teamId, teammate.id);

    seedMemory(env.db, owner.id);
    seedMemory(env.db, owner.id, { sharedToTeam: teamId });
    seedMemory(env.db, owner.id, {
      deletedAt: new Date().toISOString(), // trashed, should not count
    });
    seedMemory(env.db, teammate.id, { sharedToTeam: teamId });

    const b = buildMemoryBriefing(env.db, owner.id);
    expect(b.totals.personal_memories).toBe(2); // 2 live personal, 1 trashed
    expect(b.totals.personal_memories_shared).toBe(1);
    expect(b.totals.team_pool_total).toBe(2); // owner's shared + teammate's shared
  });
});

describe("buildMemoryBriefing — personal tags", () => {
  it("aggregates counts across all personal memories, ordered by count desc", async () => {
    const user = seedUser(env.db);
    seedMemory(env.db, user.id, { tags: ["eng", "p0"] });
    seedMemory(env.db, user.id, { tags: ["eng", "p1"] });
    seedMemory(env.db, user.id, { tags: ["eng"] });
    seedMemory(env.db, user.id, { tags: ["docs"] });

    const b = buildMemoryBriefing(env.db, user.id);
    const tagCounts = Object.fromEntries(b.personal_tags.map((t) => [t.tag, t.count]));
    expect(tagCounts).toEqual({ eng: 3, p0: 1, p1: 1, docs: 1 });
    expect(b.personal_tags[0]).toEqual({ tag: "eng", count: 3 }); // highest first
  });

  it("excludes tags from trashed memories", async () => {
    const user = seedUser(env.db);
    seedMemory(env.db, user.id, { tags: ["live"] });
    seedMemory(env.db, user.id, {
      tags: ["trashed-only"],
      deletedAt: new Date().toISOString(),
    });
    const b = buildMemoryBriefing(env.db, user.id);
    const tags = b.personal_tags.map((t) => t.tag);
    expect(tags).toContain("live");
    expect(tags).not.toContain("trashed-only");
  });

  it("respects topTagsN option", async () => {
    const user = seedUser(env.db);
    for (let i = 0; i < 50; i++) {
      seedMemory(env.db, user.id, { tags: [`tag-${i}`] });
    }
    const b = buildMemoryBriefing(env.db, user.id, { topTagsN: 10 });
    expect(b.personal_tags.length).toBe(10);
  });
});

describe("buildMemoryBriefing — team tags", () => {
  it("empty when user has no team", async () => {
    const user = seedUser(env.db);
    seedMemory(env.db, user.id, { tags: ["eng"] });
    const b = buildMemoryBriefing(env.db, user.id);
    expect(b.team_tags).toEqual([]);
  });

  it("includes team-shared memories from every member, excluding trash", async () => {
    const owner = seedUser(env.db);
    const teamId = seedTeam(env.db, owner.id);
    const teammate = seedUser(env.db);
    env.db.prepare(`UPDATE users SET team_id = ? WHERE id = ?`).run(
      teamId,
      teammate.id,
    );

    seedMemory(env.db, owner.id, { tags: ["eng", "resolved"], sharedToTeam: teamId });
    seedMemory(env.db, teammate.id, { tags: ["eng", "shipped"], sharedToTeam: teamId });
    seedMemory(env.db, teammate.id, {
      tags: ["personal-only"], // NOT shared; should not appear in team tags
    });
    seedMemory(env.db, owner.id, {
      tags: ["trash-only"],
      sharedToTeam: teamId,
      deletedAt: new Date().toISOString(),
    });

    const b = buildMemoryBriefing(env.db, owner.id);
    const tags = Object.fromEntries(b.team_tags.map((t) => [t.tag, t.count]));
    expect(tags).toEqual({ eng: 2, resolved: 1, shipped: 1 });
  });
});

describe("buildMemoryBriefing — recent tags", () => {
  it("only includes memories within the recency window", async () => {
    const user = seedUser(env.db);
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();

    seedMemory(env.db, user.id, { tags: ["fresh"], createdAt: dayAgo });
    seedMemory(env.db, user.id, { tags: ["stale"], createdAt: tenDaysAgo });

    const b = buildMemoryBriefing(env.db, user.id, { recencyDays: 7 });
    const tags = b.recent_tags.map((t) => t.tag);
    expect(tags).toContain("fresh");
    expect(tags).not.toContain("stale");
  });

  it("unions personal + team-shared memories in the window", async () => {
    const owner = seedUser(env.db);
    const teamId = seedTeam(env.db, owner.id);
    const teammate = seedUser(env.db);
    env.db.prepare(`UPDATE users SET team_id = ? WHERE id = ?`).run(teamId, teammate.id);

    const now = new Date().toISOString();
    seedMemory(env.db, owner.id, { tags: ["personal-recent"], createdAt: now });
    seedMemory(env.db, teammate.id, {
      tags: ["team-recent"],
      sharedToTeam: teamId,
      createdAt: now,
    });

    const b = buildMemoryBriefing(env.db, owner.id);
    const tags = b.recent_tags.map((t) => t.tag);
    expect(tags).toEqual(expect.arrayContaining(["personal-recent", "team-recent"]));
  });
});

describe("buildMemoryBriefing — active threads", () => {
  it("lists parents that have at least one non-trashed reply", async () => {
    const user = seedUser(env.db);
    const parent = seedMemory(env.db, user.id, { title: "ticket" });
    seedMemory(env.db, user.id, { parent });
    seedMemory(env.db, user.id, { parent });
    // Parent with no replies should NOT appear
    seedMemory(env.db, user.id, { title: "lonely" });

    const b = buildMemoryBriefing(env.db, user.id);
    expect(b.active_threads.length).toBe(1);
    expect(b.active_threads[0]).toMatchObject({
      memory_id: parent,
      title: "ticket",
      reply_count: 2,
    });
  });

  it("excludes trashed parents", async () => {
    const user = seedUser(env.db);
    const parent = seedMemory(env.db, user.id, {
      title: "trashed-parent",
      deletedAt: new Date().toISOString(),
    });
    seedMemory(env.db, user.id, { parent });
    const b = buildMemoryBriefing(env.db, user.id);
    expect(b.active_threads.map((t) => t.memory_id)).not.toContain(parent);
  });

  it("reports shared_with_team when the parent is shared", async () => {
    const user = seedUser(env.db);
    const teamId = seedTeam(env.db, user.id);
    const parent = seedMemory(env.db, user.id, { sharedToTeam: teamId });
    seedMemory(env.db, user.id, { parent, sharedToTeam: teamId });
    const b = buildMemoryBriefing(env.db, user.id);
    expect(b.active_threads[0].shared_with_team).toBe(true);
  });

  it("orders by reply count desc, then last activity desc", async () => {
    const user = seedUser(env.db);
    const busy = seedMemory(env.db, user.id, { title: "busy" });
    seedMemory(env.db, user.id, { parent: busy });
    seedMemory(env.db, user.id, { parent: busy });
    seedMemory(env.db, user.id, { parent: busy });

    const quiet = seedMemory(env.db, user.id, { title: "quiet" });
    seedMemory(env.db, user.id, { parent: quiet });

    const b = buildMemoryBriefing(env.db, user.id);
    expect(b.active_threads.map((t) => t.title)).toEqual(["busy", "quiet"]);
  });
});

describe("buildMemoryBriefing — convention detection", () => {
  it("detects priority tags when at least two of p0-p3 are present", async () => {
    const user = seedUser(env.db);
    seedMemory(env.db, user.id, { tags: ["p0"] });
    seedMemory(env.db, user.id, { tags: ["p1"] });
    const b = buildMemoryBriefing(env.db, user.id);
    expect(b.detected_conventions.some((c) => c.toLowerCase().includes("priority"))).toBe(true);
  });

  it("detects ref_<id> pattern when any tag matches", async () => {
    const user = seedUser(env.db);
    seedMemory(env.db, user.id, { tags: ["ref_438eebea"] });
    const b = buildMemoryBriefing(env.db, user.id);
    expect(b.detected_conventions.some((c) => c.includes("ref_"))).toBe(true);
  });

  it("detects eng + resolved convention", async () => {
    const user = seedUser(env.db);
    seedMemory(env.db, user.id, { tags: ["eng", "resolved"] });
    const b = buildMemoryBriefing(env.db, user.id);
    expect(b.detected_conventions.some((c) => c.includes("Engineering resolutions"))).toBe(true);
  });

  it("detects session_summary threading convention", async () => {
    const user = seedUser(env.db);
    seedMemory(env.db, user.id, { tags: ["session_summary"] });
    const b = buildMemoryBriefing(env.db, user.id);
    expect(
      b.detected_conventions.some((c) => c.toLowerCase().includes("session summar")),
    ).toBe(true);
  });

  it("detects shipped only when count >= 3", async () => {
    const user = seedUser(env.db);
    seedMemory(env.db, user.id, { tags: ["shipped"] });
    seedMemory(env.db, user.id, { tags: ["shipped"] });
    const bLow = buildMemoryBriefing(env.db, user.id);
    expect(bLow.detected_conventions.some((c) => c.includes("shipped"))).toBe(false);

    seedMemory(env.db, user.id, { tags: ["shipped"] });
    const bHigh = buildMemoryBriefing(env.db, user.id);
    expect(bHigh.detected_conventions.some((c) => c.includes("shipped"))).toBe(true);
  });

  it("emits empty array when no conventions match", async () => {
    const user = seedUser(env.db);
    seedMemory(env.db, user.id, { tags: ["miscellaneous"] });
    const b = buildMemoryBriefing(env.db, user.id);
    expect(b.detected_conventions).toEqual([]);
  });
});

describe("formatBriefingAsMarkdown", () => {
  function makeBriefing(overrides: Partial<MemoryBriefing> = {}): MemoryBriefing {
    return {
      user: {
        id: "u1",
        email: "ts@example.com",
        first_name: "Tamer",
        last_name: "Test",
        role: "admin",
        plan: "team",
        team_id: "t1",
        team_name: "Reflect",
        team_role: "owner",
        team_member_count: 2,
        ...overrides.user,
      },
      totals: {
        personal_memories: 10,
        personal_memories_shared: 3,
        team_pool_total: 8,
        ...overrides.totals,
      },
      personal_tags: overrides.personal_tags ?? [
        { tag: "eng", count: 5 },
        { tag: "p0", count: 2 },
      ],
      team_tags: overrides.team_tags ?? [{ tag: "resolved", count: 4 }],
      recent_tags: overrides.recent_tags ?? [{ tag: "sse", count: 3 }],
      active_threads: overrides.active_threads ?? [
        {
          memory_id: "aaaabbbb-1111-2222-3333-444455556666",
          title: "Session summary",
          reply_count: 2,
          last_activity_at: "2026-04-22T18:00:00.000Z",
          shared_with_team: true,
        },
      ],
      detected_conventions: overrides.detected_conventions ?? [
        "Tickets use priority tags.",
      ],
      generated_at: "2026-04-22T18:30:00.000Z",
    };
  }

  it("includes user identity with team membership", () => {
    const md = formatBriefingAsMarkdown(makeBriefing());
    expect(md).toContain("Tamer Test");
    expect(md).toContain("ts@example.com");
    expect(md).toContain("team **Reflect**");
    expect(md).toContain("role: admin");
  });

  it("renders tag counts in inline code", () => {
    const md = formatBriefingAsMarkdown(makeBriefing());
    expect(md).toContain("`eng` (5)");
    expect(md).toContain("`resolved` (4)");
  });

  it("omits the team tags section for users not on a team", () => {
    const md = formatBriefingAsMarkdown(
      makeBriefing({
        user: {
          id: "u1",
          email: null,
          first_name: null,
          last_name: null,
          role: "user",
          plan: "free",
          team_id: null,
          team_name: null,
          team_role: null,
          team_member_count: 0,
        },
      }),
    );
    expect(md).not.toContain("## Team tags");
  });

  it("renders active thread block with short id + reply count + last activity", () => {
    const md = formatBriefingAsMarkdown(makeBriefing());
    expect(md).toContain("`aaaabbbb`");
    expect(md).toContain("2 replies");
    expect(md).toContain("Session summary");
    expect(md).toContain("shared");
  });

  it("omits the active threads section entirely when there are none", () => {
    const md = formatBriefingAsMarkdown(makeBriefing({ active_threads: [] }));
    expect(md).not.toContain("## Current open threads");
  });

  it("reminds the reader that get_memory_briefing can refresh mid-session", () => {
    const md = formatBriefingAsMarkdown(makeBriefing());
    expect(md).toMatch(/get_memory_briefing/);
  });
});
