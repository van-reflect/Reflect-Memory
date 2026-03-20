import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type AuditSeverity = "info" | "warn" | "error";

export interface AuditEventInput {
  userId: string | null;
  eventType: string;
  severity?: AuditSeverity;
  authMethod?: string | null;
  vendor?: string | null;
  path?: string | null;
  statusCode?: number | null;
  ip?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AuditEventRow {
  id: string;
  user_id: string | null;
  event_type: string;
  severity: string;
  auth_method: string | null;
  vendor: string | null;
  path: string | null;
  status_code: number | null;
  ip: string | null;
  request_id: string | null;
  metadata: string | null;
  created_at: string;
}

export interface AuditQueryOptions {
  eventType?: string;
  userId?: string;
  severity?: AuditSeverity;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export function createAuditTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id           TEXT NOT NULL PRIMARY KEY,
      user_id      TEXT,
      event_type   TEXT NOT NULL,
      severity     TEXT NOT NULL DEFAULT 'info',
      auth_method  TEXT,
      vendor       TEXT,
      path         TEXT,
      status_code  INTEGER,
      ip           TEXT,
      request_id   TEXT,
      metadata     TEXT,
      created_at   TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_events_event_type ON audit_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_audit_events_user ON audit_events(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_events_request ON audit_events(request_id);
  `);
}

export function recordAuditEvent(
  db: Database.Database,
  input: AuditEventInput,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO audit_events (
      id, user_id, event_type, severity, auth_method, vendor, path, status_code, ip, request_id, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.userId,
    input.eventType,
    input.severity ?? "info",
    input.authMethod ?? null,
    input.vendor ?? null,
    input.path ?? null,
    input.statusCode ?? null,
    input.ip ?? null,
    input.requestId ?? null,
    input.metadata ? JSON.stringify(input.metadata) : null,
    now,
  );
}

export function queryAuditEvents(
  db: Database.Database,
  options: AuditQueryOptions = {},
): AuditEventRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.eventType) {
    conditions.push("event_type = ?");
    params.push(options.eventType);
  }
  if (options.userId) {
    conditions.push("user_id = ?");
    params.push(options.userId);
  }
  if (options.severity) {
    conditions.push("severity = ?");
    params.push(options.severity);
  }
  if (options.since) {
    conditions.push("created_at >= ?");
    params.push(options.since);
  }
  if (options.until) {
    conditions.push("created_at <= ?");
    params.push(options.until);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(options.limit ?? 100, 1000);
  const offset = options.offset ?? 0;
  params.push(limit, offset);

  return db
    .prepare(`SELECT * FROM audit_events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params) as AuditEventRow[];
}

export function countAuditEvents(
  db: Database.Database,
  options: Pick<AuditQueryOptions, "eventType" | "userId" | "severity" | "since" | "until"> = {},
): number {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.eventType) { conditions.push("event_type = ?"); params.push(options.eventType); }
  if (options.userId) { conditions.push("user_id = ?"); params.push(options.userId); }
  if (options.severity) { conditions.push("severity = ?"); params.push(options.severity); }
  if (options.since) { conditions.push("created_at >= ?"); params.push(options.since); }
  if (options.until) { conditions.push("created_at <= ?"); params.push(options.until); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const row = db.prepare(`SELECT COUNT(*) as count FROM audit_events ${where}`).get(...params) as { count: number };
  return row.count;
}

export function pruneAuditEvents(
  db: Database.Database,
  retentionDays: number,
): number {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare(`DELETE FROM audit_events WHERE created_at < ?`).run(cutoff);
  return result.changes;
}

export function exportAuditEvents(
  db: Database.Database,
  since: string,
  until: string,
): AuditEventRow[] {
  return db
    .prepare(`SELECT * FROM audit_events WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC`)
    .all(since, until) as AuditEventRow[];
}
