// Reflect Memory -- Usage Service
// Append-only usage event logging with atomic monthly aggregation.
// request_id provides idempotency -- duplicate events are silently ignored.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { PLAN_LIMITS } from "./billing-service.js";

export type Operation = "memory_write" | "memory_read" | "query" | "chat";

const OP_TO_COLUMN: Record<Operation, "writes" | "reads" | "queries"> = {
  memory_write: "writes",
  memory_read: "reads",
  query: "queries",
  chat: "queries",
};

function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function recordUsage(
  db: Database.Database,
  userId: string,
  operation: Operation,
  origin: string,
  requestId?: string,
): void {
  const month = currentMonth();
  const column = OP_TO_COLUMN[operation];

  const txn = db.transaction(() => {
    const eventId = randomUUID();
    const now = new Date().toISOString();
    const rid = requestId ?? eventId;

    try {
      db.prepare(
        `INSERT INTO usage_events (id, user_id, operation, origin, request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(eventId, userId, operation, origin, rid, now);
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
        return; // idempotent -- duplicate request_id
      }
      throw e;
    }

    // Upsert monthly_usage -- increment the relevant counter atomically
    const existing = db
      .prepare(`SELECT id FROM monthly_usage WHERE user_id = ? AND month = ?`)
      .get(userId, month) as { id: string } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE monthly_usage SET ${column} = ${column} + 1, total_ops = total_ops + 1 WHERE id = ?`,
      ).run(existing.id);
    } else {
      const muId = randomUUID();
      const initWrites = column === "writes" ? 1 : 0;
      const initReads = column === "reads" ? 1 : 0;
      const initQueries = column === "queries" ? 1 : 0;
      db.prepare(
        `INSERT INTO monthly_usage (id, user_id, month, writes, reads, queries, total_ops, overage_ops, synced_to_stripe)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0)`,
      ).run(muId, userId, month, initWrites, initReads, initQueries);
    }
  });

  txn();
}

export interface QuotaStatus {
  allowed: boolean;
  plan: string;
  memory_count: number;
  limits: {
    maxMemories: number;
  };
  memories_remaining: number;
}

export function checkQuota(
  db: Database.Database,
  userId: string,
): QuotaStatus {
  const user = db
    .prepare(`SELECT plan, org_id FROM users WHERE id = ?`)
    .get(userId) as { plan: string; org_id: string | null } | undefined;

  const plan = user?.plan ?? "free";
  const orgId = user?.org_id ?? null;
  const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;

  let memoryCount: number;
  if (orgId && plan === "team") {
    const row = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM memories
         WHERE deleted_at IS NULL AND user_id IN (SELECT id FROM users WHERE org_id = ?)`,
      )
      .get(orgId) as { cnt: number };
    memoryCount = row.cnt;
  } else {
    const row = db
      .prepare(`SELECT COUNT(*) as cnt FROM memories WHERE user_id = ? AND deleted_at IS NULL`)
      .get(userId) as { cnt: number };
    memoryCount = row.cnt;
  }

  const unlimited = !isFinite(limits.maxMemories);
  const remaining = unlimited ? -1 : Math.max(0, limits.maxMemories - memoryCount);

  return {
    allowed: unlimited || memoryCount < limits.maxMemories,
    plan,
    memory_count: memoryCount,
    limits: { maxMemories: unlimited ? -1 : limits.maxMemories },
    memories_remaining: remaining,
  };
}

export function getUsageForMonth(
  db: Database.Database,
  userId: string,
  _month?: string,
): QuotaStatus {
  return checkQuota(db, userId);
}
