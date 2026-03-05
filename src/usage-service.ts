// Reflect Memory — Usage Service
// Append-only usage event logging with atomic monthly aggregation.
// request_id provides idempotency — duplicate events are silently ignored.

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
        return; // idempotent — duplicate request_id
      }
      throw e;
    }

    // Upsert monthly_usage — increment the relevant counter atomically
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
  usage: {
    writes: number;
    reads: number;
    queries: number;
    total_ops: number;
  };
  limits: {
    maxMemories: number;
    maxOpsPerMonth: number;
  };
  remaining: number;
}

export function checkQuota(
  db: Database.Database,
  userId: string,
): QuotaStatus {
  const month = currentMonth();

  const user = db
    .prepare(`SELECT plan FROM users WHERE id = ?`)
    .get(userId) as { plan: string } | undefined;

  const plan = user?.plan ?? "free";
  const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;

  const usage = db
    .prepare(`SELECT writes, reads, queries, total_ops FROM monthly_usage WHERE user_id = ? AND month = ?`)
    .get(userId, month) as { writes: number; reads: number; queries: number; total_ops: number } | undefined;

  const totalOps = usage?.total_ops ?? 0;
  const remaining = Math.max(0, limits.maxOpsPerMonth - totalOps);

  return {
    allowed: totalOps < limits.maxOpsPerMonth,
    plan,
    usage: {
      writes: usage?.writes ?? 0,
      reads: usage?.reads ?? 0,
      queries: usage?.queries ?? 0,
      total_ops: totalOps,
    },
    limits,
    remaining,
  };
}

export function getUsageForMonth(
  db: Database.Database,
  userId: string,
  month?: string,
): QuotaStatus {
  const m = month ?? currentMonth();

  const user = db
    .prepare(`SELECT plan FROM users WHERE id = ?`)
    .get(userId) as { plan: string } | undefined;

  const plan = user?.plan ?? "free";
  const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;

  const usage = db
    .prepare(`SELECT writes, reads, queries, total_ops FROM monthly_usage WHERE user_id = ? AND month = ?`)
    .get(userId, m) as { writes: number; reads: number; queries: number; total_ops: number } | undefined;

  const totalOps = usage?.total_ops ?? 0;

  return {
    allowed: totalOps < limits.maxOpsPerMonth,
    plan,
    usage: {
      writes: usage?.writes ?? 0,
      reads: usage?.reads ?? 0,
      queries: usage?.queries ?? 0,
      total_ops: totalOps,
    },
    limits,
    remaining: Math.max(0, limits.maxOpsPerMonth - totalOps),
  };
}
