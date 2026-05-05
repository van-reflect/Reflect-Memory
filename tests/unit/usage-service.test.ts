// Unit tests: src/usage-service.ts
//
// Verifies the append-only usage event log + atomic monthly aggregation.
// Specifically targets:
//   - request_id idempotency (duplicate insert silently ignored, no double-count)
//   - operation -> column mapping (memory_write -> writes, chat -> queries, ...)
//   - quota status math (memory_count, remaining, unlimited plans)
//   - team plan aggregates across team members

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { checkQuota, recordUsage } from "../../src/usage-service.js";
import { makeTestDb, seedUser, type TestDb } from "./db.js";

let h: TestDb;
let userId: string;

beforeEach(() => {
  h = makeTestDb();
  userId = seedUser(h.db).id;
});

afterEach(() => {
  h.close();
});

function monthlyRow(uid: string) {
  return h.db
    .prepare(`SELECT writes, reads, queries, total_ops FROM monthly_usage WHERE user_id = ?`)
    .get(uid) as
    | { writes: number; reads: number; queries: number; total_ops: number }
    | undefined;
}

function eventCount(uid: string): number {
  const row = h.db
    .prepare(`SELECT COUNT(*) as c FROM usage_events WHERE user_id = ?`)
    .get(uid) as { c: number };
  return row.c;
}

function seedMemory(uid: string, deletedAt: string | null = null) {
  const now = new Date().toISOString();
  h.db.prepare(
    `INSERT INTO memories (id, user_id, title, content, tags, origin, allowed_vendors, memory_type, created_at, updated_at, deleted_at)
     VALUES (?, ?, 'x', 'y', '[]', 'user', '["*"]', 'semantic', ?, ?, ?)`,
  ).run(randomUUID(), uid, now, now, deletedAt);
}

describe("recordUsage: operation -> column mapping", () => {
  it("memory_write bumps writes", () => {
    recordUsage(h.db, userId, "memory_write", "cursor");
    const m = monthlyRow(userId)!;
    expect(m).toEqual({ writes: 1, reads: 0, queries: 0, total_ops: 1 });
  });

  it("memory_read bumps reads", () => {
    recordUsage(h.db, userId, "memory_read", "dashboard");
    const m = monthlyRow(userId)!;
    expect(m).toEqual({ writes: 0, reads: 1, queries: 0, total_ops: 1 });
  });

  it("query bumps queries", () => {
    recordUsage(h.db, userId, "query", "dashboard");
    const m = monthlyRow(userId)!;
    expect(m).toEqual({ writes: 0, reads: 0, queries: 1, total_ops: 1 });
  });

  it("chat collapses into queries (LLM ops billed alongside reads-from-memory)", () => {
    recordUsage(h.db, userId, "chat", "dashboard");
    const m = monthlyRow(userId)!;
    expect(m).toEqual({ writes: 0, reads: 0, queries: 1, total_ops: 1 });
  });
});

describe("recordUsage: aggregation", () => {
  it("upserts a single monthly row across many events", () => {
    recordUsage(h.db, userId, "memory_write", "cursor");
    recordUsage(h.db, userId, "memory_write", "cursor");
    recordUsage(h.db, userId, "memory_read", "dashboard");
    recordUsage(h.db, userId, "query", "dashboard");

    const rows = h.db.prepare(`SELECT * FROM monthly_usage WHERE user_id = ?`).all(userId);
    expect(rows).toHaveLength(1);
    const m = monthlyRow(userId)!;
    expect(m).toEqual({ writes: 2, reads: 1, queries: 1, total_ops: 4 });
  });

  it("scopes monthly rows per user (no cross-user pollution)", () => {
    const otherId = seedUser(h.db).id;
    recordUsage(h.db, userId, "memory_write", "cursor");
    recordUsage(h.db, otherId, "memory_write", "cursor");
    recordUsage(h.db, otherId, "memory_write", "cursor");

    expect(monthlyRow(userId)!.writes).toBe(1);
    expect(monthlyRow(otherId)!.writes).toBe(2);
  });
});

