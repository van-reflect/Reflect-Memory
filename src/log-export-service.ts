// Log export for self-hosted private deploys.
//
// Builds a JSON bundle of the operational tables a customer would share
// with us when they need help debugging or want us to understand their
// usage patterns. Designed to be reviewed before sending — the customer
// downloads, opens, sees exactly what's leaving their server.
//
// What's included: usage_events, monthly_usage, audit_events, users,
// teams. All filtered to the requested date range where applicable.
//
// What's NOT included (and why):
//   - memories.{title,content,tags} — the whole point of private deploy
//     is that user content stays in their network. Including it would
//     undermine that promise.
//   - api_keys — credentials, even hashed.
//   - oauth_clients, oauth_tokens — credentials.
//   - memory_versions — would leak content via title/content fields.
//
// Gate: callers must check RM_LOG_SHARING_ENABLED before invoking this.
// We do NOT check the env var inside this function so it remains
// programmatically usable for tests and future direct-upload paths.

import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

interface ExportMetadata {
  generated_at: string;
  deployment_mode: string;
  server_version: string;
  tenant_id: string | null;
  date_range: { from: string; to: string };
  row_counts: Record<string, number>;
  excluded_tables: string[];
  notes: string[];
}

export interface LogExportBundle {
  metadata: ExportMetadata;
  usage_events: Record<string, unknown>[];
  monthly_usage: Record<string, unknown>[];
  audit_events: Record<string, unknown>[];
  users: Record<string, unknown>[];
  teams: Record<string, unknown>[];
}

function readServerVersion(): string {
  // package.json sits two dirs up from this file at build time.
  // Wrap in try so a missing file or bad parse never blocks an export.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "package.json"), "utf-8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Build the export bundle. Caller is responsible for serialising to JSON
 * and shipping to the client; we keep the data shape strongly typed so
 * downstream tools (the dashboard download, future direct-upload, support
 * tooling) all see the same structure.
 */
export function buildLogExport(
  db: Database.Database,
  opts: {
    from: string; // ISO 8601
    to: string;   // ISO 8601
    deploymentMode: string;
    tenantId: string | null;
  },
): LogExportBundle {
  const { from, to, deploymentMode, tenantId } = opts;

  // usage_events — date-range filtered, ordered for readability.
  const usage_events = db
    .prepare(
      `SELECT id, user_id, operation, origin, request_id, created_at
       FROM usage_events
       WHERE created_at >= ? AND created_at <= ?
       ORDER BY created_at ASC`,
    )
    .all(from, to) as Record<string, unknown>[];

  // monthly_usage — overlap with the date window. Months are stored as
  // 'YYYY-MM' so we filter on the prefix of the from/to dates.
  const fromMonth = from.slice(0, 7);
  const toMonth = to.slice(0, 7);
  const monthly_usage = db
    .prepare(
      `SELECT id, user_id, month, writes, reads, queries, total_ops,
              overage_ops, synced_to_stripe
       FROM monthly_usage
       WHERE month >= ? AND month <= ?
       ORDER BY month ASC, user_id ASC`,
    )
    .all(fromMonth, toMonth) as Record<string, unknown>[];

  // audit_events — full row dump in the date range.
  const audit_events = db
    .prepare(
      `SELECT id, user_id, event_type, severity, auth_method, vendor,
              path, status_code, ip, request_id, metadata, created_at
       FROM audit_events
       WHERE created_at >= ? AND created_at <= ?
       ORDER BY created_at ASC`,
    )
    .all(from, to) as Record<string, unknown>[];

  // users — only users who appear in the filtered usage_events / audit_events.
  // Avoids leaking the full user table when the date range is narrow.
  const referenced = new Set<string>();
  for (const e of [...usage_events, ...audit_events]) {
    const uid = e.user_id;
    if (typeof uid === "string") referenced.add(uid);
  }
  const users: Record<string, unknown>[] =
    referenced.size === 0
      ? []
      : (db
          .prepare(
            `SELECT id, email, role, plan, team_id, team_role, created_at,
                    updated_at
             FROM users
             WHERE id IN (${[...referenced].map(() => "?").join(",")})
             ORDER BY created_at ASC`,
          )
          .all(...referenced) as Record<string, unknown>[]);

  // teams — only teams referenced by the included users.
  const teamIds = new Set<string>();
  for (const u of users) {
    const t = u.team_id;
    if (typeof t === "string") teamIds.add(t);
  }
  const teams: Record<string, unknown>[] =
    teamIds.size === 0
      ? []
      : (db
          .prepare(
            `SELECT id, name, owner_id, plan, created_at, updated_at
             FROM teams
             WHERE id IN (${[...teamIds].map(() => "?").join(",")})`,
          )
          .all(...teamIds) as Record<string, unknown>[]);

  const metadata: ExportMetadata = {
    generated_at: new Date().toISOString(),
    deployment_mode: deploymentMode,
    server_version: readServerVersion(),
    tenant_id: tenantId,
    date_range: { from, to },
    row_counts: {
      usage_events: usage_events.length,
      monthly_usage: monthly_usage.length,
      audit_events: audit_events.length,
      users: users.length,
      teams: teams.length,
    },
    excluded_tables: [
      "memories",
      "memory_versions",
      "api_keys",
      "oauth_clients",
      "oauth_tokens",
      "tag_cluster_cache",
    ],
    notes: [
      "User memory content (titles, body, tags) is NOT included in this export.",
      "Credentials (API keys, OAuth tokens) are NOT included.",
      "Only users and teams referenced by the date-range usage/audit events are included.",
      "Review this file before sharing.",
    ],
  };

  return { metadata, usage_events, monthly_usage, audit_events, users, teams };
}

/**
 * Suggested filename for the download. Customer can rename freely.
 */
export function logExportFilename(
  tenantId: string | null,
  from: string,
  to: string,
): string {
  const tenant = tenantId?.replace(/[^a-z0-9_-]/gi, "_") ?? "instance";
  const fromDate = from.slice(0, 10);
  const toDate = to.slice(0, 10);
  return `reflect-memory-logs-${tenant}-${fromDate}-to-${toDate}.json`;
}