describe("recordUsage: idempotency via request_id", () => {
  it("same request_id is recorded once even when called repeatedly", () => {
    const rid = "req-abc-123";
    recordUsage(h.db, userId, "memory_write", "cursor", rid);
    recordUsage(h.db, userId, "memory_write", "cursor", rid);
    recordUsage(h.db, userId, "memory_write", "cursor", rid);

    expect(eventCount(userId)).toBe(1);
    expect(monthlyRow(userId)!.writes).toBe(1);
    expect(monthlyRow(userId)!.total_ops).toBe(1);
  });

  it("different request_ids count as distinct events", () => {
    recordUsage(h.db, userId, "memory_write", "cursor", "rid-1");
    recordUsage(h.db, userId, "memory_write", "cursor", "rid-2");
    expect(eventCount(userId)).toBe(2);
    expect(monthlyRow(userId)!.writes).toBe(2);
  });

  it("omitted request_id never collides (each event gets a unique uuid as the rid)", () => {
    for (let i = 0; i < 5; i++) {
      recordUsage(h.db, userId, "memory_write", "cursor");
    }
    expect(eventCount(userId)).toBe(5);
    expect(monthlyRow(userId)!.writes).toBe(5);
  });
});

describe("checkQuota", () => {
  it("returns the free-plan defaults for a fresh user", () => {
    const q = checkQuota(h.db, userId);
    expect(q.plan).toBe("free");
    expect(q.memory_count).toBe(0);
    expect(q.allowed).toBe(true);
    expect(q.limits.maxMemories).toBe(200);
    expect(q.memories_remaining).toBe(200);
  });

  it("counts only non-trashed memories toward the cap", () => {
    seedMemory(userId);
    seedMemory(userId);
    seedMemory(userId, new Date().toISOString());

    const q = checkQuota(h.db, userId);
    expect(q.memory_count).toBe(2);
    expect(q.memories_remaining).toBe(198);
  });

  it("blocks once cap is reached (allowed = false, remaining = 0)", () => {
    // Pro plan has 400; bump the user up so we can exhaust the cap quickly.
    h.db.prepare(`UPDATE users SET plan = 'free' WHERE id = ?`).run(userId);
    for (let i = 0; i < 200; i++) seedMemory(userId);

    const q = checkQuota(h.db, userId);
    expect(q.memory_count).toBe(200);
    expect(q.memories_remaining).toBe(0);
    expect(q.allowed).toBe(false);
  });

  it("admin plan reports unlimited (-1 sentinel)", () => {
    h.db.prepare(`UPDATE users SET plan = 'admin' WHERE id = ?`).run(userId);
    const q = checkQuota(h.db, userId);
    expect(q.allowed).toBe(true);
    expect(q.limits.maxMemories).toBe(-1);
    expect(q.memories_remaining).toBe(-1);
  });

  it("team plan aggregates memory_count across all team members", () => {
    // Need a teams row first (FK).
    const orgId = randomUUID();
    const now = new Date().toISOString();
    h.db.prepare(
      `INSERT INTO orgs (id, name, owner_id, plan, created_at, updated_at)
       VALUES (?, 'team-x', ?, 'team', ?, ?)`,
    ).run(orgId, userId, now, now);

    h.db.prepare(`UPDATE users SET plan = 'team', org_id = ? WHERE id = ?`)
      .run(orgId, userId);
    const peer = seedUser(h.db, { plan: "team", orgId });

    seedMemory(userId);
    seedMemory(userId);
    seedMemory(peer.id);

    const q = checkQuota(h.db, userId);
    expect(q.plan).toBe("team");
    expect(q.memory_count).toBe(3);
    expect(q.memories_remaining).toBe(4_000 - 3);
  });

  it("missing user falls back to free defaults rather than crashing", () => {
    const q = checkQuota(h.db, "00000000-0000-0000-0000-000000000000");
    expect(q.plan).toBe("free");
    expect(q.limits.maxMemories).toBe(200);
  });
});
